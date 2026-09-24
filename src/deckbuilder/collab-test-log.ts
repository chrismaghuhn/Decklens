/**
 * CollabTestLog — Test Protocol & Session Logging for collaborative deck editing.
 *
 * Track goldfish/playtest results: opening hand, mulligan decisions, key moments,
 * and overall win-turn stats. Persistent via D1.
 */

import { h } from '../shared/dom.js';
import { getCollabManager } from './collab-manager.js';
import { attachCardAutocomplete, cardNameWithPreview } from './card-autocomplete.js';

// ───── Types ─────

export interface TestSession {
  id: string;
  deck_id: string;
  player_id: string | null;
  player_name: string;
  opening_hand_json: string;
  mulligan_count: number;
  turn_count: number;
  result: string | null;
  notes: string | null;
  key_moments_json: string;
  created_at: string;
}

export interface KeyMoment {
  turn: number;
  action: string;
  note: string;
}

// ───── State ─────

let sessions: TestSession[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let deckId: string | null = null;
let initialized = false;

// ───── Public API ─────

export function initTestLog(currentDeckId: string): void {
  if (initialized) return;
  initialized = true;
  deckId = currentDeckId;
  loadSessions();
}

export function toggleTestLogPanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isTestLogPanelOpen(): boolean {
  return panelVisible;
}

export function refreshTestLog(): void {
  loadSessions();
}

/** Log a new test session result */
export async function logTestSession(
  openingHand: string[],
  mulliganCount: number,
  turnCount: number,
  result: string,
  notes: string,
  keyMoments: KeyMoment[],
): Promise<TestSession | null> {
  if (!deckId) return null;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/test-sessions`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ openingHand, mulliganCount, turnCount, result, notes, keyMoments }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { ok: boolean; data: { session: TestSession } };
    if (data.ok && data.data?.session) {
      sessions.unshift(data.data.session);
      if (panelVisible) renderPanel();

      // Notify collab
      const mgr = getCollabManager();
      if (mgr.isConnected) {
        mgr.sendTestSessionNotify(data.data.session.id);
      }
      return data.data.session;
    }
  } catch { /* ignore */ }
  return null;
}

/** Cleanup */
export function resetTestLog(): void {
  sessions = [];
  initialized = false;
  if (panelEl) panelEl.remove();
  panelEl = null;
  panelVisible = false;
}

// ───── API ─────

function getApiOrigin(): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}

async function loadSessions(): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/test-sessions`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { sessions: TestSession[] } };
    if (data.ok && data.data?.sessions) {
      sessions = data.data.sessions;
      if (panelVisible) renderPanel();
    }
  } catch { /* ignore */ }
}

async function deleteSession(sessionId: string): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/test-sessions/${sessionId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (resp.ok) {
      sessions = sessions.filter((s) => s.id !== sessionId);
      if (panelVisible) renderPanel();
    }
  } catch { /* ignore */ }
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; loadSessions(); return; }

  panelEl = h('div', { className: 'test-log-panel' },
    h('div', { className: 'test-log-header' },
 h('span', { className: 'test-log-title' }, '▤ Test Protocol'),
      h('div', { className: 'test-log-actions-header' },
        h('button', { className: 'test-log-add-btn', onClick: () => promptLogSession(), title: 'Log a test result manually' }, '+ Log Result'),
 h('button', { className: 'test-log-close', onClick: () => toggleTestLogPanel(), title: 'Close' }, '✕'),
      ),
    ),
    h('div', { className: 'test-log-body', id: '_testLogBody' }),
  );
  document.body.appendChild(panelEl);
  renderPanel();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderPanel(): void {
  const container = document.getElementById('_testLogBody');
  if (!container) return;

  if (sessions.length === 0) {
    container.replaceChildren(
      h('div', { className: 'test-log-empty' },
        h('p', {}, 'No test sessions logged yet.'),
        h('p', {}, 'Run goldfish playtests or log results manually to build your testing protocol.'),
      ),
    );
    return;
  }

  // Stats summary
  const avgTurn = sessions.reduce((sum, s) => sum + s.turn_count, 0) / sessions.length;
  const avgMulligan = sessions.reduce((sum, s) => sum + s.mulligan_count, 0) / sessions.length;
  const keepRate = sessions.filter((s) => s.mulligan_count === 0).length / sessions.length;

  const statsEl = h('div', { className: 'test-log-stats' },
    h('div', { className: 'test-log-stat' },
      h('div', { className: 'test-log-stat-value' }, avgTurn.toFixed(1)),
      h('div', { className: 'test-log-stat-label' }, 'Avg Win Turn'),
    ),
    h('div', { className: 'test-log-stat' },
      h('div', { className: 'test-log-stat-value' }, avgMulligan.toFixed(1)),
      h('div', { className: 'test-log-stat-label' }, 'Avg Mulligans'),
    ),
    h('div', { className: 'test-log-stat' },
      h('div', { className: 'test-log-stat-value' }, `${(keepRate * 100).toFixed(0)}%`),
      h('div', { className: 'test-log-stat-label' }, '7-Card Keep Rate'),
    ),
    h('div', { className: 'test-log-stat' },
      h('div', { className: 'test-log-stat-value' }, String(sessions.length)),
      h('div', { className: 'test-log-stat-label' }, 'Total Games'),
    ),
  );

  // Session list
  const sessionEls = sessions.map((session) => renderSessionCard(session));

  container.replaceChildren(statsEl, ...sessionEls);
}

