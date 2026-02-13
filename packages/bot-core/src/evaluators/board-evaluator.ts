import type { GameState, Permanent, PlayerState } from '@mtg/game-engine';

/**
 * Board Evaluator — Assesses battlefield positions.
 *
 * Evaluates board state from a player's perspective using heuristic scores.
 * Higher scores = better position for the player.
 */

/** Score weights for board evaluation */
const WEIGHTS = {
  creature: 2,
  creaturePower: 1,
  creatureToughness: 0.5,
  artifact: 1.5,
  enchantment: 1.5,
  planeswalker: 4,
  planeswalkerLoyalty: 0.5,
  tappedPenalty: -0.5,
  summoningSickPenalty: -0.3,
  lifeDelta: 0.1,
  cardAdvantage: 1.5,
  manaAdvantage: 0.3,
} as const;

/** Detailed board score breakdown */
export interface BoardScore {
  /** Total composite score */
  total: number;
  /** Creature power total */
  creaturePower: number;
  /** Creature toughness total */
  creatureToughness: number;
  /** Number of creatures */
  creatureCount: number;
  /** Number of non-creature permanents */
  nonCreatureCount: number;
  /** Planeswalker loyalty total */
  planeswalkerLoyalty: number;
  /** Life total */
  life: number;
  /** Cards in hand */
  handSize: number;
}

/** Evaluate a single permanent's contribution to board strength */
export function evaluatePermanent(perm: Permanent): number {
  let score = 0;

  const isCreature = perm.currentPower !== undefined;
  const isPlaneswalker = perm.currentLoyalty !== undefined;

  if (isCreature) {
    score += WEIGHTS.creature;
    score += (perm.currentPower ?? 0) * WEIGHTS.creaturePower;
    score += (perm.currentToughness ?? 0) * WEIGHTS.creatureToughness;
  }

  if (isPlaneswalker) {
    score += WEIGHTS.planeswalker;
    score += (perm.currentLoyalty ?? 0) * WEIGHTS.planeswalkerLoyalty;
  }

  // Artifacts and enchantments
  const typeLower = perm.typeLine.toLowerCase();
  if (typeLower.includes('artifact') && !isCreature) {
    score += WEIGHTS.artifact;
  }
  if (typeLower.includes('enchantment') && !isCreature) {
    score += WEIGHTS.enchantment;
  }

  // Penalties
  if (perm.tapped) score += WEIGHTS.tappedPenalty;
  if (perm.summoningSick) score += WEIGHTS.summoningSickPenalty;

  return score;
}

/** Get detailed board score for a player */
export function evaluatePlayerBoard(player: PlayerState): BoardScore {
  let total = 0;
  let creaturePower = 0;
  let creatureToughness = 0;
  let creatureCount = 0;
  let nonCreatureCount = 0;
  let planeswalkerLoyalty = 0;

  for (const perm of player.battlefield) {
    total += evaluatePermanent(perm);

    const isCreature = perm.currentPower !== undefined;
    if (isCreature) {
      creatureCount++;
      creaturePower += perm.currentPower ?? 0;
      creatureToughness += perm.currentToughness ?? 0;
    } else {
      nonCreatureCount++;
    }

    if (perm.currentLoyalty !== undefined) {
      planeswalkerLoyalty += perm.currentLoyalty;
    }
  }

  // Add resource bonuses
  total += player.life * WEIGHTS.lifeDelta;
  total += player.hand.length * WEIGHTS.cardAdvantage;

  return {
    total,
    creaturePower,
    creatureToughness,
    creatureCount,
    nonCreatureCount,
    planeswalkerLoyalty,
    life: player.life,
    handSize: player.hand.length,
  };
}

/**
 * Evaluate board position relative to opponent.
 * Positive = player ahead, negative = opponent ahead.
 */
export function evaluateBoardPosition(state: GameState, player: 0 | 1): number {
  const opponent = (player === 0 ? 1 : 0) as 0 | 1;
  const myScore = evaluatePlayerBoard(state.players[player]);
  const oppScore = evaluatePlayerBoard(state.players[opponent]);
  return myScore.total - oppScore.total;
}

/**
 * Check if a player has board dominance (significantly ahead).
 */
export function hasBoardDominance(state: GameState, player: 0 | 1): boolean {
  return evaluateBoardPosition(state, player) > 10;
}

/**
 * Count total power on the opponent's board (for threat assessment).
 */
export function getOpponentTotalPower(state: GameState, player: 0 | 1): number {
  const opponent = (player === 0 ? 1 : 0) as 0 | 1;
  return state.players[opponent].battlefield
    .filter((p) => p.currentPower !== undefined)
    .reduce((sum, p) => sum + (p.currentPower ?? 0), 0);
}
