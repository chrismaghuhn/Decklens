// ==================== Playmat Multi-Selection ====================
// Desktop-style selection for mainboard cards on the mat: click,
// ctrl-click, shift-range, rubber band on empty mat space, Ctrl+A,
// Delete, Ctrl+C. The selection is keyed by card name, so it survives
// re-renders and sort-mode switches. Bulk actions live in mat.ts.

import { isTypingContext, normalizeNameKey, type PlaymatState } from './state.js';
import { isDragging } from './drag.js';
import { openArtPicker } from './art-picker.js';
import { iconSvg } from '../shared/icons.js';

export const EV_SELECTION_CHANGED = 'pm-selection-changed';

// ── pure helpers (unit-tested) ──

export function toggleName(sel: Set<string>, name: string): void {
  if (sel.has(name)) sel.delete(name);
  else sel.add(name);
}

/** Inclusive range between anchor and target in the given reading order. */
export function rangeNames(order: string[], anchor: string, target: string): string[] {
  const a = order.indexOf(anchor);
  const b = order.indexOf(target);
  if (b < 0) return [];
  if (a < 0) return [target];
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return order.slice(lo, hi + 1);
}

export interface RectLike { left: number; top: number; right: number; bottom: number }

export function rectsIntersect(a: RectLike, b: RectLike): boolean {
  return a.left <= b.right && b.left <= a.right && a.top <= b.bottom && b.top <= a.bottom;
}

// ── selection state ──

let selected = new Set<string>();
let anchor: string | null = null;
let stateRef: PlaymatState;
let matRef: HTMLElement;

function emit(): void {
  document.dispatchEvent(new CustomEvent(EV_SELECTION_CHANGED));
  applySelectionStyles();
}

export function selectedNames(): string[] {
  return [...selected];
}

export function isSelected(name: string): boolean {
  return selected.has(name);
}

export function selectionSize(): number {
  return selected.size;
}

export function clearSelection(): void {
  if (selected.size === 0) return;
  selected.clear();
  anchor = null;
  emit();
}

export function selectOnly(name: string): void {
  selected = new Set([name]);
  anchor = name;
  emit();
}

export function ctrlToggle(name: string): void {
  toggleName(selected, name);
  anchor = name;
  emit();
}

function readingOrder(): string[] {
  return [...matRef.querySelectorAll<HTMLElement>('.pm-field .pm-card[data-card]')]
    .map((el) => el.dataset.card!)
    .filter((v, i, arr) => arr.indexOf(v) === i);
}

export function shiftSelect(name: string): void {
  const names = rangeNames(readingOrder(), anchor ?? name, name);
  for (const n of names) selected.add(n);
  emit();
}

/** Replace the whole selection (e.g. from the in-deck search). */
export function setSelection(names: string[]): void {
  selected = new Set(names);
  anchor = null;
  emit();
}

export function selectAll(): void {
  selected = new Set(stateRef.deck.boards.mainboard.map((e) => e.name));
  anchor = null;
  emit();
}

/** Drop names that left the mainboard (e.g. after removal or move). */
function prune(): void {
  const live = new Set(stateRef.deck.boards.mainboard.map((e) => e.name));
  for (const name of [...selected]) if (!live.has(name)) selected.delete(name);
}

// ── visual feedback ──

export function applySelectionStyles(): void {
  prune();
  matRef.querySelectorAll<HTMLElement>('.pm-card[data-card]').forEach((el) => {
    el.classList.toggle('pm-selected', selected.has(el.dataset.card!));
  });
  renderBar();
  renderInspector();
}

/** A single selected card shows big in a pinned panel on the right. */
function renderInspector(): void {
  let panel = document.querySelector<HTMLElement>('.pm-inspect');
  if (selected.size !== 1) { panel?.remove(); return; }
  const name = [...selected][0];
  const card = stateRef.cardByName[normalizeNameKey(name)];
  const img = card?.image_uris?.large || card?.image_uris?.normal;
  if (!img) { panel?.remove(); return; }
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'pm-inspect';
    document.body.appendChild(panel);
  }
  panel.innerHTML = `<img src="${img}" alt="${name.replace(/"/g, '&quot;')}">`;
  const artBtn = document.createElement('button');
  artBtn.type = 'button';
  artBtn.className = 'pm-inspect-art';
  artBtn.innerHTML = `${iconSvg('image')} Artwork`;
  artBtn.title = 'Choose a different printing';
  artBtn.addEventListener('click', () => { void openArtPicker(stateRef, name, 'mainboard'); });
  panel.appendChild(artBtn);
}

