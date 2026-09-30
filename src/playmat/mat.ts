// ==================== Playmat Mat Rendering ====================
// Renders the commander zone, the pile projection of the current sort
// mode (flow layout, or absolute grid positions in free mode), the
// maybeboard/sideboard docks and the "New pile" target.

import type { DeckBoard, DeckbuilderCardEntry } from '../deckbuilder/types.js';
import { projectPiles, applyPileOrder, type Pile } from './sort.js';
import { layoutFor, GRID_CELL } from './layout.js';
import { mutateDeck, cardFor, normalizeNameKey,
  EV_OPEN_COMMANDER_SEARCH, type PlaymatState } from './state.js';
import { showDetailModal, showHoverPreview, hideHoverPreview } from '../deckbuilder/card-preview.js';
import { initContextMenu, showContextMenu } from '../deckbuilder/context-menu.js';
import { showPromptModal } from '../deckbuilder/confirm-modal.js';
import { showToast } from '../deckbuilder/toast.js';
import { iconSvg } from '../shared/icons.js';
import { openArtPicker } from './art-picker.js';

const BOARD_LABELS: Record<DeckBoard, string> = {
  commander: 'Commander',
  mainboard: 'Mainboard',
  sideboard: 'Sideboard',
  maybeboard: 'Maybeboard',
};

let stateRef: PlaymatState;
let rootRef: HTMLElement;
let openDock: DeckBoard | null = null;
const pendingTags = new Set<string>();
let collapsedPiles = new Set<string>();

function collapsedStorageKey(): string {
  return `dl_pm_collapsed_${stateRef.deck.id}`;
}

function loadCollapsedPiles(): void {
  try {
    const raw = localStorage.getItem(collapsedStorageKey());
    collapsedPiles = new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    collapsedPiles = new Set();
  }
}

function toggleCollapsed(pileId: string): void {
  if (collapsedPiles.has(pileId)) collapsedPiles.delete(pileId);
  else collapsedPiles.add(pileId);
  try {
    localStorage.setItem(collapsedStorageKey(), JSON.stringify([...collapsedPiles]));
  } catch { /* storage unavailable */ }
  renderMat(rootRef, stateRef);
}

function pileIdFor(label: string): string {
  return `pile-${label.toLowerCase().replace(/[^a-z0-9+]+/g, '-')}`;
}

function entryOf(board: DeckBoard, name: string): DeckbuilderCardEntry | null {
  const key = normalizeNameKey(name);
  return stateRef.deck.boards[board].find((e) => normalizeNameKey(e.name) === key) ?? null;
}

function changeQty(name: string, board: DeckBoard, delta: number): void {
  mutateDeck(stateRef, (d) => {
    const key = normalizeNameKey(name);
    const list = d.boards[board];
    const e = list.find((x) => normalizeNameKey(x.name) === key);
    if (!e) return;
    e.qty += delta;
    if (e.qty <= 0) d.boards[board] = list.filter((x) => x !== e);
  });
}

function moveTo(name: string, from: DeckBoard, to: DeckBoard): void {
  mutateDeck(stateRef, (d) => {
    const key = normalizeNameKey(name);
    const e = d.boards[from].find((x) => normalizeNameKey(x.name) === key);
    if (!e) return;
    d.boards[from] = d.boards[from].filter((x) => x !== e);
    const existing = d.boards[to].find((x) => normalizeNameKey(x.name) === key);
    if (existing) existing.qty += e.qty;
    else d.boards[to].push(e);
  });
}

async function editTags(name: string, board: DeckBoard): Promise<void> {
  const entry = entryOf(board, name);
  if (!entry) return;
  const input = await showPromptModal({
    title: `Tags for ${name}`,
    message: 'Comma-separated, e.g. Combo, Removal',
    placeholder: 'Tag1, Tag2',
    defaultValue: (entry.tags || []).join(', '),
  });
  if (input === null) return;
  mutateDeck(stateRef, () => {
    entry.tags = input.split(',').map((t) => t.trim()).filter(Boolean);
  });
}

