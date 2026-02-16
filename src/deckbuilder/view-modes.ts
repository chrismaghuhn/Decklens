import { h, replaceChildren, mapChildren } from '../shared/dom.js';
import { normalizeNameKey } from '../shared/utils.js';
import { STORAGE_KEYS, storageGet, storageSet } from '../shared/storage.js';
import type { DeckBoard, DeckbuilderCardEntry, DeckbuilderDeck, DeckbuilderCardView, CustomCategory } from './types.js';
import { getAutoTagForEntry, CATEGORY_PRIORITY, CATEGORY_COLORS, type CardCategory } from './auto-categories.js';
import { getTeamOwnership } from './collab-collection.js';
import { isCollabActive } from './collab-ui.js';

// ==================== Types ====================

export type ViewMode = 'grid' | 'list' | 'pile';
export type PileSortMode = 'type' | 'cmc' | 'color' | 'rarity' | 'tag';
export type ListSortMode = 'name' | 'cmc' | 'color' | 'rarity' | 'type' | 'price';
export type CardDensity = 'compact' | 'normal' | 'large';

export type ChartFilter = { type: 'cmc'; value: number } | { type: 'color'; value: string } | { type: 'cardType'; value: string } | null;

export interface ViewModeContext {
  deck: DeckbuilderDeck;
  activeBoard: DeckBoard;
  resolvedCardByName: Record<string, DeckbuilderCardView | undefined>;
  boardLabels: Record<DeckBoard, string>;
  boardOrder: DeckBoard[];
  chartFilter: ChartFilter;
  deckFilter: string;
  onQtyChange(board: DeckBoard, name: string, delta: number): void;
  onRemove(board: DeckBoard, name: string): void;
  onMove(from: DeckBoard, to: DeckBoard, name: string): void;
  onTagsChange(board: DeckBoard, name: string, tags: string): void;
  onCardClick(name: string, e: MouseEvent): void;
  onCardContextMenu(name: string, e: MouseEvent): void;
  onCardMouseEnter(name: string, e: MouseEvent): void;
  onCardMouseLeave(): void;
  getSelectedCards(): Set<string>;
  onCardSelect(name: string, e: MouseEvent): void;
  /** Optional: returns a vote widget element for the card (collab voting) */
  getVoteWidget?(board: DeckBoard, cardName: string): HTMLElement | null;
}

// ==================== State ====================

let currentViewMode: ViewMode = 'grid';
let pileSortMode: PileSortMode = 'type';
let listSortMode: ListSortMode = 'name';
let cardDensity: CardDensity = 'normal';

// ==================== Memoized Filter/Sort Cache ====================

interface FilterSortMemo {
  inputHash: string;
  result: DeckbuilderCardEntry[];
}

let filterSortMemo: FilterSortMemo | null = null;

function computeFilterSortHash(
  entries: DeckbuilderCardEntry[],
  chartFilter: ChartFilter,
  deckFilter: string,
  sortMode: ListSortMode,
  resolvedCardByName: Record<string, DeckbuilderCardView | undefined>,
): string {
  // Fast fingerprint: count + card names/qtys + filter state + sort mode + card data availability
  let hash = `${entries.length}|${sortMode}|${deckFilter}|`;
  hash += chartFilter ? `${chartFilter.type}:${chartFilter.value}` : 'none';
  
  // Count how many cards have resolved data - this ensures cache invalidation when card data loads
  let resolvedCount = 0;
  for (const e of entries) {
    hash += `|${e.name}:${e.qty}`;
    if (resolvedCardByName[normalizeNameKey(e.name)]) {
      resolvedCount++;
    }
  }
  hash += `|resolved:${resolvedCount}`;
  return hash;
}

function getFilteredSortedEntries(
  allEntries: DeckbuilderCardEntry[],
  chartFilter: ChartFilter,
  deckFilter: string,
  sortMode: ListSortMode,
  resolvedCardByName: Record<string, DeckbuilderCardView | undefined>,
): DeckbuilderCardEntry[] {
  const hash = computeFilterSortHash(allEntries, chartFilter, deckFilter, sortMode, resolvedCardByName);
  if (filterSortMemo && filterSortMemo.inputHash === hash) {
    return filterSortMemo.result;
  }
  const result = sortEntries(
    applyDeckFilter(
      applyChartFilter(allEntries, chartFilter, resolvedCardByName),
      deckFilter, resolvedCardByName,
    ),
    sortMode, resolvedCardByName,
  );
  filterSortMemo = { inputHash: hash, result };
  return result;
}

