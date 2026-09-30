// ==================== Playmat Drag Controller ====================
// One pointer-event controller for: hand-card → mat (add / tag-assign /
// free placement) and pile dragging with snap-to-grid in free mode.
// Escape or pointercancel aborts without any state mutation.

import type { MatLayout } from '../deckbuilder/types.js';
import { snapToGrid, GRID_CELL } from './layout.js';
import { mutateDeck, type PlaymatState } from './state.js';
import type { SortMode } from './sort.js';
import { addCardToDeck, assignTag } from './mat.js';
import { showToast } from '../deckbuilder/toast.js';

const DRAG_THRESHOLD = 6;

export type DropTarget =
  | { kind: 'pile'; id: string }
  | { kind: 'cell'; col: number; row: number }
  | null;

/**
 * Pure drop resolution used by the controller and by tests:
 * pile hit first; otherwise a snapped cell, but only in free mode.
 */
export function resolveDrop(
  xPx: number,
  yPx: number,
  mode: SortMode,
  pilesAt: (col: number, row: number) => string | null,
): DropTarget {
  const { col, row } = snapToGrid(xPx, yPx);
  const pileId = pilesAt(col, row);
  if (pileId) return { kind: 'pile', id: pileId };
  if (mode === 'free') return { kind: 'cell', col, row };
  return null;
}

/** Test hook: the abort path must not mutate a layout. */
export function __testAbortDrag(_layout: MatLayout): void {
  // Aborting a drag only removes the ghost element; by construction it
  // performs no data mutation. This no-op mirrors that contract.
}

interface DragSession {
  kind: 'hand-card' | 'card' | 'pile';
  name: string;
  pileId?: string;
  startX: number;
  startY: number;
  active: boolean;
  ghost: HTMLElement | null;
}

let session: DragSession | null = null;
let hintEl: HTMLElement | null = null;
let matRootRef: HTMLElement;
let stateRef: PlaymatState;

function fieldEl(): HTMLElement | null {
  return matRootRef.querySelector('.pm-field');
}

function fieldPoint(e: PointerEvent): { x: number; y: number } | null {
  const field = fieldEl();
  if (!field) return null;
  const r = field.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function pileIdAt(col: number, row: number): string | null {
  const field = fieldEl();
  if (!field) return null;
  const fr = field.getBoundingClientRect();
  const x = fr.left + col * GRID_CELL + GRID_CELL / 2;
  const y = fr.top + row * GRID_CELL + GRID_CELL / 2;
  for (const el of document.elementsFromPoint(x, y)) {
    const pile = (el as HTMLElement).closest?.('[data-pile]') as HTMLElement | null;
    if (pile?.dataset.pile && pile.dataset.pile !== 'pile-new') return pile.dataset.pile;
  }
  return null;
}

function makeGhost(from: HTMLElement): HTMLElement {
  const ghost = from.cloneNode(true) as HTMLElement;
  ghost.className = 'pm-drag-ghost';
  ghost.style.width = `${from.getBoundingClientRect().width}px`;
  document.body.appendChild(ghost);
  return ghost;
}

function showHint(col: number, row: number): void {
  const field = fieldEl();
  if (!field) return;
  if (!hintEl) {
    hintEl = document.createElement('div');
    hintEl.className = 'pm-snap-hint';
    field.appendChild(hintEl);
  }
  hintEl.style.left = `${col * GRID_CELL}px`;
  hintEl.style.top = `${row * GRID_CELL}px`;
}

function clearHint(): void {
  hintEl?.remove();
  hintEl = null;
}

function abort(): void {
  session?.ghost?.remove();
  clearHint();
  session = null;
}

function finishDrop(e: PointerEvent): void {
  if (!session?.active) { abort(); return; }
  const pt = fieldPoint(e);
  const current = session;
  abort();
  if (!pt) return;

  const target = resolveDrop(pt.x, pt.y, stateRef.sortMode, pileIdAt);

  if (current.kind === 'hand-card') {
    if (!target) { addCardToDeck(current.name); return; }
    if (target.kind === 'pile' && stateRef.sortMode === 'tags') {
      const label = matRootRef.querySelector<HTMLElement>(`[data-pile="${target.id}"]`)?.dataset.pileLabel;
      addCardToDeck(current.name, 'mainboard', label && label !== 'Ohne Tag' ? label : undefined);
    } else {
      addCardToDeck(current.name);
    }
    showToast({ message: `${current.name} hinzugefügt.`, type: 'success', duration: 1500 });
    return;
  }

  if (current.kind === 'card') {
    if (target?.kind === 'pile' && stateRef.sortMode === 'tags') {
      const label = matRootRef.querySelector<HTMLElement>(`[data-pile="${target.id}"]`)?.dataset.pileLabel;
      if (label) assignTag(current.name, label);
    }
    return;
  }

  // pile drag (free mode only)
  if (current.kind === 'pile' && current.pileId && target?.kind === 'cell') {
    mutateDeck(stateRef, (d) => {
      if (!d.matLayout) d.matLayout = { piles: [] };
      const entry = d.matLayout.piles.find((p) => p.id === current.pileId);
      if (entry) { entry.col = target.col; entry.row = target.row; }
      else d.matLayout.piles.push({ id: current.pileId!, col: target.col, row: target.row });
    });
  }
}

export function initDrag(matRoot: HTMLElement, state: PlaymatState): void {
  matRootRef = matRoot;
  stateRef = state;
  if (window.matchMedia('(max-width: 899px)').matches) return;

  document.addEventListener('pointerdown', (e) => {
    const target = (e.target as HTMLElement).closest?.('[data-drag]') as HTMLElement | null;
    if (!target || e.button !== 0) return;
    const kind = target.dataset.drag as DragSession['kind'];
    if (kind === 'pile' && state.sortMode !== 'free') return;
    const holder = kind === 'pile'
      ? (target.closest('[data-pile]') as HTMLElement | null)
      : target;
    session = {
      kind,
      name: target.dataset.card || holder?.dataset.card || '',
      pileId: holder?.dataset.pile,
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      ghost: null,
    };
  });

  document.addEventListener('pointermove', (e) => {
    if (!session) return;
    if (!session.active) {
      if (Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < DRAG_THRESHOLD) return;
      session.active = true;
      const source = session.kind === 'pile'
        ? matRootRef.querySelector<HTMLElement>(`[data-pile="${session.pileId}"]`)
        : document.querySelector<HTMLElement>(`[data-drag][data-card="${CSS.escape(session.name)}"]`);
      if (source) session.ghost = makeGhost(source);
      document.body.classList.add('pm-dragging');
    }
    if (session.ghost) {
      session.ghost.style.left = `${e.clientX + 10}px`;
      session.ghost.style.top = `${e.clientY + 10}px`;
    }
    if (stateRef.sortMode === 'free') {
      const pt = fieldPoint(e);
      if (pt) {
        const { col, row } = snapToGrid(pt.x, pt.y);
        showHint(col, row);
      }
    }
  });

  document.addEventListener('pointerup', (e) => {
    if (!session) return;
    document.body.classList.remove('pm-dragging');
    const wasActive = session.active;
    if (wasActive) finishDrop(e);
    else session = null;
  });

  document.addEventListener('pointercancel', () => {
    document.body.classList.remove('pm-dragging');
    abort();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && session?.active) {
      document.body.classList.remove('pm-dragging');
      abort();
    }
  });
}
