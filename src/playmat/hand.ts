// ==================== Playmat Search Hand ====================
// The header search feeds a fanned "hand" of results at the bottom
// edge. + or Enter adds the card; drag-to-mat is wired by drag.ts.
// Listening to EV_OPEN_COMMANDER_SEARCH switches the hand into
// commander-pick mode (legendary creatures, + sets the commander).

import { searchDeckbuilderCards, type DeckbuilderSearchCard, type DeckbuilderSearchParams } from '../shared/scryfall-client.js';
import { showToast } from '../deckbuilder/toast.js';
import { showHoverPreview, hideHoverPreview } from '../deckbuilder/card-preview.js';
import { iconSvg } from '../shared/icons.js';
import { EV_OPEN_COMMANDER_SEARCH, normalizeNameKey, type PlaymatState } from './state.js';
import { addCardToDeck, setCommander } from './mat.js';
import { setSelection } from './selection.js';

const PAGE_SIZE = 7;
const DEFAULT_PLACEHOLDER = 'Search cards … Enter adds the top hit';

let stateRef: PlaymatState;
let results: DeckbuilderSearchCard[] = [];
let page = 0;
let commanderMode = false;
let inputEl: HTMLInputElement;
let handRoot: HTMLElement;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;
let hideInDeck = localStorage.getItem('dl_pm_filter_indeck') === '1';
let ciOnly = localStorage.getItem('dl_pm_filter_ci') === '1';
let searchInDeck = false; // session-only: query the deck, highlight on the mat

/** Minimal Scryfall-ish matcher against a resolved deck card. */
function deckCardMatches(query: string, name: string, card: DeckbuilderSearchCard | undefined): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  const typeLine = (card?.type_line || '').toLowerCase();
  const oracle = (card?.oracle_text || '').toLowerCase();
  const lowerName = name.toLowerCase();
  for (const token of tokens) {
    if (token.startsWith('t:')) {
      if (!typeLine.includes(token.slice(2))) return false;
    } else if (token.startsWith('o:')) {
      if (!oracle.includes(token.slice(2))) return false;
    } else {
      const mv = token.match(/^mv(<=|>=|=|<|>)(\d+)$/);
      if (mv && card) {
        const n = Number(mv[2]);
        const c = card.cmc;
        const ok = mv[1] === '<=' ? c <= n : mv[1] === '>=' ? c >= n : mv[1] === '<' ? c < n : mv[1] === '>' ? c > n : c === n;
        if (!ok) return false;
      } else if (!lowerName.includes(token) && !oracle.includes(token)) {
        return false;
      }
    }
  }
  return true;
}

function deckNameKeys(): Set<string> {
  const keys = new Set<string>();
  const b = stateRef.deck.boards;
  for (const entry of [...b.commander, ...b.mainboard, ...b.sideboard, ...b.maybeboard]) {
    keys.add(normalizeNameKey(entry.name));
    keys.add(normalizeNameKey(entry.name.split('//')[0]));
  }
  return keys;
}

function commanderIdentity(): string | undefined {
  const cmd = stateRef.deck.boards.commander[0];
  if (!cmd) return undefined;
  const card = stateRef.cardByName[normalizeNameKey(cmd.name)];
  const ci = card?.color_identity;
  return ci && ci.length > 0 ? ci.join('') : undefined;
}

/** Register a search result so the mat can render it with full card data. */
export function rememberCard(state: PlaymatState, card: DeckbuilderSearchCard): void {
  state.cardByName[normalizeNameKey(card.name)] = card;
}

function addResult(card: DeckbuilderSearchCard): void {
  rememberCard(stateRef, card);
  if (commanderMode) {
    setCommander(card.name);
    commanderMode = false;
    inputEl.value = '';
    inputEl.placeholder = DEFAULT_PLACEHOLDER;
    results = [];
    renderHand();
    return;
  }
  addCardToDeck(card.name);
  showToast({ message: `${card.name} added.`, type: 'success', duration: 1600 });
}

