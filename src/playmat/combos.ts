// ==================== Combo Mat ====================
// Its own full-screen mat (like the goldfish) fed by Commander
// Spellbook's find-my-combos: one tab for combos the deck already has,
// one for combos a single card away. Clicking a combo opens the step
// player: the pieces lie large on the mat and prev/next walks the
// steps, lighting up (and tapping) the cards each step names.

import type { DeckbuilderDeck } from '../deckbuilder/types.js';
import { resolveDeckbuilderCards, type DeckbuilderSearchCard } from '../shared/scryfall-client.js';
import { showToast } from '../deckbuilder/toast.js';
import { iconSvg } from '../shared/icons.js';
import { normalizeNameKey, type PlaymatState } from './state.js';
import { addCardToDeck } from './mat.js';

// In production the calls go through our worker proxy (Spellbook sends
// no CORS headers for our origin); the dev server talks to it directly.
const DIRECT = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const API = DIRECT
  ? 'https://backend.commanderspellbook.com/find-my-combos'
  : '/api/spellbook/find-my-combos';
const VARIANTS_API = DIRECT
  ? 'https://backend.commanderspellbook.com/variants'
  : '/api/spellbook/variants';
const DISCOVER_PAGE = 24;

export interface ComboData {
  id: string;
  uses: Array<{ name: string; qty: number }>;
  produces: string[];
  steps: string[];
  prereq: string;
  manaNeeded: string;
  popularity: number;
  /** cards the deck does not have (empty = combo is complete) */
  missing: string[];
}

export interface ComboGroup {
  label: string;
  combos: ComboData[];
}

// ── pure normalization (unit-tested) ──

interface RawCombo {
  id?: string | number;
  uses?: Array<{ card?: { name?: string }; quantity?: number }>;
  produces?: Array<{ feature?: { name?: string }; name?: string }>;
  description?: string;
  notablePrerequisites?: string;
  easyPrerequisites?: string;
  manaNeeded?: string;
  popularity?: number | null;
}

export function normalizeCombo(raw: RawCombo, deckNameKeys: Set<string>): ComboData {
  const uses = (raw.uses || [])
    .map((u) => ({ name: u.card?.name || '', qty: u.quantity || 1 }))
    .filter((u) => u.name);
  return {
    id: String(raw.id ?? ''),
    uses,
    produces: (raw.produces || [])
      .map((p) => p.feature?.name || p.name || '')
      .filter(Boolean),
    steps: (raw.description || '').split('\n').map((s) => s.trim()).filter(Boolean),
    prereq: [raw.easyPrerequisites, raw.notablePrerequisites].filter(Boolean).join(' ').trim(),
    manaNeeded: raw.manaNeeded || '',
    popularity: typeof raw.popularity === 'number' ? raw.popularity : 0,
    missing: uses.filter((u) => !deckNameKeys.has(normalizeNameKey(u.name))).map((u) => u.name),
  };
}

const GROUPS: Array<{ label: string; test: (p: string) => boolean }> = [
  { label: 'Wins the game', test: (p) => /win the game|loses? the game/i.test(p) },
  { label: 'Infinite mana', test: (p) => /infinite.*mana/i.test(p) },
  { label: 'Infinite draw', test: (p) => /infinite.*(draw|card)/i.test(p) },
  { label: 'Infinite damage', test: (p) => /infinite.*(damage|burn)/i.test(p) },
  { label: 'Infinite tokens', test: (p) => /infinite.*token/i.test(p) },
];

export function groupCombos(combos: ComboData[]): ComboGroup[] {
  const buckets = new Map<string, ComboData[]>();
  for (const combo of combos) {
    const group = GROUPS.find((g) => combo.produces.some((p) => g.test(p)))?.label ?? 'Value engines';
    buckets.set(group, [...(buckets.get(group) || []), combo]);
  }
  const order = [...GROUPS.map((g) => g.label), 'Value engines'];
  return order
    .filter((label) => buckets.has(label))
    .map((label) => ({
      label,
      combos: buckets.get(label)!.sort((a, b) => b.popularity - a.popularity),
    }));
}

// ── fetching (cached per deck signature) ──

let cacheSig = '';
let cacheResult: { included: ComboData[]; almost: ComboData[]; identity: string } | null = null;

