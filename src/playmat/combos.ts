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

const API = 'https://backend.commanderspellbook.com/find-my-combos';

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
let cacheResult: { included: ComboData[]; almost: ComboData[] } | null = null;

function deckSignature(deck: DeckbuilderDeck): string {
  return [...deck.boards.commander, ...deck.boards.mainboard]
    .map((e) => normalizeNameKey(e.name)).sort().join('|');
}

export async function fetchDeckCombos(deck: DeckbuilderDeck): Promise<{ included: ComboData[]; almost: ComboData[] }> {
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
    results?: { included?: RawCombo[]; almostIncluded?: RawCombo[] };
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
  cacheResult = { included, almost };
  return cacheResult;
}

// ── UI ──

let overlayEl: HTMLElement | null = null;
let stateRef: PlaymatState;
let activeTab: 'included' | 'almost' = 'included';
let combosData: { included: ComboData[]; almost: ComboData[] } | null = null;

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
  const combos = activeTab === 'included' ? combosData.included : combosData.almost;

  if (combos.length === 0) {
    body.innerHTML = `<div class="pm-combomat-loading">${activeTab === 'included'
      ? 'No known combos in this deck yet — check the "One card away" tab for ideas.'
      : 'No near-miss combos found.'}</div>`;
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
    fan.appendChild(el);
  }
  tile.appendChild(fan);

  const meta = document.createElement('div');
  meta.className = 'pm-combo-meta';
  meta.innerHTML = `
    <div class="pm-combo-names">${combo.uses.map((u) => u.name.replace(/</g, '&lt;')).join(' + ')}</div>
    <div class="pm-combo-produces">${combo.produces.slice(0, 3).map((p) => `<em>${p.replace(/</g, '&lt;')}</em>`).join('')}</div>`;
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
