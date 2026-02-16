/**
 * CollabPresence — Live presence indicators for collaborative deck editing.
 *
 * Shows which board/card each participant is currently viewing.
 * Renders a presence bar with colored dots and labels.
 * Data is ephemeral — only lives in the Durable Object session.
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';

// ───── Types ─────

export interface PresenceEntry {
  board: string;
  cardName?: string;
  name: string;
  color: string;
}

export type PresenceMap = Record<string, PresenceEntry>;

// ───── State ─────

let presenceMap: PresenceMap = {};
let presenceBarEl: HTMLElement | null = null;
let initialized = false;
/** Throttle presence updates to max 1 per second */
let lastPresenceSend = 0;
const PRESENCE_THROTTLE_MS = 1000;

// ───── Public API ─────

/** Initialize presence tracking — wire up CollabManager events */
export function initPresence(): void {
  if (initialized) return;
  initialized = true;

  const mgr = getCollabManager();
  mgr.on('presence-sync', onPresenceSync);
  mgr.on('disconnected', onDisconnected);
}

/** Get the current presence map (for other modules) */
export function getPresenceMap(): PresenceMap {
  return { ...presenceMap };
}

/** Send a presence update (throttled) */
export function sendPresenceUpdate(board: string, cardName?: string): void {
  const now = Date.now();
  if (now - lastPresenceSend < PRESENCE_THROTTLE_MS) return;
  lastPresenceSend = now;
  const mgr = getCollabManager();
  if (mgr.isConnected) {
    mgr.sendPresenceUpdate(board, cardName);
  }
}

/** Render or update the presence bar element */
export function renderPresenceBar(): HTMLElement {
  if (!presenceBarEl) {
    presenceBarEl = h('div', { className: 'presence-bar' });
  }
  updatePresenceBar();
  return presenceBarEl;
}

/** Get participants currently viewing a specific board */
export function getParticipantsOnBoard(board: string): PresenceEntry[] {
  return Object.values(presenceMap).filter((p) => p.board === board);
}

/** Get participants currently viewing a specific card */
export function getParticipantsOnCard(board: string, cardName: string): PresenceEntry[] {
  return Object.values(presenceMap).filter((p) => p.board === board && p.cardName === cardName);
}

/** Clean up on session end */
export function resetPresence(): void {
  presenceMap = {};
  if (presenceBarEl) presenceBarEl.replaceChildren();
}

// ───── Event Handlers ─────

function onPresenceSync(event: CollabEvent): void {
  const data = event.data as { presenceMap: PresenceMap };
  if (data?.presenceMap) {
    presenceMap = data.presenceMap;
    updatePresenceBar();
  }
}

function onDisconnected(): void {
  resetPresence();
}

// ───── Rendering ─────

function updatePresenceBar(): void {
  if (!presenceBarEl) return;

  const entries = Object.entries(presenceMap);
  if (entries.length === 0) {
    presenceBarEl.replaceChildren();
    presenceBarEl.style.display = 'none';
    return;
  }

  presenceBarEl.style.display = 'flex';

  const badges = entries.map(([_id, entry]) => {
    const label = entry.cardName
      ? `${entry.name}: editing ${entry.cardName}`
      : `${entry.name}: ${formatBoardName(entry.board)}`;

    return h('span', {
      className: 'presence-badge',
      title: label,
    },
      h('span', {
        className: 'presence-dot',
        style: `background: ${entry.color};`,
      }),
      h('span', { className: 'presence-label' },
        entry.cardName
          ? `${entry.name}: ${truncate(entry.cardName, 18)}`
          : `${entry.name}: ${formatBoardName(entry.board)}`,
      ),
    );
  });

  presenceBarEl.replaceChildren(...badges);
}

// ───── Utilities ─────

function formatBoardName(board: string): string {
  const names: Record<string, string> = {
    commander: 'Commander',
    mainboard: 'Mainboard',
    sideboard: 'Sideboard',
    maybeboard: 'Maybeboard',
  };
  return names[board] || board;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + '\u2026' : str;
}