function deckSignature(deck: DeckbuilderDeck): string {
  return [...deck.boards.commander, ...deck.boards.mainboard]
    .map((e) => normalizeNameKey(e.name)).sort().join('|');
}

export async function fetchDeckCombos(deck: DeckbuilderDeck): Promise<{ included: ComboData[]; almost: ComboData[]; identity: string }> {
  const sig = deckSignature(deck);
  if (sig === cacheSig && cacheResult) return cacheResult;

  const payload = {
    commanders: deck.boards.commander.map((e) => ({ card: e.name, quantity: e.qty })),
    main: deck.boards.mainboard.map((e) => ({ card: e.name, quantity: e.qty })),
  };
  const response = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error('Commander Spellbook is not reachable.');
  const data = await response.json() as {
    results?: { included?: RawCombo[]; almostIncluded?: RawCombo[]; identity?: string };
  };

  const deckKeys = new Set([...deck.boards.commander, ...deck.boards.mainboard]
    .map((e) => normalizeNameKey(e.name)));
  const included = (data.results?.included || []).map((r) => normalizeCombo(r, deckKeys));
  const almost = (data.results?.almostIncluded || [])
    .map((r) => normalizeCombo(r, deckKeys))
    .filter((c) => c.missing.length === 1)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, 40);

  cacheSig = sig;
  cacheResult = { included, almost, identity: data.results?.identity || 'wubrg' };
  return cacheResult;
}

/** Browse Spellbook's whole database within a color identity, by popularity. */
export async function fetchDiscoverCombos(
  deck: DeckbuilderDeck,
  identity: string,
  offset: number,
  ordering = '-popularity',
  twoCardsOnly = false,
  finiteOnly = false,
): Promise<{ combos: ComboData[]; hasMore: boolean }> {
  const q = `legal:commander ci<=${identity.toLowerCase() || 'c'}`
    + (twoCardsOnly ? ' cards:2' : '')
    + (finiteOnly ? ' -result:infinite' : '');
  const response = await fetch(
    `${VARIANTS_API}?q=${encodeURIComponent(q)}&limit=${DISCOVER_PAGE}&offset=${offset}&ordering=${encodeURIComponent(ordering)}`,
  );
  if (!response.ok) throw new Error('Commander Spellbook is not reachable.');
  const data = await response.json() as { next?: string | null; results?: RawCombo[] };
  const deckKeys = new Set([...deck.boards.commander, ...deck.boards.mainboard]
    .map((e) => normalizeNameKey(e.name)));
  return {
    combos: (data.results || []).map((r) => normalizeCombo(r, deckKeys)),
    hasMore: Boolean(data.next),
  };
}

// ── UI ──

let overlayEl: HTMLElement | null = null;
let stateRef: PlaymatState;
let activeTab: 'included' | 'almost' | 'discover' = 'included';
let combosData: { included: ComboData[]; almost: ComboData[]; identity: string } | null = null;
let discoverList: ComboData[] = [];
let discoverOffset = 0;
let discoverHasMore = true;
let discoverLoading = false;
let discoverSort = '-popularity';
let discoverTwoOnly = false;
/** hide infinite loops, keep finite finishers (wins, burst plays) */
let finiteOnly = false;
/** almost tab: filter to combos unlocked by this one missing card */
let bestAddFilter: string | null = null;

function resetDiscover(): void {
  discoverList = [];
  discoverOffset = 0;
  discoverHasMore = true;
}

/** Lightbox: show one card large enough to read its text. */
function openCardZoom(name: string): void {
  const card = stateRef.cardByName[normalizeNameKey(name)];
  const img = card?.image_uris?.large || card?.image_uris?.normal;
  if (!img) return;
  document.querySelector('.pm-cardzoom')?.remove();
  const zoom = document.createElement('div');
  zoom.className = 'pm-cardzoom';
  zoom.innerHTML = `<img src="${img}" alt="${name.replace(/"/g, '&quot;')}">`;
  const onZoomKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  const close = (): void => {
    zoom.remove();
    document.removeEventListener('keydown', onZoomKey, true);
  };
  zoom.addEventListener('click', close);
  // capture phase so Escape closes the zoom, not the whole combo mat
  document.addEventListener('keydown', onZoomKey, true);
  document.body.appendChild(zoom);
}

