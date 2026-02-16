/**
 * CollabDecisions — Decision Log for collaborative deck editing.
 *
 * Track and display the rationale behind deck-building decisions.
 * "Why is Sol Ring in?" — persistent, searchable, attributed.
 */

import { h } from '../shared/dom.js';
import { attachCardAutocomplete, cardNameWithPreview } from './card-autocomplete.js';

// ───── Types ─────

export interface DecisionEntry {
  id: string;
  deck_id: string;
  card_name: string | null;
  participant_name: string;
  decision_type: string;
  rationale: string;
  created_at: string;
}

// ───── State ─────

let decisions: DecisionEntry[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let deckId: string | null = null;

// ───── Public API ─────

export function initDecisions(currentDeckId: string): void {
  deckId = currentDeckId;
  loadDecisions();
}

export function toggleDecisionPanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isDecisionPanelOpen(): boolean {
  return panelVisible;
}

export function refreshDecisions(): void {
  loadDecisions();
}

/** Open the decision panel and pre-fill for a specific card */
export function openDecisionForCard(cardName: string): void {
  panelVisible = true;
  showPanel();
  setTimeout(() => promptAddDecision(cardName), 100);
}

// ───── API ─────

function getApiOrigin(): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}

async function loadDecisions(): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/decisions`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { decisions: DecisionEntry[] } };
    if (data.ok && data.data?.decisions) {
      decisions = data.data.decisions;
      if (panelVisible) renderList();
    }
  } catch { /* ignore */ }
}

export async function addDecision(cardName: string | null, decisionType: string, rationale: string): Promise<DecisionEntry | null> {
  if (!deckId) return null;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/decisions`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cardName, decisionType, rationale }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { ok: boolean; data: { decision: DecisionEntry } };
    if (data.ok && data.data?.decision) {
      decisions.unshift(data.data.decision);
      if (panelVisible) renderList();
      return data.data.decision;
    }
  } catch { /* ignore */ }
  return null;
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; loadDecisions(); return; }

  panelEl = h('div', { className: 'decision-panel' },
    h('div', { className: 'decision-panel-header' },
      h('span', { className: 'decision-panel-title' }, '\uD83D\uDCD6 Decision Log'),
      h('div', { className: 'decision-panel-actions-header' },
        h('button', { className: 'decision-add-btn', onClick: () => promptAddDecision(), title: 'Add decision' }, '+ Add'),
        h('button', { className: 'decision-panel-close', onClick: () => toggleDecisionPanel(), title: 'Close' }, '\u2715'),
      ),
    ),
    h('div', { className: 'decision-list', id: '_decisionList' }),
  );
  document.body.appendChild(panelEl);
  renderList();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderList(): void {
  const container = document.getElementById('_decisionList');
  if (!container) return;

  if (decisions.length === 0) {
    container.replaceChildren(h('div', { className: 'decision-empty' }, 'No decisions logged yet. Document why cards are in or out!'));
    return;
  }

  const items = decisions.map((dec) => {
    const typeInfo = getTypeInfo(dec.decision_type);

    return h('div', { className: 'decision-entry' },
      h('div', { className: 'decision-entry-header' },
        h('span', { className: `decision-type-badge decision-type-${dec.decision_type}` }, `${typeInfo.icon} ${typeInfo.label}`),
        h('span', { className: 'decision-entry-time' }, formatDate(dec.created_at)),
      ),
      dec.card_name
        ? h('div', { className: 'decision-card-name' }, cardNameWithPreview(dec.card_name))
        : '',
      h('div', { className: 'decision-rationale' }, `"${dec.rationale}"`),
      h('div', { className: 'decision-entry-meta' },
        h('span', { className: 'decision-entry-user' }, `\u2014 ${dec.participant_name}`),
      ),
    );
  });

  container.replaceChildren(...items);
}

function promptAddDecision(cardName?: string): void {
  const overlay = h('div', { className: 'decision-modal-overlay' },
    h('div', { className: 'decision-modal' },
      h('h3', {}, 'Log Decision'),
      h('label', {}, 'Card (optional)'),
      h('input', { type: 'text', className: 'decision-input', placeholder: 'e.g. Sol Ring', id: '_decCardName', value: cardName || '' }),
      h('label', {}, 'Type'),
      h('select', { className: 'decision-select', id: '_decType' },
        h('option', { value: 'include' }, '\u2705 Include — why this card is in'),
        h('option', { value: 'exclude' }, '\u274C Exclude — why this card is out'),
        h('option', { value: 'swap' }, '\uD83D\uDD04 Swap — why one card replaced another'),
        h('option', { value: 'meta' }, '\uD83D\uDCCB Meta — general deckbuilding decision'),
      ),
      h('label', {}, 'Rationale'),
      h('textarea', { className: 'decision-textarea', placeholder: 'Why this decision?', id: '_decRationale', rows: '3' }),
      h('div', { className: 'decision-modal-actions' },
        h('button', { className: 'decision-modal-cancel', onClick: () => overlay.remove() }, 'Cancel'),
        h('button', { className: 'decision-modal-confirm', onClick: async () => {
          const cn = (document.getElementById('_decCardName') as HTMLInputElement)?.value?.trim() || null;
          const dt = (document.getElementById('_decType') as HTMLSelectElement)?.value || 'meta';
          const rat = (document.getElementById('_decRationale') as HTMLTextAreaElement)?.value?.trim();
          if (!rat) return;
          await addDecision(cn, dt, rat);
          overlay.remove();
        }}, 'Log Decision'),
      ),
    ),
  );
  document.body.appendChild(overlay);

  // Attach autocomplete to card name input
  const cardNameInput = document.getElementById('_decCardName') as HTMLInputElement;
  if (cardNameInput) {
    attachCardAutocomplete({ input: cardNameInput });
  }

  setTimeout(() => {
    if (cardName) {
      (document.getElementById('_decRationale') as HTMLTextAreaElement)?.focus();
    } else {
      cardNameInput?.focus();
    }
  }, 50);
}

// ───── Utilities ─────

function getTypeInfo(type: string): { icon: string; label: string } {
  const types: Record<string, { icon: string; label: string }> = {
    include: { icon: '\u2705', label: 'Include' },
    exclude: { icon: '\u274C', label: 'Exclude' },
    swap: { icon: '\uD83D\uDD04', label: 'Swap' },
    meta: { icon: '\uD83D\uDCCB', label: 'Meta' },
  };
  return types[type] || { icon: '\u25CF', label: type };
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString();
  } catch { return iso; }
}
