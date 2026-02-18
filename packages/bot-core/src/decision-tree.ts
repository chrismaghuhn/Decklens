import type { GameState, GameAction } from '@mtg/game-engine';
import { getLegalActionTypes } from '@mtg/game-engine';

import { identifyThreats, hasMustAnswerThreat } from './evaluators/threat-evaluator.ts';
import { evaluateBoardPosition } from './evaluators/board-evaluator.ts';
import { hasWinningCombo, evaluateCombos } from './evaluators/combo-evaluator.ts';
import { chooseMulliganAction } from './policies/mulligan-policy.ts';
import { choosePlayAction, shouldHoldMana, getCyclingCandidates, getAbilityActivationCandidates } from './policies/play-policy.ts';
import { chooseAttackers, chooseBlockers, shouldAttack } from './policies/combat-policy.ts';
import { chooseStackAction } from './policies/stack-policy.ts';

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
  if (state.stack.length > 0 && legalTypes.includes('cast-spell')) {
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
  if (state.step === 'main' && state.activePlayer === botPlayer) {
    // Check if we should hold mana for responses
    const holdMana = shouldHoldMana(state, botPlayer);

    const playAction = choosePlayAction(state, botPlayer, holdMana);
    if (playAction) {
      return {
        action: playAction.action,
        reason: playAction.reason,
        confidence: 0.8,
      };
    }

    // No spell to cast — check if we can cycle a low-value card
    const cyclingCandidates = getCyclingCandidates(state, botPlayer);
    if (cyclingCandidates.length > 0) {
      return {
        action: cyclingCandidates[0].action,
        reason: cyclingCandidates[0].reason,
        confidence: 0.6,
      };
    }

    // No cycle either — try activating an ability on a permanent
    const abilityCandidates = getAbilityActivationCandidates(state, botPlayer);
    if (abilityCandidates.length > 0) {
      const best = abilityCandidates[0];
      return {
        action: {
          type: 'activate-ability' as const,
          player: botPlayer,
          sourceId: best.permanentId,
          abilityIndex: best.abilityIndex,
        },
        reason: `Activate ability on ${best.name}`,
        confidence: Math.min(0.8, 0.4 + best.priority * 0.05),
      };
    }
  }

  // --- 6. Instant-speed plays during opponent's turn ---
  if (state.activePlayer !== botPlayer && legalTypes.includes('cast-spell')) {
    // Only respond if there's a reason to
    const threats = identifyThreats(state, botPlayer);
    if (threats.length > 0 && threats[0].level === 'critical') {
      const stackAction = chooseStackAction(state, botPlayer);
      if (stackAction.type !== 'pass') {
        return {
          action: stackAction,
          reason: `Responding to critical threat: ${threats[0].name}`,
          confidence: 0.7,
        };
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