export function addCardToDeck(name: string, board: DeckBoard = 'mainboard', tag?: string): void {
  mutateDeck(stateRef, (d) => {
    const key = normalizeNameKey(name);
    const list = d.boards[board];
    const existing = list.find((x) => normalizeNameKey(x.name) === key);
    if (existing) existing.qty += 1;
    else list.push({ name, qty: 1, set: null, collectorNumber: null, tags: tag ? [tag] : [] });
    if (tag) {
      const e = list.find((x) => normalizeNameKey(x.name) === key)!;
      if (!e.tags?.includes(tag)) e.tags = [...(e.tags || []), tag];
    }
  });
}

export function setCommander(name: string): void {
  mutateDeck(stateRef, (d) => {
    d.boards.commander = [{ name, qty: 1, set: null, collectorNumber: null, tags: [] }];
  });
  showToast({ message: `${name} is now your commander.`, type: 'success' });
}

/** Assign a tag by dropping onto a pile in tags mode. */
export function assignTag(name: string, tag: string): void {
  const entry = entryOf('mainboard', name);
  if (!entry) return;
  mutateDeck(stateRef, () => {
    if (tag === 'Untagged') entry.tags = [];
    else if (!entry.tags?.includes(tag)) entry.tags = [...(entry.tags || []), tag];
  });
}

// ── Rendering ──

function cardEl(entry: DeckbuilderCardEntry, opts: { eager: boolean; board: DeckBoard }): HTMLElement {
  const card = cardFor(stateRef, entry.name);
  const el = document.createElement('div');
  el.className = 'pm-card';
  el.dataset.card = entry.name;
  el.dataset.board = opts.board;
  el.dataset.drag = 'card';

  const img = card?.image_uris?.normal || card?.image_uris?.small;
  if (img) {
    el.innerHTML = `<img src="${img}" alt="" loading="${opts.eager ? 'eager' : 'lazy'}" draggable="false">`;
  } else {
    el.classList.add('pm-card-text');
    el.innerHTML = `<span class="pm-card-name">${escapeHtml(entry.name)}</span>`;
  }
  if (entry.qty > 1) {
    const q = document.createElement('span');
    q.className = 'pm-qty';
    q.textContent = `×${entry.qty}`;
    el.appendChild(q);
  }

  const qtybar = document.createElement('div');
  qtybar.className = 'pm-card-qtybar';
  for (const [glyph, delta, title] of [['−', -1, 'Remove one copy'], ['+', 1, 'Add one copy']] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = glyph;
    b.title = title;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      changeQty(entry.name, opts.board, delta);
    });
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    qtybar.appendChild(b);
  }
  el.appendChild(qtybar);

  el.addEventListener('click', () => {
    const c = cardFor(stateRef, entry.name);
    if (c) showDetailModal(entry.name, c, entryOf(opts.board, entry.name), opts.board);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(entry.name, opts.board, e);
  });
  el.addEventListener('mouseenter', (e) => {
    const c = cardFor(stateRef, entry.name);
    if (c) showHoverPreview(c, e);
  });
  el.addEventListener('mouseleave', () => hideHoverPreview());
  return el;
}

function pileEl(pile: Pile, opts: { free: boolean }): HTMLElement {
  const el = document.createElement('section');
  el.className = 'pm-pile';
  el.dataset.pile = pile.id;
  el.dataset.pileLabel = pile.label;

  const collapsed = collapsedPiles.has(pile.id);
  if (collapsed) el.classList.add('pm-pile-collapsed');

  const head = document.createElement('header');
  head.className = 'pm-pile-head';
  head.dataset.drag = 'pile';
  head.title = 'Drag to move · double-click to collapse';
  head.innerHTML = `<span>${escapeHtml(pile.label.toUpperCase())}</span><b>${pile.count}</b>`;
  head.addEventListener('dblclick', () => toggleCollapsed(pile.id));
  el.appendChild(head);

  if (!collapsed) {
    const stack = document.createElement('div');
    stack.className = 'pm-stack';
    pile.entries.forEach((entry, i) => {
      stack.appendChild(cardEl(entry, { eager: i === pile.entries.length - 1, board: 'mainboard' }));
    });
    el.appendChild(stack);
  }
  return el;
}

