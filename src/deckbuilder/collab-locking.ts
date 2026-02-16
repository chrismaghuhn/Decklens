/**
 * CollabLocking — Card/Board slot locking for collaborative deck editing.
 *
 * Prevents edit conflicts by allowing participants to lock cards/boards.
 * Locks are ephemeral (live only in the Durable Object session).
 * Auto-expire after 5 minutes (server-side) to prevent stale locks.
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';

// ───── Types ─────

export interface SlotLock {
  id: string;
  board: string;
  cardName?: string;
  lockedBy: string;
  lockedByName: string;
  lockedAt: number;
  expiresAt: number;
}

export interface LockCheckResult {
  locked: boolean;
  by?: string;
  lockId?: string;
  expiresAt?: number;
}

// ───── State ─────

let currentLocks: SlotLock[] = [];
let initialized = false;
/** Callbacks for lock result notifications */
let onLockResultCallback: ((success: boolean, reason?: string) => void) | null = null;
/** Callback for when locks change (for re-rendering) */
let onLocksChangedCallback: (() => void) | null = null;
/** D2: Callback when someone requests a lock we hold */
let onLockRequestReceivedCallback: ((board: string, cardName: string, requestedByName: string) => void) | null = null;
/** D2: Rate-limit lock requests: 1 per card per 30s */
const lockRequestCooldowns = new Map<string, number>();

// ───── Public API ─────

/** Initialize locking — wire up CollabManager events */
export function initLocking(): void {
  if (initialized) return;
  initialized = true;

  const mgr = getCollabManager();
  mgr.on('lock-result', onLockResult);
  mgr.on('locks-sync', onLocksSync);
  mgr.on('disconnected', onDisconnected);
  mgr.on('lock-request-received', onLockRequestReceived); // D2
}

/** Check if a specific card is locked by someone else */
export function isCardLocked(board: string, cardName: string): LockCheckResult {
  const lockKey = `${board}:${cardName}`;
  const lock = currentLocks.find((l) => {
    const key = `${l.board}:${l.cardName || '__board__'}`;
    return key === lockKey;
  });

  if (!lock) return { locked: false };

  // Check if it's expired client-side (server will clean up on next operation)
  if (lock.expiresAt < Date.now()) return { locked: false };

  return {
    locked: true,
    by: lock.lockedByName,
    lockId: lock.id,
    expiresAt: lock.expiresAt,
  };
}

/** Check if an entire board is locked by someone else */
export function isBoardLocked(board: string): LockCheckResult {
  const lockKey = `${board}:__board__`;
  const lock = currentLocks.find((l) => {
    const key = `${l.board}:${l.cardName || '__board__'}`;
    return key === lockKey;
  });

  if (!lock) return { locked: false };
  if (lock.expiresAt < Date.now()) return { locked: false };

  return {
    locked: true,
    by: lock.lockedByName,
    lockId: lock.id,
    expiresAt: lock.expiresAt,
  };
}

/** Acquire a lock on a card or board */
export function acquireLock(board: string, cardName?: string, durationMs?: number): void {
  const mgr = getCollabManager();
  if (mgr.isConnected) {
    mgr.sendLockAcquire(board, cardName, durationMs);
  }
}

/** Release a lock by ID */
export function releaseLock(lockId: string): void {
  const mgr = getCollabManager();
  if (mgr.isConnected) {
    mgr.sendLockRelease(lockId);
  }
}

/** Get all current locks */
export function getCurrentLocks(): SlotLock[] {
  return [...currentLocks];
}

/** Get locks for a specific board */
export function getLocksForBoard(board: string): SlotLock[] {
  return currentLocks.filter((l) => l.board === board && l.expiresAt > Date.now());
}

/** Register a callback for lock result notifications */
export function setOnLockResult(cb: (success: boolean, reason?: string) => void): void {
  onLockResultCallback = cb;
}

/** Register a callback for when locks change (used for re-rendering) */
export function setOnLocksChanged(cb: () => void): void {
  onLocksChangedCallback = cb;
}

/** D2: Register a callback for when someone requests a lock we hold */
export function setOnLockRequestReceived(cb: (board: string, cardName: string, requestedByName: string) => void): void {
  onLockRequestReceivedCallback = cb;
}

/**
 * D2: Send a lock request to the holder.
 * Rate-limited to 1 request per card per 30 seconds.
 */
export function requestLockFromHolder(board: string, cardName: string): boolean {
  const key = `${board}:${cardName}`;
  const now = Date.now();
  const lastRequest = lockRequestCooldowns.get(key);
  if (lastRequest && (now - lastRequest) < 30_000) {
    return false; // On cooldown
  }
  lockRequestCooldowns.set(key, now);
  const mgr = getCollabManager();
  if (mgr.isConnected) {
    mgr.sendLockRequest(board, cardName);
    return true;
  }
  return false;
}

/** Render a lock indicator for a card (returns empty string if not locked) */
export function renderLockIndicator(board: string, cardName: string): HTMLElement | string {
  const lockInfo = isCardLocked(board, cardName);
  if (!lockInfo.locked) return '';

  const remaining = Math.max(0, Math.ceil(((lockInfo.expiresAt || 0) - Date.now()) / 60000));
  return h('span', {
    className: 'lock-indicator',
    title: `Locked by ${lockInfo.by} (${remaining}m remaining)`,
  }, '\uD83D\uDD12');
}

/** Clean up on session end */
export function resetLocking(): void {
  currentLocks = [];
}

// ───── Event Handlers ─────

function onLockResult(event: CollabEvent): void {
  const data = event.data as { success: boolean; lock?: SlotLock; reason?: string };
  if (onLockResultCallback) {
    onLockResultCallback(data.success, data.reason);
  }
}

function onLocksSync(event: CollabEvent): void {
  const data = event.data as { locks: SlotLock[] };
  if (data?.locks) {
    currentLocks = data.locks;
    if (onLocksChangedCallback) {
      onLocksChangedCallback();
    }
  }
}

function onLockRequestReceived(event: CollabEvent): void {
  const data = event.data as { board: string; cardName: string; requestedBy: string; requestedByName: string };
  if (onLockRequestReceivedCallback && data) {
    onLockRequestReceivedCallback(data.board, data.cardName, data.requestedByName);
  }
}

function onDisconnected(): void {
  resetLocking();
}
