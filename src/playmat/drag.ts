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
  | { type: 'move-pile'; col: number; row: number }
  | { type: 'reorder-pile'; beforeId: string | null };

/**
 * Pure drop semantics: a release outside the mat cancels everything;
 * inside, the session kind and mode decide what the drop does.
 */
export function planDrop(
  kind: 'hand-card' | 'card' | 'pile',
  inMat: boolean,
  target: DropTarget,
  mode: SortMode,
  selfPileId?: string,
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
  // pile: free mode moves to grid cells, sorted modes reorder the flow
  if (mode === 'free') {
    if (target?.kind === 'cell') return { type: 'move-pile', col: target.col, row: target.row };
    return { type: 'none' };
  }
  if (target?.kind === 'pile') {
    if (target.id === selfPileId) return { type: 'none' };
    return { type: 'reorder-pile', beforeId: target.id };
  }
  return { type: 'reorder-pile', beforeId: null };
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

/** True while a drag is past the threshold — Escape then belongs to the drag. */
export function isDragging(): boolean {
  return session?.active === true;
}
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

function makeGhost(from: HTMLElement, kind: DragSession['kind']): HTMLElement {
  const ghost = from.cloneNode(true) as HTMLElement;
  // keep the source classes so inner images stay constrained
  ghost.className = `${from.className} pm-drag-ghost`;
  ghost.style.transform = ''; // drop the hand fan tilt; the ghost class rotates
  // single cards shrink to a small preview next to the cursor;
  // piles keep their width so the insert position reads naturally
  ghost.style.width = kind === 'pile' ? `${from.getBoundingClientRect().width}px` : '92px';
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

function clearDropFeedback(): void {
  matRootRef.classList.remove('pm-dropzone');
  matRootRef.querySelectorAll('.pm-insert-before, .pm-insert-after, .pm-drop-target, .pm-drag-source')
    .forEach((el) => el.classList.remove('pm-insert-before', 'pm-insert-after', 'pm-drop-target', 'pm-drag-source'));
}

function flowPiles(): HTMLElement[] {
  return Array.from(matRootRef.querySelectorAll<HTMLElement>('.pm-field > [data-pile]'))
    .filter((el) => el.dataset.pile !== 'pile-new');
}

/** Live preview of what a drop at the pointer would do. */
function updateDropFeedback(e: PointerEvent): void {
  if (!session?.active) return;
  clearDropFeedback();

  const matRect = matRootRef.getBoundingClientRect();
  const inMat = e.clientX >= matRect.left && e.clientX <= matRect.right
    && e.clientY >= matRect.top && e.clientY <= matRect.bottom;
  const hovered = inMat ? pileIdAtPoint(e.clientX, e.clientY) : null;

  if (session.kind === 'pile') {
    matRootRef.querySelector(`[data-pile="${session.pileId}"]`)?.classList.add('pm-drag-source');
    if (stateRef.sortMode === 'free' || !inMat) return;
    if (hovered && hovered !== session.pileId) {
      matRootRef.querySelector(`[data-pile="${hovered}"]`)?.classList.add('pm-insert-before');
    } else if (!hovered) {
      const piles = flowPiles().filter((el) => el.dataset.pile !== session!.pileId);
      piles[piles.length - 1]?.classList.add('pm-insert-after');
    }
    return;
  }

  // hand cards and mat cards: glow the mat while a release would add,
  // and highlight the pile a tag drop would land in
  if (session.kind === 'hand-card') matRootRef.classList.toggle('pm-dropzone', inMat);
  if (stateRef.sortMode === 'tags' && hovered) {
    matRootRef.querySelector(`[data-pile="${hovered}"]`)?.classList.add('pm-drop-target');
  }
}

function abort(): void {
  session?.ghost?.remove();
  clearHint();
  clearDropFeedback();
  session = null;
}

function pileLabelOf(pileId: string): string | undefined {
  const label = matRootRef.querySelector<HTMLElement>(`[data-pile="${pileId}"]`)?.dataset.pileLabel;
  return label && label !== 'Untagged' ? label : undefined;
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
  const action = planDrop(current.kind, inMat, target, stateRef.sortMode, current.pileId);

  if (action.type === 'none') return;

  if (action.type === 'add' || action.type === 'add-to-pile') {
    const card = handCardByName(current.name);
    if (card) rememberCard(stateRef, card);
    const tag = action.type === 'add-to-pile' ? pileLabelOf(action.pileId) : undefined;
    addCardToDeck(current.name, 'mainboard', tag);
    showToast({ message: `${current.name} added.`, type: 'success', duration: 1500 });
    return;
  }

  if (action.type === 'assign-to-pile') {
    // raw label on purpose: dropping on "Untagged" clears the card's tags
    const label = matRootRef.querySelector<HTMLElement>(`[data-pile="${action.pileId}"]`)?.dataset.pileLabel;
    if (label) assignTag(current.name, label);
    return;
  }

  if (action.type === 'move-pile' && current.pileId) {
    mutateDeck(stateRef, (d) => {
      if (!d.matLayout) d.matLayout = { piles: [] };
      const entry = d.matLayout.piles.find((p) => p.id === current.pileId);
      if (entry) { entry.col = action.col; entry.row = action.row; }
      else d.matLayout.piles.push({ id: current.pileId!, col: action.col, row: action.row });
    });
    return;
  }

  // reorder-pile (sorted modes): rebuild the id order from the rendered flow
  if (action.type === 'reorder-pile' && current.pileId) {
    const ids = Array.from(matRootRef.querySelectorAll<HTMLElement>('.pm-field > [data-pile]'))
      .map((el) => el.dataset.pile!)
      .filter((id) => id !== 'pile-new' && id !== current.pileId);
    const at = action.beforeId ? ids.indexOf(action.beforeId) : -1;
    if (at >= 0) ids.splice(at, 0, current.pileId);
    else ids.push(current.pileId);
    const mode = stateRef.sortMode;
    mutateDeck(stateRef, (d) => {
      d.pileOrders = { ...(d.pileOrders || {}), [mode]: ids };
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
    // pile headers drag in every mode: free repositions, sorted modes reorder
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
      if (source) session.ghost = makeGhost(source, session.kind);
      document.body.classList.add('pm-dragging');
    }
    if (session.ghost) {
      session.ghost.style.left = `${e.clientX + 10}px`;
      session.ghost.style.top = `${e.clientY + 10}px`;
    }
    if (stateRef.sortMode === 'free' && session.kind === 'pile') {
      const pt = fieldPoint(e);
      if (pt) {
        const { col, row } = snapToGrid(pt.x, pt.y);
        showHint(col, row);
      }
    }
    updateDropFeedback(e);
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
