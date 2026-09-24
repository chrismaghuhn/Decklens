// ============================================================
// Cut Assistant — Explainable AI for deck cutting
// ============================================================
// "Cut X because lowest synergy score, no combo lines,
// high CMC, off-theme." Uses engine graph data, tag
// heuristics, constraint solver, and combo lines.
// ============================================================

import type { DeckbuilderBoards, DeckbuilderCardEntry, DeckBoard } from './types.js';

// ==================== Types ====================

export interface CutCandidate {
  name: string;
  board: DeckBoard;
  score: number;               // 0-100, lower = better cut candidate
  reasons: CutReason[];
  alternatives: string[];      // Suggested replacements
}

export interface CutReason {
  factor: string;
  weight: number;              // how much this affects the score
  explanation: string;
  severity: 'strong' | 'moderate' | 'mild';
}

export interface CutAnalysis {
  candidates: CutCandidate[];
  toCut: number;                // How many cards need cutting
  deckSize: number;
  targetSize: number;
  summary: string;
}

export interface CutAssistantOptions {
  targetSize?: number;         // default 100 for EDH
  /** Tag counts from constraint solver */
  tagCounts?: Record<string, number>;
  /** Min tag requirements */
  tagMins?: Record<string, number>;
  /** Known combo lines */
  comboLines?: Array<{ name: string; cards: string[] }>;
  /** Synergy edges from engine graph */
  synergyEdges?: Array<{ from: string; to: string; weight: number }>;
  /** Card CMC data */
  cmcData?: Record<string, number>;
  /** Price data */
  priceData?: Record<string, number>;
}

// ==================== Score Factors ====================

const FACTORS = {
  NO_TAGS: { name: 'No Role Tags', weight: -15, severity: 'strong' as const },
  NO_COMBOS: { name: 'Not in Any Combo', weight: -10, severity: 'moderate' as const },
  LOW_SYNERGY: { name: 'Low Synergy Score', weight: -12, severity: 'strong' as const },
  HIGH_CMC: { name: 'High Mana Cost', weight: -8, severity: 'moderate' as const },
  TAG_SURPLUS: { name: 'Tag Category Surplus', weight: -5, severity: 'mild' as const },
  REDUNDANT: { name: 'Redundant Effect', weight: -7, severity: 'moderate' as const },
  OFF_THEME: { name: 'Off-Theme', weight: -10, severity: 'strong' as const },
  HIGH_PRICE: { name: 'Budget Consideration', weight: -3, severity: 'mild' as const },
  IS_COMMANDER: { name: 'Commander', weight: 100, severity: 'strong' as const },
  IN_COMBO: { name: 'Part of Combo Line', weight: 15, severity: 'strong' as const },
  FILLS_QUOTA: { name: 'Fills Tag Quota', weight: 12, severity: 'moderate' as const },
  HIGH_SYNERGY: { name: 'High Synergy', weight: 10, severity: 'moderate' as const },
};

// ==================== Analysis ====================

/**
 * Analyze deck and suggest cut candidates with explanations.
 */