function cardImg(name: string): string | undefined {
  const card = stateRef.cardByName[normalizeNameKey(name)];
  return card?.image_uris?.normal || card?.image_uris?.small;
}

function closeComboMat(): void {
  overlayEl?.remove();
  overlayEl = null;
  document.removeEventListener('keydown', onKey);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation();
    closeComboMat();
  }
}

export async function openComboMat(state: PlaymatState): Promise<void> {
  stateRef = state;
  closeComboMat();

  const overlay = document.createElement('div');
  overlay.className = 'pm-combomat';
  overlay.innerHTML = `
    <header class="pm-combomat-head">
      <h2>${iconSvg('infinity')} Combos</h2>
      <nav class="pm-combomat-tabs">
        <button type="button" data-tab="included" class="on">In deck</button>
        <button type="button" data-tab="almost">One card away</button>
        <button type="button" data-tab="discover">Discover</button>
      </nav>
      <span class="pm-combomat-credit">data: Commander Spellbook</span>
      <button type="button" class="pm-drawer-close" aria-label="Close">✕</button>
    </header>
    <div class="pm-combomat-body"><div class="pm-combomat-loading">${iconSvg('infinity')} Searching for combos …</div></div>`;
  overlay.querySelector('.pm-drawer-close')!.addEventListener('click', closeComboMat);
  overlay.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab as typeof activeTab;
      overlay.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b === btn));
      renderList();
    });
  });
  document.body.appendChild(overlay);
  overlayEl = overlay;
  document.addEventListener('keydown', onKey);

  try {
    combosData = await fetchDeckCombos(state.deck);
  } catch (err) {
    if (overlayEl !== overlay) return;
    overlay.querySelector('.pm-combomat-body')!.innerHTML =
      `<div class="pm-combomat-loading">${err instanceof Error ? err.message : 'Could not load combos.'}</div>`;
    return;
  }
  if (overlayEl !== overlay) return;

  // resolve images for combo cards we do not know yet (missing pieces etc.)
  const unknown = new Set<string>();
  for (const combo of [...combosData.included, ...combosData.almost]) {
    for (const use of combo.uses) {
      if (!stateRef.cardByName[normalizeNameKey(use.name)]) unknown.add(use.name);
    }
  }
  if (unknown.size > 0) {
    try {
      const { resolved } = await resolveDeckbuilderCards([...unknown]);
      for (const [key, card] of Object.entries(resolved)) {
        stateRef.cardByName[normalizeNameKey(key)] = card as DeckbuilderSearchCard;
      }
    } catch { /* thumbnails stay textual */ }
  }
  if (overlayEl !== overlay) return;

  const counts = overlay.querySelectorAll<HTMLButtonElement>('[data-tab]');
  counts[0].textContent = `In deck (${combosData.included.length})`;
  counts[1].textContent = `One card away (${combosData.almost.length})`;
  renderList();
}

