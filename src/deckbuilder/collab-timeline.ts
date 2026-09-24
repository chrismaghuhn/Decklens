/**
 * CollabTimeline — Snapshot timeline / time-travel for collaborative deck editing.
 *
 * Shows a visual timeline of deck snapshots with restore capability.
 * Snapshots are stored server-side in D1.
 */

import { h } from '../shared/dom.js';

// ───── Types ─────

export interface TimelineSnapshot {
  id: string;
  label: string;
  snapshotType: string;
  cardCount: number;
  createdBy?: string;
  createdAt: string;
  boardsJson?: string;
}

// ───── State ─────

let snapshots: TimelineSnapshot[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let deckId: string | null = null;
let branchId: string | null = null;
let onRestoreCallback: ((boards: unknown) => void) | null = null;

// ───── Public API ─────

export function initTimeline(currentDeckId: string, currentBranchId: string | null, onRestore?: (boards: unknown) => void): void {
  deckId = currentDeckId;
  branchId = currentBranchId;
  onRestoreCallback = onRestore || null;
  loadSnapshots();
}

export function setTimelineBranch(newBranchId: string): void {
  branchId = newBranchId;
  loadSnapshots();
}

export function toggleTimelinePanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isTimelinePanelOpen(): boolean {
  return panelVisible;
}

export async function createManualSnapshot(label: string, boardsJson: string, cardCount: number): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/snapshots`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branchId, label, boardsJson, cardCount, snapshotType: 'manual' }),
    });
    if (resp.ok) {
      await loadSnapshots();
    }
  } catch { /* ignore */ }
}

// ───── API ─────

function getApiOrigin(): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}

async function loadSnapshots(): Promise<void> {
  if (!deckId) return;
  try {
    const url = branchId
      ? `${getApiOrigin()}/api/decks/${deckId}/snapshots?branchId=${branchId}`
      : `${getApiOrigin()}/api/decks/${deckId}/snapshots`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { snapshots: TimelineSnapshot[] } };
    if (data.ok && data.data?.snapshots) {
      snapshots = data.data.snapshots;
      if (panelVisible) renderList();
    }
  } catch { /* ignore */ }
}

async function restoreSnapshot(snapshotId: string): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/snapshots/${snapshotId}`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { snapshot: TimelineSnapshot } };
    if (data.ok && data.data?.snapshot?.boardsJson) {
      const boards = JSON.parse(data.data.snapshot.boardsJson);
      if (onRestoreCallback) onRestoreCallback(boards);
    }
  } catch { /* ignore */ }
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; renderList(); return; }

  panelEl = h('div', { className: 'timeline-panel' },
    h('div', { className: 'timeline-panel-header' },
 h('span', { className: 'timeline-panel-title' }, '… Timeline'),
      h('div', { className: 'timeline-panel-actions-header' },
 h('button', { className: 'timeline-snapshot-btn', onClick: () => promptSnapshot(), title: 'Create snapshot' }, '◆ Snapshot'),
 h('button', { className: 'timeline-panel-close', onClick: () => toggleTimelinePanel(), title: 'Close' }, '✕'),
      ),
    ),
    h('div', { className: 'timeline-list', id: '_timelineList' }),
  );
  document.body.appendChild(panelEl);
  renderList();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderList(): void {
  const container = document.getElementById('_timelineList');
  if (!container) return;

  if (snapshots.length === 0) {
    container.replaceChildren(h('div', { className: 'timeline-empty' }, 'No snapshots yet. Changes are saved automatically.'));
    return;
  }

  const items = snapshots.map((snap, i) => {
    const isLatest = i === 0;
 const typeIcon = snap.snapshotType === 'manual' ? '◆' : '▲';
    return h('div', { className: `timeline-entry${isLatest ? ' latest' : ''}` },
      h('div', { className: 'timeline-dot' }),
      h('div', { className: 'timeline-entry-content' },
        h('div', { className: 'timeline-entry-header' },
          h('span', { className: 'timeline-entry-label' }, `${typeIcon} ${snap.label || 'Snapshot'}`),
          h('span', { className: 'timeline-entry-cards' }, `${snap.cardCount} cards`),
        ),
        h('div', { className: 'timeline-entry-meta' },
          snap.createdBy ? h('span', {}, snap.createdBy) : '',
          h('span', { className: 'timeline-entry-time' }, formatDate(snap.createdAt)),
        ),
        !isLatest ? h('button', {
          className: 'timeline-restore-btn',
          onClick: () => { if (confirm('Restore this snapshot? Current changes will be overwritten.')) restoreSnapshot(snap.id); },
 }, ' Restore') : h('span', { className: 'timeline-current-tag' }, 'current'),
      ),
    );
  });

  container.replaceChildren(...items);
}

function promptSnapshot(): void {
  const label = prompt('Snapshot label (optional):') || 'Manual snapshot';
  const event = new CustomEvent('decklens:snapshot-request', { detail: { label } });
  window.dispatchEvent(event);
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