function renderSessionCard(session: TestSession): HTMLElement {
  let openingHand: string[] = [];
  try { openingHand = JSON.parse(session.opening_hand_json); } catch { /* ignore */ }
  let keyMoments: KeyMoment[] = [];
  try { keyMoments = JSON.parse(session.key_moments_json); } catch { /* ignore */ }

  const date = new Date(session.created_at);
  const dateStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  return h('div', { className: 'test-log-card' },
    h('div', { className: 'test-log-card-header' },
      h('span', { className: 'test-log-card-player' }, session.player_name),
      h('span', { className: 'test-log-card-date' }, dateStr),
      h('button', {
        className: 'test-log-card-delete',
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          if (confirm('Delete this test session?')) deleteSession(session.id);
        },
        title: 'Delete',
 }, '✕'),
    ),

    // Result row
    h('div', { className: 'test-log-card-result' },
      h('span', { className: 'test-log-result-badge' }, session.result || 'No result'),
      h('span', {}, `Turn ${session.turn_count}`),
      h('span', {}, session.mulligan_count > 0 ? `Mulligan \u00D7${session.mulligan_count}` : 'Kept 7'),
    ),

    // Opening hand
    openingHand.length > 0
      ? h('div', { className: 'test-log-card-hand' },
          h('span', { className: 'test-log-hand-label' }, 'Opening Hand:'),
          ...openingHand.map((name) => cardNameWithPreview(name, 'test-log-hand-card')),
        )
      : '',

    // Key moments
    keyMoments.length > 0
      ? h('div', { className: 'test-log-card-moments' },
          ...keyMoments.map((km) =>
            h('div', { className: 'test-log-moment' },
              h('span', { className: 'test-log-moment-turn' }, `T${km.turn}`),
              h('span', {}, `${km.action}: ${km.note}`),
            ),
          ),
        )
      : '',

    // Notes
    session.notes
      ? h('div', { className: 'test-log-card-notes' }, session.notes)
      : '',
  );
}

// ───── Manual Log Modal ─────

function promptLogSession(): void {
  const overlay = h('div', { className: 'test-log-modal-overlay' },
    h('div', { className: 'test-log-modal' },
      h('h3', {}, 'Log Test Result'),

      h('label', {}, 'Result'),
      h('select', { className: 'test-log-select', id: '_testResult' },
        h('option', { value: 'win' }, 'Win'),
        h('option', { value: 'loss' }, 'Loss'),
        h('option', { value: 'stall' }, 'Stall/Draw'),
        h('option', { value: 'scoop' }, 'Scooped'),
      ),

      h('label', {}, 'Win Turn'),
      h('input', { type: 'number', className: 'test-log-input', id: '_testTurn', placeholder: 'e.g. 6', min: '1', max: '30' }),

      h('label', {}, 'Mulligan Count'),
      h('input', { type: 'number', className: 'test-log-input', id: '_testMulligan', placeholder: '0', min: '0', max: '6', value: '0' }),

      h('label', {}, 'Opening Hand (comma-separated, optional)'),
      h('input', { type: 'text', className: 'test-log-input', id: '_testHand', placeholder: 'Sol Ring, Command Tower, ...' }),

      h('label', {}, 'Notes (optional)'),
      h('textarea', { className: 'test-log-textarea', id: '_testNotes', placeholder: 'Key observations...', rows: '3' }),

      h('div', { className: 'test-log-modal-actions' },
        h('button', { className: 'test-log-modal-cancel', onClick: () => overlay.remove() }, 'Cancel'),
        h('button', { className: 'test-log-modal-confirm', onClick: async () => {
          const result = (document.getElementById('_testResult') as HTMLSelectElement)?.value || 'win';
          const turn = parseInt((document.getElementById('_testTurn') as HTMLInputElement)?.value || '0', 10);
          const mulligan = parseInt((document.getElementById('_testMulligan') as HTMLInputElement)?.value || '0', 10);
          const handStr = (document.getElementById('_testHand') as HTMLInputElement)?.value?.trim() || '';
          const hand = handStr ? handStr.split(',').map((s) => s.trim()).filter(Boolean) : [];
          const notes = (document.getElementById('_testNotes') as HTMLTextAreaElement)?.value?.trim() || '';
          if (turn <= 0) return;
          await logTestSession(hand, mulligan, turn, result, notes, []);
          overlay.remove();
        }}, 'Log'),
      ),
    ),
  );
  document.body.appendChild(overlay);

  // Attach autocomplete to opening hand input (comma-separated mode)
  const handInput = document.getElementById('_testHand') as HTMLInputElement;
  if (handInput) {
    attachCardAutocomplete({ input: handInput, commaSeparated: true });
  }

  setTimeout(() => (document.getElementById('_testTurn') as HTMLInputElement)?.focus(), 50);
}
