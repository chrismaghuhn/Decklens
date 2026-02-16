/**
 * CollabCollection — Shared Team Collection Pool for collaborative deck editing.
 *
 * Upload your personal collection → see who on the team owns which cards.
 * "Sol Ring — Alice(2), Bob(1) = 3 total"
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';
import { getTotalCollectionCards } from './collection.js';

// ───── Types ─────

export interface TeamOwnership {
  total: number;
  owners: Array<{ name: string; qty: number }>;
}

export type TeamCollectionMap = Record<string, TeamOwnership>;

// ───── State ─────

let teamCollection: TeamCollectionMap = {};
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let deckId: string | null = null;
let initialized = false;

// ───── Public API ─────

export function initTeamCollection(currentDeckId: string): void {
  if (initialized) return;
  initialized = true;
  deckId = currentDeckId;

  const mgr = getCollabManager();
  mgr.on('collection-shared', onCollectionShared);
}

export function toggleTeamCollectionPanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isTeamCollectionPanelOpen(): boolean {
  return panelVisible;
}

export function refreshTeamCollection(): void {
  loadTeamCollection();
}

/** Get team ownership data for a card (for badges in view-modes) */
export function getTeamOwnership(cardName: string): TeamOwnership | null {
  const key = cardName.trim().toLowerCase().replace(/\s+/g, ' ');
  // Check both normalized and original
  return teamCollection[key] || teamCollection[cardName] || null;
}

/** Share local collection to the server + notify collab */
export async function shareMyCollection(): Promise<void> {
  try {
    // Build card map from localStorage collection
    const raw = localStorage.getItem('decklens_collection');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const cards: Record<string, number> = {};

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && 'qty' in (value as Record<string, unknown>)) {
          const qty = (value as { qty: number }).qty;
          if (qty > 0) cards[key] = qty;
        }
      }
    } else if (Array.isArray(parsed)) {
      for (const name of parsed) {
        if (typeof name === 'string') cards[name.trim().toLowerCase()] = 1;
      }
    }

    const cardCount = Object.keys(cards).length;
    if (cardCount === 0) return;

    const resp = await fetch(`${getApiOrigin()}/api/collections/sync`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards }),
    });

    if (resp.ok) {
      // Notify collab participants
      const mgr = getCollabManager();
      if (mgr.isConnected) {
        mgr.sendCollectionShare(cardCount);
      }
      // Reload team collection
      await loadTeamCollection();
    }
  } catch { /* ignore */ }
}

/** Cleanup */
export function resetTeamCollection(): void {
  teamCollection = {};
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

async function loadTeamCollection(): Promise<void> {
  if (!deckId) return;
  try {
    // Get participant user IDs from collab manager
    const mgr = getCollabManager();
    const participants = mgr.currentParticipants || [];
    const userIds = participants
      .map((p: { userId?: string }) => p.userId)
      .filter((id: string | undefined): id is string => !!id);

    if (userIds.length === 0) {
      teamCollection = {};
      if (panelVisible) renderPanel();
      return;
    }

    const resp = await fetch(
      `${getApiOrigin()}/api/decks/${deckId}/team-collection?userIds=${userIds.join(',')}`,
      { credentials: 'include' },
    );
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { teamCollection: TeamCollectionMap } };
    if (data.ok && data.data?.teamCollection) {
      teamCollection = data.data.teamCollection;
      if (panelVisible) renderPanel();
    }
  } catch { /* ignore */ }
}

// ───── Event Handlers ─────

function onCollectionShared(_event: CollabEvent): void {
  // Someone shared their collection — reload
  loadTeamCollection();
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; loadTeamCollection(); return; }

  panelEl = h('div', { className: 'team-collection-panel' },
    h('div', { className: 'team-collection-header' },
      h('span', { className: 'team-collection-title' }, '\uD83D\uDCE6 Team Collection Pool'),
      h('div', { className: 'team-collection-actions-header' },
        h('button', {
          className: 'team-share-btn',
          onClick: () => shareMyCollection(),
          title: 'Upload your collection to share with the team',
        }, '\u2B06 Share My Collection'),
        h('button', { className: 'team-collection-close', onClick: () => toggleTeamCollectionPanel(), title: 'Close' }, '\u2715'),
      ),
    ),
    h('div', { className: 'team-collection-body', id: '_teamCollBody' }),
  );
  document.body.appendChild(panelEl);
  loadTeamCollection();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderPanel(): void {
  const container = document.getElementById('_teamCollBody');
  if (!container) return;

  const entries = Object.entries(teamCollection).sort(([, a], [, b]) => b.total - a.total);

  if (entries.length === 0) {
    container.replaceChildren(
      h('div', { className: 'team-collection-empty' },
        h('p', {}, 'No team collection data yet.'),
        h('p', {}, 'Click "Share My Collection" to upload your cards.'),
        h('p', { className: 'team-collection-hint' }, `Your local collection: ${getTotalCollectionCards()} cards`),
      ),
    );
    return;
  }

  const cardRows = entries.map(([name, data]) => {
    const displayName = name.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const ownerStr = data.owners.map((o) => `${o.name}(${o.qty})`).join(', ');

    return h('div', { className: 'team-card-row' },
      h('span', { className: 'team-card-name' }, displayName),
      h('span', { className: 'team-card-total' }, `${data.total}x`),
      h('span', { className: 'team-card-owners' }, ownerStr),
    );
  });

  const summary = h('div', { className: 'team-collection-summary' },
    h('span', {}, `${entries.length} unique cards`),
    h('span', {}, `${entries.reduce((sum, [, d]) => sum + d.total, 0)} total copies`),
  );

  container.replaceChildren(summary, ...cardRows);
}
