import type { GameState, GameAction, Target } from '@mtg/game-engine';
import { getLegalActionTypes } from '@mtg/game-engine';

import { identifyThreats, hasMustAnswerThreat } from './evaluators/threat-evaluator.ts';
import { evaluateBoardPosition } from './evaluators/board-evaluator.ts';
import { hasWinningCombo, evaluateCombos } from './evaluators/combo-evaluator.ts';
import { chooseMulliganAction } from './policies/mulligan-policy.ts';
import { choosePlayAction, shouldHoldMana, getCyclingCandidates, getAbilityActivationCandidates, type AbilityCandidate } from './policies/play-policy.ts';
import { chooseAttackers, chooseBlockers, shouldAttack } from './policies/combat-policy.ts';
import { chooseStackAction } from './policies/stack-policy.ts';

/** Choose targets for an activated ability based on its text */
function chooseAbilityTargets(state: GameState, botPlayer: 0 | 1, candidate: AbilityCandidate): Target[] {
  const perm = state.players[botPlayer].battlefield.find(p => p.id === candidate.permanentId);
  if (!perm) return [];
  const ability = perm.abilities[candidate.abilityIndex];
  if (!ability) return [];
  const text = (ability.text || '').toLowerCase();
  const opponent = (botPlayer === 0 ? 1 : 0) as 0 | 1;

  // Target creature/permanent — choose based on whether it's removal or buff
  if (/target\s+(creature|permanent|artifact|enchantment)/i.test(text)) {
    const isRemoval = /destroy|exile|deal.*damage|sacrifice|return.*to.*hand|tap target/i.test(text);
    const isBuff = /\+\d|counter|untap|indestructible|hexproof|protection/i.test(text);

    if (isRemoval) {
      // Target opponent's best creature/permanent
      const oppPerms = state.players[opponent].battlefield.filter(p =>
        p.typeLine?.toLowerCase().includes('creature') || p.typeLine?.toLowerCase().includes('artifact') || p.typeLine?.toLowerCase().includes('enchantment')
      );
      if (oppPerms.length > 0) {
        const best = oppPerms.sort((a, b) =>
          ((b.currentPower || 0) + (b.currentToughness || 0)) - ((a.currentPower || 0) + (a.currentToughness || 0))
        )[0];
        return [{ type: 'permanent', id: best.id }];
      }
    } else if (isBuff) {
      // Target own best creature
      const ownCreatures = state.players[botPlayer].battlefield.filter(p =>
        p.typeLine?.toLowerCase().includes('creature')
      );
      if (ownCreatures.length > 0) {
        const best = ownCreatures.sort((a, b) =>
          ((b.currentPower || 0) + (b.currentToughness || 0)) - ((a.currentPower || 0) + (a.currentToughness || 0))
        )[0];
        return [{ type: 'permanent', id: best.id }];
      }
    }
  }

  // Target player/opponent
  if (/target\s+(player|opponent)/i.test(text)) {
    return [{ type: 'player', id: String(opponent) }];
  }

  return [];
}

/**
 * Decision Tree — Main heuristic decision engine.
 *
 * Decision hierarchy (from spec):
 * 1. Win condition detection
 * 2. Threat prioritization
 * 3. Combo execution
 * 4. Board development (main phase)
 * 5. Combat decisions
 * 6. Stack interactions
 * 7. Default: pass priority
 */

/** Decision result with reasoning */
export interface Decision {
  action: GameAction;
  /** Why this action was chosen */
  reason: string;
  /** Confidence level 0-1 */
  confidence: number;
}

/**
 * Make a decision for the bot player.
 *
 * This is the core decision function called every time the bot has priority.
 */