function renderBar(): void {
  let bar = document.querySelector<HTMLElement>('.pm-selbar');
  if (selected.size === 0) { bar?.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'pm-selbar';
    document.body.appendChild(bar);
  }
  let price = 0;
  let priced = 0;
  let count = 0;
  for (const entry of stateRef.deck.boards.mainboard) {
    if (!selected.has(entry.name)) continue;
    count += entry.qty;
    const eur = Number(stateRef.cardByName[normalizeNameKey(entry.name)]?.prices?.eur);
    if (Number.isFinite(eur)) { price += eur * entry.qty; priced += entry.qty; }
  }
  bar.innerHTML = `
    <span>${count} card${count === 1 ? '' : 's'} selected</span>
    ${priced > 0 ? `<span class="pm-selbar-price">≈ €${price.toFixed(2)}</span>` : ''}
    <button type="button" class="pm-selbar-clear" title="Clear selection (Esc)">✕</button>`;
  bar.querySelector('.pm-selbar-clear')!.addEventListener('click', clearSelection);
}

// ── rubber band + keyboard ──

let lassoStart: { x: number; y: number; additive: boolean } | null = null;
let lassoEl: HTMLElement | null = null;
let lassoBase: Set<string> = new Set();

function lassoRect(e: PointerEvent): RectLike {
  return {
    left: Math.min(lassoStart!.x, e.clientX),
    top: Math.min(lassoStart!.y, e.clientY),
    right: Math.max(lassoStart!.x, e.clientX),
    bottom: Math.max(lassoStart!.y, e.clientY),
  };
}

function endLasso(): void {
  lassoEl?.remove();
  lassoEl = null;
  lassoStart = null;
}

export function initSelection(matRoot: HTMLElement, state: PlaymatState): void {
  matRef = matRoot;
  stateRef = state;
  if (window.matchMedia('(max-width: 899px)').matches) return;

  matRoot.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    // only bare mat/field space starts a rubber band
    if (t.closest('.pm-card, .pm-pile-head, .pm-ghost-pile, .pm-docks, .pm-cmdzone, .pm-targets, button, input, select, a')) return;
    lassoStart = { x: e.clientX, y: e.clientY, additive: e.ctrlKey || e.metaKey };
    lassoBase = lassoStart.additive ? new Set(selected) : new Set();
  });

  document.addEventListener('pointermove', (e) => {
    if (!lassoStart) return;
    if (!lassoEl) {
      if (Math.hypot(e.clientX - lassoStart.x, e.clientY - lassoStart.y) < 4) return;
      lassoEl = document.createElement('div');
      lassoEl.className = 'pm-lasso';
      document.body.appendChild(lassoEl);
    }
    const r = lassoRect(e);
    Object.assign(lassoEl.style, {
      left: `${r.left}px`, top: `${r.top}px`,
      width: `${r.right - r.left}px`, height: `${r.bottom - r.top}px`,
    });
    selected = new Set(lassoBase);
    matRef.querySelectorAll<HTMLElement>('.pm-field .pm-card[data-card]').forEach((el) => {
      if (rectsIntersect(r, el.getBoundingClientRect())) selected.add(el.dataset.card!);
    });
    applySelectionStyles();
  });

  document.addEventListener('pointerup', (e) => {
    if (!lassoStart) return;
    const dragged = !!lassoEl;
    endLasso();
    if (!dragged) {
      // plain click on empty space clears (unless ctrl was held)
      if (!(e.ctrlKey || e.metaKey)) clearSelection();
    } else {
      emit();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (isTypingContext(e.target)) return;
    if (e.key === 'Escape') {
      if (isDragging() || lassoStart) { endLasso(); return; }
      if (document.querySelector('.pm-drawer.open')) return; // drawer owns this Escape
      clearSelection();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectAll();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selected.size > 0) {
      e.preventDefault();
      const lines = stateRef.deck.boards.mainboard
        .filter((en) => selected.has(en.name))
        .map((en) => `${en.qty} ${en.name}`);
      void navigator.clipboard.writeText(lines.join('\n'));
    }
  });
}
