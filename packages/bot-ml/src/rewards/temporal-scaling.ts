/**
 * Temporal Scaling — Adjusts reward weights based on game phase.
 *
 * Early game (T1-4): Ramp and lands are critical, interaction less so.
 * Mid game (T5-8): Engines and card draw matter most.
 * Late game (T9+): Combos, interaction, and win conditions dominate.
 */

/** Game phase based on turn number */
export type GamePhase = 'early' | 'mid' | 'late';

/** Category of reward being scaled */
export type RewardCategory =
  | 'ramp'
  | 'missedLandDrop'
  | 'interaction'
  | 'engines'
  | 'cardDraw'
  | 'comboRewards'
  | 'winConditions'
  | 'creatures'
  | 'combat'
  | 'default';

/** Scaling factors per phase */
interface PhaseScaling {
  ramp: number;
  missedLandDrop: number;
  interaction: number;
  engines: number;
  cardDraw: number;
  comboRewards: number;
  winConditions: number;
  creatures: number;
  combat: number;
  default: number;
}

const EARLY_SCALING: PhaseScaling = {
  ramp: 1.5,
  missedLandDrop: 2.0,
  interaction: 0.7,
  engines: 0.8,
  cardDraw: 1.0,
  comboRewards: 0.5,
  winConditions: 0.5,
  creatures: 1.0,
  combat: 0.6,
  default: 1.0,
};

const MID_SCALING: PhaseScaling = {
  ramp: 1.0,
  missedLandDrop: 1.0,
  interaction: 1.2,
  engines: 1.3,
  cardDraw: 1.3,
  comboRewards: 1.2,
  winConditions: 1.2,
  creatures: 1.0,
  combat: 1.0,
  default: 1.0,
};

const LATE_SCALING: PhaseScaling = {
  ramp: 0.5,
  missedLandDrop: 0.3,
  interaction: 2.0,
  engines: 1.0,
  cardDraw: 1.0,
  comboRewards: 2.0,
  winConditions: 3.0,
  creatures: 0.7,
  combat: 1.5,
  default: 1.0,
};

/** Determine game phase from turn number */
export function getGamePhase(turn: number): GamePhase {
  if (turn <= 4) return 'early';
  if (turn <= 8) return 'mid';
  return 'late';
}

/** Get temporal scaling factor for a reward category at a given turn */
export function getTemporalScale(turn: number, category: RewardCategory): number {
  const phase = getGamePhase(turn);
  switch (phase) {
    case 'early': return EARLY_SCALING[category];
    case 'mid': return MID_SCALING[category];
    case 'late': return LATE_SCALING[category];
  }
}

/** Apply temporal scaling to a raw reward */
export function applyTemporalScaling(
  rawReward: number,
  turn: number,
  category: RewardCategory,
): number {
  return rawReward * getTemporalScale(turn, category);
}
