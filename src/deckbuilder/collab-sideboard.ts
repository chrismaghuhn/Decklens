/**
 * CollabSideboard — Collaborative Sideboard Plans for team deck editing.
 *
 * Create, share, and vote on in/out plans for different matchups.
 * Versioned: each update creates a new version, keeping history.
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';
import { attachCardAutocomplete, cardNameWithPreview } from './card-autocomplete.js';

// ───── Types ─────

export interface SideboardPlan {
  id: string;
  deck_id: string;
  matchup: string;
  in_cards_json: string;
  out_cards_json: string;
  notes: string | null;
  created_by: string;
  version: number;
  created_at: string;
}

// ───── State ─────

let plans: SideboardPlan[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let deckId: string | null = null;
let initialized = false;

// ───── Public API ─────

export function initSideboardPlans(currentDeckId: string): void {
  if (initialized) return;
  initialized = true;
  deckId = currentDeckId;

  const mgr = getCollabManager();
  mgr.on('sideboard-plan-event', onSideboardPlanEvent);
  loadPlans();
}

export function toggleSideboardPanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isSideboardPanelOpen(): boolean {
  return panelVisible;
}

export function refreshSideboardPlans(): void {
  loadPlans();
}

/** Create a new sideboard plan */
export async function createSideboardPlan(
  matchup: string,
  inCards: string[],
  outCards: string[],
  notes: string,
): Promise<SideboardPlan | null> {
  if (!deckId) return null;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/sideboard-plans`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ matchup, inCards, outCards, notes }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { ok: boolean; data: { plan: SideboardPlan } };
    if (data.ok && data.data?.plan) {
      plans.unshift(data.data.plan);
      if (panelVisible) renderPanel();

      const mgr = getCollabManager();
      if (mgr.isConnected) {
        mgr.sendSideboardPlanNotify('created', matchup);
      }
      return data.data.plan;
    }
  } catch { /* ignore */ }
  return null;
}

/** Cleanup */
export function resetSideboardPlans(): void {
  plans = [];
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

async function loadPlans(): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/sideboard-plans`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { plans: SideboardPlan[] } };
    if (data.ok && data.data?.plans) {
      plans = data.data.plans;
      if (panelVisible) renderPanel();
    }
  } catch { /* ignore */ }
}

