/**
 * CollabGoldfishMP — Online Multiplayer Goldfish via WebSocket
 *
 * Extends the local hotseat goldfish-mp.ts to support real-time
 * multiplayer over the existing CollabManager infrastructure.
 *
 * Flow:
 * 1. Host creates a multiplayer game → broadcasts 'mp-goldfish-create'
 * 2. Other players join → 'mp-goldfish-join'
 * 3. Actions are broadcast in real-time → 'mp-goldfish-action'
 * 4. Turn changes are broadcast → 'mp-goldfish-turn-change'
 * 5. Combat is broadcast → 'mp-goldfish-combat'
 * 6. Full state sync on join → 'mp-goldfish-state-sync'
 */

import { getCollabManager, type CollabEvent } from './collab-manager.js';
import {
  type MultiplayerGoldfishState, type PlayerGameState, type Phase,
  type CombatState, type AttackerDeclaration,
  PLAYER_COLORS, PLAYER_LABELS,
  createPlayerGameState, createMultiplayerState,
  getActivePlayer, getActivePlayerId, canPlayerAct,
  getAlivePlayers, shouldGameEnd,
  serializeMPState, deserializeMPState,
} from './goldfish-types.js';

// ───── State ─────

let initialized = false;
let isHost = false;
let localPlayerId: string | null = null;
let onlineGameActive = false;

/** Callbacks for the MP engine to react to remote actions */
interface MPCollabCallbacks {
  onRemoteAction: (playerId: string, action: string, details: string, turn: number) => void;
  onRemoteTurnChange: (currentPlayerIndex: number, turn: number, activePlayerId: string) => void;
  onRemoteCombat: (attackerPlayerId: string, attackers: Array<{ permanentId: string; targetPlayerId: string }>) => void;
  onRemoteBlockers: (defenderPlayerId: string, blockers: Array<{ permanentId: string; blockingPermanentId: string }>) => void;
  onRemoteStateSync: (stateJson: string) => void;
  onPlayerJoined: (playerId: string, playerName: string, playerColor: string) => void;
  onPlayerLeft: (playerId: string) => void;
  onGameCreated: (gameId: string, hostPlayerId: string) => void;
}

let callbacks: MPCollabCallbacks | null = null;

// ───── Initialization ─────

export function initMPCollab(cb: MPCollabCallbacks): void {
  if (initialized) return;
  initialized = true;
  callbacks = cb;

  const mgr = getCollabManager();
  mgr.on('mp-goldfish-created', onGameCreated);
  mgr.on('mp-goldfish-player-joined', onPlayerJoined);
  mgr.on('mp-goldfish-player-left', onPlayerLeft);
  mgr.on('mp-goldfish-action-broadcast', onActionBroadcast);
  mgr.on('mp-goldfish-turn-change-broadcast', onTurnChangeBroadcast);
  mgr.on('mp-goldfish-combat-broadcast', onCombatBroadcast);
  mgr.on('mp-goldfish-blockers-broadcast', onBlockersBroadcast);
  mgr.on('mp-goldfish-state-sync-broadcast', onStateSyncBroadcast);
}

export function cleanupMPCollab(): void {
  initialized = false;
  callbacks = null;
  isHost = false;
  localPlayerId = null;
  onlineGameActive = false;
}

// ───── Public API: Host ─────

/** Host creates a new multiplayer game */
export function hostMPGame(playerCount: number, deckName: string, myPlayerId: string): void {
  const mgr = getCollabManager();
  if (!mgr.isConnected) {
    console.warn('[MP Collab] Not connected to collab session');
    return;
  }

  isHost = true;
  localPlayerId = myPlayerId;
  onlineGameActive = true;

  mgr.sendMPGoldfishCreate(playerCount, deckName);
}

/** Player joins an existing game */
export function joinMPGame(deckName: string, myPlayerId: string): void {
  const mgr = getCollabManager();
  if (!mgr.isConnected) {
    console.warn('[MP Collab] Not connected to collab session');
    return;
  }

  isHost = false;
  localPlayerId = myPlayerId;
  onlineGameActive = true;

  mgr.sendMPGoldfishJoin(deckName);
}

// ───── Public API: Broadcast Actions ─────

/** Broadcast a player action to all other players */
export function broadcastMPAction(action: string, playerId: string, details: string, turn: number): void {
  const mgr = getCollabManager();
  if (!mgr.isConnected || !onlineGameActive) return;
  mgr.sendMPGoldfishAction(action, playerId, details, turn);
}

