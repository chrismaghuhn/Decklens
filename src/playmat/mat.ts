// ==================== Playmat Mat Rendering ====================
// Renders the commander zone, the pile projection of the current sort
// mode (flow layout, or absolute grid positions in free mode), the
// maybeboard/sideboard docks and the "New pile" target.

import type { DeckBoard, DeckbuilderCardEntry } from '../deckbuilder/types.js';
import { projectPiles, applyPileOrder, type Pile } from './sort.js';
import { layoutFor, GRID_CELL } from './layout.js';
import { mutateDeck, cardFor, normalizeNameKey, isTypingContext,
  EV_OPEN_COMMANDER_SEARCH, type PlaymatState } from './state.js';
import { showDetailModal, showHoverPreview, hideHoverPreview } from '../deckbuilder/card-preview.js';
import { initContextMenu, showContextMenu } from '../deckbuilder/context-menu.js';
import { showPromptModal } from '../deckbuilder/confirm-modal.js';
import { showToast } from '../deckbuilder/toast.js';
import { iconSvg } from '../shared/icons.js';
import { openArtPicker } from './art-picker.js';
import { openPresetSearch } from './hand.js';
import {
  initSelection, applySelectionStyles, isSelected, selectedNames, selectionSize,
  selectOnly, ctrlToggle, shiftSelect, clearSelection,
} from './selection.js';
import { classifyRoles, ROLE_LABELS, type Role } from '../deckbuilder/role-classifier.js';
import type { DeckbuilderSearchParams } from '../shared/scryfall-client.js';

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

// ── Bulk actions (each is exactly ONE undo step) ──

export function bulkMoveTo(names: string[], to: DeckBoard): void {
  const keys = new Set(names.map(normalizeNameKey));
  mutateDeck(stateRef, (d) => {
    const moving = d.boards.mainboard.filter((e) => keys.has(normalizeNameKey(e.name)));
    d.boards.mainboard = d.boards.mainboard.filter((e) => !keys.has(normalizeNameKey(e.name)));
    for (const e of moving) {
      const existing = d.boards[to].find((x) => normalizeNameKey(x.name) === normalizeNameKey(e.name));
      if (existing) existing.qty += e.qty;
      else d.boards[to].push(e);
    }
  });
  showToast({ message: `${names.length} card${names.length === 1 ? '' : 's'} moved to ${BOARD_LABELS[to]}.`, type: 'success' });
}

export function bulkRemove(names: string[]): void {
  const keys = new Set(names.map(normalizeNameKey));
  mutateDeck(stateRef, (d) => {
    d.boards.mainboard = d.boards.mainboard.filter((e) => !keys.has(normalizeNameKey(e.name)));
  });
  showToast({ message: `${names.length} card${names.length === 1 ? '' : 's'} removed — Ctrl+Z to undo.`, type: 'info' });
}

export function bulkAssignTag(names: string[], tag: string): void {
  const keys = new Set(names.map(normalizeNameKey));
  mutateDeck(stateRef, (d) => {
    for (const e of d.boards.mainboard) {
      if (!keys.has(normalizeNameKey(e.name))) continue;
      if (tag === 'Untagged') e.tags = [];
      else if (!e.tags?.includes(tag)) e.tags = [...(e.tags || []), tag];
    }
  });
}

export function bulkClearTags(names: string[]): void {
  const keys = new Set(names.map(normalizeNameKey));
  mutateDeck(stateRef, (d) => {
    for (const e of d.boards.mainboard) {
      if (keys.has(normalizeNameKey(e.name))) e.tags = [];
    }
  });
}

function showBulkMenu(event: MouseEvent): void {
  document.querySelector('.pm-menu')?.remove();
  const names = selectedNames();
  const menu = document.createElement('div');
  menu.className = 'pm-menu pm-bulk-menu';
  const head = document.createElement('div');
  head.className = 'pm-bulk-head';
  head.textContent = `${names.length} cards`;
  menu.appendChild(head);

  const item = (label: string, fn: () => void): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', () => { menu.remove(); fn(); });
    menu.appendChild(b);
  };
  item('Move to Sideboard', () => bulkMoveTo(names, 'sideboard'));
  item('Move to Maybeboard', () => bulkMoveTo(names, 'maybeboard'));
  item('Add tag …', async () => {
    const tag = (await showPromptModal({
      title: `Tag ${names.length} cards`,
      message: 'Tag to add to every selected card:',
      placeholder: 'e.g. Combo pieces',
    }))?.trim();
    if (tag) bulkAssignTag(names, tag);
  });
  item('Clear tags', () => bulkClearTags(names));
  item('Remove from deck', () => bulkRemove(names));
  item('Clear selection', () => clearSelection());

  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 240)}px`;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 200)}px`;
  menu.style.right = 'auto';
  document.body.appendChild(menu);
  const close = (e: MouseEvent): void => {
    if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('mousedown', close); }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// ── Role targets (Command Zone style template, editable per deck) ──