export function makeDecision(state: GameState, botPlayer: 0 | 1): Decision {
  const legalTypes = getLegalActionTypes(state);

  // --- Mulligan Phase ---
  if (state.mulliganPhase) {
    const action = chooseMulliganAction(state, botPlayer);
    return {
      action,
      reason: 'Mulligan decision',
      confidence: 0.8,
    };
  }

  // --- 1. Check for winning moves ---
  const winAction = findWinningAction(state, botPlayer, legalTypes);
  if (winAction) return winAction;

  // --- 2. Stack interactions (highest urgency when stack has items) ---
  // Check for responses whenever the stack is non-empty, regardless of
  // whether cast-spell is listed as legal (it may not be if the bot has
  // only non-instant cards, but the stack check looks for instants/flash).
  if (state.stack.length > 0) {
    const stackAction = chooseStackAction(state, botPlayer);
    if (stackAction.type !== 'pass') {
      return {
        action: stackAction,
        reason: 'Stack interaction: responding to opponent',
        confidence: 0.7,
      };
    }
  }

  // --- 3. Declare attackers ---
  if (legalTypes.includes('declare-attackers')) {
    if (shouldAttack(state, botPlayer)) {
      const action = chooseAttackers(state, botPlayer);
      return {
        action,
        reason: 'Combat: declaring attackers',
        confidence: 0.7,
      };
    }
    // Don't attack — declare empty attackers
    return {
      action: { type: 'declare-attackers', player: botPlayer, attackers: [] },
      reason: 'Combat: no profitable attacks',
      confidence: 0.6,
    };
  }

  // --- 4. Declare blockers ---
  if (legalTypes.includes('declare-blockers')) {
    const action = chooseBlockers(state, botPlayer);
    return {
      action,
      reason: 'Combat: declaring blockers',
      confidence: 0.7,
    };
  }

  // --- 5. Main phase development ---
  // Evaluate BOTH spell casting AND ability activation, pick the best
  if (state.step === 'main' && state.activePlayer === botPlayer) {
    const holdMana = shouldHoldMana(state, botPlayer);

    // Get all candidates: spells, abilities, cycling
    const playAction = choosePlayAction(state, botPlayer, holdMana);
    const abilityCandidates = getAbilityActivationCandidates(state, botPlayer);
    const cyclingCandidates = getCyclingCandidates(state, botPlayer);

    // Score each option — compare apples to apples
    type ScoredOption = { decision: Decision; score: number };
    const options: ScoredOption[] = [];

    if (playAction) {
      // Spells get confidence as score (0.8 base)
      options.push({
        decision: { action: playAction.action, reason: playAction.reason, confidence: 0.8 },
        score: 0.8,
      });
    }

    if (abilityCandidates.length > 0) {
      const best = abilityCandidates[0];
      const targets = chooseAbilityTargets(state, botPlayer, best);
      const abilityScore = Math.min(0.85, 0.4 + best.priority * 0.06);
      options.push({
        decision: {
          action: {
            type: 'activate-ability' as const,
            player: botPlayer,
            sourceId: best.permanentId,
            abilityIndex: best.abilityIndex,
            targets,
          },
          reason: `Activate ability on ${best.name} (priority ${best.priority})`,
          confidence: abilityScore,
        },
        score: abilityScore,
      });
    }

    if (cyclingCandidates.length > 0) {
      options.push({
        decision: {
          action: cyclingCandidates[0].action,
          reason: cyclingCandidates[0].reason,
          confidence: 0.55,
        },
        score: 0.55,
      });
    }

    // Pick the highest-scored option
    if (options.length > 0) {
      options.sort((a, b) => b.score - a.score);
      return options[0].decision;
    }
  }

  // --- 6. Instant-speed plays during opponent's turn ---
  // Bot should try to respond to ANY significant threat, not just critical ones
  if (state.activePlayer !== botPlayer) {
    // Try stack interactions first (counter/removal in response)
    if (state.stack.length > 0) {
      const stackAction = chooseStackAction(state, botPlayer);
      if (stackAction.type !== 'pass') {
        return {
          action: stackAction,
          reason: 'Responding to opponent spell',
          confidence: 0.7,
        };
      }
    }

    // Try instant-speed abilities (e.g., tap abilities, flash abilities)
    const abilityCandidates = getAbilityActivationCandidates(state, botPlayer);
    const instantAbilities = abilityCandidates.filter(c => {
      const perm = state.players[botPlayer].battlefield.find(p => p.id === c.permanentId);
      if (!perm) return false;
      const ability = perm.abilities[c.abilityIndex];
      return ability?.instantSpeed;
    });
    if (instantAbilities.length > 0 && instantAbilities[0].priority >= 3) {
      const best = instantAbilities[0];
      const targets = chooseAbilityTargets(state, botPlayer, best);
      return {
        action: {
          type: 'activate-ability' as const,
          player: botPlayer,
          sourceId: best.permanentId,
          abilityIndex: best.abilityIndex,
          targets,
        },
        reason: `Activate instant-speed ability on ${best.name}`,
        confidence: Math.min(0.75, 0.4 + best.priority * 0.05),
      };
    }

    // Try flash creatures / instants if board position is concerning
    if (legalTypes.includes('cast-spell')) {
      const threats = identifyThreats(state, botPlayer);
      if (threats.length > 0 && (threats[0].level === 'critical' || threats[0].level === 'high')) {
        const stackAction = chooseStackAction(state, botPlayer);
        if (stackAction.type !== 'pass') {
          return {
            action: stackAction,
            reason: `Responding to threat: ${threats[0].name}`,
            confidence: 0.7,
          };
        }
      }
    }
  }

  // --- 7. Default: pass priority ---
  return {
    action: { type: 'pass', player: botPlayer },
    reason: 'No profitable actions available',
    confidence: 0.5,
  };
}