/** Broadcast a turn change */
export function broadcastMPTurnChange(currentPlayerIndex: number, turn: number, activePlayerId: string): void {
  const mgr = getCollabManager();
  if (!mgr.isConnected || !onlineGameActive) return;
  mgr.sendMPGoldfishTurnChange(currentPlayerIndex, turn, activePlayerId);
}

/** Broadcast combat state */
export function broadcastMPCombat(attackerPlayerId: string, attackers: Array<{ permanentId: string; targetPlayerId: string }>): void {
  const mgr = getCollabManager();
  if (!mgr.isConnected || !onlineGameActive) return;
  mgr.sendMPGoldfishCombat(attackerPlayerId, attackers);
}

/** Broadcast blocker declarations */
export function broadcastMPBlockers(defenderPlayerId: string, blockers: Array<{ permanentId: string; blockingPermanentId: string }>): void {
  const mgr = getCollabManager();
  if (!mgr.isConnected || !onlineGameActive) return;
  mgr.sendMPGoldfishBlockers(defenderPlayerId, blockers);
}

/** Sync full state (for late joiners or resync) */
export function broadcastMPStateSync(state: MultiplayerGoldfishState): void {
  const mgr = getCollabManager();
  if (!mgr.isConnected || !onlineGameActive) return;

  const serialized = serializeMPState(state);
  // Strip hand data for privacy (each player's hand should only be visible to them)
  const sanitized = { ...serialized };
  const sanitizedPlayers: Record<string, PlayerGameState> = {};
  for (const [id, player] of Object.entries(serialized.players)) {
    sanitizedPlayers[id] = {
      ...player,
      hand: id === localPlayerId ? player.hand : [], // Only include own hand
    };
  }
  sanitized.players = sanitizedPlayers;

  mgr.sendMPGoldfishStateSync(JSON.stringify(sanitized));
}

/** Leave the game */
export function leaveMPGame(): void {
  const mgr = getCollabManager();
  if (mgr.isConnected && onlineGameActive) {
    mgr.sendMPGoldfishLeave();
  }
  onlineGameActive = false;
}

// ───── Status ─────

export function isMPOnline(): boolean {
  return onlineGameActive && getCollabManager().isConnected;
}

export function isMPHost(): boolean {
  return isHost;
}

export function getLocalPlayerId(): string | null {
  return localPlayerId;
}

// ───── Event Handlers (Inbound) ─────

function onGameCreated(event: CollabEvent): void {
  const data = event.data as { gameId: string; hostPlayerId: string; by: string };
  console.log(`[MP Collab] Game created: ${data.gameId} by ${data.by}`);
  callbacks?.onGameCreated(data.gameId, data.hostPlayerId);
}

function onPlayerJoined(event: CollabEvent): void {
  const data = event.data as { playerId: string; playerName: string; playerColor: string; by: string };
  console.log(`[MP Collab] Player joined: ${data.playerName} (${data.playerId})`);
  callbacks?.onPlayerJoined(data.playerId, data.playerName, data.playerColor);
}

function onPlayerLeft(event: CollabEvent): void {
  const data = event.data as { playerId: string; by: string };
  console.log(`[MP Collab] Player left: ${data.playerId}`);
  callbacks?.onPlayerLeft(data.playerId);
}

function onActionBroadcast(event: CollabEvent): void {
  const data = event.data as { by: string; playerId: string; action: string; details: string; turn: number };
  callbacks?.onRemoteAction(data.playerId, data.action, data.details, data.turn);
}

function onTurnChangeBroadcast(event: CollabEvent): void {
  const data = event.data as { currentPlayerIndex: number; turn: number; activePlayerId: string; by: string };
  callbacks?.onRemoteTurnChange(data.currentPlayerIndex, data.turn, data.activePlayerId);
}

function onCombatBroadcast(event: CollabEvent): void {
  const data = event.data as { attackerPlayerId: string; attackers: Array<{ permanentId: string; targetPlayerId: string }>; by: string };
  callbacks?.onRemoteCombat(data.attackerPlayerId, data.attackers);
}

function onBlockersBroadcast(event: CollabEvent): void {
  const data = event.data as { defenderPlayerId: string; blockers: Array<{ permanentId: string; blockingPermanentId: string }>; by: string };
  callbacks?.onRemoteBlockers(data.defenderPlayerId, data.blockers);
}

function onStateSyncBroadcast(event: CollabEvent): void {
  const data = event.data as { stateJson: string; by: string };
  callbacks?.onRemoteStateSync(data.stateJson);
}