/** Invalidate the filter/sort memo cache. Call on deck mutations. */
export function invalidateViewMemo(): void {
  filterSortMemo = null;
}

// ==================== Persistence ====================

export function getViewMode(): ViewMode {
  return currentViewMode;
}

export function setViewMode(mode: ViewMode): void {
  currentViewMode = mode;
  storageSet(STORAGE_KEYS.DECKBUILDER_VIEW_MODE, mode);
}

export function getPileSortMode(): PileSortMode {
  return pileSortMode;
}

export function setPileSortMode(mode: PileSortMode): void {
  pileSortMode = mode;
}

export function getListSortMode(): ListSortMode {
  return listSortMode;
}

export function setListSortMode(mode: ListSortMode): void {
  listSortMode = mode;
}

export function getCardDensity(): CardDensity {
  return cardDensity;
}

export function setCardDensity(d: CardDensity): void {
  cardDensity = d;
  storageSet(STORAGE_KEYS.DECKBUILDER_CARD_DENSITY, d);
}

export function loadViewModePreference(): void {
  const saved = storageGet<string>(STORAGE_KEYS.DECKBUILDER_VIEW_MODE, 'grid');
  if (saved === 'grid' || saved === 'list' || saved === 'pile') {
    currentViewMode = saved;
  }
  const savedDensity = storageGet<string>(STORAGE_KEYS.DECKBUILDER_CARD_DENSITY, 'normal');
  if (savedDensity === 'compact' || savedDensity === 'normal' || savedDensity === 'large') {
    cardDensity = savedDensity;
  }
}

/** Render team ownership badge if collab is active and team has collection data */
function teamOwnBadge(cardName: string): HTMLElement | string {
  if (!isCollabActive()) return '';
  const data = getTeamOwnership(cardName);
  if (!data || data.total === 0) return '';
  const ownerCount = data.owners.length;
  const cls = ownerCount >= 3 ? 'team-own-full' : ownerCount >= 1 ? 'team-own-partial' : 'team-own-none';
  return h('span', {
    className: `team-own-badge ${cls}`,
    title: data.owners.map((o) => `${o.name}: ${o.qty}x`).join(', '),
  }, `\u2713 ${data.total}`);
}

function getCardImage(card: DeckbuilderCardView | undefined, size: 'normal' | 'small' = 'normal'): string {
  return card?.image_uris?.[size] || card?.image_uris?.normal || card?.image_uris?.small || '';
}

// Transparent 1x1 GIF placeholder for deferred image loading
const PLACEHOLDER_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** IntersectionObserver that swaps data-src → src when images enter viewport */
const imgObserver = new IntersectionObserver((entries, obs) => {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      const img = entry.target as HTMLImageElement;
      if (img.dataset.src) {
        img.src = img.dataset.src;
        img.removeAttribute('data-src');
      }
      obs.unobserve(img);
    }
  }
}, { rootMargin: '200px' });

/** Create an img element with IntersectionObserver lazy loading and error fallback */
function cardImg(src: string, alt: string, className?: string): HTMLElement {
  const img = document.createElement('img');
  img.dataset.src = src;
  img.src = PLACEHOLDER_GIF;
  img.alt = alt;
  if (className) img.className = className;
  img.addEventListener('error', () => {
    // Replace failed image with placeholder text
    const placeholder = document.createElement('div');
    placeholder.className = className ? `${className} gcard-placeholder` : 'gcard-placeholder';
    placeholder.textContent = alt;
    img.replaceWith(placeholder);
  });
  imgObserver.observe(img);
  return img;
}

function classifyType(typeLine: string): string {
  const lower = typeLine.toLowerCase();
  if (lower.includes('creature')) return 'Creature';
  if (lower.includes('instant')) return 'Instant';
  if (lower.includes('sorcery')) return 'Sorcery';
  if (lower.includes('enchantment')) return 'Enchantment';
  if (lower.includes('artifact')) return 'Artifact';
  if (lower.includes('planeswalker')) return 'Planeswalker';
  if (lower.includes('land')) return 'Land';
  if (lower.includes('battle')) return 'Battle';
  return 'Other';
}