export function analyzeCuts(
  boards: DeckbuilderBoards,
  options: CutAssistantOptions = {}
): CutAnalysis {
  const targetSize = options.targetSize || 100;
  const allCards: Array<{ card: DeckbuilderCardEntry; board: DeckBoard }> = [];

  // Collect all cards
  for (const [board, cards] of Object.entries(boards) as [DeckBoard, DeckbuilderCardEntry[]][]) {
    for (const card of cards) {
      allCards.push({ card, board });
    }
  }

  const totalCards = allCards.reduce((sum, { card }) => sum + card.qty, 0);
  const toCut = Math.max(0, totalCards - targetSize);

  // Build synergy scores
  const synergyScores = new Map<string, number>();
  if (options.synergyEdges) {
    for (const edge of options.synergyEdges) {
      synergyScores.set(edge.from, (synergyScores.get(edge.from) || 0) + edge.weight);
      synergyScores.set(edge.to, (synergyScores.get(edge.to) || 0) + edge.weight);
    }
  }

  // Build combo lookup
  const inCombo = new Set<string>();
  if (options.comboLines) {
    for (const line of options.comboLines) {
      for (const card of line.cards) {
        inCombo.add(card.toLowerCase());
      }
    }
  }

  // Tag surplus detection
  const tagSurplus = new Map<string, boolean>();
  if (options.tagCounts && options.tagMins) {
    for (const [tag, count] of Object.entries(options.tagCounts)) {
      const min = options.tagMins[tag] || 0;
      tagSurplus.set(tag, count > min + 2); // surplus if more than 2 over minimum
    }
  }

  // Score each card
  const candidates: CutCandidate[] = [];

  for (const { card, board } of allCards) {
    if (board === 'sideboard' || board === 'maybeboard') continue;

    const reasons: CutReason[] = [];
    let score = 50; // base score

    // Commander is never cut
    if (board === 'commander') {
      score += FACTORS.IS_COMMANDER.weight;
      reasons.push({
        factor: FACTORS.IS_COMMANDER.name,
        weight: FACTORS.IS_COMMANDER.weight,
        explanation: 'Commanders cannot be cut',
        severity: FACTORS.IS_COMMANDER.severity,
      });
    } else {
      // No tags = no identified role
      if (card.tags.length === 0) {
        score += FACTORS.NO_TAGS.weight;
        reasons.push({
          factor: FACTORS.NO_TAGS.name,
          weight: FACTORS.NO_TAGS.weight,
          explanation: 'This card has no role tags — its purpose in the deck is unclear',
          severity: FACTORS.NO_TAGS.severity,
        });
      }

      // Not in any combo
      if (!inCombo.has(card.name.toLowerCase())) {
        score += FACTORS.NO_COMBOS.weight;
        reasons.push({
          factor: FACTORS.NO_COMBOS.name,
          weight: FACTORS.NO_COMBOS.weight,
          explanation: 'Not part of any known combo line',
          severity: FACTORS.NO_COMBOS.severity,
        });
      } else {
        score += FACTORS.IN_COMBO.weight;
        reasons.push({
          factor: FACTORS.IN_COMBO.name,
          weight: FACTORS.IN_COMBO.weight,
          explanation: 'Part of a combo line — important to keep',
          severity: FACTORS.IN_COMBO.severity,
        });
      }

      // Synergy score
      const syn = synergyScores.get(card.name) || 0;
      if (syn === 0) {
        score += FACTORS.LOW_SYNERGY.weight;
        reasons.push({
          factor: FACTORS.LOW_SYNERGY.name,
          weight: FACTORS.LOW_SYNERGY.weight,
          explanation: 'No synergy connections to other cards in the deck',
          severity: FACTORS.LOW_SYNERGY.severity,
        });
      } else if (syn >= 3) {
        score += FACTORS.HIGH_SYNERGY.weight;
        reasons.push({
          factor: FACTORS.HIGH_SYNERGY.name,
          weight: FACTORS.HIGH_SYNERGY.weight,
          explanation: `${syn} synergy connections with other cards`,
          severity: FACTORS.HIGH_SYNERGY.severity,
        });
      }

      // High CMC
      const cmc = options.cmcData?.[card.name];
      if (cmc !== undefined && cmc >= 6) {
        score += FACTORS.HIGH_CMC.weight;
        reasons.push({
          factor: FACTORS.HIGH_CMC.name,
          weight: FACTORS.HIGH_CMC.weight,
          explanation: `Mana value ${cmc} is expensive — consider if the impact justifies the cost`,
          severity: FACTORS.HIGH_CMC.severity,
        });
      }

      // Tag surplus — card in a category that's already above minimum
      for (const tag of card.tags) {
        if (tagSurplus.get(tag)) {
          score += FACTORS.TAG_SURPLUS.weight;
          reasons.push({
            factor: FACTORS.TAG_SURPLUS.name,
            weight: FACTORS.TAG_SURPLUS.weight,
            explanation: `"${tag}" category already exceeds minimum quota`,
            severity: FACTORS.TAG_SURPLUS.severity,
          });
          break; // only count once
        } else if (options.tagCounts && options.tagMins) {
          const count = options.tagCounts[tag] || 0;
          const min = options.tagMins[tag] || 0;
          if (count <= min) {
            score += FACTORS.FILLS_QUOTA.weight;
            reasons.push({
              factor: FACTORS.FILLS_QUOTA.name,
              weight: FACTORS.FILLS_QUOTA.weight,
              explanation: `Needed to meet "${tag}" minimum (${count}/${min})`,
              severity: FACTORS.FILLS_QUOTA.severity,
            });
            break;
          }
        }
      }

      // High price (budget consideration)
      const price = options.priceData?.[card.name];
      if (price !== undefined && price > 20) {
        score += FACTORS.HIGH_PRICE.weight;
        reasons.push({
          factor: FACTORS.HIGH_PRICE.name,
          weight: FACTORS.HIGH_PRICE.weight,
          explanation: `$${price.toFixed(2)} — a budget alternative could save money`,
          severity: FACTORS.HIGH_PRICE.severity,
        });
      }
    }

    // Sort reasons by absolute weight
    reasons.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

    candidates.push({
      name: card.name,
      board,
      score: Math.max(0, Math.min(100, score)),
      reasons,
      alternatives: [],
    });
  }

  // Sort by score (lowest = best cut candidate)
  candidates.sort((a, b) => a.score - b.score);

  // Build summary
  const topCuts = candidates.filter(c => c.board !== 'commander').slice(0, toCut);
  let summary: string;
  if (toCut === 0) {
    summary = `Deck is at ${totalCards} cards (target: ${targetSize}). No cuts needed!`;
  } else {
    summary = `Need to cut ${toCut} card(s) (${totalCards} → ${targetSize}). `;
    summary += `Top suggestion: ${topCuts[0]?.name || 'none'} `;
    if (topCuts[0]?.reasons[0]) {
      summary += `(${topCuts[0].reasons[0].explanation})`;
    }
  }

  return {
    candidates,
    toCut,
    deckSize: totalCards,
    targetSize,
    summary,
  };
}

