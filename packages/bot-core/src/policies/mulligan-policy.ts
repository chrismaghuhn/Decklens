import type { GameState, GameAction } from '@mtg/game-engine';
import { assessHand, chooseMulliganBottoms, countLands } from '../evaluators/hand-evaluator.ts';
import { emptyPool } from '@mtg/game-engine';

/**
 * Mulligan Policy — Decides whether to keep or mulligan opening hands.
 *
 * Uses London Mulligan rules:
 * - Draw 7, decide keep/mulligan
 * - If mulligan, draw 7 again, then bottom N cards (N = number of mulligans)
 * - Repeat until keep or down to 1 card
 */

/** Quality threshold for keeping a hand, indexed by mulligan count */
const KEEP_THRESHOLDS = [
  5.0, // 7 cards — be selective
  4.0, // 6 cards — slightly less picky
  3.0, // 5 cards — accept reasonable hands
  2.0, // 4 cards — keep almost anything with lands
  1.0, // 3 or fewer — keep anything
];

/**
 * Decide whether to keep the current hand.
 */
export function shouldKeepHand(state: GameState, player: 0 | 1): boolean {
  const hand = state.players[player].hand;
  const mulliganCount = state.mulliganCount?.[player] ?? 0;

  // Always keep at 4 or fewer cards
  if (hand.length <= 4) return true;

  const assessment = assessHand(hand, emptyPool(), state.players[player].life);
  const threshold = KEEP_THRESHOLDS[Math.min(mulliganCount, KEEP_THRESHOLDS.length - 1)];

  // Special case: no lands = always mulligan (unless very few cards)
  if (assessment.landCount === 0 && hand.length > 4) return false;

  // Special case: all lands = always mulligan
  if (assessment.landCount >= hand.length - 1 && hand.length > 4) return false;

  return assessment.quality >= threshold;
}

/**
 * Choose which cards to put on bottom after keeping a mulliganed hand.
 * Returns a mulligan action.
 */
export function chooseMulliganAction(state: GameState, player: 0 | 1): GameAction {
  const hand = state.players[player].hand;
  const mulliganCount = state.mulliganCount?.[player] ?? 0;

  if (shouldKeepHand(state, player)) {
    // Keep — bottom the worst N cards
    const bottomCount = mulliganCount;
    const toBottom = chooseMulliganBottoms(hand, bottomCount);
    return { type: 'mulligan', player, toBottom };
  }

  // Mulligan — signal by bottoming all (the engine will redraw)
  // In our engine, an empty toBottom array with mulligan action = take another mulligan
  return { type: 'mulligan', player, toBottom: [] };
}

/**
 * Get a human-readable explanation of the mulligan decision.
 */
export function explainMulliganDecision(state: GameState, player: 0 | 1): string {
  const hand = state.players[player].hand;
  const assessment = assessHand(hand, emptyPool(), state.players[player].life);
  const mulliganCount = state.mulliganCount?.[player] ?? 0;

  if (hand.length <= 4) {
    return `Keeping ${hand.length}-card hand (too few to mulligan further).`;
  }

  if (assessment.landCount === 0) {
    return `Mulliganing: no lands in hand.`;
  }

  if (assessment.landCount >= hand.length - 1) {
    return `Mulliganing: too many lands (${assessment.landCount}/${hand.length}).`;
  }

  const threshold = KEEP_THRESHOLDS[Math.min(mulliganCount, KEEP_THRESHOLDS.length - 1)];
  if (assessment.quality >= threshold) {
    return `Keeping: quality ${assessment.quality.toFixed(1)} >= threshold ${threshold} (${assessment.landCount} lands, avg CMC ${assessment.averageCMC.toFixed(1)}).`;
  }

  return `Mulliganing: quality ${assessment.quality.toFixed(1)} < threshold ${threshold}.`;
}