const TARGET_TEMPLATES: Record<string, Partial<Record<Role, number>>> = {
  'command-zone': { ramp: 10, draw: 12, removal: 12, wipe: 6, land: 38 },
  '8x8': { ramp: 8, draw: 8, removal: 8, wipe: 8, counter: 8, recursion: 8, protection: 8, wincon: 8, land: 35 },
  '7x9': { ramp: 9, draw: 9, removal: 9, wipe: 9, recursion: 9, protection: 9, wincon: 9, land: 36 },
};
const TEMPLATE_LABELS: Record<string, string> = {
  'command-zone': 'Command Zone', '8x8': '8×8', '7x9': '7×9', custom: 'Custom',
};
const DEFAULT_TARGETS = TARGET_TEMPLATES['command-zone'];

function templateKey(): string {
  return `dl_pm_template_${stateRef.deck.id}`;
}

// Scryfall's curated oracle tags give far better role hits than
// hand-rolled oracle-text heuristics.
const ROLE_SEARCH: Partial<Record<Role, DeckbuilderSearchParams>> = {
  ramp: { q: '', raw: 'otag:ramp' },
  draw: { q: '', raw: 'otag:draw' },
  removal: { q: '', raw: 'otag:removal' },
  wipe: { q: '', raw: 'otag:board-wipe' },
  counter: { q: '', raw: 'otag:counterspell' },
  tutor: { q: '', raw: 'otag:tutor' },
  recursion: { q: '', raw: 'otag:recursion' },
  protection: { q: '', raw: 'otag:protection' },
  wincon: { q: '', raw: 'otag:win-condition' },
  land: { q: '', type: 'land' },
};

function targetsKey(): string {
  return `dl_pm_targets_${stateRef.deck.id}`;
}

function loadTargets(): Partial<Record<Role, number>> {
  try {
    const raw = localStorage.getItem(targetsKey());
    if (raw) return JSON.parse(raw) as Partial<Record<Role, number>>;
  } catch { /* corrupt or unavailable */ }
  return { ...DEFAULT_TARGETS };
}

function roleCounts(): Partial<Record<Role, number>> {
  const counts: Partial<Record<Role, number>> = {};
  for (const entry of stateRef.deck.boards.mainboard) {
    const card = cardFor(stateRef, entry.name);
    if (!card) continue;
    // multi-role: a removal spell that draws counts toward both targets
    for (const role of classifyRoles(card)) {
      counts[role] = (counts[role] || 0) + entry.qty;
    }
  }
  return counts;
}