// Standard type sort order
const TYPE_ORDER: Record<string, number> = {
  Creature: 0, Planeswalker: 1, Instant: 2, Sorcery: 3,
  Enchantment: 4, Artifact: 5, Battle: 6, Land: 7, Other: 8,
};

// Color sort order for pile view
const COLOR_ORDER: Record<string, number> = {
  White: 0, Blue: 1, Black: 2, Red: 3, Green: 4, Multicolor: 5, Colorless: 6,
};

function classifyColor(colorIdentity: string[] | undefined): string {
  if (!colorIdentity || colorIdentity.length === 0) return 'Colorless';
  if (colorIdentity.length >= 2) return 'Multicolor';
  const map: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
  return map[colorIdentity[0].toUpperCase()] || 'Colorless';
}

// Rarity sort order for pile view
const RARITY_ORDER: Record<string, number> = {
  Mythic: 0, Rare: 1, Uncommon: 2, Common: 3, Unknown: 4,
};

function classifyRarity(rarity: string | undefined): string {
  if (!rarity) return 'Unknown';
  const r = rarity.toLowerCase();
  if (r === 'mythic') return 'Mythic';
  if (r === 'rare') return 'Rare';
  if (r === 'uncommon') return 'Uncommon';
  if (r === 'common') return 'Common';
  return 'Unknown';
}

// ==================== Chart Filter ====================

function applyChartFilter(
  entries: DeckbuilderCardEntry[],
  filter: ChartFilter,
  resolvedCardByName: Record<string, DeckbuilderCardView | undefined>,
): DeckbuilderCardEntry[] {
  if (!filter) return entries;
  return entries.filter((entry) => {
    const card = resolvedCardByName[normalizeNameKey(entry.name)];
    switch (filter.type) {
      case 'cmc': {
        const cmc = Math.trunc(card?.cmc || 0);
        return filter.value >= 7 ? cmc >= 7 : cmc === filter.value;
      }
      case 'color': {
        const identity = Array.isArray(card?.color_identity) ? card.color_identity.map((c: string) => c.toUpperCase()) : [];
        if (filter.value === 'C') return identity.length === 0;
        return identity.includes(filter.value);
      }
      case 'cardType': {
        const typeLine = (card?.type_line || '').toLowerCase();
        return typeLine.includes(filter.value.toLowerCase());
      }
      default:
        return true;
    }
  });
}

// ==================== Deck Filter ====================

function applyDeckFilter(
  entries: DeckbuilderCardEntry[],
  filter: string,
  resolvedCardByName: Record<string, DeckbuilderCardView | undefined>,
): DeckbuilderCardEntry[] {
  if (!filter) return entries;
  const lower = filter.toLowerCase();
  return entries.filter((entry) => {
    if (entry.name.toLowerCase().includes(lower)) return true;
    const card = resolvedCardByName[normalizeNameKey(entry.name)];
    if (card?.type_line?.toLowerCase().includes(lower)) return true;
    if (card?.oracle_text?.toLowerCase().includes(lower)) return true;
    if (entry.tags.some((t) => t.toLowerCase().includes(lower))) return true;
    return false;
  });
}

// ==================== List/Grid Sort ====================

function sortEntries(
  entries: DeckbuilderCardEntry[],
  mode: ListSortMode,
  resolvedCardByName: Record<string, DeckbuilderCardView | undefined>,
): DeckbuilderCardEntry[] {
  if (mode === 'name') return entries; // Already alphabetically sorted
  const sorted = [...entries];
  sorted.sort((a, b) => {
    const cardA = resolvedCardByName[normalizeNameKey(a.name)];
    const cardB = resolvedCardByName[normalizeNameKey(b.name)];
    switch (mode) {
      case 'cmc': return (cardA?.cmc ?? 0) - (cardB?.cmc ?? 0);
      case 'color': return (COLOR_ORDER[classifyColor(cardA?.color_identity)] ?? 99)
                         - (COLOR_ORDER[classifyColor(cardB?.color_identity)] ?? 99);
      case 'rarity': return (RARITY_ORDER[classifyRarity(cardA?.rarity)] ?? 99)
                          - (RARITY_ORDER[classifyRarity(cardB?.rarity)] ?? 99);
      case 'type': return (TYPE_ORDER[classifyType(cardA?.type_line || '')] ?? 99)
                        - (TYPE_ORDER[classifyType(cardB?.type_line || '')] ?? 99);
      case 'price': {
        const priceA = parseFloat(cardA?.prices?.eur || cardA?.prices?.usd || '0') || 0;
        const priceB = parseFloat(cardB?.prices?.eur || cardB?.prices?.usd || '0') || 0;
        return priceB - priceA; // Descending for price
      }
      default: return 0;
    }
  });
  return sorted;
}

