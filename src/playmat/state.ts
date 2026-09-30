// ==================== Playmat State ====================
// One state object per editor session; mutations go through mutateDeck
// so undo + persistence + re-render stay in lockstep.

import type { DeckbuilderDeck } from '../deckbuilder/types.js';
import type { DeckbuilderSearchCard } from '../shared/scryfall-client.js';
import { resolveDeckbuilderCards } from '../shared/scryfall-client.js';
import { getDeckById, upsertDeck, setLastOpenedDeckId } from '../deckbuilder/storage.js';
import { pushSnapshot } from '../deckbuilder/undo-stack.js';
import type { SortMode } from './sort.js';

export interface PlaymatState {
  deck: DeckbuilderDeck;
  cardByName: Record<string, DeckbuilderSearchCard | undefined>;
  sortMode: SortMode;
}

export const EV_DECK_CHANGED = 'pm-deck-changed';
export const EV_CARDS_RESOLVED = 'pm-cards-resolved';
export const EV_SORT_CHANGED = 'pm-sort-changed';
export const EV_OPEN_COMMANDER_SEARCH = 'pm-open-commander-search';

export function normalizeNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function initState(deckId: string): PlaymatState | null {
  const deck = getDeckById(deckId);
  if (!deck) return null;
  setLastOpenedDeckId(deck.id);
  const stored = localStorage.getItem(`dl_pm_sort_${deck.id}`);
  const sortMode: SortMode = (['type', 'mana', 'color', 'role', 'tags', 'free'] as SortMode[])
    .includes(stored as SortMode) ? (stored as SortMode) : 'type';
  return { deck, cardByName: {}, sortMode };
}

export function setSortMode(state: PlaymatState, mode: SortMode): void {
  state.sortMode = mode;
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
  const names = [
    ...state.deck.boards.commander,
    ...state.deck.boards.mainboard,
    ...state.deck.boards.sideboard,
    ...state.deck.boards.maybeboard,
  ]
    .map((e) => e.name)
    .filter((n) => !state.cardByName[normalizeNameKey(n)]);
  if (names.length === 0) return;

  resolveInFlight = true;
  try {
    const { resolved } = await resolveDeckbuilderCards([...new Set(names)]);
    for (const [key, card] of Object.entries(resolved)) {
      state.cardByName[normalizeNameKey(key)] = card;
    }
    document.dispatchEvent(new CustomEvent(EV_CARDS_RESOLVED));
  } finally {
    resolveInFlight = false;
  }
}

export function cardFor(state: PlaymatState, name: string): DeckbuilderSearchCard | undefined {
  return state.cardByName[normalizeNameKey(name)];
}
