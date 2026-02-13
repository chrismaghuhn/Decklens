import type { PlayerState } from './player.ts';
import type { StackObject, GameAction, CombatState } from './action.ts';

/** MTG turn phases */
export type Phase =
  | 'beginning'
  | 'precombat-main'
  | 'combat'
  | 'postcombat-main'
  | 'ending';

/** Steps within phases */
export type Step =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'main'
  | 'begin-combat'
  | 'declare-attackers'
  | 'declare-blockers'
  | 'first-strike-damage'
  | 'combat-damage'
  | 'end-combat'
  | 'end'
  | 'cleanup';

/** Phase-to-steps mapping */
export const PHASE_STEPS: Record<Phase, Step[]> = {
  beginning: ['untap', 'upkeep', 'draw'],
  'precombat-main': ['main'],
  combat: [
    'begin-combat',
    'declare-attackers',
    'declare-blockers',
    'first-strike-damage',
    'combat-damage',
    'end-combat',
  ],
  'postcombat-main': ['main'],
  ending: ['end', 'cleanup'],
};

/** Ordered phase list for turn progression */
export const PHASES: Phase[] = [
  'beginning',
  'precombat-main',
  'combat',
  'postcombat-main',
  'ending',
];

/** A log entry for game history display */
export interface GameLogEntry {
  timestamp: number;
  turn: number;
  phase: Phase;
  step: Step;
  player: 0 | 1 | null;
  message: string;
  cardName?: string;
  actionType?: GameAction['type'];
}

/** Complete game state at any point in time */
export interface GameState {
  /** The two players: index 0 = human, index 1 = bot */
  players: [PlayerState, PlayerState];

  /** Whose turn it is */
  activePlayer: 0 | 1;
  /** Who currently has priority to act */
  priorityPlayer: 0 | 1;

  /** Current turn number (starts at 1) */
  turn: number;
  phase: Phase;
  step: Step;

  /** The spell/ability stack (LIFO) */
  stack: StackObject[];

  /** Combat state (null when not in combat) */
  combat: CombatState | null;

  /** Winner (null if game in progress) */
  winner: 0 | 1 | null;
  gameOver: boolean;

  /** Game log for display */
  log: GameLogEntry[];
  /** Full action history for replay */
  actionHistory: GameAction[];

  /** Whether both players have passed priority in sequence (for stack resolution) */
  bothPlayersPassed: boolean;

  /** Mulligan phase tracking */
  mulliganPhase: boolean;
  /** How many times each player has mulliganed */
  mulliganCount: [number, number];
}
