/**
 * Multiplayer Goldfish Types
 *
 * Shared type definitions for the multiplayer goldfish playtest system.
 * Extends the single-player goldfish to support 2-4 players with:
 * - Per-player game states (hand, battlefield, life, etc.)
 * - Turn rotation between players
 * - Multiplayer combat (attackers target specific players)
 * - Action authorization (only active player can act)
 */

// ───── Phase & Zone Types ─────

export type Phase = 'untap' | 'upkeep' | 'draw' | 'main1' | 'combat' | 'main2' | 'end';
export type GfZone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'commandZone';

export const PHASES: Phase[] = ['untap', 'upkeep', 'draw', 'main1', 'combat', 'main2', 'end'];

export const PHASE_LABELS: Record<Phase, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  main1: 'Main 1',
  combat: 'Combat',
  main2: 'Main 2',
  end: 'End',
};

// ───── Permanent ─────

export interface GoldfishPermanent {
  id: string;
  name: string;
  tapped: boolean;
  isLand: boolean;
  isCreature: boolean;
  isToken: boolean;
  typeLine: string;
  imgUrl: string;
  counters: Record<string, number>;
  power?: string;
  toughness?: string;
  x: number;   // % position 0-100 on battlefield
  y: number;   // % position 0-100 on battlefield
  /** Owner player ID (for multiplayer) */
  ownerId?: string;
  /** Summoning sickness: turn number when entered battlefield */
  enteredTurn?: number;

  // ── Combat & Rules Fields ──
  /** Marked damage this turn (resets in cleanup) */
  damage: number;
  /** Numeric power (base + counter adjustments) */
  currentPower: number;
  /** Numeric toughness (base + counter adjustments) */
  currentToughness: number;
  /** Oracle text for keyword detection fallback */
  oracleText: string;
  /** Scryfall keywords array (flying, first strike, trample, etc.) */
  keywords: string[];
  /** Whether this creature is currently attacking */
  attacking: boolean;
  /** Permanent ID of the attacker this creature is blocking (null if not blocking) */
  blockingId: string | null;

  // ── DFC / Morph Fields ──
  /** Whether this permanent is transformed (showing back face) */
  transformed?: boolean;
  /** Whether this permanent is face-down (morph/manifest) */
  faceDown?: boolean;
  /** Saved name for face-down cards */
  _savedName?: string;
  /** Saved image for face-down cards */
  _savedImg?: string;
  /** Saved power for face-down cards */
  _savedPower?: number;
  /** Saved toughness for face-down cards */
  _savedToughness?: number;
}

// ───── Token Detection ─────

export interface DetectedToken {
  name: string;
  power?: string;
  toughness?: string;
  colors: string;
  typeLine: string;
  abilities: string;
  imgUrl?: string;
}

// ───── Single-Player State (backward compatible) ─────

export interface GoldfishState {
  library: string[];
  hand: string[];
  battlefield: GoldfishPermanent[];
  graveyard: string[];
  exile: string[];
  commandZone: string[];
  commanderTax: number;
  poisonCounters: number;
  lifeTotal: number;
  turn: number;
  phase: Phase;
  landPlayedThisTurn: boolean;
  log: string[];
  undoStack: string[];
  nextPermanentId: number;
}

// ───── Multiplayer State ─────

export interface PlayerGameState {
  /** Unique player identifier */
  playerId: string;
  /** Display name */
  playerName: string;
  /** Player color (for UI theming) */
  playerColor: string;

  // Game zones
  library: string[];
  hand: string[];
  battlefield: GoldfishPermanent[];
  graveyard: string[];
  exile: string[];
  commandZone: string[];

  // Player stats
  lifeTotal: number;
  poisonCounters: number;
  commanderTax: number;

  // Turn state
  landPlayedThisTurn: boolean;

  // Undo (per-player)
  undoStack: string[];
  nextPermanentId: number;

  // Commander damage tracking (per opponent)
  commanderDamageReceived: Record<string, number>;

  // Status
  isEliminated: boolean;
  eliminatedReason?: 'life' | 'poison' | 'commander' | 'concede' | 'library';
}

export interface MultiplayerGoldfishState {
  /** Game mode */
  mode: 'single' | 'multiplayer';

  /** Global turn counter */
  turn: number;

  /** Current active player index in playerOrder */
  currentPlayerIndex: number;

  /** Player IDs in turn order */
  playerOrder: string[];

  /** Per-player game states */
  players: Map<string, PlayerGameState>;

  /** Current phase for active player */
  phase: Phase;

  /** Shared game log */
  sharedLog: string[];

  /** Combat state (active during combat phase) */
  combat: CombatState | null;