function renderList(): void {
  if (!overlayEl || !combosData) return;
  const body = overlayEl.querySelector<HTMLElement>('.pm-combomat-body')!;
  body.textContent = '';
  if (activeTab === 'discover') {
    renderDiscover(body);
    return;
  }
  let combos = activeTab === 'included' ? combosData.included : combosData.almost;

  const bar = document.createElement('div');
  bar.className = 'pm-combo-sortbar';
  const finiteBtn = document.createElement('button');
  finiteBtn.type = 'button';
  finiteBtn.className = finiteOnly ? 'on' : '';
  finiteBtn.textContent = 'No infinites';
  finiteBtn.title = 'Only finite finishers — combos that win or swing the game without an endless loop';
  finiteBtn.addEventListener('click', () => { finiteOnly = !finiteOnly; resetDiscover(); renderList(); });
  bar.appendChild(finiteBtn);
  body.appendChild(bar);

  if (finiteOnly) {
    combos = combos.filter((c) => !c.produces.some((p) => /infinite/i.test(p)));
  }

  // "Best adds": which single card unlocks the most combos
  if (activeTab === 'almost' && combos.length > 0) {
    const unlocks = new Map<string, ComboData[]>();
    for (const combo of combos) {
      const name = combo.missing[0];
      if (!name) continue;
      unlocks.set(name, [...(unlocks.get(name) || []), combo]);
    }
    const ranking = [...unlocks.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8);
    if (ranking.length > 0) {
      const strip = document.createElement('div');
      strip.className = 'pm-bestadds';
      strip.innerHTML = '<h3>Best adds — one card, most combos</h3>';
      const row = document.createElement('div');
      row.className = 'pm-bestadds-row';
      for (const [name, list] of ranking) {
        const eur = Number(stateRef.cardByName[normalizeNameKey(name)]?.prices?.eur);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'pm-bestadd' + (bestAddFilter === name ? ' on' : '');
        const img = cardImg(name);
        chip.innerHTML = `
          ${img ? `<img src="${img}" alt="" loading="lazy">` : ''}
          <span class="pm-bestadd-name">${name.replace(/</g, '&lt;')}</span>
          <span class="pm-bestadd-count">unlocks ${list.length} combo${list.length === 1 ? '' : 's'}${Number.isFinite(eur) ? ` · €${eur.toFixed(2)}` : ''}</span>`;
        chip.querySelector('img')?.addEventListener('click', (e) => {
          e.stopPropagation();
          openCardZoom(name);
        });
        chip.title = 'Click to show only these combos';
        chip.addEventListener('click', () => {
          bestAddFilter = bestAddFilter === name ? null : name;
          renderList();
        });
        row.appendChild(chip);
      }
      strip.appendChild(row);
      body.appendChild(strip);
    }
    if (bestAddFilter) {
      combos = combos.filter((c) => c.missing[0] === bestAddFilter);
    }
  }

  if (combos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pm-combomat-loading';
    empty.textContent = finiteOnly
      ? 'No finite combos here — turn off "No infinites" or check Discover.'
      : activeTab === 'included'
        ? 'No known combos in this deck yet — check the "One card away" tab for ideas.'
        : 'No near-miss combos found.';
    body.appendChild(empty);
    return;
  }

  for (const group of groupCombos(combos)) {
    const section = document.createElement('section');
    section.className = 'pm-combo-group';
    section.innerHTML = `<h3>${group.label} <b>${group.combos.length}</b></h3>`;
    const grid = document.createElement('div');
    grid.className = 'pm-combo-grid';
    for (const combo of group.combos) grid.appendChild(comboTile(combo));
    section.appendChild(grid);
    body.appendChild(section);
  }
}

function renderDiscover(body: HTMLElement): void {
  const bar = document.createElement('div');
  bar.className = 'pm-combo-sortbar';
  const sortChip = (label: string, on: boolean, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = on ? 'on' : '';
    b.textContent = label;
    b.addEventListener('click', () => { fn(); resetDiscover(); void loadDiscoverPage(); });
    return b;
  };
  bar.append(
    sortChip('Popular', discoverSort === '-popularity', () => { discoverSort = '-popularity'; }),
    sortChip('New', discoverSort === '-created', () => { discoverSort = '-created'; }),
    sortChip('2 cards only', discoverTwoOnly, () => { discoverTwoOnly = !discoverTwoOnly; }),
    sortChip('No infinites', finiteOnly, () => { finiteOnly = !finiteOnly; }),
  );
  body.appendChild(bar);

  const section = document.createElement('section');
  section.className = 'pm-combo-group';
  const identity = combosData!.identity.toUpperCase();
  section.innerHTML = `<h3>All Spellbook combos in ${identity || 'C'} <b>${discoverSort === '-created' ? 'newest first' : 'by popularity'}</b></h3>`;
  const grid = document.createElement('div');
  grid.className = 'pm-combo-grid';
  for (const combo of discoverList) grid.appendChild(comboTile(combo));
  section.appendChild(grid);
  body.appendChild(section);

  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'pm-btn pm-combo-more';
  more.textContent = discoverLoading ? 'Loading …' : discoverHasMore ? 'Load more' : 'No more combos';
  more.disabled = discoverLoading || !discoverHasMore;
  more.addEventListener('click', () => { void loadDiscoverPage(); });
  body.appendChild(more);

  if (discoverList.length === 0 && !discoverLoading) void loadDiscoverPage();
}

