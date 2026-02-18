import type { PlayerState } from './player.ts';
import type { StackObject, GameAction, CombatState } from './action.ts';
import type { Card } from './card.ts';

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
  actionType?: GameAction['type'] | 'effect';
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

  /** Manual resolution state — set when a spell/ability can't be auto-resolved */
  needsManualResolution?: boolean;
  /** The card whose effect needs manual resolution */
  manualResolutionCard?: Card;
  /** Controller of the spell needing manual resolution */
  manualResolutionController?: 0 | 1;

  /** Hand size enforcement — which player needs to discard (null if none) */
  pendingDiscard?: 0 | 1 | null;
  /** How many cards the pending discard player must discard */
  pendingDiscardCount?: number;

  /** Queue of extra turns to be taken (CR 500.7). Shift from front when starting a new turn. */
  extraTurns?: { player: 0 | 1 }[];
  /** Number of extra combat phases remaining this turn (CR 506.1). Decremented after each extra combat. */
  extraCombats?: number;

  /** Legend Rule choice pending — player must choose which legendary permanent to keep */
  pendingLegendChoice?: {
    player: 0 | 1;
    legendName: string;
    permanentIds: string[]; // IDs of the duplicate legendaries
  } | null;

  /** Commander zone replacement pending — player must choose whether to move commander to command zone */
  pendingCommanderChoice?: {
    player: 0 | 1;
    commanderName: string;
    /** Where the commander currently is (graveyard or exile) */
    currentZone: 'graveyard' | 'exile';
  } | null;

  /**
   * Combat Damage Assignment pending (CR 510.1).
   * When an attacker is blocked by multiple creatures, the attacking player
   * must divide damage among blockers in Damage Assignment Order (DAO).
   * Each blocker must be assigned at least lethal damage before the next
   * (deathtouch: 1 damage = lethal per CR 702.2b).
   */
  pendingDamageAssignment?: {
    /** The attacking player who must assign damage */
    player: 0 | 1;
    /** The attacking permanent that needs damage assigned */
    attackerId: string;
    /** The attacker's power (total damage to distribute) */
    totalDamage: number;
    /** Whether the attacker has deathtouch (1 = lethal) */
    hasDeathtouch: boolean;
    /** Blocker IDs in Damage Assignment Order (first = must receive lethal first) */
    blockerIds: string[];
    /** Current damage assignment map: blockerId → assigned damage */
    assignments: Record<string, number>;
  } | null;
}
