// ==================== Playmat Editor Entry ====================

import { initState, mutateDeck, persistDeck, resolveMissing, setSortMode, cardFor,
  EV_DECK_CHANGED, EV_CARDS_RESOLVED, EV_SORT_CHANGED, type PlaymatState } from './state.js';
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
  { mode: 'type', label: 'Kartentyp' },
  { mode: 'mana', label: 'Manakosten' },
  { mode: 'color', label: 'Farbe' },
  { mode: 'role', label: 'Funktion' },
  { mode: 'tags', label: 'Eigene Tags' },
  { mode: 'free', label: 'Frei' },
];

function renderHeader(root: HTMLElement, state: PlaymatState): void {
  root.textContent = '';

  const name = document.createElement('input');
  name.className = 'pm-name';
  name.value = state.deck.name;
  name.maxLength = 100;
  name.setAttribute('aria-label', 'Deckname');
  name.addEventListener('change', () => {
    mutateDeck(state, (d) => { d.name = name.value.trim() || 'Untitled Deck'; });
  });

  const fmt = document.createElement('span');
  fmt.className = 'pm-format';
  fmt.textContent = (state.deck.format || 'commander').toUpperCase();

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
  more.title = 'Deck-Aktionen';
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
    ? 'Commander fehlt noch — Slot links oben auf der Matte'
    : hasCap ? `${total} von ${rules.maxDeckSize} Karten` : `${total} Karten (min. ${rules.minDeckSize})`;
}

function openMoreMenu(anchor: HTMLElement, state: PlaymatState): void {
  document.querySelector('.pm-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'pm-menu';
  const items: Array<[string, () => void]> = [
    ['Zur Deck-Liste', () => { window.location.href = '/decks'; }],
    ['Deck duplizieren', () => {
      const copy = duplicateDeck(state.deck.id);
      if (copy) window.location.href = `/decks/id/${copy.id}`;
    }],
    ['Deck löschen', async () => {
      const ok = await showConfirmModal({
        title: 'Deck löschen?',
        message: `„${state.deck.name}“ wird dauerhaft gelöscht.`,
        confirmLabel: 'Löschen',
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

function renderSortbar(root: HTMLElement, state: PlaymatState): void {
  root.textContent = '';
  const lbl = document.createElement('span');
  lbl.className = 'pm-sort-label';
  lbl.textContent = 'SORTIEREN NACH';
  root.appendChild(lbl);

  for (const { mode, label } of SORT_MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pm-sort-opt' + (state.sortMode === mode ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => setSortMode(state, mode));
    root.appendChild(b);
  }

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
      `<div class="pm-notfound">${iconSvg('cards')}<p>Deck nicht gefunden auf diesem Gerät.</p><a href="/decks">Zur Deck-Liste</a></div>`;
    return;
  }

  document.title = `${state.deck.name} — DeckLens Deckbuilder`;

  initUndoStack(() => { /* re-render happens via persistDeck below */ });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      if (undo(state.deck)) { persistDeck(state); showToast({ message: 'Rückgängig.', type: 'info', duration: 1500 }); }
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      if (redo(state.deck)) { persistDeck(state); showToast({ message: 'Wiederhergestellt.', type: 'info', duration: 1500 }); }
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

  initMat(document.getElementById('pmMat')!, state);
  initDrag(document.getElementById('pmMat')!, state);
  initHand(state);
  initDrawers(state);

  void resolveMissing(state).catch(() => {
    showToast({ message: 'Kartendaten konnten nicht geladen werden.', type: 'error' });
  });

  // expose for debugging
  (window as unknown as { __pm?: PlaymatState }).__pm = state;
  void cardFor; // referenced by downstream modules
}

void boot();
