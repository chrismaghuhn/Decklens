// ==================== YGO Application (Full Extraction) ====================
// Source: yugioh.html lines 1329-4257
// NOTE: This preserves the EXACT behavior of the original inline code.
// Step B (DOM Policy): Migrating innerHTML to h() helper for XSS-safe rendering.
// Sprint 2 S2-A3: Using STORAGE_KEYS instead of magic strings.

import { h, replaceChildren, fragment, mapChildren } from '../shared/dom.js';
import { STORAGE_KEYS, storageGet, storageSet, storageRemove } from '../shared/storage.js';
import { escapeHtml, sanitizeUrl } from '../shared/utils.js';
import { 
  compareDecksDiff, 
  renderDeckComparison, 
  createDiffSummary,
  injectComparisonStyles,
  type DeckZones,
  type DeckEntry as CompDeckEntry
} from '../shared/features/deck-comparison.js';
import {
  generatePrintHTML,
  injectProxyStyles,
  type ProxyCard,
  type ProxySheetOptions,
} from '../shared/features/print-proxy.js';

// ==================== TYPES ====================

interface YGODeck {
  main: number[];
  extra: number[];
  side: number[];
}

interface YGOCard {
  id: number;
  name: string;
  type: string;
  desc: string;
  atk?: number;
  def?: number;
  level?: number;
  race: string;
  attribute?: string;
  archetype?: string;
  card_prices?: Array<{
    cardmarket_price?: string;
    tcgplayer_price?: string;
  }>;
  card_images?: Array<{
    image_url?: string;
    image_url_small?: string;
    image_url_cropped?: string;
  }>;
  banlist_info?: {
    ban_tcg?: string;
    ban_ocg?: string;
    ban_goat?: string;
  };
  misc_info?: Array<{
    formats?: string[];
    treated_as?: string;
  }>;
}

type CardMap = Record<number, YGOCard>;

interface TestHandState {
  cards: number[];
  graded: string[];
  mulligans: number;
  totalDrawn: number;
  grades: Record<string, number>;
}

interface HyperCategory {
  id: string;
  name: string;
  cards: number[];
  target: number;
}

interface ComboRequirement {
  type: 'any' | 'all' | 'count';
  cards: number[];
  count?: number;
}

interface ComboLine {
  id: string;
  name: string;
  requirements: ComboRequirement[];
}

interface DeckVersion {
  name: string;
  deck: YGODeck;
  ts: number;
}

// ==================== GLOBALS ====================
const API = 'https://db.ygoprodeck.com/api/v7/cardinfo.php';
let currentDeck: YGODeck | null = null;
let currentCardMap: CardMap | null = null;
let currentDeckName = '';
let currentView = 'cards';
let currentTypeFilter = 'all';
let banlistData: Record<string, Record<number, string>> = {};
let currentBanlist = 'tcg';
const banlistCache: Record<string, Record<number, string>> = {};

// Comparison state
let compareDeck: YGODeck | null = null;
let compareDeckName = '';

// Test hand state
const testHandState: TestHandState = {
  cards: [],
  graded: [],
  mulligans: 0,
  totalDrawn: 0,
  grades: {}
};

// Hypergeometric categories
const hyperCategories: HyperCategory[] = [];

// Combo lines
const comboLineData: ComboLine[] = [];

// ==================== UTILS ====================
export const $ = (id: string): HTMLElement | null => document.getElementById(id);
export const show = (el: HTMLElement | null, cls = 'active'): void => { el?.classList.add(cls); };
export const hide = (el: HTMLElement | null, cls = 'active'): void => { el?.classList.remove(cls); };

export function showError(msg: string): void {
  const el = $('errorMsg');
  if (el) { el.textContent = msg; show(el); }
}
export function clearError(): void { hide($('errorMsg')); }
export function showToast(msg: string): void {
  const t = $('toast');
  if (t) { t.textContent = msg; show(t, 'show'); setTimeout(() => hide(t, 'show'), 2200); }
}

// ==================== COMPARISON HELPERS ====================
/**
 * Convert a YGO deck (card IDs) to DeckZones format (card names) for comparison.
 * Maps: main+extra → main, side → sideboard, commander is empty for YGO.
 */
function ygoDeckToZones(deck: YGODeck, cardMap: CardMap | null): DeckZones {
  const toEntries = (ids: number[]): CompDeckEntry[] => {
    // Count occurrences of each ID
    const counts = new Map<number, number>();
    for (const id of ids) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    
    const entries: CompDeckEntry[] = [];
    for (const [id, qty] of counts) {
      const card = cardMap?.[id];
      const name = card?.name || `Card #${id}`;
      entries.push({ name, qty });
    }
    return entries;
  };
  
  return {
    main: toEntries([...deck.main, ...deck.extra]), // Combine main + extra
    sideboard: toEntries(deck.side),
    commander: [], // YGO has no commander
  };
}

// ==================== SHARED UTILITIES (from first script block) ====================
async function fetchWithBackoff(url: string, options: RequestInit = {}, maxRetries = 4, baseDelayMs = 200): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;
    lastError = new Error(`HTTP 429 (attempt ${attempt + 1}/${maxRetries + 1})`);
    if (attempt === maxRetries) break;
    const retryAfter = response.headers.get('Retry-After');
    const delayMs = retryAfter ? Math.min(Number(retryAfter) * 1000, 30000) || baseDelayMs * 2 ** attempt : baseDelayMs * 2 ** attempt;
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw lastError!;
}

// NOTE: escapeHtml and sanitizeUrl imported from ../shared/utils.js

// ==================== VIRTUAL SCROLL (CHUNKED RENDERING) ====================
const CHUNK_SIZE = 60;
const CHUNK_BUFFER_PX = 400;

type RenderFn = (batch: YGOCard[], countsFn: () => Record<number, number>) => string;

class ChunkedRenderer {
  container: HTMLElement;
  items: YGOCard[];
  renderFn: RenderFn;
  countsFn: () => Record<number, number>;
  chunkSize: number;
  rendered: number;
  observer: IntersectionObserver | null;
  sentinel: HTMLDivElement | null;

  constructor(container: HTMLElement, items: YGOCard[], renderFn: RenderFn, countsFn: () => Record<number, number>, chunkSize = CHUNK_SIZE) {
    this.container = container;
    this.items = items;
    this.renderFn = renderFn;
    this.countsFn = countsFn;
    this.chunkSize = chunkSize;
    this.rendered = 0;
    this.observer = null;
    this.sentinel = null;
  }

  start(): void {
    this.rendered = 0;
    this._renderNext();
    if (this.rendered < this.items.length) this._observeSentinel();
  }

  _renderNext(): void {
    const batch = this.items.slice(this.rendered, this.rendered + this.chunkSize);
    if (batch.length === 0) return;
    const html = this.renderFn(batch, this.countsFn);
    const wrapper = this.container.querySelector('.card-grid, .ygo-grid, .card-table-wrap');
    if (wrapper && this.rendered > 0) {
      const tbody = wrapper.querySelector('tbody');
      if (tbody) {
        const temp = document.createElement('template');
        temp.innerHTML = html.replace(/.*?<tbody>/s, '').replace(/<\/tbody>.*/s, ''); // SAFE: html from renderFn uses escapeHtml
        tbody.appendChild(temp.content);
      } else {
        const temp = document.createElement('template');
        const innerHtml = html.replace(/^<div class="[^"]*">/, '').replace(/<\/div>$/, '');
        temp.innerHTML = innerHtml; // SAFE: innerHtml from renderFn uses escapeHtml
        wrapper.appendChild(temp.content);
      }
    } else {
      this.container.insertAdjacentHTML('beforeend', html); // SAFE: html from renderFn uses escapeHtml
    }
    this.rendered += batch.length;
    if (this.rendered >= this.items.length) this._removeSentinel();
    else this._placeSentinel();
  }

  _placeSentinel(): void {
    if (!this.sentinel) {
      this.sentinel = document.createElement('div');
      this.sentinel.className = 'chunk-sentinel';
      this.sentinel.style.height = '1px';
    }
    this.container.appendChild(this.sentinel);
  }

  _removeSentinel(): void {
    if (this.sentinel?.parentNode) this.sentinel.remove();
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
  }

  _observeSentinel(): void {
    this._placeSentinel();
    this.observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) {
        this._renderNext();
        if (this.rendered >= this.items.length) this._removeSentinel();
      }
    }, { rootMargin: `${CHUNK_BUFFER_PX}px` });
    if (this.sentinel) this.observer.observe(this.sentinel);
  }

  destroy(): void { this._removeSentinel(); }
}

let _activeChunkers: ChunkedRenderer[] = [];
export function cleanupChunkers(): void { _activeChunkers.forEach(c => c.destroy()); _activeChunkers = []; }

// ==================== LAZY PANEL INIT ====================
interface LazyElement extends HTMLElement {
  _lazyInit?: () => void;
}

const _lazyPanelObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      const el = entry.target as LazyElement;
      const initFn = el._lazyInit;
      if (initFn) { initFn(); delete el._lazyInit; }
      _lazyPanelObserver.unobserve(el);
    }
  }
}, { rootMargin: '200px' });

function registerLazyPanel(elementId: string, initFn: () => void): void {
  const el = $(elementId) as LazyElement;
  if (!el) return;
  el._lazyInit = initFn;
  _lazyPanelObserver.observe(el);
}

// ==================== THEME ====================
export function toggleTheme(): void {
  const body = document.body;
  const isDark = body.dataset.theme === 'dark';
  body.dataset.theme = isDark ? 'light' : 'dark';
  const btn = $('btnTheme');
  if (btn) btn.textContent = isDark ? 'â˜€ï¸' : 'ðŸŒ™';
  storageSet(STORAGE_KEYS.THEME, body.dataset.theme);
}

function initTheme(): void {
  const saved = storageGet<string>(STORAGE_KEYS.THEME, '');
  if (saved) {
    document.body.dataset.theme = saved;
    const btn = $('btnTheme');
    if (btn) btn.textContent = saved === 'dark' ? 'ðŸŒ™' : 'â˜€ï¸';
  }
}

// ==================== RECENT DECKS ====================
interface RecentDeck {
  name: string;
  deck: YGODeck;
  ts: number;
}

function getRecent(): RecentDeck[] {
  return storageGet<RecentDeck[]>(STORAGE_KEYS.YGO_RECENT, []);
}

function saveRecent(name: string, deck: YGODeck): void {
  let recent = getRecent().filter(r => r.name !== name);
  recent.unshift({ name, deck, ts: Date.now() });
  if (recent.length > 8) recent = recent.slice(0, 8);
  storageSet(STORAGE_KEYS.YGO_RECENT, recent);
  renderRecent();
}

export function removeRecent(name: string, e: Event): void {
  e.stopPropagation();
  const recent = getRecent().filter(r => r.name !== name);
  storageSet(STORAGE_KEYS.YGO_RECENT, recent);
  renderRecent();
}

export function renderRecent(): void {
  const recent = getRecent();
  const bar = $('recentBar');
  if (recent.length === 0) { hide(bar); return; }
  show(bar);
  const list = $('recentList');
  if (!list) return;
  replaceChildren(list);
  recent.forEach(r => {
    const chip = document.createElement('div');
    chip.className = 'recent-chip';
    chip.textContent = r.name;
    chip.addEventListener('click', () => loadRecentDeck(r.name));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = 'âœ•';
    x.addEventListener('click', (e) => { e.stopPropagation(); removeRecent(r.name, e); });
    chip.appendChild(x);
    list.appendChild(chip);
  });
}

export async function loadRecentDeck(name: string): Promise<void> {
  const r = getRecent().find(x => x.name === name);
  if (!r) return;
  currentDeckName = r.name;
  await processDeck(r.deck);
}


