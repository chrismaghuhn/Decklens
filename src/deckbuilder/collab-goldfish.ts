/**
 * CollabGoldfish — Goldfish Spectator Mode for collaborative deck editing.
 *
 * When a team member starts a goldfish playtest, others can watch live:
 * - See game actions in real-time (draw, play, tap, etc.)
 * - Post comments tied to specific turns
 * - View final test results and key moments
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';

// ───── Types ─────

export interface GoldfishAction {
  by: string;
  action: string;
  details: string;
  turn: number;
  timestamp: number;
}

export interface GoldfishComment {
  by: string;
  text: string;
  turn: number;
  timestamp: number;
}

// ───── State ─────

let spectatorPanelEl: HTMLElement | null = null;
let spectatorVisible = false;
let initialized = false;
let currentPlayer: string | null = null;
let currentDeckName: string | null = null;
let actions: GoldfishAction[] = [];
let comments: GoldfishComment[] = [];
let currentTurn = 0;
let isLive = false;

// ───── Public API ─────

export function initGoldfish(): void {
  if (initialized) return;
  initialized = true;

  const mgr = getCollabManager();
  mgr.on('goldfish-started', onGoldfishStarted);
  mgr.on('goldfish-action-broadcast', onGoldfishAction);
  mgr.on('goldfish-ended', onGoldfishEnded);
  mgr.on('goldfish-comment-broadcast', onGoldfishComment);
}

export function toggleSpectatorPanel(): void {
  spectatorVisible = !spectatorVisible;
  if (spectatorVisible) showPanel();
  else hidePanel();
}

export function isSpectatorPanelOpen(): boolean {
  return spectatorVisible;
}

export function isGoldfishLive(): boolean {
  return isLive;
}

/** Call from goldfish.ts when playtest starts (local player broadcasting) */
export function broadcastGoldfishStart(deckName: string): void {
  const mgr = getCollabManager();
  if (mgr.isConnected) {
    mgr.sendGoldfishStart(deckName);
  }
}

/** Call from goldfish.ts on each action */
export function broadcastGoldfishAction(action: string, details: string, turn: number): void {
  const mgr = getCollabManager();
  if (mgr.isConnected) {
    mgr.sendGoldfishAction(action, details, turn);
  }
}

/** Call from goldfish.ts when playtest ends */
export function broadcastGoldfishEnd(result: string, turnCount: number): void {
  const mgr = getCollabManager();
  if (mgr.isConnected) {
    mgr.sendGoldfishEnd(result, turnCount);
  }
  isLive = false;
}

/** Cleanup */
export function resetGoldfish(): void {
  initialized = false;
  if (spectatorPanelEl) spectatorPanelEl.remove();
  spectatorPanelEl = null;
  spectatorVisible = false;
  currentPlayer = null;
  currentDeckName = null;
  actions = [];
  comments = [];
  currentTurn = 0;
  isLive = false;
}

// ───── Event Handlers ─────

function onGoldfishStarted(event: CollabEvent): void {
  const data = event.data as { by: string; deckName: string };
  currentPlayer = data.by;
  currentDeckName = data.deckName;
  actions = [];
  comments = [];
  currentTurn = 1;
  isLive = true;

  // Auto-open spectator panel
  if (!spectatorVisible) {
    spectatorVisible = true;
    showPanel();
  } else {
    renderPanel();
  }
}

function onGoldfishAction(event: CollabEvent): void {
  const data = event.data as { by: string; action: string; details: string; turn: number };
  actions.push({
    by: data.by,
    action: data.action,
    details: data.details,
    turn: data.turn,
    timestamp: Date.now(),
  });
  currentTurn = Math.max(currentTurn, data.turn);
  if (spectatorVisible) renderPanel();
}

function onGoldfishEnded(event: CollabEvent): void {
  const data = event.data as { by: string; result: string; turnCount: number };
  isLive = false;
  currentTurn = data.turnCount;

  // Add a final "ended" entry
  actions.push({
    by: data.by,
    action: 'end',
    details: `Game ended: ${data.result} (Turn ${data.turnCount})`,
    turn: data.turnCount,
    timestamp: Date.now(),
  });
  if (spectatorVisible) renderPanel();
}

function onGoldfishComment(event: CollabEvent): void {
  const data = event.data as { by: string; text: string; turn: number };
  comments.push({
    by: data.by,
    text: data.text,
    turn: data.turn,
    timestamp: Date.now(),
  });
  if (spectatorVisible) renderPanel();
}

// ───── Panel UI ─────