// ==================== Explain ====================

/**
 * Generate a human-readable explanation for why a card should be cut.
 */
export function explainCut(candidate: CutCandidate): string {
  const lines = [`Cut "${candidate.name}" (score: ${candidate.score}/100):`];

  for (const reason of candidate.reasons) {
    const icon = reason.severity === 'strong' ? '●' : reason.severity === 'moderate' ? '◐' : '○';
    const direction = reason.weight < 0 ? '↓' : '↑';
    lines.push(`  ${icon} ${direction} ${reason.explanation}`);
  }

  if (candidate.alternatives.length > 0) {
    lines.push(`\nConsider replacing with: ${candidate.alternatives.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Generate a visual "cut flowchart" showing the reasoning process.
 * Returns structured data for rendering.
 */
export function generateCutFlowchart(
  analysis: CutAnalysis
): Array<{ stage: string; kept: number; cut: number; reason: string }> {
  const stages = [
    { stage: 'Start', kept: analysis.deckSize, cut: 0, reason: `${analysis.deckSize} cards total` },
  ];

  let remaining = analysis.deckSize;
  const topCandidates = analysis.candidates.filter(c => c.board !== 'commander');

  // Group cuts by primary reason
  const reasonGroups = new Map<string, CutCandidate[]>();
  for (const candidate of topCandidates.slice(0, analysis.toCut)) {
    const primaryReason = candidate.reasons.find(r => r.weight < 0)?.factor || 'Unknown';
    if (!reasonGroups.has(primaryReason)) reasonGroups.set(primaryReason, []);
    reasonGroups.get(primaryReason)!.push(candidate);
  }

  for (const [reason, candidates] of reasonGroups) {
    remaining -= candidates.length;
    stages.push({
      stage: reason,
      kept: remaining,
      cut: candidates.length,
      reason: `Cut ${candidates.length}: ${candidates.map(c => c.name).join(', ')}`,
    });
  }

  stages.push({
    stage: 'Final',
    kept: remaining,
    cut: 0,
    reason: `${remaining} cards — ${remaining === analysis.targetSize ? 'on target!' : `${remaining - analysis.targetSize} off target`}`,
  });

  return stages;
}
