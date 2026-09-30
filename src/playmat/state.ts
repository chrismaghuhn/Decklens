// ==================== Playmat State ====================
// One state object per editor session; mutations go through mutateDeck
// so undo + persistence + re-render stay in lockstep.

import type { DeckbuilderDeck } from '../deckbuilder/types.js';
import type { DeckbuilderSearchCard } from '../shared/scryfall-client.js';
import { resolveDeckbuilderCards, resolveDeckbuilderPrintings } from '../shared/scryfall-client.js';
import { getDeckById, upsertDeck, setLastOpenedDeckId } from '../deckbuilder/storage.js';
import { pushSnapshot } from '../deckbuilder/undo-stack.js';
import type { SortMode } from './sort.js';

export interface PlaymatState {
  deck: DeckbuilderDeck;
  cardByName: Record<string, DeckbuilderSearchCard | undefined>;
  sortMode: SortMode;
  /** Grouping the free mode inherits: the last non-free sort mode. */
  freeBase: Exclude<SortMode, 'free'>;
}

export const EV_DECK_CHANGED = 'pm-deck-changed';
export const EV_CARDS_RESOLVED = 'pm-cards-resolved';
export const EV_SORT_CHANGED = 'pm-sort-changed';
export const EV_OPEN_COMMANDER_SEARCH = 'pm-open-commander-search';

export function normalizeNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** True when keyboard input belongs to a field, not to global shortcuts. */
export function isTypingContext(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT'
    || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT'
    || el.isContentEditable === true;
}

export function initState(deckId: string): PlaymatState | null {
  const deck = getDeckById(deckId);
  if (!deck) return null;
  setLastOpenedDeckId(deck.id);
  const stored = localStorage.getItem(`dl_pm_sort_${deck.id}`);
  const sortMode: SortMode = (['type', 'mana', 'color', 'role', 'tags', 'free'] as SortMode[])
    .includes(stored as SortMode) ? (stored as SortMode) : 'type';
  const storedBase = localStorage.getItem(`dl_pm_freebase_${deck.id}`);
  const freeBase = (['type', 'mana', 'color', 'role', 'tags'] as Array<Exclude<SortMode, 'free'>>)
    .includes(storedBase as Exclude<SortMode, 'free'>)
    ? (storedBase as Exclude<SortMode, 'free'>)
    : (sortMode !== 'free' ? sortMode : 'type');
  return { deck, cardByName: {}, sortMode, freeBase };
}

export function setSortMode(state: PlaymatState, mode: SortMode): void {
  state.sortMode = mode;
  if (mode !== 'free') {
    state.freeBase = mode;
    try { localStorage.setItem(`dl_pm_freebase_${state.deck.id}`, mode); } catch { /* quota */ }
  }
  try { localStorage.setItem(`dl_pm_sort_${state.deck.id}`, mode); } catch { /* quota */ }
  document.dispatchEvent(new CustomEvent(EV_SORT_CHANGED));
}

export function mutateDeck(state: PlaymatState, fn: (deck: DeckbuilderDeck) => void): void {
  pushSnapshot(state.deck);
  fn(state.deck);
  state.deck = upsertDeck(state.deck);
  document.dispatchEvent(new CustomEvent(EV_DECK_CHANGED));
}

/** Persist without an undo snapshot (e.g. after undo/redo restored the deck). */
export function persistDeck(state: PlaymatState): void {
  state.deck = upsertDeck(state.deck);
  document.dispatchEvent(new CustomEvent(EV_DECK_CHANGED));
}

let resolveInFlight = false;

export async function resolveMissing(state: PlaymatState): Promise<void> {
  if (resolveInFlight) return;
  const entries = [
    ...state.deck.boards.commander,
    ...state.deck.boards.mainboard,
    ...state.deck.boards.sideboard,
    ...state.deck.boards.maybeboard,
  ];
  const names = entries
    .map((e) => e.name)
    .filter((n) => !state.cardByName[normalizeNameKey(n)]);

  resolveInFlight = true;
  try {
    let changed = false;
    if (names.length > 0) {
      const { resolved } = await resolveDeckbuilderCards([...new Set(names)]);
      for (const [key, card] of Object.entries(resolved)) {
        state.cardByName[normalizeNameKey(key)] = card;
        changed = true;
      }
    }

    // Entries with an explicitly chosen printing: swap the cached card
    // for that exact set/number so the picked artwork survives reloads.
    const printRefs = entries.filter((e) => {
      if (!e.set || !e.collectorNumber) return false;
      const cached = state.cardByName[normalizeNameKey(e.name)];
      return !cached || cached.set !== e.set || cached.collector_number !== e.collectorNumber;
    });
    if (printRefs.length > 0) {
      const prints = await resolveDeckbuilderPrintings(
        printRefs.map((e) => ({ set: e.set!, collectorNumber: e.collectorNumber! })),
      );
      for (const card of prints) {
        state.cardByName[normalizeNameKey(card.name)] = card;
        const frontKey = normalizeNameKey(card.name.split('//')[0]);
        if (frontKey) state.cardByName[frontKey] = card;
        changed = true;
      }
    }

    if (changed) document.dispatchEvent(new CustomEvent(EV_CARDS_RESOLVED));
  } finally {
    resolveInFlight = false;
  }
}

export function cardFor(state: PlaymatState, name: string): DeckbuilderSearchCard | undefined {
  return state.cardByName[normalizeNameKey(name)];
}