async function runSearch(query: string): Promise<void> {
  const seq = ++searchSeq;
  const q = query.trim();
  if (q.length < 2) {
    results = [];
    renderHand();
    if (searchInDeck) setSelection([]);
    return;
  }
  if (searchInDeck && !commanderMode) {
    // query the deck itself: highlight matches on the mat via selection
    const matches = stateRef.deck.boards.mainboard
      .filter((e) => deckCardMatches(q, e.name, stateRef.cardByName[normalizeNameKey(e.name)]))
      .map((e) => e.name);
    setSelection(matches);
    results = [];
    renderHand();
    return;
  }
  try {
    const res = await searchDeckbuilderCards(
      commanderMode
        ? { q, type: 'legendary creature', legality: 'commander' }
        : { q, colorIdentity: ciOnly ? commanderIdentity() : undefined },
    );
    if (seq !== searchSeq) return; // stale response
    results = res.items;
    if (hideInDeck && !commanderMode) {
      const inDeck = deckNameKeys();
      results = results.filter((c) => !inDeck.has(normalizeNameKey(c.name)));
    }
    page = 0;
    renderHand();
  } catch (err) {
    if (seq !== searchSeq) return;
    showToast({ message: err instanceof Error ? err.message : 'Search failed.', type: 'error' });
  }
}

function renderHand(): void {
  handRoot.textContent = '';
  if (results.length === 0) {
    handRoot.classList.remove('open');
    return;
  }
  handRoot.classList.add('open');

  const label = document.createElement('div');
  label.className = 'pm-hand-label';
  label.textContent = commanderMode
    ? `CHOOSE A COMMANDER — ${results.length} HITS`
    : `YOUR HAND — ${results.length} HITS · + OR DRAG`;
  handRoot.appendChild(label);

  const fan = document.createElement('div');
  fan.className = 'pm-fan';

  const start = page * PAGE_SIZE;
  const visible = results.slice(start, start + PAGE_SIZE);
  const mid = (visible.length - 1) / 2;

  if (page > 0) fan.appendChild(pageBtn('‹', -1));

  visible.forEach((card, i) => {
    const el = document.createElement('div');
    el.className = 'pm-hand-card';
    el.dataset.drag = 'hand-card';
    el.dataset.card = card.name;
    const tilt = (i - mid) * 3.2;
    const lift = Math.abs(i - mid) * 5;
    el.style.transform = `rotate(${tilt}deg) translateY(${lift}px)`;
    const img = card.image_uris?.normal || card.image_uris?.small;
    el.innerHTML = img
      ? `<img src="${img}" alt="" draggable="false">`
      : `<span class="pm-card-name">${card.name.replace(/</g, '&lt;')}</span>`;

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'pm-hand-add';
    add.textContent = '+';
    add.title = commanderMode ? 'Set as commander' : 'Add to deck';
    add.addEventListener('click', (e) => { e.stopPropagation(); addResult(card); });
    el.appendChild(add);

    el.addEventListener('mouseenter', (e) => showHoverPreview(card, e));
    el.addEventListener('mouseleave', () => hideHoverPreview());
    fan.appendChild(el);
  });

  if (start + PAGE_SIZE < results.length) fan.appendChild(pageBtn('›', +1));

  handRoot.appendChild(fan);
}

function pageBtn(glyph: string, dir: number): HTMLElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pm-hand-page';
  b.textContent = glyph;
  b.addEventListener('click', () => { page += dir; renderHand(); });
  return b;
}