function commanderZone(): HTMLElement {
  const zone = document.createElement('div');
  zone.className = 'pm-cmdzone';
  const rulesFormat = stateRef.deck.format || 'commander';
  if (rulesFormat !== 'commander') {
    zone.classList.add('hidden');
    return zone;
  }

  const label = document.createElement('div');
  label.className = 'pm-zone-label';
  label.textContent = 'COMMANDER';
  zone.appendChild(label);

  const cmd = stateRef.deck.boards.commander[0];
  if (cmd) {
    const card = cardFor(stateRef, cmd.name);
    const el = document.createElement('div');
    el.className = 'pm-cmdcard';
    const img = card?.image_uris?.normal;
    el.innerHTML = img
      ? `<img src="${img}" alt="" draggable="false"><span class="pm-cmdname">${escapeHtml(cmd.name)}</span>`
      : `<span class="pm-cmdname">${escapeHtml(cmd.name)}</span>`;
    el.addEventListener('click', () => { if (card) showDetailModal(cmd.name, card, cmd, 'commander'); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showContextMenu(cmd.name, 'commander', e); });
    zone.appendChild(el);
  } else {
    const slot = document.createElement('button');
    slot.type = 'button';
    slot.className = 'pm-cmdslot';
    slot.innerHTML = `${iconSvg('sparkle')}<span>Choose<br>commander</span>`;
    slot.addEventListener('click', () => document.dispatchEvent(new CustomEvent(EV_OPEN_COMMANDER_SEARCH)));
    zone.appendChild(slot);
  }
  return zone;
}

function dockEl(board: 'maybeboard' | 'sideboard'): HTMLElement {
  const entries = stateRef.deck.boards[board];
  const dock = document.createElement('div');
  dock.className = 'pm-dock' + (openDock === board ? ' open' : '');

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'pm-dock-chip';
  chip.innerHTML = `${iconSvg('layers')} ${BOARD_LABELS[board]} <b>${entries.reduce((s, e) => s + e.qty, 0)}</b>`;
  chip.addEventListener('click', () => {
    openDock = openDock === board ? null : board;
    renderMat(rootRef, stateRef);
  });
  dock.appendChild(chip);

  if (openDock === board) {
    const tray = document.createElement('div');
    tray.className = 'pm-dock-tray';
    if (entries.length === 0) {
      tray.innerHTML = '<span class="pm-dock-empty">Empty — move cards here via the context menu.</span>';
    }
    for (const e of entries) {
      const row = document.createElement('div');
      row.className = 'pm-dock-row';
      row.innerHTML = `<span class="q">${e.qty}</span><span class="n">${escapeHtml(e.name)}</span>`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.title = 'Move to mainboard';
      btn.textContent = '→ Main';
      btn.addEventListener('click', () => moveTo(e.name, board, 'mainboard'));
      row.appendChild(btn);
      row.addEventListener('contextmenu', (ev) => { ev.preventDefault(); showContextMenu(e.name, board, ev); });
      tray.appendChild(row);
    }
    dock.appendChild(tray);
  }
  return dock;
}