  /** Game timing */
  gameStartedAt: number;
  gameEndedAt?: number;

  /** Winner (if game ended) */
  winnerId?: string;
}

// ───── Combat ─────

export interface AttackerDeclaration {
  /** Permanent ID of attacking creature */
  permanentId: string;
  /** Player ID who owns the attacker */
  attackerPlayerId: string;
  /** Player ID being attacked */
  targetPlayerId: string;
}

export interface BlockerDeclaration {
  /** Permanent ID of blocking creature */
  permanentId: string;
  /** Player ID who owns the blocker */
  blockerPlayerId: string;
  /** Permanent ID of the creature being blocked */
  blockingPermanentId: string;
}

export interface CombatState {
  /** Phase of combat */
  phase: 'begin-combat' | 'declare-attackers' | 'declare-blockers' | 'first-strike-damage' | 'damage' | 'end-combat';
  /** Declared attackers */
  attackers: AttackerDeclaration[];
  /** Declared blockers */
  blockers: BlockerDeclaration[];
  /** Players who are being attacked (need to declare blockers) */
  defendingPlayerIds: string[];
  /** Index into defendingPlayerIds — which defender is currently declaring blockers */
  activeDefenderIndex: number;
  /** Whether any attacker/blocker has first strike or double strike */
  hasFirstStrike: boolean;
  /** Whether first-strike damage step has been resolved */
  firstStrikeDamageResolved: boolean;
}

// ───── Player Actions ─────

export type PlayerAction =
  | { type: 'draw'; playerId: string }
  | { type: 'play'; playerId: string; handIndex: number }
  | { type: 'tap'; playerId: string; permanentId: string }
  | { type: 'untap-all'; playerId: string }
  | { type: 'move-zone'; playerId: string; from: GfZone; to: GfZone; cardIndex: number }
  | { type: 'cast-commander'; playerId: string; cmdIndex: number }
  | { type: 'create-token'; playerId: string; token: DetectedToken; qty: number }
  | { type: 'adjust-counter'; playerId: string; permanentId: string; counterType: string; delta: number }
  | { type: 'adjust-life'; playerId: string; delta: number }
  | { type: 'adjust-poison'; playerId: string; delta: number }
  | { type: 'next-phase'; playerId: string }
  | { type: 'end-turn'; playerId: string }
  | { type: 'declare-attackers'; playerId: string; attackers: AttackerDeclaration[] }
  | { type: 'declare-blockers'; playerId: string; blockers: BlockerDeclaration[] }
  | { type: 'resolve-combat'; playerId: string }
  | { type: 'undo'; playerId: string }
  | { type: 'mulligan'; playerId: string }
  | { type: 'concede'; playerId: string }
  | { type: 'shuffle-library'; playerId: string };

// ───── Multiplayer Collab Message Types ─────

/** Outbound: Client → Server */
export type MPGoldfishOutbound =
  | { type: 'mp-goldfish-create'; playerCount: number; deckName: string }
  | { type: 'mp-goldfish-join'; deckName: string }
  | { type: 'mp-goldfish-action'; action: PlayerAction }
  | { type: 'mp-goldfish-state-request' }
  | { type: 'mp-goldfish-leave' };

/** Inbound: Server → Client */
export type MPGoldfishInbound =
  | { type: 'mp-goldfish-created'; gameId: string; hostPlayerId: string }
  | { type: 'mp-goldfish-player-joined'; playerId: string; playerName: string; playerColor: string }
  | { type: 'mp-goldfish-player-left'; playerId: string }
  | { type: 'mp-goldfish-action-broadcast'; by: string; action: PlayerAction }
  | { type: 'mp-goldfish-state-sync'; state: SerializedMPState }
  | { type: 'mp-goldfish-turn-change'; currentPlayerIndex: number; turn: number; activePlayerId: string }
  | { type: 'mp-goldfish-combat-update'; combat: CombatState }
  | { type: 'mp-goldfish-player-eliminated'; playerId: string; reason: string }
  | { type: 'mp-goldfish-game-over'; winnerId: string }
  | { type: 'mp-goldfish-error'; message: string };

/** Serialized state for network transmission (Maps → objects) */
export interface SerializedMPState {
  mode: 'multiplayer';
  turn: number;
  currentPlayerIndex: number;
  playerOrder: string[];
  players: Record<string, PlayerGameState>;
  phase: Phase;
  sharedLog: string[];
  combat: CombatState | null;
  gameStartedAt: number;
}

// ───── Drag Payload ─────

export interface GfDragPayload {
  zone: GfZone;
  index: number;
  cardName: string;
  /** Player ID who owns the card (multiplayer) */
  playerId?: string;
}

