// ============================================================
// Constraint Solver — "I need 10 ramp, 10 draw, 33 lands"
// ============================================================
// Given target tag quotas, suggests which cards to cut or add
// to meet the constraints. Integrates with tag heuristics.
// ============================================================

import type { DeckbuilderCardEntry, DeckBoard } from './types.js';

// ==================== Types ====================

export interface TagConstraint {
  tag: string;
  minCount: number;
  maxCount?: number;
  priority: number;          // 0 = highest priority
}

export interface ConstraintViolation {
  constraint: TagConstraint;
  currentCount: number;
  deficit: number;           // positive = need more, negative = need fewer
}

export interface SolverSuggestion {
  action: 'cut' | 'add' | 'swap';
  cardName: string;
  board: DeckBoard;
  reason: string;
  score: number;             // higher = better suggestion
  /** For swap suggestions */
  swapFor?: string;
}

export interface SolverResult {
  violations: ConstraintViolation[];
  suggestions: SolverSuggestion[];
  isSatisfied: boolean;
  summary: string;
}

// ==================== Default Constraints ====================

export function getDefaultEDHConstraints(): TagConstraint[] {
  return [
    { tag: 'land', minCount: 33, maxCount: 40, priority: 0 },
    { tag: 'ramp', minCount: 10, priority: 1 },
    { tag: 'draw', minCount: 10, priority: 1 },
    { tag: 'removal', minCount: 5, priority: 2 },
    { tag: 'board_wipe', minCount: 2, priority: 3 },
    { tag: 'wincon', minCount: 3, priority: 2 },
  ];
}

// ==================== Solver ====================

/**
 * Analyze deck against constraints and suggest fixes.
 */
export function solveConstraints(
  cards: { board: DeckBoard; entries: DeckbuilderCardEntry[] }[],
  constraints: TagConstraint[],
  deckSizeTarget = 100
): SolverResult {
  // Count cards per tag
  const tagCounts = new Map<string, number>();
  const allCards: Array<{ board: DeckBoard; entry: DeckbuilderCardEntry }> = [];

  for (const { board, entries } of cards) {
    for (const entry of entries) {
      allCards.push({ board, entry });
      for (const tag of entry.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + entry.qty);
      }
    }
  }

  const totalCards = allCards.reduce((sum, c) => sum + c.entry.qty, 0);

  // Find violations
  const violations: ConstraintViolation[] = [];

  for (const constraint of constraints) {
    const current = tagCounts.get(constraint.tag) ?? 0;
    const deficit = constraint.minCount - current;

    if (deficit > 0) {
      violations.push({ constraint, currentCount: current, deficit });
    } else if (constraint.maxCount && current > constraint.maxCount) {
      violations.push({
        constraint,
        currentCount: current,
        deficit: constraint.maxCount - current, // negative = over limit
      });
    }
  }

  // Sort violations by priority (highest priority first)
  violations.sort((a, b) => a.constraint.priority - b.constraint.priority);

  // Generate suggestions
  const suggestions: SolverSuggestion[] = [];

  // Suggest cuts for over-limit or deck size issues
  if (totalCards > deckSizeTarget) {
    const excess = totalCards - deckSizeTarget;
    const cutCandidates = findCutCandidates(allCards, constraints, tagCounts);
    for (const candidate of cutCandidates.slice(0, excess)) {
      suggestions.push(candidate);
    }
  }

  // Suggest additions for under-limit tags
  for (const violation of violations.filter(v => v.deficit > 0)) {
    suggestions.push({
      action: 'add',
      cardName: `[${violation.constraint.tag}]`,
      board: 'mainboard',
      reason: `Need ${violation.deficit} more ${violation.constraint.tag} cards (have ${violation.currentCount}/${violation.constraint.minCount})`,
      score: 100 - violation.constraint.priority * 10,
    });
  }

  // Build summary
  const satisfied = violations.length === 0;
  const parts: string[] = [];
  if (satisfied) {
    parts.push('All constraints satisfied!');
  } else {
    parts.push(`${violations.length} constraint(s) not met:`);
    for (const v of violations) {
      if (v.deficit > 0) {
        parts.push(`  - ${v.constraint.tag}: need ${v.deficit} more (${v.currentCount}/${v.constraint.minCount})`);
      } else {
        parts.push(`  - ${v.constraint.tag}: ${Math.abs(v.deficit)} over limit (${v.currentCount}/${v.constraint.maxCount})`);
      }
    }
  }
  if (totalCards !== deckSizeTarget) {
    parts.push(`Deck size: ${totalCards}/${deckSizeTarget}`);
  }

  return {
    violations,
    suggestions,
    isSatisfied: satisfied && totalCards === deckSizeTarget,
    summary: parts.join('\n'),
  };
}

// ==================== Cut Candidates ====================

function findCutCandidates(
  allCards: Array<{ board: DeckBoard; entry: DeckbuilderCardEntry }>,
  constraints: TagConstraint[],
  tagCounts: Map<string, number>
): SolverSuggestion[] {
  const candidates: SolverSuggestion[] = [];

  // Score each card: lower score = better cut candidate
  for (const { board, entry } of allCards) {
    if (board === 'commander') continue; // Never cut commanders
    if (board === 'sideboard' || board === 'maybeboard') continue;

    let score = 50; // base score
    const reasons: string[] = [];

    // Cards that don't fulfill any constraint are better cut candidates
    let fulfillsConstraint = false;
    for (const constraint of constraints) {
      if (entry.tags.includes(constraint.tag)) {
        fulfillsConstraint = true;
        const count = tagCounts.get(constraint.tag) ?? 0;
        if (count <= constraint.minCount) {
          score += 30; // Don't cut if at or below minimum
        } else {
          score -= 10; // OK to cut if above minimum
          reasons.push(`${constraint.tag} surplus`);
        }
      }
    }

    if (!fulfillsConstraint) {
      score -= 20; // No tags matching constraints → good cut candidate
      reasons.push('no constraint tags');
    }

    // Cards with no tags at all
    if (entry.tags.length === 0) {
      score -= 15;
      reasons.push('untagged');
    }

    candidates.push({
      action: 'cut',
      cardName: entry.name,
      board,
      reason: reasons.length > 0 ? reasons.join(', ') : 'flexible slot',
      score,
    });
  }

  // Sort by score (lowest = best cut candidate)
  candidates.sort((a, b) => a.score - b.score);

  return candidates;
}

// ==================== Quick Analysis ====================

/**
 * Quick analysis: just check if constraints are met without suggestions.
 */
export function quickAnalysis(
  cards: { board: DeckBoard; entries: DeckbuilderCardEntry[] }[],
  constraints: TagConstraint[]
): { tag: string; count: number; min: number; met: boolean }[] {
  const tagCounts = new Map<string, number>();

  for (const { entries } of cards) {
    for (const entry of entries) {
      for (const tag of entry.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + entry.qty);
      }
    }
  }

  return constraints.map(c => {
    const count = tagCounts.get(c.tag) ?? 0;
    return {
      tag: c.tag,
      count,
      min: c.minCount,
      met: count >= c.minCount && (!c.maxCount || count <= c.maxCount),
    };
  });
}
