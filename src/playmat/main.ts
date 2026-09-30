// ==================== Playmat Editor Entry ====================

import { initState, mutateDeck, persistDeck, resolveMissing, setSortMode, cardFor,
  EV_DECK_CHANGED, EV_CARDS_RESOLVED, EV_SORT_CHANGED, isTypingContext, type PlaymatState } from './state.js';
import { initToastContainer, showToast } from '../deckbuilder/toast.js';
import { initCardPreview } from '../deckbuilder/card-preview.js';
import { initUndoStack, undo, redo, pushSnapshot } from '../deckbuilder/undo-stack.js';
import { deleteDeck, duplicateDeck, summarizeDeckCardCounts } from '../deckbuilder/storage.js';
import { getFormatRules } from '../deckbuilder/live-validation.js';
import { showConfirmModal } from '../deckbuilder/confirm-modal.js';
import { iconSvg } from '../shared/icons.js';
import type { SortMode } from './sort.js';
import { initMat } from './mat.js';
import { initHand } from './hand.js';
import { initDrawers } from './drawers.js';
import { initDrag } from './drag.js';

function parseDeckIdFromPath(): string | null {
  const m = window.location.pathname.match(/\/decks\/id\/([^/?#]+)/);
  if (!m || m[1] === 'public') return null;
  return decodeURIComponent(m[1]);
}

const SORT_MODES: Array<{ mode: SortMode; label: string }> = [
  { mode: 'type', label: 'Card Type' },
  { mode: 'mana', label: 'Mana Value' },
  { mode: 'color', label: 'Color' },
  { mode: 'role', label: 'Function' },
  { mode: 'tags', label: 'Custom Tags' },
  { mode: 'free', label: 'Free' },
];

function renderHeader(root: HTMLElement, state: PlaymatState): void {
  root.textContent = '';

  const name = document.createElement('input');
  name.className = 'pm-name';
  name.value = state.deck.name;
  name.maxLength = 100;
  name.setAttribute('aria-label', 'Deck name');
  name.addEventListener('change', () => {
    mutateDeck(state, (d) => { d.name = name.value.trim() || 'Untitled Deck'; });
  });

  const fmt = document.createElement('select');
  fmt.className = 'pm-format';
  fmt.setAttribute('aria-label', 'Deck format');
  const FORMATS: Array<[string, string]> = [
    ['commander', 'COMMANDER'], ['standard', 'STANDARD'], ['modern', 'MODERN'],
    ['pioneer', 'PIONEER'], ['legacy', 'LEGACY'], ['pauper', 'PAUPER'], ['none', 'CASUAL'],
  ];
  for (const [value, label] of FORMATS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    fmt.appendChild(opt);
  }
  fmt.value = state.deck.format || 'commander';
  fmt.addEventListener('change', () => {
    mutateDeck(state, (d) => { d.format = fmt.value as typeof d.format; });
  });

  const spacer = document.createElement('div');
  spacer.className = 'pm-spacer';

  const searchSlot = document.createElement('div');
  searchSlot.id = 'pmSearchSlot';
  searchSlot.className = 'pm-search-slot';

  const ring = document.createElement('div');
  ring.className = 'pm-progress';
  ring.id = 'pmProgress';

  const more = document.createElement('button');
  more.className = 'pm-more';
  more.type = 'button';
  more.title = 'Deck actions';
  more.textContent = '⋯';
  more.addEventListener('click', () => openMoreMenu(more, state));

  root.append(name, fmt, spacer, searchSlot, ring, more);
  renderProgress(state);
}

function renderProgress(state: PlaymatState): void {
  const host = document.getElementById('pmProgress');
  if (!host) return;
  const rules = getFormatRules(state.deck.format || 'commander');
  const counts = summarizeDeckCardCounts(state.deck);
  const total = counts.total;
  const hasCap = Number.isFinite(rules.maxDeckSize);
  const target = hasCap ? rules.maxDeckSize : Math.max(rules.minDeckSize, 1);
  const frac = Math.max(0, Math.min(1, total / target));
  const R = 11;
  const C = 2 * Math.PI * R;
  const missingCmd = rules.commanderRequired && state.deck.boards.commander.length === 0;

  host.innerHTML = `
    <svg class="pm-ring" viewBox="0 0 28 28" aria-hidden="true">
      <circle class="bg" cx="14" cy="14" r="${R}"></circle>
      <circle class="fg${missingCmd ? ' warn' : ''}" cx="14" cy="14" r="${R}"
        stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${(C * (1 - frac)).toFixed(1)}"></circle>
    </svg>
    <span class="pm-ring-label">${total}${hasCap ? `<em>/${rules.maxDeckSize}</em>` : ''}</span>
  `;
  host.title = missingCmd
    ? 'Commander missing — use the slot in the top-left of the mat'
    : hasCap ? `${total} of ${rules.maxDeckSize} cards` : `${total} cards (min. ${rules.minDeckSize})`;
}

function openMoreMenu(anchor: HTMLElement, state: PlaymatState): void {
  document.querySelector('.pm-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'pm-menu';
  const items: Array<[string, () => void]> = [
    ['Back to decks', () => { window.location.href = '/decks'; }],
    ['Duplicate deck', () => {
      const copy = duplicateDeck(state.deck.id);
      if (copy) window.location.href = `/decks/id/${copy.id}`;
    }],
    ['Delete deck', async () => {
      const ok = await showConfirmModal({
        title: 'Delete deck?',
        message: `"${state.deck.name}" will be deleted permanently.`,
        confirmLabel: 'Delete',
      });
      if (ok) { deleteDeck(state.deck.id); window.location.href = '/decks'; }
    }],
  ];
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => { menu.remove(); fn(); });
    menu.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - r.right}px`;
  document.body.appendChild(menu);
  const close = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

const ZOOM_KEY = 'dl_pm_zoom';
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.5;

// Visible strip per stacked card (px of the card that peeks out).
const STRIP_KEY = 'dl_pm_strip';
const STRIP_MIN = 16;
const STRIP_MAX = 88;
const STRIP_DEFAULT = 44;

function currentStrip(): number {
  const v = Number(localStorage.getItem(STRIP_KEY));
  if (Number.isFinite(v) && v >= STRIP_MIN && v <= STRIP_MAX) return v;
  // migrate the old S/M/L preset
  const legacy = localStorage.getItem('dl_pm_density');
  if (legacy === 'compact') return 22;
  if (legacy === 'loose') return 78;
  return STRIP_DEFAULT;
}

function applyStrip(px: number): void {
  (document.getElementById('pmMat') as HTMLElement).style.setProperty('--pm-strip', `${px}px`);
}

function setStrip(px: number): void {
  const clamped = Math.min(STRIP_MAX, Math.max(STRIP_MIN, Math.round(px)));
  localStorage.setItem(STRIP_KEY, String(clamped));
  applyStrip(clamped);
}

function currentZoom(): number {
  const v = Number(localStorage.getItem(ZOOM_KEY));
  return Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX ? v : 1;
}

function applyZoom(zoom: number): void {
  // CSS zoom scales layout AND hit-testing consistently; drag.ts divides
  // field-relative coordinates by this factor for the snap grid.
  const mat = document.getElementById('pmMat') as HTMLElement;
  mat.style.zoom = String(zoom);
  // keep the background raster at a crisp visual 1px at any zoom
  mat.style.setProperty('--pm-grid-line', `${1 / zoom}px`);
  const label = document.querySelector<HTMLElement>('.pm-zoom-value');
  if (label) label.textContent = `${Math.round(zoom * 100)}%`;
}

function setZoom(zoom: number): void {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 20) / 20));
  localStorage.setItem(ZOOM_KEY, String(clamped));
  applyZoom(clamped);
  const slider = document.getElementById('pmZoomSlider') as HTMLInputElement | null;
  if (slider) slider.value = String(Math.round(clamped * 100));
}

function renderSortbar(root: HTMLElement, state: PlaymatState): void {
  root.textContent = '';
  const lbl = document.createElement('span');
  lbl.className = 'pm-sort-label';
  lbl.textContent = 'SORT BY';
  root.appendChild(lbl);

  for (const { mode, label } of SORT_MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pm-sort-opt' + (state.sortMode === mode ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => setSortMode(state, mode));
    root.appendChild(b);
  }

  const strip = document.createElement('div');
  strip.className = 'pm-zoom pm-stripctl';
  strip.title = 'Stack spacing — how much of each card peeks out';
  strip.innerHTML = iconSvg('layers');
  const stripSlider = document.createElement('input');
  stripSlider.type = 'range';
  stripSlider.min = String(STRIP_MIN);
  stripSlider.max = String(STRIP_MAX);
  stripSlider.step = '4';
  stripSlider.value = String(currentStrip());
  stripSlider.setAttribute('aria-label', 'Stack spacing');
  stripSlider.addEventListener('input', () => setStrip(Number(stripSlider.value)));
  strip.appendChild(stripSlider);
  root.appendChild(strip);

  const zoom = document.createElement('div');
  zoom.className = 'pm-zoom';
  zoom.title = 'Card size — drag to scale, click the % to reset';
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.id = 'pmZoomSlider';
  slider.min = String(ZOOM_MIN * 100);
  slider.max = String(ZOOM_MAX * 100);
  slider.step = '5';
  slider.value = String(Math.round(currentZoom() * 100));
  slider.setAttribute('aria-label', 'Card size');
  slider.addEventListener('input', () => setZoom(Number(slider.value) / 100));
  const value = document.createElement('button');
  value.type = 'button';
  value.className = 'pm-zoom-value';
  value.textContent = `${Math.round(currentZoom() * 100)}%`;
  value.title = 'Reset to 100%';
  value.addEventListener('click', () => setZoom(1));
  zoom.append(slider, value);
  root.appendChild(zoom);

  const hud = document.createElement('div');
  hud.className = 'pm-hud';
  hud.id = 'pmHud';
  root.appendChild(hud);
}

async function boot(): Promise<void> {
  initToastContainer();
  initCardPreview();

  const deckId = parseDeckIdFromPath();
  const state = deckId ? initState(deckId) : null;
  if (!state) {
    document.getElementById('pmMat')!.innerHTML =
      `<div class="pm-notfound">${iconSvg('cards')}<p>Deck not found on this device.</p><a href="/decks">Back to decks</a></div>`;
    return;
  }

  document.title = `${state.deck.name} — DeckLens Deckbuilder`;

  initUndoStack(() => { /* re-render happens via persistDeck below */ });
  document.addEventListener('keydown', (e) => {
    if (isTypingContext(e.target)) return; // native text undo stays native
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (undo(state.deck)) { persistDeck(state); showToast({ message: 'Undone.', type: 'info', duration: 1500 }); }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      if (redo(state.deck)) { persistDeck(state); showToast({ message: 'Redone.', type: 'info', duration: 1500 }); }
    }
  });

  const header = document.getElementById('pmHeader')!;
  const sortbar = document.getElementById('pmSortbar')!;
  renderHeader(header, state);
  renderSortbar(sortbar, state);

  const rerender = () => {
    renderProgress(state);
    renderSortbar(sortbar, state);
    document.dispatchEvent(new CustomEvent('pm-render-mat'));
  };
  document.addEventListener(EV_DECK_CHANGED, rerender);
  document.addEventListener(EV_CARDS_RESOLVED, rerender);
  document.addEventListener(EV_SORT_CHANGED, rerender);

  // seed first snapshot so Ctrl+Z has a floor
  pushSnapshot(state.deck);

  applyStrip(currentStrip());
  applyZoom(currentZoom());
  initMat(document.getElementById('pmMat')!, state);
  initDrag(document.getElementById('pmMat')!, state);
  initHand(state);
  initDrawers(state);

  void resolveMissing(state).catch(() => {
    showToast({ message: 'Could not load card data.', type: 'error' });
  });

  // expose for debugging
  (window as unknown as { __pm?: PlaymatState }).__pm = state;
  void cardFor; // referenced by downstream modules
}

void boot();