// ───── Context Menu ─────

export interface GfCtxItem {
  label: string;
  action: () => void;
  danger?: boolean;
  divider?: boolean;
}

// ───── Player Colors ─────

export const PLAYER_COLORS = [
  '#c9a84c',  // Gold (Player 1)
  '#34d399',  // Emerald (Player 2)
  '#60a5fa',  // Blue (Player 3)
  '#f472b6',  // Pink (Player 4)
] as const;

export const PLAYER_LABELS = ['Player 1', 'Player 2', 'Player 3', 'Player 4'] as const;

// ───── Helpers ─────

/** Create initial player game state */
export function createPlayerGameState(
  playerId: string,
  playerName: string,
  playerColor: string,
  library: string[],
  commandZone: string[],
): PlayerGameState {
  return {
    playerId,
    playerName,
    playerColor,
    library,
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    commandZone,
    lifeTotal: 40,
    poisonCounters: 0,
    commanderTax: 0,
    landPlayedThisTurn: false,
    undoStack: [],
    nextPermanentId: 0,
    commanderDamageReceived: {},
    isEliminated: false,
  };
}

/** Create initial multiplayer state */
export function createMultiplayerState(
  playerOrder: string[],
  players: Map<string, PlayerGameState>,
): MultiplayerGoldfishState {
  return {
    mode: 'multiplayer',
    turn: 1,
    currentPlayerIndex: 0,
    playerOrder,
    players,
    phase: 'main1',
    sharedLog: [],
    combat: null,
    gameStartedAt: Date.now(),
  };
}

/** Get active player from multiplayer state */
export function getActivePlayer(state: MultiplayerGoldfishState): PlayerGameState | undefined {
  const activeId = state.playerOrder[state.currentPlayerIndex];
  return state.players.get(activeId);
}

/** Get active player ID */
export function getActivePlayerId(state: MultiplayerGoldfishState): string {
  return state.playerOrder[state.currentPlayerIndex];
}

/** Check if a player can perform actions (it's their turn) */
export function canPlayerAct(state: MultiplayerGoldfishState, playerId: string): boolean {
  const activeId = getActivePlayerId(state);
  return activeId === playerId;
}

/** Get all non-eliminated players */
export function getAlivePlayers(state: MultiplayerGoldfishState): PlayerGameState[] {
  return state.playerOrder
    .map(id => state.players.get(id)!)
    .filter(p => p && !p.isEliminated);
}

/** Check if game should end (only 1 player left) */
export function shouldGameEnd(state: MultiplayerGoldfishState): boolean {
  const alive = getAlivePlayers(state);
  return alive.length <= 1;
}

/** Serialize multiplayer state for network transmission */
export function serializeMPState(state: MultiplayerGoldfishState): SerializedMPState {
  const players: Record<string, PlayerGameState> = {};
  for (const [id, p] of state.players) {
    players[id] = p;
  }
  return {
    mode: 'multiplayer',
    turn: state.turn,
    currentPlayerIndex: state.currentPlayerIndex,
    playerOrder: state.playerOrder,
    players,
    phase: state.phase,
    sharedLog: state.sharedLog,
    combat: state.combat,
    gameStartedAt: state.gameStartedAt,
  };
}

/** Deserialize multiplayer state from network */
export function deserializeMPState(data: SerializedMPState): MultiplayerGoldfishState {
  const players = new Map<string, PlayerGameState>();
  for (const [id, p] of Object.entries(data.players)) {
    // Backward-compat: ensure new permanent fields have defaults
    for (const perm of p.battlefield) {
      perm.damage ??= 0;
      perm.currentPower ??= parseInt(perm.power || '0') || 0;
      perm.currentToughness ??= parseInt(perm.toughness || '0') || 0;
      perm.oracleText ??= '';
      perm.keywords ??= [];
      perm.attacking ??= false;
      perm.blockingId ??= null;
    }
    players.set(id, p);
  }

  // Backward-compat: ensure CombatState has new fields
  if (data.combat) {
    (data.combat as CombatState).activeDefenderIndex ??= 0;
    (data.combat as CombatState).hasFirstStrike ??= false;
    (data.combat as CombatState).firstStrikeDamageResolved ??= false;
  }

  return {
    mode: 'multiplayer',
    turn: data.turn,
    currentPlayerIndex: data.currentPlayerIndex,
    playerOrder: data.playerOrder,
    players,
    phase: data.phase,
    sharedLog: data.sharedLog,
    combat: data.combat,
    gameStartedAt: data.gameStartedAt,
  };
}
