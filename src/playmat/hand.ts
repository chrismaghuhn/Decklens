// ==================== Playmat Search Hand ====================
// The header search feeds a fanned "hand" of results at the bottom
// edge. + or Enter adds the card; drag-to-mat is wired by drag.ts.
// Listening to EV_OPEN_COMMANDER_SEARCH switches the hand into
// commander-pick mode (legendary creatures, + sets the commander).

import { searchDeckbuilderCards, type DeckbuilderSearchCard } from '../shared/scryfall-client.js';
import { showToast } from '../deckbuilder/toast.js';
import { showHoverPreview, hideHoverPreview } from '../deckbuilder/card-preview.js';
import { iconSvg } from '../shared/icons.js';
import { EV_OPEN_COMMANDER_SEARCH, normalizeNameKey, type PlaymatState } from './state.js';
import { addCardToDeck, setCommander } from './mat.js';

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
    return;
  }
  try {
    const res = await searchDeckbuilderCards(
      commanderMode
        ? { q, type: 'legendary creature', legality: 'commander' }
        : { q },
    );
    if (seq !== searchSeq) return; // stale response
    results = res.items;
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
    </div>`;
  inputEl = slot.querySelector('input')!;

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