export function initHand(state: PlaymatState): void {
  stateRef = state;
  handRoot = document.getElementById('pmHand')!;

  const slot = document.getElementById('pmSearchSlot')!;
  slot.innerHTML = `
    <div class="pm-search">
      <span class="pm-search-lens">${iconSvg('search')}</span>
      <input type="search" id="searchInput" placeholder="${DEFAULT_PLACEHOLDER}" aria-label="Card search">
      <span class="pm-kbd">/</span>
    </div>
    <div class="pm-search-filters">
      <button type="button" data-filter="indeck" class="${hideInDeck ? 'on' : ''}" title="Hide cards already in this deck">Hide in deck</button>
      <button type="button" data-filter="ci" class="${ciOnly ? 'on' : ''}" title="Only cards inside your commander's color identity">Color identity</button>
      <button type="button" data-filter="indeckmode" title="Search the deck instead of Scryfall — matches highlight on the mat (supports t: o: mv<=)">In deck</button>
    </div>`;
  inputEl = slot.querySelector('input')!;

  slot.querySelectorAll<HTMLButtonElement>('.pm-search-filters button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.filter === 'indeck') {
        hideInDeck = !hideInDeck;
        localStorage.setItem('dl_pm_filter_indeck', hideInDeck ? '1' : '0');
        btn.classList.toggle('on', hideInDeck);
      } else if (btn.dataset.filter === 'indeckmode') {
        searchInDeck = !searchInDeck;
        btn.classList.toggle('on', searchInDeck);
        inputEl.placeholder = searchInDeck ? 'Find in deck … (t: o: mv<= and words)' : DEFAULT_PLACEHOLDER;
        if (!searchInDeck) setSelection([]);
      } else {
        ciOnly = !ciOnly;
        localStorage.setItem('dl_pm_filter_ci', ciOnly ? '1' : '0');
        btn.classList.toggle('on', ciOnly);
      }
      if (inputEl.value.trim().length >= 2) void runSearch(inputEl.value);
    });
  });

  inputEl.addEventListener('input', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runSearch(inputEl.value), 250);
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault();
      addResult(results[page * PAGE_SIZE] ?? results[0]);
    }
    if (e.key === 'Escape') {
      commanderMode = false;
      if (searchInDeck) {
        searchInDeck = false;
        document.querySelector('.pm-search-filters button[data-filter="indeckmode"]')?.classList.remove('on');
        setSelection([]);
      }
      inputEl.value = '';
      inputEl.placeholder = DEFAULT_PLACEHOLDER;
      results = [];
      renderHand();
      inputEl.blur();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== inputEl
      && !(document.activeElement instanceof HTMLInputElement)
      && !(document.activeElement instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      inputEl.focus();
    }
    // Ctrl+F: find in THIS deck — matches highlight on the mat
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchInDeck = true;
      document.querySelector('.pm-search-filters button[data-filter="indeckmode"]')?.classList.add('on');
      inputEl.placeholder = 'Find in deck … (t: o: mv<= and words)';
      inputEl.focus();
      inputEl.select();
      if (inputEl.value.trim().length >= 2) void runSearch(inputEl.value);
    }
  });

  document.addEventListener(EV_OPEN_COMMANDER_SEARCH, () => {
    commanderMode = true;
    inputEl.focus();
    inputEl.placeholder = 'Search commander (legendary creature) …';
    if (inputEl.value.trim().length >= 2) void runSearch(inputEl.value);
    else showToast({ message: 'Type a name — only legendary creatures are searched.', type: 'info' });
  });
}

/** Used by drag.ts to look up a dragged hand card. */
export function handCardByName(name: string): DeckbuilderSearchCard | undefined {
  return results.find((c) => c.name === name);
}

/** Run a preset search (e.g. from a role-target chip) and open the hand. */
export function openPresetSearch(params: DeckbuilderSearchParams, label: string): void {
  inputEl.value = label;
  commanderMode = false;
  const seq = ++searchSeq;
  void searchDeckbuilderCards({
    ...params,
    colorIdentity: params.colorIdentity ?? (commanderIdentity() || undefined),
  }).then((res) => {
    if (seq !== searchSeq) return;
    results = res.items;
    if (hideInDeck) {
      const inDeck = deckNameKeys();
      results = results.filter((c) => !inDeck.has(normalizeNameKey(c.name)));
    }
    page = 0;
    renderHand();
  }).catch((err) => {
    if (seq !== searchSeq) return;
    showToast({ message: err instanceof Error ? err.message : 'Search failed.', type: 'error' });
  });
}