function showPanel(): void {
  if (spectatorPanelEl) { spectatorPanelEl.style.display = 'flex'; renderPanel(); return; }

  spectatorPanelEl = h('div', { className: 'goldfish-spectator-panel' },
    h('div', { className: 'goldfish-spectator-header' },
      h('span', { className: 'goldfish-spectator-title' }, '\uD83C\uDFAE Goldfish Spectator'),
      h('button', { className: 'goldfish-spectator-close', onClick: () => toggleSpectatorPanel(), title: 'Close' }, '\u2715'),
    ),
    h('div', { className: 'goldfish-spectator-body', id: '_goldfishBody' }),
  );
  document.body.appendChild(spectatorPanelEl);
  renderPanel();
}

function hidePanel(): void {
  if (spectatorPanelEl) spectatorPanelEl.style.display = 'none';
}

function renderPanel(): void {
  const container = document.getElementById('_goldfishBody');
  if (!container) return;

  if (!isLive && actions.length === 0) {
    container.replaceChildren(
      h('div', { className: 'goldfish-spectator-empty' },
        h('p', {}, 'No active goldfish session.'),
        h('p', {}, 'When a team member starts a goldfish playtest, you\u2019ll see their actions here in real-time.'),
      ),
    );
    return;
  }

  const els: (HTMLElement | string)[] = [];

  // Status bar
  const statusClass = isLive ? 'goldfish-status-live' : 'goldfish-status-ended';
  const statusText = isLive
    ? `\uD83D\uDD34 LIVE — ${currentPlayer} is playtesting "${currentDeckName}" — Turn ${currentTurn}`
    : `\u2705 Ended — ${currentPlayer}'s playtest of "${currentDeckName}"`;
  els.push(h('div', { className: `goldfish-status ${statusClass}` }, statusText));

  // Action log
  const logEl = h('div', { className: 'goldfish-action-log', id: '_goldfishLog' });
  const merged = mergeActionsAndComments();
  for (const entry of merged) {
    if (entry.type === 'action') {
      const a = entry.data as GoldfishAction;
      const isEnd = a.action === 'end';
      logEl.appendChild(
        h('div', { className: `goldfish-log-entry${isEnd ? ' goldfish-log-end' : ''}` },
          h('span', { className: 'goldfish-log-turn' }, `T${a.turn}`),
          h('span', { className: 'goldfish-log-action' }, a.details),
        ),
      );
    } else {
      const c = entry.data as GoldfishComment;
      logEl.appendChild(
        h('div', { className: 'goldfish-log-entry goldfish-log-comment' },
          h('span', { className: 'goldfish-log-turn' }, `T${c.turn}`),
          h('span', { className: 'goldfish-log-commenter' }, `${c.by}:`),
          h('span', { className: 'goldfish-log-text' }, c.text),
        ),
      );
    }
  }
  els.push(logEl);

  // Comment input (only when live)
  if (isLive) {
    const inputRow = h('div', { className: 'goldfish-comment-input' },
      h('input', {
        type: 'text',
        className: 'goldfish-comment-field',
        id: '_goldfishCommentInput',
        placeholder: 'Comment on this play...',
        maxLength: '500',
      }),
      h('button', {
        className: 'goldfish-comment-send',
        onClick: () => sendComment(),
      }, 'Send'),
    );
    els.push(inputRow);
  }

  // Stats summary (when ended)
  if (!isLive && actions.length > 0) {
    const totalActions = actions.filter((a) => a.action !== 'end').length;
    const totalComments = comments.length;
    els.push(
      h('div', { className: 'goldfish-summary' },
        h('span', {}, `${currentTurn} turns`),
        h('span', {}, `${totalActions} actions`),
        h('span', {}, `${totalComments} comments`),
      ),
    );
  }

  container.replaceChildren(...els);

  // Auto-scroll log
  requestAnimationFrame(() => {
    const log = document.getElementById('_goldfishLog');
    if (log) log.scrollTop = log.scrollHeight;
  });

  // Enter to send
  const input = document.getElementById('_goldfishCommentInput') as HTMLInputElement | null;
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); sendComment(); }
    });
  }
}

function mergeActionsAndComments(): Array<{ type: 'action' | 'comment'; data: GoldfishAction | GoldfishComment; timestamp: number }> {
  const merged: Array<{ type: 'action' | 'comment'; data: GoldfishAction | GoldfishComment; timestamp: number }> = [];
  for (const a of actions) merged.push({ type: 'action', data: a, timestamp: a.timestamp });
  for (const c of comments) merged.push({ type: 'comment', data: c, timestamp: c.timestamp });
  merged.sort((a, b) => a.timestamp - b.timestamp);
  return merged;
}

function sendComment(): void {
  const input = document.getElementById('_goldfishCommentInput') as HTMLInputElement | null;
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  const mgr = getCollabManager();
  if (mgr.isConnected) {
    mgr.sendGoldfishComment(text, currentTurn);
  }
}
