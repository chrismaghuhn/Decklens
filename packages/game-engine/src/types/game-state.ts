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
  player: number | null;
  message: string;
  cardName?: string;
  actionType?: GameAction['type'] | 'effect';
}

/** Complete game state at any point in time */
export interface GameState {
  /** All players: index 0 = human, index 1 = bot (extensible for N-player) */
  players: PlayerState[];

  /** Whose turn it is */
  activePlayer: number;
  /** Who currently has priority to act */
  priorityPlayer: number;

  /** Current turn number (starts at 1) */
  turn: number;
  phase: Phase;
  step: Step;

  /** The spell/ability stack (LIFO) */
  stack: StackObject[];

  /** Combat state (null when not in combat) */
  combat: CombatState | null;

  /** Winner (null if game in progress) */
  winner: number | null;
  gameOver: boolean;

  /** Game log for display */
  log: GameLogEntry[];
  /** Full action history for replay */
  actionHistory: GameAction[];

  /** Set of player indices who have passed priority in sequence (for stack resolution) */
  playersPassed: Set<number>;

  /** Mulligan phase tracking */
  mulliganPhase: boolean;
  /** How many times each player has mulliganed */
  mulliganCount: number[];

  /** Manual resolution state — set when a spell/ability can't be auto-resolved */
  needsManualResolution?: boolean;
  /** The card whose effect needs manual resolution */
  manualResolutionCard?: Card;
  /** Controller of the spell needing manual resolution */
  manualResolutionController?: number;

  /** Hand size enforcement — which player needs to discard (null if none) */
  pendingDiscard?: number | null;
  /** How many cards the pending discard player must discard */
  pendingDiscardCount?: number;
  /** Queue of players still waiting to discard (for "each player discards" effects) */
  pendingDiscardQueue?: { player: number; count: number }[];

  /** Which player is the monarch, or null if no one (CR 721) */
  monarch?: number | null;

  /** Queue of extra turns to be taken (CR 500.7). Shift from front when starting a new turn. */
  extraTurns?: { player: number }[];
  /** Number of extra combat phases remaining this turn (CR 506.1). Decremented after each extra combat. */
  extraCombats?: number;

  /** Legend Rule choice pending — player must choose which legendary permanent to keep */
  pendingLegendChoice?: {
    player: number;
    legendName: string;
    permanentIds: string[]; // IDs of the duplicate legendaries
  } | null;

  /** Commander zone replacement pending — player must choose whether to move commander to command zone */
  pendingCommanderChoice?: {
    player: number;
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
    player: number;
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

  /** Modal choice pending — player must choose modes for a modal spell */
  pendingModalChoice?: {
    stackObjectId: string;
    controller: number;
    modes: { index: number; text: string; oracleText: string }[];
    minChoices: number;
    maxChoices: number;
    cardName?: string;
  } | null;

  /** Sacrifice choice pending — player must choose permanents to sacrifice */
  pendingSacrifice?: {
    player: number;
    filter: string; // 'creature', 'artifact', 'enchantment', 'permanent'
    count: number;
    sourceId?: string; // The card that caused the sacrifice
    sourceName?: string;
  } | null;

  /** Queue of players still waiting to sacrifice (for "each player sacrifices" effects) */
  pendingSacrificeQueue?: { player: number; count: number; filter: string }[];

  /** Library search pending — player must choose cards from their library */
  pendingSearch?: {
    player: number;
    filter: string; // 'creature', 'land', 'basic land', 'artifact', 'enchantment', 'instant', 'sorcery', '' (any)
    count: number; // how many cards to choose
    destination: 'hand' | 'battlefield' | 'top-of-library';
    sourceName?: string;
    /** For Cultivate-style effects: count2 cards go to a second destination */
    count2?: number;
    destination2?: 'hand' | 'battlefield' | 'top-of-library';
    /** Whether cards going to battlefield enter tapped */
    tapped?: boolean;
  } | null;

  /** Scry pending — player must arrange top N cards */
  pendingScry?: {
    player: number;
    count: number;
    cards: string[]; // card IDs of the top N cards
  } | null;

  /**
   * Trigger ordering pending — when ≥2 triggers fire simultaneously for the same player,
   * pause and let that player choose the order they resolve (CR 603.3b).
   * Triggers are pushed onto the stack in chosen order after confirmation.
   */
  pendingTriggerOrder?: {
    player: number;
    triggers: Array<{
      id: string;
      sourceName: string;
      oracleText: string;
      /** Pre-built StackObject ready to push once order is confirmed */
      stackObject: import('./action.ts').StackObject;
    }>;
  } | null;

  /** Whether a card has been drawn this turn (for Miracle — first draw is special) */
  firstDrawThisTurn?: boolean;

  /** Day/Night state (CR 722). null = not yet entered day/night. */
  dayNight?: 'day' | 'night' | null;

  /** Number of spells cast by the active player during their current turn (for day/night flipping) */
  spellsCastThisTurn?: number;

  /** Spells cast by the active player last turn — preserved across cleanup for day/night upkeep check */
  spellsCastLastTurn?: number;

  /** Whether a creature died this turn — used for Morbid condition checks (CR 702.109) */
  creatureDiedThisTurn?: boolean;

  /** Cards exiled with time counters for Suspend mechanic */
  suspendedCards?: Array<{ cardId: string; ownerId: number; counters: number }>;

  /** Card IDs that were foretold (exiled face-down, can be cast for foretell cost) */
  foretoldCards?: string[];

  /**
   * The Ring tempts you state (CR 701.52, LTR set).
   * ringBearerId: permanent ID of the current ring-bearer (null if none chosen yet).
   * ringTemptedCount: number of times the ring has tempted this player (0-4).
   * Once at 4, further temptations still let you choose a new ring-bearer.
   */
  theRing?: {
    ringBearerId: string | null;  // Permanent ID of ring-bearer on battlefield
    ringTemptedCount: number;     // 0=none, 1=menace added, 2=+lifelink, 3=unblockable except by legends, 4=drain on attack
    player: number;               // Which player the ring has tempted
  } | null;

  /** Companion card revealed at game start (CR 702.138). One per player; null if no companion. */
  companion?: (Card | null)[];
  /** Whether each player has already moved their companion to hand this game */
  companionUsed?: boolean[];

  /** Damage prevention shields — "prevent the next N damage" effects (CR 615.7) */
  damageShields?: Array<{
    targetId: string; // permanent ID or 'player-0'/'player-1'
    amount: number; // remaining prevention amount (decremented as damage is prevented)
    source?: string; // description of what created this shield
    turn: number; // turn created (for cleanup of permanent shields vs one-turn)
    untilEndOfTurn: boolean; // whether this expires at cleanup
  }>;
}