export function renderMat(root: HTMLElement, state: PlaymatState): void {
  stateRef = state;
  rootRef = root;
  root.textContent = '';
  root.classList.toggle('pm-mat-free', state.sortMode === 'free');

  root.appendChild(commanderZone());

  // free mode inherits the grouping of the last non-free sort mode
  const mode = state.sortMode === 'free' ? state.freeBase : state.sortMode;
  let piles = projectPiles(state.deck, state.cardByName, mode);
  if (state.sortMode !== 'free') {
    piles = applyPileOrder(piles, state.deck.pileOrders?.[state.sortMode]);
  }

  // Freshly created (still empty) tag piles live only in this session;
  // once a card carries the tag, the projection takes over.
  if (state.sortMode === 'tags') {
    for (const tag of [...pendingTags]) {
      const id = pileIdFor(tag);
      if (piles.some((p) => p.id === id)) pendingTags.delete(tag);
      else piles.push({ id, label: tag, entries: [], count: 0 });
    }
  }

  const field = document.createElement('div');
  field.className = 'pm-field';
  root.appendChild(field);

  if (state.sortMode === 'free') {
    const layout = layoutFor(state.deck, piles);
    const posOf = new Map(layout.piles.map((p) => [p.id, p]));
    for (const pile of piles) {
      const el = pileEl(pile, { free: true });
      const pos = posOf.get(pile.id);
      if (pos) {
        el.style.left = `${pos.col * GRID_CELL}px`;
        el.style.top = `${pos.row * GRID_CELL}px`;
      }
      field.appendChild(el);
    }
    // persist a seeded layout once so reloads are stable
    if (!state.deck.matLayout) {
      state.deck.matLayout = layout;
    }
  } else {
    for (const pile of piles) field.appendChild(pileEl(pile, { free: false }));
  }

  if (state.sortMode === 'tags' || state.sortMode === 'free') {
    const ghost = document.createElement('button');
    ghost.type = 'button';
    ghost.className = 'pm-ghost-pile';
    ghost.innerHTML = `${iconSvg('plus')}<span>New pile</span>`;
    ghost.dataset.pile = 'pile-new';
    ghost.addEventListener('click', async () => {
      const tag = (await showPromptModal({
        title: 'New pile',
        message: 'Tag name for this pile:',
        placeholder: 'e.g. Combo pieces',
      }))?.trim();
      if (!tag) return;
      if (state.sortMode !== 'tags') {
        showToast({ message: 'Switch to "Custom Tags" to use tag piles.', type: 'info' });
        return;
      }
      pendingTags.add(tag);
      renderMat(rootRef, stateRef);
      showToast({ message: `Pile "${tag}" created — drag cards onto it to tag them.`, type: 'success' });
    });
    field.appendChild(ghost);
  }

  const docks = document.createElement('div');
  docks.className = 'pm-docks';
  docks.append(dockEl('maybeboard'), dockEl('sideboard'));
  root.appendChild(docks);
}

export function initMat(root: HTMLElement, state: PlaymatState): void {
  stateRef = state;
  rootRef = root;
  loadCollapsedPiles();

  // one-time layout reset: seeds before v2 wrapped piles into overlapping
  // rows; re-seed once so every deck starts from the clean top-aligned row
  try {
    const versionKey = `dl_pm_layoutv_${state.deck.id}`;
    if (localStorage.getItem(versionKey) !== '2') {
      state.deck.matLayout = undefined;
      localStorage.setItem(versionKey, '2');
    }
  } catch { /* storage unavailable */ }

  initContextMenu({
    onMoveTo: (name, from, to) => moveTo(name, from, to),
    onQtyChange: (name, board, delta) => changeQty(name, board, delta),
    onRemove: (name, board) => changeQty(name, board, -9999),
    onEditTags: (name, board) => { void editTags(name, board); },
    onChangeArt: (name, board) => { void openArtPicker(stateRef, name, board); },
    getScryfallUrl: (name) => {
      const c = cardFor(state, name);
      return c?.set && c?.collector_number
        ? `https://scryfall.com/card/${c.set}/${c.collector_number}`
        : `https://scryfall.com/search?q=${encodeURIComponent(name)}`;
    },
    boardOrder: ['commander', 'mainboard', 'maybeboard', 'sideboard'],
    boardLabels: BOARD_LABELS,
  });

  document.addEventListener('pm-render-mat', () => renderMat(root, state));
  renderMat(root, state);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