// ==================== PARSE FORMATS ====================
export function parseYDK(text: string): YGODeck {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const deck: YGODeck = { main: [], extra: [], side: [] };
  let cur: keyof YGODeck | null = null;
  for (const line of lines) {
    if (/^#main$/i.test(line)) { cur = 'main'; continue; }
    if (/^#extra$/i.test(line)) { cur = 'extra'; continue; }
    if (/^!side$/i.test(line)) { cur = 'side'; continue; }
    if (!cur) continue;
    const id = parseInt(line);
    if (!isNaN(id) && id > 0) deck[cur].push(id);
  }
  return deck;
}

export function parseYDKE(url: string): YGODeck | null {
  const match = url.match(/^ydke:\/\/([^!]*)!([^!]*)!([^!]*)!?$/);
  if (!match) return null;
  const decode = (b64: string): number[] => {
    if (!b64) return [];
    const bin = atob(b64);
    const ids: number[] = [];
    for (let i = 0; i < bin.length; i += 4) {
      ids.push(bin.charCodeAt(i) | (bin.charCodeAt(i + 1) << 8) | (bin.charCodeAt(i + 2) << 16) | (bin.charCodeAt(i + 3) << 24));
    }
    return ids.map(id => id >>> 0);
  };
  return { main: decode(match[1]), extra: decode(match[2]), side: decode(match[3]) };
}

export function parsePaste(text: string): YGODeck | null {
  const trimmed = text.trim();
  // Try Omega base64 first
  if (/^[A-Za-z0-9+/=\n\r]+$/.test(trimmed) && trimmed.length > 20) {
    try {
      const decoded = decodeURIComponent(escape(atob(trimmed.replace(/\s/g, ''))));
      if (decoded.includes('#main') || decoded.includes('#Main')) return parseYDK(decoded);
    } catch { /* ignore */ }
  }
  // Try YDKE
  if (trimmed.startsWith('ydke://')) return parseYDKE(trimmed);
  // Try raw IDs
  const ids = trimmed.split(/[\n,;\s]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n > 0);
  if (ids.length > 0) return { main: ids, extra: [], side: [] };
  return null;
}

// ==================== IMPORT HANDLERS ====================
export async function handleFile(file: File): Promise<void> {
  clearError();
  const FILE_MAX_BYTES = 2 * 1024 * 1024;
  if (file.size > FILE_MAX_BYTES) { showError(`File too large (max ${FILE_MAX_BYTES / 1024 / 1024}MB)`); return; }
  if (!file.name.toLowerCase().endsWith('.ydk')) { showError('Please select a .ydk file.'); return; }
  const text = await file.text();
  const deck = parseYDK(text);
  currentDeckName = file.name.replace('.ydk', '').replace(/[_-]/g, ' ');
  await processDeck(deck);
}

export function importYDKE(): void {
  clearError();
  const input = $('ydkeInput') as HTMLInputElement;
  const url = input?.value.trim();
  if (!url) { showError('Please enter a YDKE URL.'); return; }
  const deck = parseYDKE(url);
  if (!deck) { showError('Invalid YDKE URL format.'); return; }
  currentDeckName = 'YDKE Import';
  processDeck(deck);
}

export function importPaste(): void {
  clearError();
  const input = $('pasteInput') as HTMLTextAreaElement;
  const text = input?.value.trim();
  if (!text) { showError('Please paste card IDs or an Omega code.'); return; }
  const PASTE_MAX_CHARS = 200000;
  if (text.length > PASTE_MAX_CHARS) { showError(`Input too large (max ${PASTE_MAX_CHARS.toLocaleString()} characters)`); return; }
  const deck = parsePaste(text);
  if (!deck || (deck.main.length + deck.extra.length + deck.side.length) === 0) {
    showError('Could not parse any card IDs from input.'); return;
  }
  currentDeckName = 'Pasted Deck';
  processDeck(deck);
}

// ==================== API ====================
async function fetchCards(ids: number[]): Promise<CardMap> {
  const unique = [...new Set(ids)];
  const cardMap: CardMap = {};
  const chunks: number[][] = [];
  for (let i = 0; i < unique.length; i += 20) chunks.push(unique.slice(i, i + 20));
  let fetched = 0;
  for (const chunk of chunks) {
    try {
      const res = await fetchWithBackoff(`${API}?id=${chunk.join(',')}&misc=yes`);
      if (!res.ok) throw new Error(String(res.status));
      const json = await res.json();
      if (json.data) for (const c of json.data) cardMap[c.id] = c;
    } catch {
      for (const id of chunk) {
        try {
          const r = await fetchWithBackoff(`${API}?id=${id}&misc=yes`);
          const j = await r.json();
          if (j.data?.[0]) cardMap[j.data[0].id] = j.data[0];
        } catch { /* ignore */ }
      }
    }
    fetched += chunk.length;
    const pct = Math.round((fetched / unique.length) * 100);
    const fill = $('progressFill');
    const text = $('loaderText');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = `Loading cardsâ€¦ ${fetched}/${unique.length}`;
  }
  return cardMap;
}

// ==================== PROCESS DECK ====================
export async function processDeck(deck: YGODeck): Promise<void> {
  const total = deck.main.length + deck.extra.length + deck.side.length;
  if (total === 0) { showError('No valid card IDs found.'); return; }

  const DECK_MAX_CARDS_TOTAL = 1000;
  const DECK_MAX_CARDS_UNIQUE = 750;
  const uniqueIds = new Set([...deck.main, ...deck.extra, ...deck.side]);

  if (total > DECK_MAX_CARDS_TOTAL) {
    showError(`Deck too large (max ${DECK_MAX_CARDS_TOTAL} cards, got ${total})`);
    return;
  }
  if (uniqueIds.size > DECK_MAX_CARDS_UNIQUE) {
    showError(`Too many unique cards (max ${DECK_MAX_CARDS_UNIQUE}, got ${uniqueIds.size})`);
    return;
  }

  const content = $('deckContent');
  if (content) replaceChildren(content);
  hide($('deckOverview')); hide($('toolbar')); hide($('analysisPanel')); hide($('exportPanel'));

  show($('loader'));
  const fill = $('progressFill');
  if (fill) fill.style.width = '0%';

  try {
    const allIds = [...deck.main, ...deck.extra, ...deck.side];
    const cardMap = await fetchCards(allIds);

    hide($('loader'));
    currentDeck = deck;
    currentCardMap = cardMap;

    buildBanlistFromCards(cardMap);
    saveRecent(currentDeckName, deck);

    const title = $('deckTitle');
    if (title) title.textContent = currentDeckName;
    show($('deckOverview'));
    show($('toolbar'));
    show($('analysisPanel'));
    // Export panel bleibt geschlossen bis User klickt

    renderStats();
    renderBanlistBadge();
    renderPrice();
    renderAnalysis();
    renderExtendedStats();
    renderHyperCategories();
    calcHyperAll();
    detectArchetypes();
    generateShareUrl();
    resetHandStats();
    applyFilters();
    calcHand();

    const calcDeck = $('calcDeck') as HTMLInputElement;
    if (calcDeck) calcDeck.value = String(deck.main.length);
  } catch (err) {
    hide($('loader'));
    showError('Error loading cards: ' + (err as Error).message);
  }
}

// ==================== BANLIST ====================
const BANLIST_LABELS: Record<string, string> = {
  tcg: 'TCG', ocg: 'OCG', goat: 'Goat', master_duel: 'Master Duel',
  edison: 'Edison', speed_duel: 'Speed Duel', duel_links: 'Duel Links'
};

const REMOTE_BANLISTS = ['master_duel', 'edison', 'speed_duel', 'duel_links'];

function buildBanlistFromCards(cardMap: CardMap): void {
  banlistData = { tcg: {}, ocg: {}, goat: {} };
  for (const [id, card] of Object.entries(cardMap)) {
    if (card.banlist_info) {
      if (card.banlist_info.ban_tcg) banlistData.tcg[Number(id)] = card.banlist_info.ban_tcg;
      if (card.banlist_info.ban_ocg) banlistData.ocg[Number(id)] = card.banlist_info.ban_ocg;
      if (card.banlist_info.ban_goat) banlistData.goat[Number(id)] = card.banlist_info.ban_goat;
    }
  }
}

async function fetchRemoteBanlist(format: string): Promise<Record<number, string>> {
  if (banlistCache[format]) return banlistCache[format];

  const formatApiName: Record<string, string> = {
    master_duel: 'Master Duel',
    edison: 'Edison',
    speed_duel: 'Speed Duel',
    duel_links: 'Duel Links'
  };
  const name = formatApiName[format];
  if (!name) return {};

  const result: Record<number, string> = {};

  if (currentCardMap) {
    for (const [id, card] of Object.entries(currentCardMap)) {
      const formats = card.misc_info?.[0]?.formats || [];
      if (formats.length > 0 && !formats.includes(name)) {
        result[Number(id)] = 'Not Available';
      }
    }
  }

  try {
    const url = `${API}?banlist=${encodeURIComponent(name.toLowerCase())}`;
    const res = await fetchWithBackoff(url);
    if (res.ok) {
      const json = await res.json();
      if (json.data) {
        for (const card of json.data) {
          if (card.banlist_info) {
            for (const [key, val] of Object.entries(card.banlist_info)) {
              if (['Banned', 'Forbidden', 'Limited', 'Semi-Limited'].includes(val as string)) {
                result[card.id] = val === 'Forbidden' ? 'Banned' : val as string;
                break;
              }
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn(`Could not fetch ${name} banlist:`, e);
  }

  banlistCache[format] = result;
  return result;
}

function getBanStatus(id: number): string | null {
  const list = banlistData[currentBanlist];
  return list?.[id] || null;
}

export async function changeBanlist(): Promise<void> {
  const select = $('banlistSelect') as HTMLSelectElement;
  const newBanlist = select?.value || 'tcg';
  currentBanlist = newBanlist;

  if (REMOTE_BANLISTS.includes(newBanlist) && !banlistData[newBanlist]) {
    showToast(`Loading ${BANLIST_LABELS[newBanlist]} banlistâ€¦`);
    const data = await fetchRemoteBanlist(newBanlist);
    banlistData[newBanlist] = data;

    if (Object.keys(data).length === 0 && currentCardMap) {
      const fallback: Record<number, string> = {};
      const formatName: Record<string, string> = { master_duel: 'Master Duel', edison: 'Edison', speed_duel: 'Speed Duel', duel_links: 'Duel Links' };
      for (const [id, card] of Object.entries(currentCardMap)) {
        const formats = card.misc_info?.[0]?.formats || [];
        const fn = formatName[newBanlist];
        if (fn && !formats.includes(fn)) {
          fallback[Number(id)] = 'Not Available';
        }
      }
      if (Object.keys(fallback).length > 0) banlistData[newBanlist] = fallback;
    }
  }

  renderBanlistBadge();
  applyFilters();
}

function renderBanlistBadge(): void {
  if (!currentDeck) return;
  const allIds = [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side];
  const issues: string[] = [];
  const counts: Record<number, number> = {};
  for (const id of allIds) counts[id] = (counts[id] || 0) + 1;

  for (const [id, count] of Object.entries(counts)) {
    const status = getBanStatus(Number(id));
    const name = currentCardMap?.[Number(id)]?.name || `#${id}`;
    if (status === 'Banned' || status === 'Forbidden') { issues.push(`${name}: Banned`); }
    else if (status === 'Not Available') { issues.push(`${name}: Not in format`); }
    else if (status === 'Limited' && count > 1) { issues.push(`${name}: Limited (${count}x)`); }
    else if (status === 'Semi-Limited' && count > 2) { issues.push(`${name}: Semi-Limited (${count}x)`); }
  }

  const label = BANLIST_LABELS[currentBanlist] || currentBanlist.toUpperCase();
  const badge = $('banlistBadge');
  if (!badge) return;
  if (issues.length > 0) {
    badge.className = 'banlist-badge illegal';
    badge.textContent = `⚠ ${label} — ${issues.length} issue${issues.length > 1 ? 's' : ''}`;
    badge.title = issues.join('\n');
  } else {
    badge.className = 'banlist-badge legal';
    badge.textContent = `✓ ${label} Legal`;
    badge.title = '';
  }
  badge.style.display = 'inline-flex';
}

// ==================== PRICE ====================
function getCardPrice(card: YGOCard | undefined): number {
  if (!card?.card_prices?.[0]) return 0;
  const p = card.card_prices[0];
  return parseFloat(p.cardmarket_price || '') || parseFloat(p.tcgplayer_price || '') || 0;
}

function renderPrice(): void {
  if (!currentDeck || !currentCardMap) return;
  const allIds = [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side];
  let total = 0;
  for (const id of allIds) total += getCardPrice(currentCardMap[id]);
  const el = $('deckPrice');
  if (!el) return;
  if (total > 0) {
    el.textContent = `â‰ˆ â‚¬${total.toFixed(2)}`;
    el.title = 'Estimated price from Cardmarket';
    el.style.display = 'inline';
  } else { el.style.display = 'none'; }
}


// ==================== CARD HELPERS ====================
function getCardType(card: YGOCard | undefined): 'monster' | 'spell' | 'trap' {
  if (!card) return 'monster';
  const t = card.type?.toLowerCase() || '';
  if (t.includes('spell')) return 'spell';
  if (t.includes('trap')) return 'trap';
  return 'monster';
}

function buildCounts(): Record<number, number> {
  if (!currentDeck) return {};
  const counts: Record<number, number> = {};
  for (const id of [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side]) {
    counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
}

// ==================== STATS ====================
function renderStats(): void {
  const d = currentDeck, cm = currentCardMap;
  if (!d || !cm) return;
  let monsters = 0, spells = 0, traps = 0;
  for (const id of d.main) {
    const t = getCardType(cm[id]);
    if (t === 'monster') monsters++;
    else if (t === 'spell') spells++;
    else traps++;
  }
  const row = $('statsRow');
  if (row) {
    const statChip = (color: string, label: string, num: number) =>
      h('div', { className: 'stat-chip' },
        h('div', { className: 'stat-dot', style: `background:var(--${color})` }),
        `${label} `,
        h('span', { className: 'num' }, String(num))
      );
    replaceChildren(row,
      statChip('gold', 'Main', d.main.length),
      statChip('monster', 'Monster', monsters),
      statChip('spell', 'Spell', spells),
      statChip('trap', 'Trap', traps),
      statChip('extra-f', 'Extra', d.extra.length),
      statChip('border-light', 'Side', d.side.length)
    );
  }
}

// ==================== ANALYSIS ====================
function renderAnalysis(): void {
  renderLevelChart();
  renderTypeBars();
  renderFormatLegality();
}

function renderLevelChart(): void {
  if (!currentDeck || !currentCardMap) return;
  const levels: Record<number, number> = {};
  for (const id of currentDeck.main) {
    const card = currentCardMap[id];
    if (card && getCardType(card) === 'monster' && card.level) {
      levels[card.level] = (levels[card.level] || 0) + 1;
    }
  }
  const maxCount = Math.max(...Object.values(levels), 1);
  const el = $('levelChart');
  if (!el) return;
  
  const bars: HTMLElement[] = [];
  for (let lvl = 1; lvl <= 12; lvl++) {
    const count = levels[lvl] || 0;
    const pct = Math.round((count / maxCount) * 100);
    bars.push(
      h('div', { className: 'level-bar', title: `Level ${lvl}: ${count}` },
        h('div', { className: 'level-fill', style: `height:${pct}%` }),
        h('span', { className: 'level-num' }, String(lvl))
      )
    );
  }
  replaceChildren(el, ...bars);
}

function renderTypeBars(): void {
  if (!currentDeck || !currentCardMap) return;
  const types: Record<string, number> = {};
  for (const id of currentDeck.main) {
    const card = currentCardMap[id];
    if (card && getCardType(card) === 'monster' && card.race) {
      types[card.race] = (types[card.race] || 0) + 1;
    }
  }
  const sorted = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxCount = Math.max(...sorted.map(s => s[1]), 1);
  const el = $('typeBars');
  if (!el) return;
  
  if (sorted.length === 0) {
    replaceChildren(el, h('div', { className: 'empty' }, 'No monster types'));
    return;
  }
  
  // Use correct CSS class names: type-bar-row, type-bar-label, type-bar-track, type-bar-fill, type-bar-count
  replaceChildren(el, ...sorted.map(([type, count]) => {
    const pct = Math.round((count / maxCount) * 100);
    return h('div', { className: 'type-bar-row' },
      h('span', { className: 'type-bar-label' }, type),
      h('div', { className: 'type-bar-track' },
        h('div', { className: 'type-bar-fill', style: `width:${pct}%; background:var(--trap);` },
          h('span', {}, String(count))
        )
      )
    );
  }));
}

function renderFormatLegality(): void {
  if (!currentDeck || !currentCardMap) return;
  const el = $('formatLegality');
  if (!el) return;
  
  const allIds = [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side];
  const counts: Record<number, number> = {};
  for (const id of allIds) counts[id] = (counts[id] || 0) + 1;

  const formats = [
    { key: 'tcg', label: 'TCG' },
    { key: 'ocg', label: 'OCG' },
    { key: 'goat', label: 'Goat' },
  ];

  replaceChildren(el, ...formats.map(fmt => {
    const list = banlistData[fmt.key] || {};
    let legal = true;
    for (const [id, count] of Object.entries(counts)) {
      const status = list[Number(id)];
      if (status === 'Banned' || status === 'Forbidden') { legal = false; break; }
      if (status === 'Limited' && count > 1) { legal = false; break; }
      if (status === 'Semi-Limited' && count > 2) { legal = false; break; }
    }
    return h('span', { className: `format-chip ${legal ? 'legal' : 'illegal'}` }, fmt.label);
  }));
}

function renderExtendedStats(): void {
  if (!currentDeck || !currentCardMap) return;
  
  const allIds = [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side];
  const attributes: Record<string, number> = {};
  const races: Record<string, number> = {};
  const handTraps: { name: string; count: number }[] = [];
  
  // Known hand trap IDs
  const HAND_TRAP_IDS = new Set([
    14558127, // Ash Blossom & Joyous Spring
    94145021, // Droll & Lock Bird
    59438930, // Ghost Ogre & Snow Rabbit
    23434538, // Infinite Impermanence
    24224830, // Called by the Grave
    97268402, // Effect Veiler
    15693423, // Nibiru, the Primal Being
    73642296, // Maxx "C"
    98095162, // D.D. Crow
    61936647, // Ghost Belle & Haunted Mansion
    83764719, // PSY-Framegear Gamma
    63764897, // Fantastical Dragon Phantazmay
    82044279, // Crossout Designator
  ]);
  
  const handTrapCounts: Record<string, number> = {};
  
  for (const id of allIds) {
    const card = currentCardMap[id];
    if (!card) continue;
    
    if (getCardType(card) === 'monster') {
      if (card.attribute) {
        attributes[card.attribute] = (attributes[card.attribute] || 0) + 1;
      }
      if (card.race) {
        races[card.race] = (races[card.race] || 0) + 1;
      }
    }
    
    // Check if it's a hand trap (by ID or by effect keywords)
    if (HAND_TRAP_IDS.has(id) || 
        (card.desc && (card.desc.includes('from your hand') || card.desc.includes('(Quick Effect)'))) &&
        getCardType(card) === 'monster') {
      const name = card.name || `Card ${id}`;
      handTrapCounts[name] = (handTrapCounts[name] || 0) + 1;
    }
  }
  
  // Render Attribute Distribution
  const attrEl = $('attrBars');
  if (attrEl) {
    const sortedAttrs = Object.entries(attributes).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxAttr = Math.max(...sortedAttrs.map(s => s[1]), 1);
    
    if (sortedAttrs.length === 0) {
      replaceChildren(attrEl, h('div', { className: 'empty', style: 'color:var(--text-dim);font-size:0.8rem;' }, 'No monsters'));
    } else {
      const attrColors: Record<string, string> = {
        'DARK': '#8B5CF6',
        'LIGHT': '#FCD34D',
        'EARTH': '#92400E',
        'WATER': '#3B82F6',
        'FIRE': '#EF4444',
        'WIND': '#10B981',
        'DIVINE': '#F59E0B',
      };
      replaceChildren(attrEl, ...sortedAttrs.map(([attr, count]) => {
        const pct = Math.round((count / maxAttr) * 100);
        const color = attrColors[attr] || 'var(--gold)';
        return h('div', { className: 'ext-bar-row' },
          h('span', { className: 'ext-bar-label' }, attr),
          h('div', { className: 'ext-bar-track' },
            h('div', { className: 'ext-bar-fill', style: `width:${pct}%; background:${color};` },
              h('span', {}, String(count))
            )
          )
        );
      }));
    }
  }
  
  // Render Race/Type Distribution (separate from typeBars which shows card type breakdown)
  const raceEl = $('raceBars');
  if (raceEl) {
    const sortedRaces = Object.entries(races).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxRace = Math.max(...sortedRaces.map(s => s[1]), 1);
    
    if (sortedRaces.length === 0) {
      replaceChildren(raceEl, h('div', { className: 'empty', style: 'color:var(--text-dim);font-size:0.8rem;' }, 'No monsters'));
    } else {
      replaceChildren(raceEl, ...sortedRaces.map(([race, count]) => {
        const pct = Math.round((count / maxRace) * 100);
        return h('div', { className: 'ext-bar-row' },
          h('span', { className: 'ext-bar-label' }, race),
          h('div', { className: 'ext-bar-track' },
            h('div', { className: 'ext-bar-fill', style: `width:${pct}%; background:var(--monster);` },
              h('span', {}, String(count))
            )
          )
        );
      }));
    }
  }
  
  // Render Hand Traps & Staples
  const htEl = $('handTrapBadges');
  if (htEl) {
    const sortedHT = Object.entries(handTrapCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    
    if (sortedHT.length === 0) {
      replaceChildren(htEl, h('div', { className: 'empty', style: 'color:var(--text-dim);font-size:0.8rem;' }, 'No hand traps detected'));
    } else {
      replaceChildren(htEl, ...sortedHT.map(([name, count]) =>
        h('span', { className: 'ht-badge' },
          h('span', { className: 'ht-count' }, `${count}×`),
          h('span', {}, name.length > 18 ? name.substring(0, 16) + '…' : name)
        )
      ));
    }
  }
}

function detectArchetypes(): void {
  if (!currentDeck || !currentCardMap) return;
  
  const archetypes: Record<string, number[]> = {};
  const allIds = [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side];
  
  for (const id of allIds) {
    const card = currentCardMap[id];
    if (card?.archetype) {
      if (!archetypes[card.archetype]) archetypes[card.archetype] = [];
      archetypes[card.archetype].push(id);
    }
  }
  
  const sorted = Object.entries(archetypes).sort((a, b) => b[1].length - a[1].length);
  
  // Render archetype tags
  const tagsEl = $('archetypeTags');
  if (tagsEl) {
    if (sorted.length === 0) {
      replaceChildren(tagsEl, h('div', { className: 'empty', style: 'color:var(--text-dim);font-size:0.85rem;padding:0.5rem;' }, 'No archetypes detected'));
    } else {
      replaceChildren(tagsEl, ...sorted.slice(0, 8).map(([name, ids]) =>
        h('span', { className: 'archetype-tag', title: `${ids.length} cards` },
          h('span', { className: 'arch-name' }, name),
          h('span', { className: 'arch-count' }, String(ids.length))
        )
      ));
    }
  }
  
  // Render archetype composition breakdown
  const compEl = $('archComposition');
  if (compEl && sorted.length > 0) {
    const total = allIds.length;
    const topArchetypes = sorted.slice(0, 3);
    const otherCount = total - topArchetypes.reduce((sum, [, ids]) => sum + ids.length, 0);
    
    replaceChildren(compEl, 
      h('div', { className: 'arch-breakdown' },
        ...topArchetypes.map(([name, ids]) => {
          const pct = Math.round((ids.length / total) * 100);
          return h('div', { className: 'arch-bar-row' },
            h('span', { className: 'arch-bar-name' }, name),
            h('div', { className: 'arch-bar-track' },
              h('div', { className: 'arch-bar-fill', style: `width:${pct}%; background:var(--gold);` })
            ),
            h('span', { className: 'arch-bar-pct' }, `${pct}%`)
          );
        }),
        otherCount > 0 ? h('div', { className: 'arch-bar-row' },
          h('span', { className: 'arch-bar-name', style: 'color:var(--text-dim);' }, 'Other'),
          h('div', { className: 'arch-bar-track' },
            h('div', { className: 'arch-bar-fill', style: `width:${Math.round((otherCount / total) * 100)}%; background:var(--bg-3);` })
          ),
          h('span', { className: 'arch-bar-pct', style: 'color:var(--text-dim);' }, `${Math.round((otherCount / total) * 100)}%`)
        ) : ''
      )
    );
  } else if (compEl) {
    replaceChildren(compEl);
  }
}

// ==================== FILTERS & VIEWS ====================
export function setTypeFilter(filter: string): void {
  currentTypeFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === filter);
  });
  applyFilters();
}

export function setView(view: string): void {
  currentView = view;
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === view);
  });
  applyFilters();
}

function filterAndSort(cards: YGOCard[]): YGOCard[] {
  let filtered = cards;
  if (currentTypeFilter !== 'all') {
    filtered = cards.filter(c => getCardType(c) === currentTypeFilter);
  }
  return filtered;
}

export function applyFilters(): void {
  if (!currentDeck || !currentCardMap) return;
  
  cleanupChunkers();
  
  const container = $('deckContent');
  if (!container) return;
  replaceChildren(container);

  const sections: Array<{ key: keyof YGODeck; label: string }> = [
    { key: 'main', label: 'Main Deck' },
    { key: 'extra', label: 'Extra Deck' },
    { key: 'side', label: 'Side Deck' }
  ];

  for (const section of sections) {
    const ids = currentDeck[section.key];
    if (ids.length === 0) continue;

    const uniqueIds = [...new Set(ids)];
    const cards = uniqueIds.map(id => currentCardMap![id]).filter(Boolean);
    const filtered = filterAndSort(cards);

    if (filtered.length === 0) continue;

    const sectionEl = h('div', { className: 'deck-section' },
      h('h3', { className: 'section-title', 'data-action': 'section-toggle', 'data-section': section.key },
        `${section.label} (${ids.length})`
      )
    );
    container.appendChild(sectionEl);

    const contentEl = document.createElement('div');
    contentEl.className = 'section-content';
    contentEl.id = `section-${section.key}`;
    sectionEl.appendChild(contentEl);

    const renderFn = currentView === 'grid' ? renderGridChunk : currentView === 'table' ? renderTableChunk : renderCardsChunk;
    const chunker = new ChunkedRenderer(contentEl, filtered, renderFn, buildCounts);
    _activeChunkers.push(chunker);
    chunker.start();
  }
}

// ==================== RENDER VIEWS ====================
function banIndicatorHtml(id: number): string {
  const status = getBanStatus(id);
  if (!status) return '';
  const cls = status === 'Banned' || status === 'Forbidden' ? 'banned' : status === 'Limited' ? 'limited' : status === 'Semi-Limited' ? 'semi' : 'unavailable';
  const label = status === 'Banned' || status === 'Forbidden' ? 'âŠ˜' : status === 'Limited' ? 'â‘ ' : status === 'Semi-Limited' ? 'â‘¡' : 'âœ—';
  return `<span class="ban-indicator ${cls}" title="${escapeHtml(status)}">${label}</span>`;
}

/** h()-based version for DOM API rendering */
function banIndicatorEl(id: number): HTMLElement | null {
  const status = getBanStatus(id);
  if (!status) return null;
  const cls = status === 'Banned' || status === 'Forbidden' ? 'banned' : status === 'Limited' ? 'limited' : status === 'Semi-Limited' ? 'semi' : 'unavailable';
  const label = status === 'Banned' || status === 'Forbidden' ? '⊘' : status === 'Limited' ? '①' : status === 'Semi-Limited' ? '②' : '✗';
  return h('span', { className: `ban-indicator ${cls}`, title: status }, label);
}


function renderCardsChunk(cards: YGOCard[], countsFn: () => Record<number, number>): string {
  const counts = countsFn();
  let html = '<div class="ygo-grid">';
  for (const card of cards) {
    const count = counts[card.id] || 1;
    const img = card.card_images?.[0]?.image_url_small || '';
    html += `
      <div class="ygo-card" data-id="${card.id}" data-action="modal">
        <div class="card-img-wrap">
          <img src="${sanitizeUrl(img)}" alt="${escapeHtml(card.name)}" loading="lazy">
          ${banIndicatorHtml(card.id)}
          ${count > 1 ? `<span class="card-count">Ã—${count}</span>` : ''}
        </div>
        <div class="card-name">${escapeHtml(card.name)}</div>
      </div>`;
  }
  html += '</div>';
  return html;
}

function renderGridChunk(cards: YGOCard[], countsFn: () => Record<number, number>): string {
  const counts = countsFn();
  let html = '<div class="card-grid compact">';
  for (const card of cards) {
    const count = counts[card.id] || 1;
    const img = card.card_images?.[0]?.image_url_small || '';
    html += `
      <div class="grid-card" data-id="${card.id}" data-action="modal">
        <img src="${sanitizeUrl(img)}" alt="${escapeHtml(card.name)}" loading="lazy">
        ${banIndicatorHtml(card.id)}
        ${count > 1 ? `<span class="card-count">Ã—${count}</span>` : ''}
      </div>`;
  }
  html += '</div>';
  return html;
}

function renderTableChunk(cards: YGOCard[], countsFn: () => Record<number, number>): string {
  const counts = countsFn();
  let html = '<div class="card-table-wrap"><table class="card-table"><thead><tr><th>Name</th><th>Type</th><th>ATK/DEF</th><th>Qty</th></tr></thead><tbody>';
  for (const card of cards) {
    const count = counts[card.id] || 1;
    const atkDef = card.atk !== undefined ? `${card.atk}/${card.def ?? '?'}` : '-';
    html += `<tr data-id="${card.id}" data-action="modal">
      <td>${banIndicatorHtml(card.id)}${escapeHtml(card.name)}</td>
      <td>${escapeHtml(card.type)}</td>
      <td>${atkDef}</td>
      <td>${count}</td>
    </tr>`;
  }
  html += '</tbody></table></div>';
  return html;
}


// ==================== MODAL ====================
export function openModal(id: number): void {
  const card = currentCardMap?.[id];
  if (!card) return;

  const modal = $('cardModal');
  if (!modal) return;

  const img = card.card_images?.[0]?.image_url || '';
  const content = $('modalContent');
  if (content) {
    replaceChildren(content,
      h('div', { className: 'modal-card' },
        h('img', { src: sanitizeUrl(img), alt: card.name }),
        h('div', { className: 'modal-info' },
          h('h2', {}, card.name, ' ', banIndicatorEl(card.id)),
          h('div', { className: 'card-meta' },
            h('span', { className: 'type' }, card.type),
            card.attribute ? h('span', { className: `attr attr-${card.attribute.toLowerCase()}` }, card.attribute) : null,
            card.level ? h('span', { className: 'level' }, `★${card.level}`) : null
          ),
          card.atk !== undefined ? h('div', { className: 'stats' }, `ATK ${card.atk} / DEF ${card.def ?? '?'}`) : null,
          h('p', { className: 'desc' }, card.desc),
          card.archetype ? h('div', { className: 'archetype' }, `Archetype: ${card.archetype}`) : null,
          h('div', { className: 'price' }, `Price: €${getCardPrice(card).toFixed(2)}`)
        )
      )
    );
  }
  show(modal);
}

export function closeModal(): void {
  hide($('cardModal'));
}

// ==================== PREVIEW ====================
export function showPreview(id: number, evt: MouseEvent): void {
  const card = currentCardMap?.[id];
  if (!card) return;
  
  const preview = $('cardPreview');
  if (!preview) return;
  
  const img = card.card_images?.[0]?.image_url || '';
  replaceChildren(preview, h('img', { src: sanitizeUrl(img), alt: card.name }));
  preview.style.left = (evt.pageX + 20) + 'px';
  preview.style.top = (evt.pageY - 100) + 'px';
  show(preview);
}

export function hidePreview(): void {
  hide($('cardPreview'));
}

// ==================== TEST HANDS ====================
export function drawTestHand(handSize: number = 5): void {
  if (!currentDeck || currentDeck.main.length < handSize) {
    showToast(`Need at least ${handSize} cards in main deck`);
    return;
  }
  
  const pool = [...currentDeck.main];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  
  testHandState.cards = pool.slice(0, handSize);
  testHandState.graded = [];
  testHandState.totalDrawn++;
  renderTestHand();
}

export function mulligan(): void {
  if (!currentDeck || testHandState.cards.length === 0) return;
  testHandState.mulligans++;
  drawTestHand();
}

function renderTestHand(): void {
  const el = $('handDrawn');
  if (!el) return;
  
  if (testHandState.cards.length === 0) {
    replaceChildren(el, h('div', { className: 'hand-sim-empty' }, 'Click "Draw 5" or "Draw 6" to simulate an opening hand'));
    return;
  }
  
  const handCards = testHandState.cards.map((id, i) => {
    const card = currentCardMap?.[id];
    if (!card) return null;
    const img = card.card_images?.[0]?.image_url_small || '';
    return h('div', { className: 'hand-card', 'data-idx': String(i), 'data-action': 'hand-card', 'data-id': String(id) },
      h('img', { src: sanitizeUrl(img), alt: card.name })
    );
  }).filter(Boolean) as HTMLElement[];
  
  replaceChildren(el, ...handCards);
  
  // Update stats
  const statsEl = $('handSimStats');
  if (statsEl) {
    const grades = testHandState.grades;
    const playable = grades['playable'] || 0;
    const brick = grades['brick'] || 0;
    const total = playable + brick;
    const ratio = total > 0 ? ((playable / total) * 100).toFixed(1) : '0';
    
    replaceChildren(statsEl,
      h('span', {}, `Drawn: ${testHandState.totalDrawn}`),
      h('span', {}, ` | Mulligans: ${testHandState.mulligans}`),
      total > 0 ? h('span', {}, ` | Playable: ${playable}/${total} (${ratio}%)`) : null
    );
  }
}

export function markHand(grade: string): void {
  testHandState.grades[grade] = (testHandState.grades[grade] || 0) + 1;
  drawTestHand();
}

export function resetHandStats(): void {
  testHandState.cards = [];
  testHandState.graded = [];
  testHandState.mulligans = 0;
  testHandState.totalDrawn = 0;
  testHandState.grades = {};
  renderTestHand();
}

// ==================== EXPORT ====================
export function renderExport(): void {
  console.log('[renderExport] Called, currentDeck:', currentDeck ? `${currentDeck.main.length} main cards` : 'null');
  
  if (!currentDeck) {
    console.log('[renderExport] No deck - showing toast');
    showToast('Please load a deck first');
    return;
  }
  
  const el = $('exportOutput');
  console.log('[renderExport] exportOutput element:', el);
  if (!el) {
    console.log('[renderExport] ERROR: exportOutput not found!');
    return;
  }
  
  const format = ($('exportFormat') as HTMLSelectElement)?.value || 'ydk';
  console.log('[renderExport] Format:', format);
  let output = '';
  
  if (format === 'ydk') {
    output = '#created by DeckLens\n#main\n';
    output += currentDeck.main.join('\n') + '\n';
    output += '#extra\n';
    output += currentDeck.extra.join('\n') + '\n';
    output += '!side\n';
    output += currentDeck.side.join('\n');
  } else if (format === 'ydke') {
    output = buildYDKEString();
  } else if (format === 'omega') {
    try {
      const data = {
        main: currentDeck.main,
        extra: currentDeck.extra,
        side: currentDeck.side
      };
      output = btoa(JSON.stringify(data));
    } catch {
      output = '# Omega encoding failed';
    }
  } else if (format === 'names') {
    const names: string[] = [];
    for (const id of [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side]) {
      const card = currentCardMap?.[id];
      if (card) names.push(card.name);
    }
    output = names.join('\n');
  } else if (format === 'csv') {
    output = 'Name,Type,Quantity,Section\n';
    const counts = buildCounts();
    const processed = new Set<number>();
    for (const section of ['main', 'extra', 'side'] as const) {
      for (const id of currentDeck[section]) {
        if (processed.has(id)) continue;
        processed.add(id);
        const card = currentCardMap?.[id];
        if (!card) continue;
        const qty = counts[id] || 1;
        output += `"${card.name.replace(/"/g, '""')}","${card.type}",${qty},${section}\n`;
      }
    }
  } else if (format === 'json') {
    const counts = buildCounts();
    const deckData = {
      name: currentDeckName || 'Unnamed Deck',
      main: currentDeck.main.map(id => ({
        id,
        name: currentCardMap?.[id]?.name || 'Unknown',
        qty: counts[id] || 1
      })),
      extra: currentDeck.extra.map(id => ({
        id,
        name: currentCardMap?.[id]?.name || 'Unknown',
        qty: counts[id] || 1
      })),
      side: currentDeck.side.map(id => ({
        id,
        name: currentCardMap?.[id]?.name || 'Unknown',
        qty: counts[id] || 1
      }))
    };
    output = JSON.stringify(deckData, null, 2);
  }
  
  console.log('[renderExport] Output length:', output.length);
  (el as HTMLTextAreaElement).value = output;
  showToast(`Exported as ${format.toUpperCase()}`);
}

export function copyExport(): void {
  const el = $('exportOutput') as HTMLTextAreaElement;
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => showToast('Copied to clipboard!'));
}

export function downloadExport(): void {
  const el = $('exportOutput') as HTMLTextAreaElement;
  const format = ($('exportFormat') as HTMLSelectElement)?.value || 'ydk';
  if (!el || !el.value) {
    showToast('Nothing to download - select a format first');
    return;
  }
  
  const ext = format === 'csv' ? 'csv' : format === 'json' ? 'json' : format === 'names' ? 'txt' : format === 'ydke' ? 'txt' : 'ydk';
  const blob = new Blob([el.value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentDeckName || 'deck'}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${currentDeckName || 'deck'}.${ext}`);
}

// ==================== SPECIAL EXPORT FUNCTIONS ====================

/**
 * Open PDF export modal to collect tournament info.
 */
export function exportPdf(): void {
  if (!currentDeck) {
    showToast('Please load a deck first');
    return;
  }
  
  // Set default date to today
  const dateInput = $('pdfDate') as HTMLInputElement | null;
  if (dateInput && !dateInput.value) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }
  
  // Open modal
  const modal = $('pdfModal');
  if (modal) {
    modal.classList.add('active');
  } else {
    showToast('PDF modal not found');
  }
}

/**
 * Close PDF export modal.
 */
export function closePdfModal(): void {
  const modal = $('pdfModal');
  if (modal) {
    modal.classList.remove('active');
  }
}

/**
 * Generate printable tournament deck sheet and open print dialog.
 * Uses browser's "Save as PDF" for PDF generation (no dependencies).
 */
export function generatePdf(): void {
  if (!currentDeck || !currentCardMap) {
    showToast('Please load a deck first');
    return;
  }
  
  // Collect form data
  const playerName = ($('pdfPlayerName') as HTMLInputElement)?.value.trim() || 'Player';
  const eventName = ($('pdfEventName') as HTMLInputElement)?.value.trim() || 'Tournament';
  const eventDate = ($('pdfDate') as HTMLInputElement)?.value || new Date().toISOString().split('T')[0];
  const format = ($('pdfFormat') as HTMLSelectElement)?.value || 'TCG Advanced';
  
  // Build card lists with names
  const getCardList = (ids: number[]): Array<{ name: string; qty: number }> => {
    const counts = new Map<number, number>();
    for (const id of ids) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    
    const list: Array<{ name: string; qty: number }> = [];
    for (const [id, qty] of counts) {
      const card = currentCardMap![id];
      list.push({ name: card?.name || `Unknown #${id}`, qty });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  };
  
  const mainDeck = getCardList(currentDeck.main);
  const extraDeck = getCardList(currentDeck.extra);
  const sideDeck = getCardList(currentDeck.side);
  
  // Generate print-ready HTML
  const html = generateDeckSheetHTML({
    deckName: currentDeckName || 'Deck',
    playerName,
    eventName,
    eventDate,
    format,
    mainDeck,
    extraDeck,
    sideDeck,
    mainCount: currentDeck.main.length,
    extraCount: currentDeck.extra.length,
    sideCount: currentDeck.side.length,
  });
  
  // Open in new window for printing
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showError('Popup blocked. Please allow popups for this site.');
    return;
  }
  
  printWindow.document.write(html);
  printWindow.document.close();
  
  // Close modal
  closePdfModal();
  
  // Auto-trigger print dialog after content loads
  printWindow.onload = () => {
    printWindow.focus();
    setTimeout(() => {
      printWindow.print();
    }, 300);
  };
  
  showToast('Print dialog opened - select "Save as PDF"');
}

/**
 * Generate HTML for tournament deck sheet.
 * SECURITY: All user input is escaped via escapeHtml.
 */
function generateDeckSheetHTML(data: {
  deckName: string;
  playerName: string;
  eventName: string;
  eventDate: string;
  format: string;
  mainDeck: Array<{ name: string; qty: number }>;
  extraDeck: Array<{ name: string; qty: number }>;
  sideDeck: Array<{ name: string; qty: number }>;
  mainCount: number;
  extraCount: number;
  sideCount: number;
}): string {
  const escape = escapeHtml;
  
  const renderCardList = (cards: Array<{ name: string; qty: number }>): string => {
    return cards.map(c => 
      `<div class="card-entry"><span class="qty">${c.qty}x</span> <span class="name">${escape(c.name)}</span></div>`
    ).join('');
  };
  
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Deck Sheet - ${escape(data.deckName)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 10pt; line-height: 1.3; padding: 15mm; }
    .header { text-align: center; margin-bottom: 10mm; border-bottom: 2px solid #000; padding-bottom: 5mm; }
    .header h1 { font-size: 16pt; margin-bottom: 3mm; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 5mm; margin-bottom: 8mm; }
    .info-row { display: flex; border-bottom: 1px solid #ccc; padding: 2mm 0; }
    .info-label { font-weight: bold; width: 25mm; }
    .deck-sections { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; }
    .deck-section { break-inside: avoid; }
    .deck-section h2 { font-size: 11pt; background: #333; color: #fff; padding: 2mm 3mm; margin-bottom: 2mm; }
    .card-entry { display: flex; padding: 1mm 2mm; border-bottom: 1px dotted #ddd; }
    .card-entry .qty { width: 8mm; font-weight: bold; }
    .card-entry .name { flex: 1; }
    .footer { margin-top: 10mm; text-align: center; font-size: 8pt; color: #666; }
    .signature { margin-top: 15mm; display: flex; justify-content: space-between; }
    .sig-box { width: 45%; border-top: 1px solid #000; padding-top: 2mm; text-align: center; font-size: 9pt; }
    @media print {
      body { padding: 10mm; }
      .deck-section { page-break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Yu-Gi-Oh! Deck Registration Sheet</h1>
    <div>${escape(data.eventName)}</div>
  </div>
  
  <div class="info-grid">
    <div class="info-row"><span class="info-label">Player:</span> ${escape(data.playerName)}</div>
    <div class="info-row"><span class="info-label">Date:</span> ${escape(data.eventDate)}</div>
    <div class="info-row"><span class="info-label">Deck Name:</span> ${escape(data.deckName)}</div>
    <div class="info-row"><span class="info-label">Format:</span> ${escape(data.format)}</div>
  </div>
  
  <div class="deck-sections">
    <div class="deck-section">
      <h2>Main Deck (${data.mainCount} cards)</h2>
      ${renderCardList(data.mainDeck)}
    </div>
    
    <div class="deck-section">
      <h2>Extra Deck (${data.extraCount} cards)</h2>
      ${renderCardList(data.extraDeck)}
      
      <h2 style="margin-top:5mm;">Side Deck (${data.sideCount} cards)</h2>
      ${renderCardList(data.sideDeck)}
    </div>
  </div>
  
  <div class="signature">
    <div class="sig-box">Player Signature</div>
    <div class="sig-box">Judge Signature</div>
  </div>
  
  <div class="footer">
    Generated by DeckLens | ${new Date().toLocaleDateString()}
  </div>
</body>
</html>`;
}

/**
 * Export deck summary as PNG image using Canvas API.
 * No external dependencies - uses native browser Canvas.
 */
export function exportDeckImage(): void {
  if (!currentDeck || !currentCardMap) {
    showToast('Please load a deck first');
    return;
  }
  
  // Gather deck statistics
  const stats = gatherDeckStats();
  
  // Create canvas and render
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    showToast('Canvas not supported');
    return;
  }
  
  // Canvas dimensions
  const width = 600;
  const height = 400;
  canvas.width = width;
  canvas.height = height;
  
  // Draw deck summary
  renderDeckSummaryToCanvas(ctx, width, height, stats);
  
  // Convert to PNG and download
  try {
    canvas.toBlob((blob) => {
      if (!blob) {
        showToast('Failed to generate image');
        return;
      }
      
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizeFilename(currentDeckName || 'deck')}-summary.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showToast('Deck image downloaded');
    }, 'image/png');
  } catch (err) {
    showToast('Failed to export image');
  }
}

/**
 * Sanitize filename for download.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*]/g, '') // Remove invalid chars
    .replace(/\s+/g, '_')         // Replace spaces with underscores
    .substring(0, 50);            // Limit length
}

/**
 * Gather deck statistics for image export.
 */
interface DeckStats {
  deckName: string;
  mainCount: number;
  extraCount: number;
  sideCount: number;
  monsters: number;
  spells: number;
  traps: number;
  topArchetypes: Array<{ name: string; count: number }>;
  avgAtk: number;
  avgDef: number;
}

function gatherDeckStats(): DeckStats {
  const d = currentDeck!;
  const cm = currentCardMap!;
  
  let monsters = 0, spells = 0, traps = 0;
  let totalAtk = 0, totalDef = 0, monsterCount = 0;
  const archetypes: Record<string, number> = {};
  
  for (const id of d.main) {
    const card = cm[id];
    if (!card) continue;
    
    const type = getCardType(card);
    if (type === 'monster') {
      monsters++;
      if (card.atk !== undefined) {
        totalAtk += card.atk;
        monsterCount++;
      }
      if (card.def !== undefined) {
        totalDef += card.def;
      }
    } else if (type === 'spell') {
      spells++;
    } else {
      traps++;
    }
    
    // Track archetypes
    if (card.archetype) {
      archetypes[card.archetype] = (archetypes[card.archetype] || 0) + 1;
    }
  }
  
  // Sort archetypes by count
  const topArchetypes = Object.entries(archetypes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));
  
  return {
    deckName: currentDeckName || 'Deck',
    mainCount: d.main.length,
    extraCount: d.extra.length,
    sideCount: d.side.length,
    monsters,
    spells,
    traps,
    topArchetypes,
    avgAtk: monsterCount > 0 ? Math.round(totalAtk / monsterCount) : 0,
    avgDef: monsterCount > 0 ? Math.round(totalDef / monsterCount) : 0,
  };
}

/**
 * Render deck summary to canvas.
 * All text is drawn via Canvas API (no DOM/innerHTML).
 */
function renderDeckSummaryToCanvas(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  stats: DeckStats
): void {
  // Background gradient
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, '#1a1a2e');
  gradient.addColorStop(1, '#16213e');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  
  // Border
  ctx.strokeStyle = '#c9a227';
  ctx.lineWidth = 3;
  ctx.strokeRect(2, 2, width - 4, height - 4);
  
  // Header
  ctx.fillStyle = '#c9a227';
  ctx.font = 'bold 28px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(truncateText(ctx, stats.deckName, width - 40), width / 2, 45);
  
  // Subtitle
  ctx.fillStyle = '#888';
  ctx.font = '14px Arial, sans-serif';
  ctx.fillText('Yu-Gi-Oh! Deck Summary', width / 2, 70);
  
  // Divider line
  ctx.strokeStyle = '#333';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(30, 85);
  ctx.lineTo(width - 30, 85);
  ctx.stroke();
  
  // Card counts section
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px Arial, sans-serif';
  ctx.fillText('Card Counts', 30, 115);
  
  ctx.font = '14px Arial, sans-serif';
  ctx.fillStyle = '#aaa';
  
  const countY = 140;
  drawStatBox(ctx, 30, countY, 160, 60, 'Main Deck', String(stats.mainCount), '#4a90d9');
  drawStatBox(ctx, 210, countY, 160, 60, 'Extra Deck', String(stats.extraCount), '#9b59b6');
  drawStatBox(ctx, 390, countY, 160, 60, 'Side Deck', String(stats.sideCount), '#27ae60');
  
  // Type breakdown section
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px Arial, sans-serif';
  ctx.fillText('Type Breakdown', 30, 230);
  
  const typeY = 255;
  drawStatBox(ctx, 30, typeY, 160, 60, '🐲 Monsters', String(stats.monsters), '#e74c3c');
  drawStatBox(ctx, 210, typeY, 160, 60, '✨ Spells', String(stats.spells), '#2ecc71');
  drawStatBox(ctx, 390, typeY, 160, 60, '🪤 Traps', String(stats.traps), '#e91e63');
  
  // Stats section
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px Arial, sans-serif';
  ctx.fillText('Monster Stats', 30, 345);
  
  ctx.font = '13px Arial, sans-serif';
  ctx.fillStyle = '#aaa';
  ctx.fillText(`Avg ATK: ${stats.avgAtk}`, 30, 370);
  ctx.fillText(`Avg DEF: ${stats.avgDef}`, 150, 370);
  
  // Top archetypes
  if (stats.topArchetypes.length > 0) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px Arial, sans-serif';
    ctx.fillText('Top Archetypes', 300, 345);
    
    ctx.font = '13px Arial, sans-serif';
    ctx.fillStyle = '#c9a227';
    const archText = stats.topArchetypes
      .map(a => `${a.name} (${a.count})`)
      .join(', ');
    ctx.fillText(truncateText(ctx, archText, 270), 300, 370);
  }
  
  // Footer
  ctx.fillStyle = '#555';
  ctx.font = '11px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`Generated by DeckLens • ${new Date().toLocaleDateString()}`, width / 2, height - 12);
}

/**
 * Draw a stat box on canvas.
 */
function drawStatBox(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  value: string,
  accentColor: string
): void {
  // Box background
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fillRect(x, y, w, h);
  
  // Accent bar
  ctx.fillStyle = accentColor;
  ctx.fillRect(x, y, 4, h);
  
  // Label
  ctx.fillStyle = '#888';
  ctx.font = '12px Arial, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(label, x + 12, y + 22);
  
  // Value
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 24px Arial, sans-serif';
  ctx.fillText(value, x + 12, y + 50);
}

/**
 * Truncate text to fit within maxWidth.
 */
function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  
  let truncated = text;
  while (truncated.length > 0 && ctx.measureText(truncated + '…').width > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return truncated + '…';
}

export function showQrCode(): void {
  if (!currentDeck) {
    showToast('Please load a deck first');
    return;
  }
  const ydke = buildYDKEString();
  // Simple QR display using a public API
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(ydke)}`;
  
  // Create modal content
  const modal = $('cardModal');
  const modalBody = $('modalBody');
  if (modal && modalBody) {
    const img = document.createElement('img');
    img.src = qrUrl;
    img.alt = 'Deck QR Code';
    img.style.cssText = 'max-width:200px;border-radius:8px;background:#fff;padding:8px;';

    replaceChildren(modalBody,
      h('div', { style: 'text-align:center;padding:1rem;' },
        h('h3', { style: 'margin-bottom:1rem;' }, 'Deck QR Code'),
        img,
        h('p', { style: 'margin-top:1rem;font-size:0.8rem;color:var(--text-dim);' }, 'Scan to import deck in EDOPro'),
      )
    );
    modal.classList.add('active');
  }
  showToast('QR Code generated');
}

// ==================== PROXY PRINT ====================

/**
 * Convert YGO deck to proxy entries format.
 */
function deckToProxyEntries(): Array<{ name: string; qty: number; imageUrl?: string }> {
  if (!currentDeck || !currentCardMap) return [];
  
  // Count occurrences of each card ID
  const counts = new Map<number, number>();
  const allIds = [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side];
  
  for (const id of allIds) {
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  
  // Convert to proxy entries
  const entries: Array<{ name: string; qty: number; imageUrl?: string }> = [];
  
  for (const [id, qty] of counts) {
    const card = currentCardMap[id];
    if (card) {
      entries.push({
        name: card.name,
        qty,
        imageUrl: card.card_images?.[0]?.image_url,
      });
    } else {
      entries.push({
        name: `Unknown Card #${id}`,
        qty,
      });
    }
  }
  
  // Sort alphabetically by name
  entries.sort((a, b) => a.name.localeCompare(b.name));
  
  return entries;
}

/**
 * Open proxy print sheet in new window.
 */
export function exportProxy(): void {
  if (!currentDeck) {
    showToast('Please load a deck first');
    return;
  }
  
  if (!currentCardMap) {
    showToast('Card data not loaded');
    return;
  }
  
  const entries = deckToProxyEntries();
  
  if (entries.length === 0) {
    showToast('No cards to print');
    return;
  }
  
  showToast('Generating proxy sheet...');
  
  // Generate print-ready HTML
  const html = generatePrintHTML(entries, {
    title: currentDeckName || 'YGO Proxy Sheet',
    showNames: false, // Card images already have names
    showCutGuides: true,
    showCount: true,
    quality: 'normal',
  });
  
  // Open in new window for printing
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showError('Popup blocked. Please allow popups for this site.');
    return;
  }
  
  printWindow.document.write(html);
  printWindow.document.close();
  
  // Auto-focus and suggest print after images load
  printWindow.onload = () => {
    printWindow.focus();
    showToast('Proxy sheet ready! Press Ctrl+P to print.');
  };
}

// ==================== DECK COMPARISON ====================

export function toggleComparePanel(): void {
  const panel = $('comparePanel');
  if (!panel) {
    showToast('Compare panel not found');
    return;
  }
  
  const isOpening = !panel.classList.contains('active');
  panel.classList.toggle('active');
  
  if (isOpening) {
    // Reset comparison state when opening
    compareDeck = null;
    compareDeckName = '';
    
    // Clear previous diff display
    const diffEl = $('compareDiff');
    if (diffEl) {
      replaceChildren(diffEl, 
        h('p', { className: 'compare-hint', style: 'color:var(--text-dim);font-size:0.9rem;text-align:center;' },
          currentDeck ? 'Drop or select a .YDK file to compare with your current deck' : 'Load a deck first, then drop another .YDK file to compare'
        )
      );
    }
    
    // Inject comparison styles
    injectComparisonStyles();
    
    showToast('Compare panel opened');
  } else {
    showToast('Compare panel closed');
  }
}

/**
 * Handle comparison file upload.
 * Called when user drops or selects a file in the compare panel.
 */
export async function handleCompareFile(file: File): Promise<void> {
  if (!currentDeck) {
    showError('Please load a deck first before comparing');
    return;
  }
  
  if (!currentCardMap) {
    showError('Card data not loaded. Please reload your deck.');
    return;
  }
  
  const FILE_MAX_BYTES = 2 * 1024 * 1024;
  if (file.size > FILE_MAX_BYTES) {
    showError(`File too large (max ${FILE_MAX_BYTES / 1024 / 1024}MB)`);
    return;
  }
  
  if (!file.name.toLowerCase().endsWith('.ydk')) {
    showError('Please select a .YDK file');
    return;
  }
  
  try {
    const text = await file.text();
    compareDeck = parseYDK(text);
    compareDeckName = file.name.replace('.ydk', '').replace(/[_-]/g, ' ');
    
    // Run comparison
    await runComparison();
  } catch (e) {
    showError('Failed to parse comparison file');
    console.error('[YGO Compare] Parse error:', e);
  }
}

/**
 * Run deck comparison and render results.
 */
async function runComparison(): Promise<void> {
  if (!currentDeck || !compareDeck || !currentCardMap) {
    showError('Both decks must be loaded for comparison');
    return;
  }
  
  showToast('Comparing decks...');
  
  // For comparison deck, we need card names. 
  // Fetch card data for the comparison deck IDs we don't have yet.
  const allCompareIds = [...compareDeck.main, ...compareDeck.extra, ...compareDeck.side];
  const missingIds = allCompareIds.filter(id => !currentCardMap![id]);
  
  if (missingIds.length > 0) {
    // Fetch missing cards
    const uniqueMissing = [...new Set(missingIds)];
    if (uniqueMissing.length > 750) {
      showError('Comparison deck has too many unique cards');
      return;
    }
    
    try {
      const chunks: number[][] = [];
      for (let i = 0; i < uniqueMissing.length; i += 75) {
        chunks.push(uniqueMissing.slice(i, i + 75));
      }
      
      for (const chunk of chunks) {
        const idsParam = chunk.join(',');
        const resp = await fetch(`${API}?id=${idsParam}`);
        if (resp.ok) {
          const data = await resp.json();
          for (const card of data.data || []) {
            currentCardMap![card.id] = card;
          }
        }
      }
    } catch (e) {
      console.warn('[YGO Compare] Failed to fetch some comparison cards:', e);
    }
  }
  
  // Convert both decks to DeckZones format
  const zonesA = ygoDeckToZones(currentDeck, currentCardMap);
  const zonesB = ygoDeckToZones(compareDeck, currentCardMap);
  
  // Run diff
  const diff = compareDecksDiff(zonesA, zonesB);
  
  // Render results
  const diffEl = $('compareDiff');
  if (diffEl) {
    renderDeckComparison(diffEl, diff, {
      deckNameA: currentDeckName || 'Current Deck',
      deckNameB: compareDeckName || 'Comparison Deck',
      showUnchanged: true,
    });
  }
  
  showToast(createDiffSummary(diff));
}

/**
 * Close compare panel.
 */
export function closeComparePanel(): void {
  const panel = $('comparePanel');
  if (panel) {
    panel.classList.remove('active');
    compareDeck = null;
    compareDeckName = '';
  }
}

// ==================== SHARE ====================
function buildYDKEString(): string {
  if (!currentDeck) return '';
  const encode = (ids: number[]): string => {
    const bytes: number[] = [];
    for (const id of ids) {
      bytes.push(id & 0xFF, (id >> 8) & 0xFF, (id >> 16) & 0xFF, (id >> 24) & 0xFF);
    }
    return btoa(String.fromCharCode(...bytes));
  };
  return `ydke://${encode(currentDeck.main)}!${encode(currentDeck.extra)}!${encode(currentDeck.side)}!`;
}

export function generateShareUrl(): void {
  if (!currentDeck) return;
  const el = $('shareUrl') as HTMLInputElement;
  if (!el) return;
  
  const ydke = buildYDKEString();
  const encoded = encodeURIComponent(ydke);
  const url = `${location.origin}${location.pathname}?deck=${encoded}`;
  el.value = url;
}

export function copyShareUrl(): void {
  const el = $('shareUrl') as HTMLInputElement;
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => showToast('Share URL copied!'));
}

export function shareNative(): void {
  const el = $('shareUrl') as HTMLInputElement;
  if (!el || !navigator.share) return;
  navigator.share({
    title: currentDeckName,
    url: el.value
  }).catch(() => {});
}

// ==================== COLLECTION ====================
function getCollection(): Record<number, number> {
  return storageGet<Record<number, number>>(STORAGE_KEYS.YGO_COLLECTION, {});
}

function saveCollection(coll: Record<number, number>): void {
  storageSet(STORAGE_KEYS.YGO_COLLECTION, coll);
}

export function renderCollection(): void {
  if (!currentDeck || !currentCardMap) return;
  const el = $('collectionPanel');
  if (!el) return;
  
  const coll = getCollection();
  const allIds = [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side];
  const counts = buildCounts();
  
  let missing = 0;
  const rows: HTMLElement[] = [];
  
  const processed = new Set<number>();
  for (const id of allIds) {
    if (processed.has(id)) continue;
    processed.add(id);
    const card = currentCardMap[id];
    if (!card) continue;
    const needed = counts[id] || 1;
    const owned = coll[id] || 0;
    const deficit = Math.max(0, needed - owned);
    missing += deficit;
    
    rows.push(
      h('div', { className: `collection-row ${deficit > 0 ? 'missing' : 'owned'}` },
        h('span', { className: 'coll-name' }, card.name),
        h('span', { className: 'coll-qty' }, `${owned}/${needed}`),
        h('div', { className: 'coll-actions' },
          h('button', { className: 'btn-sm', 'data-action': 'adjust-coll', 'data-id': String(id), 'data-delta': '-1' }, '−'),
          h('button', { className: 'btn-sm', 'data-action': 'adjust-coll', 'data-id': String(id), 'data-delta': '1' }, '+')
        )
      )
    );
  }
  
  replaceChildren(el,
    h('div', { className: 'collection-list' }, ...rows),
    h('div', { className: 'collection-summary' }, `Missing: ${missing} cards`)
  );
}

export function adjustCollection(id: number, delta: number): void {
  const coll = getCollection();
  coll[id] = Math.max(0, (coll[id] || 0) + delta);
  saveCollection(coll);
  renderCollection();
}

export function markAllOwned(): void {
  if (!currentDeck) return;
  const coll = getCollection();
  const counts = buildCounts();
  for (const [id, needed] of Object.entries(counts)) {
    coll[Number(id)] = Math.max(coll[Number(id)] || 0, needed);
  }
  saveCollection(coll);
  renderCollection();
  showToast('Marked all as owned');
}

export function clearCollection(): void {
  if (!confirm('Clear your entire collection data?')) return;
  storageRemove(STORAGE_KEYS.YGO_COLLECTION);
  renderCollection();
  showToast('Collection cleared');
}


// ==================== VERSIONS ====================
function getVersions(): DeckVersion[] {
  return storageGet<DeckVersion[]>(STORAGE_KEYS.YGO_VERSIONS, []);
}

function saveVersions(versions: DeckVersion[]): void {
  storageSet(STORAGE_KEYS.YGO_VERSIONS, versions);
}

export function saveVersion(): void {
  if (!currentDeck) return;
  const name = prompt('Version name:', `v${getVersions().length + 1}`);
  if (!name) return;
  
  const versions = getVersions();
  versions.push({ name, deck: { ...currentDeck }, ts: Date.now() });
  saveVersions(versions);
  renderVersions();
  showToast(`Saved version: ${name}`);
}

export function renderVersions(): void {
  const el = $('versionList');
  if (!el) return;
  
  const versions = getVersions();
  if (versions.length === 0) {
    replaceChildren(el, h('div', { className: 'empty' }, 'No saved versions'));
    return;
  }
  
  replaceChildren(el, ...versions.map((v, i) => {
    const date = new Date(v.ts).toLocaleDateString();
    return h('div', { className: 'version-row' },
      h('span', { className: 'version-name' }, v.name),
      h('span', { className: 'version-date' }, date),
      h('button', { className: 'btn-sm', 'data-action': 'version-load', 'data-idx': String(i) }, 'Load'),
      h('button', { className: 'btn-sm danger', 'data-action': 'version-remove', 'data-idx': String(i) }, '×')
    );
  }));
}

export function loadVersion(idx: number): void {
  const versions = getVersions();
  const v = versions[idx];
  if (!v) return;
  currentDeckName = v.name;
  processDeck(v.deck);
}

export function removeVersion(idx: number): void {
  const versions = getVersions();
  versions.splice(idx, 1);
  saveVersions(versions);
  renderVersions();
}

// ==================== HYPERGEOMETRIC CALCULATOR ====================
function factorial(n: number): number {
  if (n <= 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  return factorial(n) / (factorial(k) * factorial(n - k));
}

function hypergeometric(N: number, K: number, n: number, k: number): number {
  return (comb(K, k) * comb(N - K, n - k)) / comb(N, n);
}

export function addHyperCategory(): void {
  const id = 'cat_' + Date.now();
  hyperCategories.push({ id, name: 'New Category', cards: [], target: 1 });
  renderHyperCategories();
}

export function removeHyperCategory(id: string): void {
  const idx = hyperCategories.findIndex(c => c.id === id);
  if (idx >= 0) {
    hyperCategories.splice(idx, 1);
    renderHyperCategories();
    calcHyperAll();
  }
}

export function renderHyperCategories(): void {
  const el = $('hyperCategories');
  if (!el) return;
  
  if (hyperCategories.length === 0) {
    replaceChildren(el, h('div', { className: 'empty' }, 'Add categories to calculate opening hand probabilities'));
    return;
  }
  
  replaceChildren(el, ...hyperCategories.map(cat =>
    h('div', { className: 'hyper-row', 'data-cat-id': cat.id },
      h('input', { 
        type: 'text', 
        className: 'hyper-name', 
        value: cat.name,
        onChange: (e: Event) => updateHyperCat(cat.id, 'name', (e.target as HTMLInputElement).value)
      }),
      h('input', { 
        type: 'number', 
        className: 'hyper-target', 
        value: String(cat.target), 
        min: '1', 
        max: '5',
        onChange: (e: Event) => updateHyperCat(cat.id, 'target', (e.target as HTMLInputElement).value)
      }),
      h('span', { className: 'hyper-cards' }, `${cat.cards.length} cards`),
      h('button', { className: 'btn-sm', 'data-action': 'picker-toggle', 'data-cat-id': cat.id }, 'Edit'),
      h('button', { className: 'btn-sm danger', 'data-action': 'hyper-remove', 'data-cat-id': cat.id }, '×'),
      h('span', { className: 'hyper-prob', id: `prob-${cat.id}` }, '—')
    )
  ));
}

export function updateHyperCat(id: string, field: string, value: string): void {
  const cat = hyperCategories.find(c => c.id === id);
  if (!cat) return;
  if (field === 'name') cat.name = value;
  else if (field === 'target') cat.target = parseInt(value) || 1;
  calcHyperAll();
}

export function calcHyperAll(): void {
  if (!currentDeck) return;
  const deckSize = currentDeck.main.length;
  const handSize = 5;
  
  for (const cat of hyperCategories) {
    const K = cat.cards.reduce((sum, id) => {
      const counts = buildCounts();
      return sum + (counts[id] || 0);
    }, 0);
    
    let prob = 0;
    for (let k = cat.target; k <= Math.min(K, handSize); k++) {
      prob += hypergeometric(deckSize, K, handSize, k);
    }
    
    const el = $(`prob-${cat.id}`);
    if (el) el.textContent = `${(prob * 100).toFixed(1)}%`;
  }
}

export function togglePicker(catId: string): void {
  const picker = $('cardPicker');
  if (!picker) return;
  
  if (picker.dataset.catId === catId && picker.classList.contains('active')) {
    hide(picker);
    return;
  }
  
  picker.dataset.catId = catId;
  renderPicker(catId);
  show(picker);
}

function renderPicker(catId: string): void {
  const picker = $('cardPicker');
  if (!picker || !currentCardMap) return;
  
  const cat = hyperCategories.find(c => c.id === catId);
  if (!cat) return;
  
  const uniqueIds = [...new Set([...(currentDeck?.main || [])])];
  
  const searchInput = h('input', { 
    type: 'text', 
    id: 'pickerSearch', 
    placeholder: 'Search cards...',
    onInput: () => filterPicker()
  });
  
  const cardElements = uniqueIds.map(id => {
    const card = currentCardMap![id];
    if (!card) return null;
    const selected = cat.cards.includes(id);
    const img = card.card_images?.[0]?.image_url_small || '';
    return h('div', { 
      className: `picker-card ${selected ? 'selected' : ''}`,
      'data-id': String(id),
      'data-action': 'combo-card-toggle',
      'data-cat-id': catId
    },
      h('img', { src: sanitizeUrl(img), alt: card.name }),
      h('span', { className: 'picker-name' }, card.name)
    );
  }).filter(Boolean) as HTMLElement[];
  
  replaceChildren(picker,
    h('div', { className: 'picker-header' }, searchInput),
    h('div', { className: 'picker-cards' }, ...cardElements)
  );
}

export function filterPicker(): void {
  const search = ($('pickerSearch') as HTMLInputElement)?.value.toLowerCase() || '';
  const cards = document.querySelectorAll('.picker-card');
  cards.forEach(card => {
    const name = card.querySelector('.picker-name')?.textContent?.toLowerCase() || '';
    (card as HTMLElement).style.display = name.includes(search) ? '' : 'none';
  });
}

export function toggleCardInCategory(catId: string, cardId: number): void {
  const cat = hyperCategories.find(c => c.id === catId);
  if (!cat) return;
  
  const idx = cat.cards.indexOf(cardId);
  if (idx >= 0) {
    cat.cards.splice(idx, 1);
  } else {
    cat.cards.push(cardId);
  }
  
  renderPicker(catId);
  renderHyperCategories();
  calcHyperAll();
}

// ==================== COMBO CALCULATOR ====================
export function addComboLine(): void {
  const id = 'combo_' + Date.now();
  comboLineData.push({ id, name: 'New Combo', requirements: [{ type: 'any', cards: [] }] });
  renderComboLines();
}

export function removeComboLine(id: string): void {
  const idx = comboLineData.findIndex(c => c.id === id);
  if (idx >= 0) {
    comboLineData.splice(idx, 1);
    renderComboLines();
  }
}

export function renderComboLines(): void {
  const el = $('comboLines');
  if (!el) return;
  
  if (comboLineData.length === 0) {
    replaceChildren(el, h('div', { className: 'empty' }, 'Add combo lines to calculate probabilities'));
    return;
  }
  
  replaceChildren(el, ...comboLineData.map(combo =>
    h('div', { className: 'combo-row', 'data-combo-id': combo.id },
      h('input', { 
        type: 'text', 
        className: 'combo-name', 
        value: combo.name,
        onChange: (e: Event) => updateComboName(combo.id, (e.target as HTMLInputElement).value)
      }),
      h('div', { className: 'combo-reqs' },
        ...combo.requirements.map((req, i) =>
          h('div', { className: 'combo-req' },
            h('select', {
              onChange: (e: Event) => updateComboReqType(combo.id, i, (e.target as HTMLSelectElement).value)
            },
              h('option', { value: 'any', selected: req.type === 'any' }, 'Any of'),
              h('option', { value: 'all', selected: req.type === 'all' }, 'All of')
            ),
            h('span', { className: 'req-cards' }, `${req.cards.length} cards`),
            h('button', { className: 'btn-sm', 'data-action': 'combo-req-remove', 'data-combo-id': combo.id, 'data-req-idx': String(i) }, '×')
          )
        )
      ),
      h('button', { className: 'btn-sm', 'data-action': 'combo-req-add', 'data-combo-id': combo.id }, '+ Req'),
      h('button', { className: 'btn-sm danger', 'data-action': 'combo-remove', 'data-combo-id': combo.id }, '×'),
      h('span', { className: 'combo-prob', id: `combo-prob-${combo.id}` }, '—')
    )
  ));
}

export function updateComboName(id: string, name: string): void {
  const combo = comboLineData.find(c => c.id === id);
  if (combo) combo.name = name;
}

export function updateComboReqType(id: string, idx: number, type: string): void {
  const combo = comboLineData.find(c => c.id === id);
  if (combo && combo.requirements[idx]) {
    combo.requirements[idx].type = type as 'any' | 'all';
  }
}

export function addComboRequirement(id: string): void {
  const combo = comboLineData.find(c => c.id === id);
  if (combo) {
    combo.requirements.push({ type: 'any', cards: [] });
    renderComboLines();
  }
}

export function removeComboRequirement(id: string, idx: number): void {
  const combo = comboLineData.find(c => c.id === id);
  if (combo && combo.requirements.length > 1) {
    combo.requirements.splice(idx, 1);
    renderComboLines();
  }
}

export function calcCombos(): void {
  // Simplified combo calculation using Monte Carlo simulation
  if (!currentDeck) return;
  
  const iterations = 10000;
  const handSize = 5;
  const pool = [...currentDeck.main];
  
  for (const combo of comboLineData) {
    let successes = 0;
    
    for (let i = 0; i < iterations; i++) {
      // Shuffle
      const shuffled = [...pool];
      for (let j = shuffled.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
      }
      
      const hand = shuffled.slice(0, handSize);
      
      // Check all requirements
      let allMet = true;
      for (const req of combo.requirements) {
        if (req.cards.length === 0) continue;
        
        if (req.type === 'any') {
          const hasAny = req.cards.some(c => hand.includes(c));
          if (!hasAny) { allMet = false; break; }
        } else if (req.type === 'all') {
          const hasAll = req.cards.every(c => hand.includes(c));
          if (!hasAll) { allMet = false; break; }
        }
      }
      
      if (allMet) successes++;
    }
    
    const prob = successes / iterations;
    const el = $(`combo-prob-${combo.id}`);
    if (el) el.textContent = `${(prob * 100).toFixed(1)}%`;
  }
}

// ==================== HAND PROBABILITY CALCULATOR ====================
export function calcHand(): void {
  if (!currentDeck) return;
  
  const deckSize = parseInt(($('calcDeck') as HTMLInputElement)?.value) || currentDeck.main.length;
  const handSize = parseInt(($('calcHand') as HTMLInputElement)?.value) || 5;
  const copies = parseInt(($('calcCopies') as HTMLInputElement)?.value) || 3;
  const target = parseInt(($('calcTarget') as HTMLInputElement)?.value) || 1;
  
  let prob = 0;
  for (let k = target; k <= Math.min(copies, handSize); k++) {
    prob += hypergeometric(deckSize, copies, handSize, k);
  }
  
  const el = $('calcResult');
  if (el) el.textContent = `${(prob * 100).toFixed(2)}%`;
}

// ==================== TOOLS PANEL ====================
export function toggleToolsPanel(show: boolean): void {
  const panel = $('toolsPanel');
  if (!panel) return;
  if (show) {
    panel.classList.add('active');
  } else {
    panel.classList.remove('active');
  }
}

export function setToolTab(tab: string): void {
  document.querySelectorAll('.tool-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tool-content').forEach(c => c.classList.remove('active'));
  document.querySelector(`.tool-tab[data-tab="${tab}"]`)?.classList.add('active');
  $(`tool-${tab}`)?.classList.add('active');
}

// ==================== TOOL PLACEHOLDERS ====================
// These functions need full implementation

export function generateDNA(): void {
  if (!currentDeck || !currentCardMap) {
    showToast('Please load a deck first');
    return;
  }
  
  // Simple DNA analysis based on card types
  const counts = { monster: 0, spell: 0, trap: 0 };
  for (const id of [...currentDeck.main, ...currentDeck.extra, ...currentDeck.side]) {
    const card = currentCardMap[id];
    if (!card) continue;
    const type = card.type.toLowerCase();
    if (type.includes('monster')) counts.monster++;
    else if (type.includes('spell')) counts.spell++;
    else if (type.includes('trap')) counts.trap++;
  }
  
  const total = counts.monster + counts.spell + counts.trap;
  const profile = $('dnaProfile');
  if (profile) {
    const pct = (n: number) => total > 0 ? ((n / total) * 100).toFixed(0) : '0';
    replaceChildren(profile,
      h('div', { style: 'margin-top:0.5rem;' },
        h('div', {}, `🐲 Monsters: ${counts.monster} (${pct(counts.monster)}%)`),
        h('div', {}, `✨ Spells: ${counts.spell} (${pct(counts.spell)}%)`),
        h('div', {}, `🪤 Traps: ${counts.trap} (${pct(counts.trap)}%)`),
      )
    );
  }
  showToast('DNA Profile generated');
}

export function detectEngines(): void {
  if (!currentDeck || !currentCardMap) {
    showToast('Please load a deck first');
    return;
  }
  
  // Simple archetype detection
  const archetypes: Record<string, number> = {};
  for (const id of currentDeck.main) {
    const card = currentCardMap[id];
    if (card?.archetype) {
      archetypes[card.archetype] = (archetypes[card.archetype] || 0) + 1;
    }
  }
  
  const results = $('engineResults');
  if (results) {
    const sorted = Object.entries(archetypes).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) {
      replaceChildren(results,
        h('div', { style: 'color:var(--text-dim);' }, 'No clear engine detected')
      );
    } else {
      replaceChildren(results, fragment(
        ...sorted.slice(0, 5).map(([name, count]) =>
          h('div', { style: 'margin:0.3rem 0;' }, `⚙️ ${name}: ${count} cards`)
        )
      ));
    }
  }
  showToast('Engines detected');
}

export function runHandGrade(): void {
  if (!currentDeck) {
    showToast('Please load a deck first');
    return;
  }
  
  const simCount = parseInt(($('gradeSimCount') as HTMLInputElement)?.value || '1000');
  const handSize = parseInt(($('gradeHandSize') as HTMLSelectElement)?.value || '5');
  
  // Simple simulation
  const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  const mainDeck = currentDeck.main;
  
  for (let i = 0; i < simCount; i++) {
    // Shuffle and draw
    const shuffled = [...mainDeck].sort(() => Math.random() - 0.5);
    const hand = shuffled.slice(0, handSize);
    
    // Simple grading based on variety
    const unique = new Set(hand).size;
    const ratio = unique / handSize;
    
    if (ratio >= 0.9) grades.A++;
    else if (ratio >= 0.7) grades.B++;
    else if (ratio >= 0.5) grades.C++;
    else if (ratio >= 0.3) grades.D++;
    else grades.F++;
  }
  
  const results = $('gradeResults');
  if (results) {
    replaceChildren(results, fragment(
      ...Object.entries(grades).map(([grade, count]) =>
        h('div', {}, `Grade ${grade}: ${((count / simCount) * 100).toFixed(1)}%`)
      )
    ));
  }
  showToast(`Simulated ${simCount} hands`);
}

export function calculateCraftCost(): void {
  if (!currentDeck || !currentCardMap) {
    showToast('Please load a deck first');
    return;
  }
  
  // Master Duel rarity estimation based on card type
  const costs = { UR: 0, SR: 0, R: 0, N: 0 };
  const counts = buildCounts();
  
  for (const [idStr, qty] of Object.entries(counts)) {
    const id = parseInt(idStr);
    const card = currentCardMap[id];
    if (!card) continue;
    
    // Simple heuristic: Extra deck monsters tend to be higher rarity
    const type = card.type.toLowerCase();
    if (type.includes('link') || type.includes('xyz') || type.includes('synchro') || type.includes('fusion')) {
      costs.UR += qty;
    } else if (card.atk && card.atk >= 2500) {
      costs.SR += qty;
    } else if (card.atk && card.atk >= 1500) {
      costs.R += qty;
    } else {
      costs.N += qty;
    }
  }
  
  const display = $('craftDisplay');
  if (display) {
    const totalCp = (costs.UR + costs.SR + costs.R + costs.N) * 30;
    const rarityBox = (label: string, count: number, bg: string, color?: string) =>
      h('div', { style: `text-align:center;padding:0.5rem;background:${bg};border-radius:4px;${color ? `color:${color};` : ''}` },
        h('span', {}, `${label}: ${count}`),
        h('br', {}),
        h('small', {}, `${count * 30} CP`),
      );

    replaceChildren(display, fragment(
      h('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:0.5rem;margin-top:0.5rem;' },
        rarityBox('UR', costs.UR, 'linear-gradient(135deg,#ffd700,#ff8c00)', '#000'),
        rarityBox('SR', costs.SR, 'linear-gradient(135deg,#c0c0c0,#808080)', '#000'),
        rarityBox('R', costs.R, 'linear-gradient(135deg,#0099ff,#0066cc)'),
        rarityBox('N', costs.N, 'var(--bg-3)'),
      ),
      h('div', { style: 'margin-top:0.5rem;text-align:center;color:var(--text-dim);font-size:0.8rem;' },
        `Total: ~${totalCp} CP estimated`
      ),
    ));
  }
  showToast('Craft cost calculated');
}

export function calculateSalt(): void {
  if (!currentDeck || !currentCardMap) {
    showToast('Please load a deck first');
    return;
  }
  
  // Simple salt score based on certain card characteristics
  let salt = 0;
  const counts = buildCounts();
  const saltCards: string[] = [];
  
  for (const [idStr, qty] of Object.entries(counts)) {
    const id = parseInt(idStr);
    const card = currentCardMap[id];
    if (!card) continue;
    
    const desc = (card.desc || '').toLowerCase();
    const name = card.name.toLowerCase();
    
    // Cards that typically cause salt
    if (desc.includes('negate') || desc.includes('cannot be')) {
      salt += 2 * qty;
      saltCards.push(card.name);
    }
    if (desc.includes('banish') || desc.includes('destroy all')) {
      salt += 1 * qty;
    }
    if (name.includes('maxx') || name.includes('ash blossom') || name.includes('nibiru')) {
      salt += 3 * qty;
      saltCards.push(card.name);
    }
  }
  
  const display = $('saltDisplay');
  if (display) {
    const rating = salt > 30 ? '🧂🧂🧂 Very Salty' : salt > 15 ? '🧂🧂 Moderately Salty' : '🧂 Low Salt';
    const children: (HTMLElement | Text)[] = [
      h('div', { style: 'text-align:center;font-size:1.5rem;margin:0.5rem 0;' }, `${salt} Salt Points`),
      h('div', { style: 'text-align:center;color:var(--gold);' }, rating),
    ];
    if (saltCards.length > 0) {
      const uniqueSalty = [...new Set(saltCards)];
      const preview = uniqueSalty.slice(0, 5).join(', ') + (uniqueSalty.length > 5 ? '...' : '');
      children.push(
        h('div', { style: 'margin-top:0.5rem;font-size:0.8rem;color:var(--text-dim);' }, `Salty cards: ${preview}`)
      );
    }
    replaceChildren(display, fragment(...children));
  }
  showToast('Salt score calculated');
}

// ==================== DECK IMAGE PREVIEW & DOWNLOAD ====================

export function generateDeckImagePreview(): void {
  // Reuse the existing canvas export but show in preview div instead of downloading
  if (!currentDeck || !currentCardMap) {
    showToast('Please load a deck first');
    return;
  }

  const stats = gatherDeckStats();
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    showToast('Canvas not supported');
    return;
  }
  renderDeckSummaryToCanvas(ctx, canvas.width, canvas.height, stats);

  const preview = $('imgPreview');
  if (preview) {
    preview.textContent = '';
    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    img.style.maxWidth = '100%';
    img.style.borderRadius = '8px';
    preview.appendChild(img);
  }
  showToast('Preview generated');
}

export function downloadDeckImage(): void {
  // Same as exportDeckImage
  exportDeckImage();
}

// ==================== QR CODE DOWNLOAD ====================

export function downloadQrCode(): void {
  if (!currentDeck) {
    showToast('Please load a deck first');
    return;
  }
  const ydke = buildYDKEString();
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(ydke)}`;

  // Fetch the image and download it
  fetch(qrUrl)
    .then(resp => {
      if (!resp.ok) throw new Error('QR fetch failed');
      return resp.blob();
    })
    .then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sanitizeFilename(currentDeckName || 'deck') + '-qr.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('QR code downloaded');
    })
    .catch(() => {
      showToast('Failed to download QR code');
    });
}

// ==================== COLLECTION CSV EXPORT/IMPORT ====================

export function exportCollectionCsv(): void {
  if (!currentCardMap) {
    showToast('Please load a deck first');
    return;
  }

  const collKey = 'ygo_collection';
  const stored = storageGet<Record<string, number>>(collKey, {});
  if (Object.keys(stored).length === 0) {
    showToast('Collection is empty');
    return;
  }

  const lines = ['id,name,qty'];
  for (const [id, qty] of Object.entries(stored)) {
    const card = currentCardMap[parseInt(id)];
    const name = card?.name || `Unknown #${id}`;
    // SECURITY: Escape CSV values
    const safeName = name.includes(',') || name.includes('"')
      ? `"${name.replace(/"/g, '""')}"` : name;
    lines.push(`${id},${safeName},${qty}`);
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'ygo-collection.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Collection exported as CSV');
}

export function importCollectionCsv(): void {
  const input = $('collImportFile') as HTMLInputElement | null;
  input?.click();
}

export function handleCollectionFile(file: File): void {
  if (file.size > 2 * 1024 * 1024) {
    showError('File too large (max 2MB)');
    return;
  }

  file.text().then(text => {
    const lines = text.split('\n').filter(l => l.trim());
    const collKey = 'ygo_collection';
    const collection = storageGet<Record<string, number>>(collKey, {});
    let count = 0;

    for (const line of lines) {
      // Skip header
      if (line.toLowerCase().startsWith('id,') || line.toLowerCase().startsWith('name,')) continue;
      // Try CSV: id,name,qty
      const parts = line.split(',');
      if (parts.length >= 3) {
        const id = parts[0].trim();
        const qty = parseInt(parts[parts.length - 1].trim());
        if (id && !isNaN(qty) && qty > 0) {
          collection[id] = qty;
          count++;
        }
      }
    }

    if (count > 0) {
      storageSet(collKey, collection);
      showToast(`Imported ${count} cards into collection`);
      renderCollection();
    } else {
      showError('Could not parse any cards from CSV');
    }
  });
}

// ==================== CROSS-FORMAT / TAGS / FOLDERS (Coming Soon) ====================

export function buildCrossFormatMatrix(): void {
  showToast('Cross-format legality matrix coming soon!');
}

export function addTag(): void {
  showToast('Tag management coming soon!');
}

export function addFolder(): void {
  showToast('Folder management coming soon!');
}

// ==================== URL PARAMS ====================
function checkUrlParams(): void {
  const params = new URLSearchParams(location.search);
  const deckParam = params.get('deck');
  
  if (deckParam) {
    try {
      const decoded = decodeURIComponent(deckParam);
      const deck = parseYDKE(decoded);
      if (deck) {
        currentDeckName = 'Shared Deck';
        processDeck(deck);
        // Clear URL params
        history.replaceState(null, '', location.pathname);
      }
    } catch (e) {
      console.warn('Failed to parse deck from URL:', e);
    }
  }
}

// ==================== INIT ====================
export function initYgoApp(): void {
  initTheme();
  renderRecent();
  renderVersions();
  renderHyperCategories();
  renderComboLines();
  checkUrlParams();
  
  // Register lazy panels
  registerLazyPanel('collectionPanel', renderCollection);
  registerLazyPanel('versionPanel', renderVersions);
}

// Export for window._ygo binding
export {
  testHandState,
  hyperCategories,
  comboLineData,
  currentDeck,
  currentCardMap,
  currentDeckName
};