export function renderFilterBadge(container: HTMLElement, filter: ChartFilter, onClear: () => void): void {
  const existing = container.querySelector('.chart-filter-badge');
  if (existing) existing.remove();
  if (!filter) return;

  const labels: Record<string, string> = {
    cmc: `CMC ${filter.type === 'cmc' && filter.value >= 7 ? '7+' : filter.type === 'cmc' ? String(filter.value) : ''}`,
    color: (() => {
      const names: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
      return filter.type === 'color' ? (names[filter.value] || filter.value) : '';
    })(),
    cardType: filter.type === 'cardType' ? filter.value.charAt(0).toUpperCase() + filter.value.slice(1) : '',
  };

  const badge = h('div', { className: 'chart-filter-badge', onClick: onClear },
    h('span', {}, `Filtered: ${labels[filter.type]}`),
    h('span', { className: 'chart-filter-x' }, '✕'),
  );
  container.insertBefore(badge, container.firstChild);
}

// ==================== Grid View ====================

function renderGridView(container: HTMLElement, ctx: ViewModeContext): void {
  const allEntries = ctx.deck.boards[ctx.activeBoard];
  const entries = getFilteredSortedEntries(allEntries, ctx.chartFilter, ctx.deckFilter, listSortMode, ctx.resolvedCardByName);

  if (allEntries.length === 0) {
    replaceChildren(container,
      h('div', { className: 'empty-state' },
        h('div', { className: 'empty-state-icon' }, '\uD83C\uDCCF'),
        h('p', { className: 'empty-state-text' }, `No cards in ${ctx.boardLabels[ctx.activeBoard]}. Search for cards or import a decklist to get started.`),
        h('div', { className: 'empty-state-actions' },
          h('button', { className: 'btn btn-sm', onClick: () => {
            const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
            if (searchInput) searchInput.focus();
          }}, 'Search Cards'),
          h('button', { className: 'btn btn-sm', onClick: () => {
            const importTab = document.querySelector('[data-tab="import"]') as HTMLElement | null;
            if (importTab) importTab.click();
          }}, 'Import Decklist'),
        ),
      ),
    );
    return;
  }

  const selected = ctx.getSelectedCards();

  const grid = h('div', { className: 'card-grid-img' },
    ...mapChildren(entries, (entry) => {
      const key = normalizeNameKey(entry.name);
      const card = ctx.resolvedCardByName[key];
      const imgSrc = getCardImage(card);
      const isSelected = selected.has(key);

      return h('div', {
        className: `gcard${isSelected ? ' selected' : ''}`,
        'data-card-name': entry.name,
        'data-board': ctx.activeBoard,
        draggable: true,
      },
        imgSrc
          ? cardImg(imgSrc, entry.name)
          : h('div', { className: 'gcard-placeholder' }, entry.name),
        entry.qty > 1 ? h('span', { className: 'gqty' }, `×${entry.qty}`) : null,
        teamOwnBadge(entry.name),
        
        // Hover Overlay
        h('div', { className: 'gcard-overlay' },
          h('div', { className: 'gcard-actions-row' },
            h('button', {
              className: 'btn-overlay',
              title: '+1 Copy',
              onClick: (e) => {
                e.preventDefault(); e.stopPropagation();
                ctx.onQtyChange(ctx.activeBoard, entry.name, 1);
              }
            }, '+'),
            h('button', {
              className: 'btn-overlay',
              title: '-1 Copy',
              onClick: (e) => {
                e.preventDefault(); e.stopPropagation();
                if (entry.qty <= 1) ctx.onRemove(ctx.activeBoard, entry.name);
                else ctx.onQtyChange(ctx.activeBoard, entry.name, -1);
              }
            }, '\u2212'), // minus sign
          ),
          h('button', {
            className: 'btn-overlay-text',
            title: ctx.activeBoard === 'sideboard' ? 'Move to Mainboard' : 'Move to Sideboard',
            onClick: (e) => {
              e.preventDefault(); e.stopPropagation();
              const targetBoard = ctx.activeBoard === 'sideboard' ? 'mainboard' : 'sideboard';
              ctx.onMove(ctx.activeBoard, targetBoard, entry.name);
            }
          }, ctx.activeBoard === 'sideboard' ? 'To Main' : 'To Side'),
        ),
      );
    })
  );

  replaceChildren(container, grid);
}