async function deletePlan(planId: string): Promise<void> {
  if (!deckId) return;
  try {
    const plan = plans.find((p) => p.id === planId);
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/sideboard-plans/${planId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (resp.ok) {
      plans = plans.filter((p) => p.id !== planId);
      if (panelVisible) renderPanel();

      if (plan) {
        const mgr = getCollabManager();
        if (mgr.isConnected) {
          mgr.sendSideboardPlanNotify('deleted', plan.matchup);
        }
      }
    }
  } catch { /* ignore */ }
}

// ───── Event Handlers ─────

function onSideboardPlanEvent(_event: CollabEvent): void {
  loadPlans();
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; loadPlans(); return; }

  panelEl = h('div', { className: 'sideboard-plan-panel' },
    h('div', { className: 'sideboard-plan-header' },
 h('span', { className: 'sideboard-plan-title' }, '▤ Sideboard Plans'),
      h('div', { className: 'sideboard-plan-actions-header' },
        h('button', { className: 'sideboard-plan-add-btn', onClick: () => promptCreatePlan(), title: 'Create new sideboard plan' }, '+ Plan'),
 h('button', { className: 'sideboard-plan-close', onClick: () => toggleSideboardPanel(), title: 'Close' }, '✕'),
      ),
    ),
    h('div', { className: 'sideboard-plan-body', id: '_sbPlanBody' }),
  );
  document.body.appendChild(panelEl);
  renderPanel();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderPanel(): void {
  const container = document.getElementById('_sbPlanBody');
  if (!container) return;

  if (plans.length === 0) {
    container.replaceChildren(
      h('div', { className: 'sideboard-plan-empty' },
        h('p', {}, 'No sideboard plans yet.'),
        h('p', {}, 'Create plans for different matchups to share sideboard strategies with your team.'),
      ),
    );
    return;
  }

  // Group by matchup, show latest version only
  const byMatchup = new Map<string, SideboardPlan[]>();
  for (const plan of plans) {
    const existing = byMatchup.get(plan.matchup) || [];
    existing.push(plan);
    byMatchup.set(plan.matchup, existing);
  }

  const cards: HTMLElement[] = [];
  for (const [matchup, matchupPlans] of byMatchup) {
    // Sort by version descending, show latest
    matchupPlans.sort((a, b) => b.version - a.version);
    const latest = matchupPlans[0];
    cards.push(renderPlanCard(latest, matchupPlans.length));
  }

  container.replaceChildren(...cards);
}

function renderPlanCard(plan: SideboardPlan, versionCount: number): HTMLElement {
  let inCards: string[] = [];
  try { inCards = JSON.parse(plan.in_cards_json); } catch { /* ignore */ }
  let outCards: string[] = [];
  try { outCards = JSON.parse(plan.out_cards_json); } catch { /* ignore */ }

  return h('div', { className: 'sideboard-plan-card' },
    h('div', { className: 'sideboard-plan-card-header' },
      h('span', { className: 'sideboard-plan-matchup' }, `vs. ${plan.matchup}`),
      h('span', { className: 'sideboard-plan-version' }, `v${plan.version}${versionCount > 1 ? ` (${versionCount} revisions)` : ''}`),
      h('button', {
        className: 'sideboard-plan-delete-btn',
        onClick: (e: MouseEvent) => {
          e.stopPropagation();
          if (confirm(`Delete sideboard plan for "${plan.matchup}"?`)) deletePlan(plan.id);
        },
        title: 'Delete',
 }, '✕'),
    ),

    // In cards
    h('div', { className: 'sideboard-plan-section' },
 h('div', { className: 'sideboard-plan-section-title sideboard-in' }, ` IN (${inCards.length})`),
      h('div', { className: 'sideboard-plan-cards' },
        ...inCards.map((name) => h('span', { className: 'sideboard-plan-card-item sideboard-card-in' }, '+', cardNameWithPreview(name))),
      ),
    ),

    // Out cards
    h('div', { className: 'sideboard-plan-section' },
 h('div', { className: 'sideboard-plan-section-title sideboard-out' }, ` OUT (${outCards.length})`),
      h('div', { className: 'sideboard-plan-cards' },
        ...outCards.map((name) => h('span', { className: 'sideboard-plan-card-item sideboard-card-out' }, '-', cardNameWithPreview(name))),
      ),
    ),

    // Notes + Meta
    plan.notes
      ? h('div', { className: 'sideboard-plan-notes' }, plan.notes)
      : '',
    h('div', { className: 'sideboard-plan-meta' },
      h('span', {}, `by ${plan.created_by}`),
      h('span', {}, new Date(plan.created_at).toLocaleDateString()),
    ),
  );
}

// ───── Create Modal ─────

function promptCreatePlan(): void {
  const overlay = h('div', { className: 'sideboard-modal-overlay' },
    h('div', { className: 'sideboard-modal' },
      h('h3', {}, 'New Sideboard Plan'),

      h('label', {}, 'Matchup (e.g. "Aggro", "Control", "Mono-Red")'),
      h('input', { type: 'text', className: 'sideboard-modal-input', id: '_sbMatchup', placeholder: 'e.g. Mono-Red Aggro' }),

      h('label', {}, 'Cards IN (one per line)'),
      h('textarea', {
        className: 'sideboard-modal-textarea',
        id: '_sbInCards',
        placeholder: 'Wrath of God\nSwords to Plowshares\nTimely Reinforcements',
        rows: '5',
      }),

      h('label', {}, 'Cards OUT (one per line)'),
      h('textarea', {
        className: 'sideboard-modal-textarea',
        id: '_sbOutCards',
        placeholder: 'Counterspell\nThink Twice\nSnapcaster Mage',
        rows: '5',
      }),

      h('label', {}, 'Notes (optional)'),
      h('textarea', {
        className: 'sideboard-modal-textarea',
        id: '_sbNotes',
        placeholder: 'Strategy notes for this matchup...',
        rows: '3',
      }),

      h('div', { className: 'sideboard-modal-actions' },
        h('button', { className: 'sideboard-modal-cancel', onClick: () => overlay.remove() }, 'Cancel'),
        h('button', { className: 'sideboard-modal-confirm', onClick: async () => {
          const matchup = (document.getElementById('_sbMatchup') as HTMLInputElement)?.value?.trim();
          if (!matchup) return;
          const inText = (document.getElementById('_sbInCards') as HTMLTextAreaElement)?.value?.trim() || '';
          const outText = (document.getElementById('_sbOutCards') as HTMLTextAreaElement)?.value?.trim() || '';
          const inCards = inText.split('\n').map((l) => l.trim()).filter(Boolean);
          const outCards = outText.split('\n').map((l) => l.trim()).filter(Boolean);
          if (inCards.length === 0 && outCards.length === 0) return;
          const notes = (document.getElementById('_sbNotes') as HTMLTextAreaElement)?.value?.trim() || '';
          await createSideboardPlan(matchup, inCards, outCards, notes);
          overlay.remove();
        }}, 'Create'),
      ),
    ),
  );
  document.body.appendChild(overlay);

  // Attach autocomplete to IN/OUT card textareas (multi-line mode)
  const sbIn = document.getElementById('_sbInCards') as HTMLTextAreaElement;
  const sbOut = document.getElementById('_sbOutCards') as HTMLTextAreaElement;
  if (sbIn) attachCardAutocomplete({ input: sbIn, multiLine: true });
  if (sbOut) attachCardAutocomplete({ input: sbOut, multiLine: true });

  setTimeout(() => (document.getElementById('_sbMatchup') as HTMLInputElement)?.focus(), 50);
}