function targetsStrip(): HTMLElement {
  const strip = document.createElement('div');
  strip.className = 'pm-targets';
  const targets = loadTargets();
  const counts = roleCounts();
  const roles = (Object.keys(ROLE_LABELS) as Role[]).filter((r) => (targets[r] ?? 0) > 0);

  const label = document.createElement('span');
  label.className = 'pm-targets-label';
  label.textContent = 'TARGETS';
  label.title = 'Click a chip to search for that role · double-click to edit the target';
  strip.appendChild(label);

  const template = document.createElement('select');
  template.className = 'pm-targets-template';
  template.setAttribute('aria-label', 'Target template');
  const currentTemplate = localStorage.getItem(templateKey()) || 'command-zone';
  for (const [value, name] of Object.entries(TEMPLATE_LABELS)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = name;
    if (value === currentTemplate) opt.selected = true;
    template.appendChild(opt);
  }
  template.addEventListener('change', () => {
    try {
      localStorage.setItem(templateKey(), template.value);
      const preset = TARGET_TEMPLATES[template.value];
      if (preset) localStorage.setItem(targetsKey(), JSON.stringify(preset));
    } catch { /* quota */ }
    renderMat(rootRef, stateRef);
  });
  strip.appendChild(template);

  for (const role of roles) {
    const have = counts[role] || 0;
    const want = targets[role]!;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pm-target-chip' + (have >= want ? ' met' : '');
    chip.innerHTML = `${ROLE_LABELS[role]} <b>${have}/${want}</b>`;
    chip.title = have >= want
      ? `${ROLE_LABELS[role]}: target met`
      : `${ROLE_LABELS[role]}: ${want - have} missing — click to search`;
    chip.addEventListener('click', () => {
      const params = ROLE_SEARCH[role];
      if (params) openPresetSearch(params, `» ${ROLE_LABELS[role]}`);
    });
    chip.addEventListener('dblclick', async () => {
      const input = await showPromptModal({
        title: `Target for ${ROLE_LABELS[role]}`,
        message: 'How many cards of this role should the deck run? (0 hides the chip)',
        defaultValue: String(want),
      });
      if (input === null) return;
      const n = Math.max(0, Math.min(99, Math.round(Number(input)) || 0));
      const next = loadTargets();
      next[role] = n;
      try {
        localStorage.setItem(targetsKey(), JSON.stringify(next));
        localStorage.setItem(templateKey(), 'custom'); // manual edit leaves the preset
      } catch { /* quota */ }
      renderMat(rootRef, stateRef);
    });
    strip.appendChild(chip);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'pm-target-chip pm-target-add';
  add.innerHTML = iconSvg('plus');
  add.title = 'Set a target for another role';
  add.addEventListener('click', async () => {
    const targetsNow = loadTargets();
    const options = (Object.keys(ROLE_LABELS) as Role[])
      .filter((r) => !(targetsNow[r] ?? 0))
      .map((r) => ROLE_LABELS[r]).join(', ');
    const input = await showPromptModal({
      title: 'Add role target',
      message: `Role name (${options}):`,
      placeholder: 'e.g. Counterspells',
    });
    if (!input?.trim()) return;
    const role = (Object.keys(ROLE_LABELS) as Role[])
      .find((r) => ROLE_LABELS[r].toLowerCase() === input.trim().toLowerCase());
    if (!role) { showToast({ message: 'Unknown role.', type: 'error' }); return; }
    targetsNow[role] = targetsNow[role] || 5;
    try {
      localStorage.setItem(targetsKey(), JSON.stringify(targetsNow));
      localStorage.setItem(templateKey(), 'custom');
    } catch { /* quota */ }
    renderMat(rootRef, stateRef);
  });
  strip.appendChild(add);

  return strip;
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

  if (card?.game_changer) {
    const gc = document.createElement('span');
    gc.className = 'pm-gc-badge';
    gc.title = 'Game Changer (Commander Brackets)';
    gc.innerHTML = iconSvg('bolt');
    el.appendChild(gc);
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

  // desktop metaphor: click selects, double-click opens the detail view
  el.addEventListener('click', (e) => {
    if (e.shiftKey) shiftSelect(entry.name);
    else if (e.ctrlKey || e.metaKey) ctrlToggle(entry.name);
    else selectOnly(entry.name);
  });
  el.addEventListener('dblclick', () => {
    const c = cardFor(stateRef, entry.name);
    if (c) showDetailModal(entry.name, c, entryOf(opts.board, entry.name), opts.board);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (isSelected(entry.name) && selectionSize() > 1) {
      showBulkMenu(e);
    } else {
      selectOnly(entry.name);
      showContextMenu(entry.name, opts.board, e);
    }
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
  if (mode === 'role') root.appendChild(targetsStrip());
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

  applySelectionStyles();
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

  initSelection(root, state);
  // with an active selection, right-clicking mat space opens the bulk
  // menu instead of the browser menu (cards have their own handler)
  root.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.pm-card, .pm-dock-row, input, select, textarea, a')) return;
    if (selectionSize() > 1) {
      e.preventDefault();
      showBulkMenu(e);
    } else if (selectionSize() === 1) {
      e.preventDefault();
      showContextMenu(selectedNames()[0], 'mainboard', e);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' && selectionSize() > 0 && !isTypingContext(e.target)) {
      e.preventDefault();
      bulkRemove(selectedNames());
    }
  });
  document.addEventListener('pm-render-mat', () => renderMat(root, state));
  renderMat(root, state);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