// ==================== List View ====================

// ── Virtual scroll state ──
const VS_THRESHOLD = 30; // Only use virtual scroll for 30+ cards
const VS_ROW_HEIGHT: Record<CardDensity, number> = { compact: 32, normal: 44, large: 56 };
const VS_BUFFER = 5; // Extra rows above/below viewport

function buildListRow(entry: DeckbuilderCardEntry, ctx: ViewModeContext, isSelected: boolean): HTMLElement {
  const key = normalizeNameKey(entry.name);
  const card = ctx.resolvedCardByName[key];
  const thumbSrc = getCardImage(card, 'small');

  return h('div', {
    className: `board-row${isSelected ? ' selected' : ''}`,
    'data-card-name': entry.name,
    'data-board': ctx.activeBoard,
    draggable: true,
  },
    thumbSrc ? cardImg(thumbSrc, entry.name, 'list-thumb') : null,
    h('div', { className: 'board-row-main' },
      h('strong', {}, entry.name),
      h('div', { className: 'muted' }, card?.type_line || 'Card data pending'),
    ),
    h('div', { className: 'board-row-controls' },
      h('button', { className: 'btn', onClick: () => {
        if (entry.qty <= 1) ctx.onRemove(ctx.activeBoard, entry.name);
        else ctx.onQtyChange(ctx.activeBoard, entry.name, -1);
      }}, '-'),
      h('span', { className: 'qty-pill' }, String(entry.qty)),
      teamOwnBadge(entry.name),
      h('button', { className: 'btn', onClick: () => {
        ctx.onQtyChange(ctx.activeBoard, entry.name, 1);
      }}, '+'),
      (() => {
        const select = document.createElement('select');
        select.className = 'inline-select';
        for (const board of ctx.boardOrder) {
          const opt = document.createElement('option');
          opt.value = board;
          opt.textContent = ctx.boardLabels[board];
          opt.selected = board === ctx.activeBoard;
          select.appendChild(opt);
        }
        select.addEventListener('change', () => {
          ctx.onMove(ctx.activeBoard, select.value as DeckBoard, entry.name);
        });
        return select;
      })(),
      (() => {
        const tagsInput = document.createElement('input');
        tagsInput.className = 'inline-tags';
        tagsInput.placeholder = 'tags: ramp, draw';
        tagsInput.value = entry.tags.join(', ');
        tagsInput.addEventListener('change', () => {
          ctx.onTagsChange(ctx.activeBoard, entry.name, tagsInput.value);
        });
        return tagsInput;
      })(),
      ...(ctx.getVoteWidget ? [ctx.getVoteWidget(ctx.activeBoard, entry.name)].filter(Boolean) as HTMLElement[] : []),
      h('button', { className: 'btn danger', onClick: () => {
        ctx.onRemove(ctx.activeBoard, entry.name);
      }}, 'Remove'),
    ),
  );
}