async function loadDiscoverPage(): Promise<void> {
  if (!combosData || discoverLoading || !discoverHasMore) return;
  discoverLoading = true;
  if (activeTab === 'discover') renderList();
  try {
    const page = await fetchDiscoverCombos(stateRef.deck, combosData.identity, discoverOffset, discoverSort, discoverTwoOnly, finiteOnly);
    discoverList = [...discoverList, ...page.combos];
    discoverOffset += DISCOVER_PAGE;
    discoverHasMore = page.hasMore;
    // resolve thumbnails for the new cards
    const unknown = new Set<string>();
    for (const combo of page.combos) {
      for (const use of combo.uses) {
        if (!stateRef.cardByName[normalizeNameKey(use.name)]) unknown.add(use.name);
      }
    }
    if (unknown.size > 0) {
      const { resolved } = await resolveDeckbuilderCards([...unknown]);
      for (const [key, card] of Object.entries(resolved)) {
        stateRef.cardByName[normalizeNameKey(key)] = card as DeckbuilderSearchCard;
      }
    }
  } catch (err) {
    showToast({ message: err instanceof Error ? err.message : 'Could not load combos.', type: 'error' });
    discoverHasMore = false;
  } finally {
    discoverLoading = false;
    if (activeTab === 'discover') renderList();
  }
}

function comboTile(combo: ComboData): HTMLElement {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'pm-combo-tile';
  const missing = new Set(combo.missing.map(normalizeNameKey));

  const fan = document.createElement('div');
  fan.className = 'pm-combo-fan';
  for (const use of combo.uses) {
    const isMissing = missing.has(normalizeNameKey(use.name));
    const img = cardImg(use.name);
    const el = document.createElement('div');
    el.className = 'pm-combo-thumb' + (isMissing ? ' missing' : '');
    el.innerHTML = img ? `<img src="${img}" alt="" loading="lazy">` : `<span>${use.name.replace(/</g, '&lt;')}</span>`;
    el.title = `Read ${use.name}`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardZoom(use.name);
    });
    fan.appendChild(el);
  }
  tile.appendChild(fan);

  const meta = document.createElement('div');
  meta.className = 'pm-combo-meta';
  const have = combo.uses.length - combo.missing.length;
  meta.innerHTML = `
    <div class="pm-combo-names">${combo.uses.map((u) => u.name.replace(/</g, '&lt;')).join(' + ')}</div>
    <div class="pm-combo-produces">${combo.missing.length > 0 ? `<em class="pm-combo-have">${have}/${combo.uses.length} in deck</em>` : ''}${combo.produces.slice(0, 3).map((p) => `<em>${p.replace(/</g, '&lt;')}</em>`).join('')}</div>`;
  tile.appendChild(meta);

  if (combo.missing.length === 1) {
    const name = combo.missing[0];
    const eur = Number(stateRef.cardByName[normalizeNameKey(name)]?.prices?.eur);
    const add = document.createElement('span');
    add.className = 'pm-combo-add';
    add.textContent = `+ Add ${name}${Number.isFinite(eur) ? ` · €${eur.toFixed(2)}` : ''}`;
    add.addEventListener('click', (e) => {
      e.stopPropagation();
      addCardToDeck(name);
      showToast({ message: `${name} added — combo complete!`, type: 'success' });
      combo.missing = [];
      if (combosData) {
        combosData.almost = combosData.almost.filter((c) => c !== combo);
        combosData.included = [combo, ...combosData.included];
        const tabs = overlayEl!.querySelectorAll<HTMLButtonElement>('[data-tab]');
        tabs[0].textContent = `In deck (${combosData.included.length})`;
        tabs[1].textContent = `One card away (${combosData.almost.length})`;
      }
      renderList();
    });
    tile.appendChild(add);
  }

  tile.addEventListener('click', () => renderPlayer(combo));
  return tile;
}

// ── step player ──

