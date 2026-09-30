// ==================== Playmat Drag Controller ====================
// One pointer-event controller for: hand-card → mat (add / tag-assign /
// free placement) and pile dragging with snap-to-grid in free mode.
// Escape or pointercancel aborts without any state mutation.

import { snapToGrid, GRID_CELL } from './layout.js';
import { mutateDeck, type PlaymatState } from './state.js';
import type { SortMode } from './sort.js';
import { addCardToDeck, assignTag } from './mat.js';
import { handCardByName, rememberCard } from './hand.js';
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

export type DropAction =
  | { type: 'none' }
  | { type: 'add' }
  | { type: 'add-to-pile'; pileId: string }
  | { type: 'assign-to-pile'; pileId: string }
  | { type: 'move-pile'; col: number; row: number };

/**
 * Pure drop semantics: a release outside the mat cancels everything;
 * inside, the session kind and mode decide what the drop does.
 */
export function planDrop(
  kind: 'hand-card' | 'card' | 'pile',
  inMat: boolean,
  target: DropTarget,
  mode: SortMode,
): DropAction {
  if (!inMat) return { type: 'none' };
  if (kind === 'hand-card') {
    if (target?.kind === 'pile' && mode === 'tags') return { type: 'add-to-pile', pileId: target.id };
    return { type: 'add' };
  }
  if (kind === 'card') {
    if (target?.kind === 'pile' && mode === 'tags') return { type: 'assign-to-pile', pileId: target.id };
    return { type: 'none' };
  }
  // pile
  if (target?.kind === 'cell') return { type: 'move-pile', col: target.col, row: target.row };
  return { type: 'none' };
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

function pileIdAtPoint(x: number, y: number): string | null {
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

function pileLabelOf(pileId: string): string | undefined {
  const label = matRootRef.querySelector<HTMLElement>(`[data-pile="${pileId}"]`)?.dataset.pileLabel;
  return label && label !== 'Ohne Tag' ? label : undefined;
}

function finishDrop(e: PointerEvent): void {
  if (!session?.active) { abort(); return; }
  const pt = fieldPoint(e);
  const current = session;
  abort();
  if (!pt) return;

  const matRect = matRootRef.getBoundingClientRect();
  const inMat = e.clientX >= matRect.left && e.clientX <= matRect.right
    && e.clientY >= matRect.top && e.clientY <= matRect.bottom;
  // Pile hit-testing uses the real pointer position: snapped cell centers
  // miss short piles (e.g. a freshly created empty tag pile).
  const target = resolveDrop(pt.x, pt.y, stateRef.sortMode, () => pileIdAtPoint(e.clientX, e.clientY));
  const action = planDrop(current.kind, inMat, target, stateRef.sortMode);

  if (action.type === 'none') return;

  if (action.type === 'add' || action.type === 'add-to-pile') {
    const card = handCardByName(current.name);
    if (card) rememberCard(stateRef, card);
    const tag = action.type === 'add-to-pile' ? pileLabelOf(action.pileId) : undefined;
    addCardToDeck(current.name, 'mainboard', tag);
    showToast({ message: `${current.name} hinzugefügt.`, type: 'success', duration: 1500 });
    return;
  }

  if (action.type === 'assign-to-pile') {
    const label = pileLabelOf(action.pileId);
    if (label) assignTag(current.name, label);
    return;
  }

  // move-pile (free mode only)
  if (current.pileId) {
    mutateDeck(stateRef, (d) => {
      if (!d.matLayout) d.matLayout = { piles: [] };
      const entry = d.matLayout.piles.find((p) => p.id === current.pileId);
      if (entry) { entry.col = action.col; entry.row = action.row; }
      else d.matLayout.piles.push({ id: current.pileId!, col: action.col, row: action.row });
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