function renderListView(container: HTMLElement, ctx: ViewModeContext): void {
  const allEntries = ctx.deck.boards[ctx.activeBoard];
  const entries = getFilteredSortedEntries(allEntries, ctx.chartFilter, ctx.deckFilter, listSortMode, ctx.resolvedCardByName);

  if (allEntries.length === 0) {
    replaceChildren(container,
      h('div', { className: 'empty-state' },
        h('div', { className: 'empty-state-icon' }, '\uD83C\uDCCF'),
        h('p', { className: 'empty-state-text' }, `No cards in ${ctx.boardLabels[ctx.activeBoard]}. Search for cards or import a decklist to get started.`),
        h('div', { className: 'empty-state-actions' },
          h('button', { className: 'btn btn-sm', onClick: () => {
            const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
            if (searchInput) searchInput.focus();
          }}, 'Search Cards'),
          h('button', { className: 'btn btn-sm', onClick: () => {
            const importTab = document.querySelector('[data-tab="import"]') as HTMLElement | null;
            if (importTab) importTab.click();
          }}, 'Import Decklist'),
        ),
      ),
    );
    return;
  }

  const selected = ctx.getSelectedCards();

  // Small decks: render all directly (no virtual scroll overhead)
  if (entries.length < VS_THRESHOLD) {
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      frag.appendChild(buildListRow(entry, ctx, selected.has(normalizeNameKey(entry.name))));
    }
    container.textContent = '';
    container.appendChild(frag);
    return;
  }

  // ── Virtual Scroll for large decks ──
  const rowHeight = VS_ROW_HEIGHT[cardDensity];
  const totalHeight = entries.length * rowHeight;

  // Create or reuse scroll container
  let scrollContainer = container.querySelector('.vs-scroll-container') as HTMLDivElement | null;
  if (!scrollContainer) {
    container.textContent = '';
    scrollContainer = document.createElement('div');
    scrollContainer.className = 'vs-scroll-container';
    scrollContainer.style.overflowY = 'auto';
    scrollContainer.style.maxHeight = 'calc(100vh - 200px)';
    container.appendChild(scrollContainer);
  }

  const topSpacer = document.createElement('div');
  topSpacer.className = 'vs-spacer-top';
  const viewport = document.createElement('div');
  viewport.className = 'vs-viewport';
  const bottomSpacer = document.createElement('div');
  bottomSpacer.className = 'vs-spacer-bottom';

  function renderVisibleRows(): void {
    if (!scrollContainer) return;
    const scrollTop = scrollContainer.scrollTop;
    const viewportHeight = scrollContainer.clientHeight;
    const startIdx = Math.max(0, Math.floor(scrollTop / rowHeight) - VS_BUFFER);
    const endIdx = Math.min(entries.length, Math.ceil((scrollTop + viewportHeight) / rowHeight) + VS_BUFFER);

    topSpacer.style.height = `${startIdx * rowHeight}px`;
    bottomSpacer.style.height = `${Math.max(0, (entries.length - endIdx) * rowHeight)}px`;

    const frag = document.createDocumentFragment();
    for (let i = startIdx; i < endIdx; i++) {
      frag.appendChild(buildListRow(entries[i], ctx, selected.has(normalizeNameKey(entries[i].name))));
    }
    viewport.textContent = '';
    viewport.appendChild(frag);
  }

  scrollContainer.textContent = '';
  scrollContainer.append(topSpacer, viewport, bottomSpacer);
  renderVisibleRows();

  scrollContainer.addEventListener('scroll', renderVisibleRows, { passive: true });
}

// ==================== Pile View ====================