function renderPlayer(combo: ComboData): void {
  if (!overlayEl) return;
  const body = overlayEl.querySelector<HTMLElement>('.pm-combomat-body')!;
  body.textContent = '';
  let step = -1; // -1 = setup view
  let autoTimer: ReturnType<typeof setInterval> | null = null;

  const stage = document.createElement('div');
  stage.className = 'pm-combo-stage';

  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'pm-btn pm-combo-back';
  back.innerHTML = '‹ All combos';
  back.addEventListener('click', () => { if (autoTimer) clearInterval(autoTimer); renderList(); });
  stage.appendChild(back);

  const table = document.createElement('div');
  table.className = 'pm-combo-table';
  const missing = new Set(combo.missing.map(normalizeNameKey));
  const cardEls = new Map<string, HTMLElement>();
  for (const use of combo.uses) {
    const img = cardImg(use.name);
    const el = document.createElement('div');
    el.className = 'pm-combo-bigcard' + (missing.has(normalizeNameKey(use.name)) ? ' missing' : '');
    el.innerHTML = (img ? `<img src="${img}" alt="" draggable="false">` : `<span>${use.name.replace(/</g, '&lt;')}</span>`)
      + `<label>${use.name.replace(/</g, '&lt;')}</label>`;
    el.title = `Click to read ${use.name}`;
    el.addEventListener('click', () => openCardZoom(use.name));
    cardEls.set(normalizeNameKey(use.name), el);
    table.appendChild(el);
  }
  stage.appendChild(table);

  const panel = document.createElement('div');
  panel.className = 'pm-combo-panel';
  const produces = combo.produces.map((p) => `<em>${p.replace(/</g, '&lt;')}</em>`).join('');
  panel.innerHTML = `
    <div class="pm-combo-produces">${produces}</div>
    ${combo.prereq ? `<div class="pm-combo-prereq">Prerequisites: ${combo.prereq.replace(/</g, '&lt;')}${combo.manaNeeded ? ` · Mana needed: ${combo.manaNeeded.replace(/</g, '&lt;')}` : ''}</div>` : ''}
    <ol class="pm-combo-steps">${combo.steps.map((s) => `<li>${s.replace(/</g, '&lt;')}</li>`).join('')}</ol>
    <div class="pm-combo-controls">
      <button type="button" class="pm-btn" data-act="prev">‹ Prev</button>
      <button type="button" class="pm-btn pm-btn-primary" data-act="next">Play ▸</button>
      <button type="button" class="pm-btn" data-act="auto">Auto</button>
      <a class="pm-btn" href="https://commanderspellbook.com/combo/${encodeURIComponent(combo.id)}/" target="_blank" rel="noopener">Spellbook ↗</a>
    </div>`;
  stage.appendChild(panel);
  body.appendChild(stage);

  const stepEls = [...panel.querySelectorAll<HTMLElement>('.pm-combo-steps li')];

  function showStep(next: number): void {
    step = Math.max(-1, Math.min(combo.steps.length - 1, next));
    stepEls.forEach((el, i) => el.classList.toggle('on', i === step));
    if (step >= 0) stepEls[step].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const text = step >= 0 ? combo.steps[step].toLowerCase() : '';
    for (const [key, el] of cardEls) {
      const plain = key.split('//')[0].trim();
      const mentioned = step >= 0 && (text.includes(plain) || text.includes(key));
      el.classList.toggle('lit', mentioned);
      el.classList.toggle('tapped', mentioned && /\btap|{t}/.test(text) && !/untap/.test(text));
      if (step < 0) el.classList.remove('lit', 'tapped');
    }
    (panel.querySelector('[data-act="next"]') as HTMLButtonElement).textContent =
      step >= combo.steps.length - 1 ? 'Restart ↺' : step < 0 ? 'Play ▸' : 'Next ▸';
  }

  panel.querySelector('[data-act="prev"]')!.addEventListener('click', () => showStep(step - 1));
  panel.querySelector('[data-act="next"]')!.addEventListener('click', () => {
    showStep(step >= combo.steps.length - 1 ? -1 : step + 1);
  });
  panel.querySelector('[data-act="auto"]')!.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
      btn.classList.remove('on');
      return;
    }
    btn.classList.add('on');
    showStep(step + 1);
    autoTimer = setInterval(() => {
      if (step >= combo.steps.length - 1) {
        clearInterval(autoTimer!);
        autoTimer = null;
        btn.classList.remove('on');
        return;
      }
      showStep(step + 1);
    }, 2600);
  });

  showStep(-1);
}