/**
 * Check if any available action wins the game on the spot.
 */
function findWinningAction(
  state: GameState,
  botPlayer: 0 | 1,
  legalTypes: GameAction['type'][],
): Decision | null {
  const opponent = (botPlayer === 0 ? 1 : 0) as 0 | 1;

  // Check lethal attack
  if (legalTypes.includes('declare-attackers')) {
    const eligible = state.players[botPlayer].battlefield.filter(
      (p) => p.currentPower !== undefined && !p.tapped && !p.summoningSick
    );
    const totalPower = eligible.reduce((sum, p) => sum + (p.currentPower ?? 0), 0);

    // Can we kill with an alpha strike?
    const opponentLife = state.players[opponent].life;
    const opponentBlockers = state.players[opponent].battlefield.filter(
      (p) => p.currentPower !== undefined && !p.tapped
    );

    if (totalPower >= opponentLife && opponentBlockers.length === 0) {
      return {
        action: {
          type: 'declare-attackers',
          player: botPlayer,
          attackers: eligible.map((p) => p.id),
        },
        reason: `Lethal attack! Total power ${totalPower} >= opponent life ${opponentLife}`,
        confidence: 0.95,
      };
    }
  }

  // Check combo wins
  if (hasWinningCombo(state, botPlayer)) {
    // If we have a winning combo, we'd need to cast the pieces.
    // For now, this signals high priority to the play policy.
    // Full combo sequencing is complex and left for future refinement.
  }

  return null;
}

// ─── Modal Mode Evaluation ───

/** Keyword-based heuristic values for modal mode text */
const MODE_KEYWORD_VALUES: { pattern: RegExp; value: number }[] = [
  { pattern: /destroy|exile/i, value: 5 },
  { pattern: /draw/i, value: 4 },
  { pattern: /counter\s+target/i, value: 4 },
  { pattern: /return.*from.*graveyard/i, value: 3 },
  { pattern: /damage/i, value: 3 },
  { pattern: /create.*token/i, value: 3 },
  { pattern: /\+\d+\/\+\d+/i, value: 2 },
  { pattern: /discard/i, value: 2 },
  { pattern: /scry|surveil/i, value: 2 },
  { pattern: /gain.*life/i, value: 1 },
  { pattern: /tap.*target/i, value: 1 },
];

/**
 * Evaluate a modal mode's value using keyword heuristics.
 * Higher score = more desirable mode for the bot.
 */
export function evaluateModalMode(modeText: string): number {
  let score = 0;
  for (const { pattern, value } of MODE_KEYWORD_VALUES) {
    if (pattern.test(modeText)) {
      score += value;
    }
  }
  return score;
}

/**
 * Choose the best N modes from a modal spell for the bot.
 *
 * @param modes - Available mode texts
 * @param count - How many modes to choose (minChoices)
 * @returns Indices of the chosen modes, sorted by preference (highest first)
 */
export function chooseBestModes(
  modes: { index: number; text: string }[],
  count: number,
): number[] {
  const scored = modes.map(m => ({
    index: m.index,
    score: evaluateModalMode(m.text),
  }));

  // Sort by score descending, pick top N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, count).map(s => s.index);
}