function renderPileView(container: HTMLElement, ctx: ViewModeContext): void {
  const allEntries = ctx.deck.boards[ctx.activeBoard];
  const entries = getFilteredSortedEntries(allEntries, ctx.chartFilter, ctx.deckFilter, 'name', ctx.resolvedCardByName);

  if (allEntries.length === 0) {
    replaceChildren(container,
      h('div', { className: 'empty-state' },
        h('div', { className: 'empty-state-icon' }, '\uD83C\uDCCF'),
        h('p', { className: 'empty-state-text' }, `No cards in ${ctx.boardLabels[ctx.activeBoard]}. Search for cards or import a decklist to get started.`),
        h('div', { className: 'empty-state-actions' },
          h('button', { className: 'btn btn-sm', onClick: () => {
            const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
            if (searchInput) searchInput.focus();
          }}, 'Search Cards'),
          h('button', { className: 'btn btn-sm', onClick: () => {
            const importTab = document.querySelector('[data-tab="import"]') as HTMLElement | null;
            if (importTab) importTab.click();
          }}, 'Import Decklist'),
        ),
      ),
    );
    return;
  }

  const selected = ctx.getSelectedCards();
  const piles: Record<string, DeckbuilderCardEntry[]> = {};

  for (const entry of entries) {
    const card = ctx.resolvedCardByName[normalizeNameKey(entry.name)];
    let pileKey: string;

    switch (pileSortMode) {
      case 'cmc':
        pileKey = String(Math.trunc(card?.cmc ?? 0));
        break;
      case 'color':
        pileKey = classifyColor(card?.color_identity);
        break;
      case 'rarity':
        pileKey = classifyRarity(card?.rarity);
        break;
      case 'tag': {
        // Custom category takes priority over auto-tag
        const customCats = ctx.deck.customCategories || [];
        const customCat = entry.customCategoryId
          ? customCats.find((c) => c.id === entry.customCategoryId)
          : undefined;
        pileKey = customCat ? customCat.name : getAutoTagForEntry(entry, ctx.resolvedCardByName);
        break;
      }
      default:
        pileKey = classifyType(card?.type_line || '');
    }

    (piles[pileKey] ??= []).push(entry);
  }

  // Sort pile keys
  const sortedKeys = Object.keys(piles).sort((a, b) => {
    switch (pileSortMode) {
      case 'cmc': return Number(a) - Number(b);
      case 'color': return (COLOR_ORDER[a] ?? 99) - (COLOR_ORDER[b] ?? 99);
      case 'rarity': return (RARITY_ORDER[a] ?? 99) - (RARITY_ORDER[b] ?? 99);
      case 'tag': {
        // Custom categories sort before auto-categories (priority -1)
        const customCats = ctx.deck.customCategories || [];
        const customNames = new Set(customCats.map((c) => c.name));
        const aIsCustom = customNames.has(a) ? -1 : (CATEGORY_PRIORITY[a as CardCategory] ?? 99);
        const bIsCustom = customNames.has(b) ? -1 : (CATEGORY_PRIORITY[b as CardCategory] ?? 99);
        return aIsCustom !== bIsCustom ? aIsCustom - bIsCustom : a.localeCompare(b);
      }
      default: return (TYPE_ORDER[a] ?? 99) - (TYPE_ORDER[b] ?? 99);
    }
  });

  const isCompact = cardDensity === 'compact' || (pileSortMode === 'tag' && sortedKeys.length > 8);
  // margin-top % is relative to parent WIDTH, not card height.
  // MTG cards are ~1.4× taller than wide, so -100% ≈ hiding 71% of card height.
  // To show only the name strip (~top 12%): need to hide ~88% of height = ~123% of width.
  const PILE_OVERLAP: Record<CardDensity, string> = { compact: '-125%', normal: '-90%', large: '-75%' };
  const PILE_OVERLAP_COMPACT: Record<CardDensity, string> = { compact: '-125%', normal: '-105%', large: '-90%' };
  const overlap = isCompact ? PILE_OVERLAP_COMPACT[cardDensity] : PILE_OVERLAP[cardDensity];

  const pilesContainer = h('div', { className: `pile-view${isCompact ? ' pile-view--compact' : ''}` },
    ...sortedKeys.map((label) => {
      const pile = piles[label];
      const totalQty = pile.reduce((s, e) => s + e.qty, 0);

      const customCatColor = (ctx.deck.customCategories || []).find((c) => c.name === label)?.color;
      const catColor = pileSortMode === 'tag' ? (customCatColor || CATEGORY_COLORS[label as CardCategory] || '') : '';

      return h('div', { className: 'pile-column' },
        h('div', {
          className: 'pile-header',
          style: catColor ? `border-left: 3px solid ${catColor}; padding-left: 8px;` : '',
        },
          pileSortMode === 'cmc' ? `CMC ${label} (${totalQty})` : pileSortMode === 'tag' ? `${label} (${totalQty})` : `${label} (${totalQty})`
        ),
        h('div', { className: 'pile-stack' },
          ...pile.map((entry, i) => {
            const key = normalizeNameKey(entry.name);
            const card = ctx.resolvedCardByName[key];
            const imgSrc = getCardImage(card);
            const isSelected = selected.has(key);

            return h('div', {
              className: `pile-card${isSelected ? ' selected' : ''}`,
              style: i === 0 ? '' : `margin-top: ${overlap}`,
              'data-card-name': entry.name,
              'data-board': ctx.activeBoard,
              draggable: true,
            },
              imgSrc
                ? cardImg(imgSrc, entry.name)
                : h('div', { className: 'gcard-placeholder' }, entry.name),
              entry.qty > 1 ? h('span', { className: 'gqty' }, `×${entry.qty}`) : null,
              teamOwnBadge(entry.name),
            );
          })
        ),
      );
    })
  );

  replaceChildren(container, pilesContainer);
}

// ==================== Main Dispatcher ====================

export function renderActiveView(container: HTMLElement, ctx: ViewModeContext): void {
  switch (currentViewMode) {
    case 'grid':
      renderGridView(container, ctx);
      break;
    case 'list':
      renderListView(container, ctx);
      break;
    case 'pile':
      renderPileView(container, ctx);
      break;
    default:
      renderGridView(container, ctx);
  }
}
