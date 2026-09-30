import { describe, expect, test, beforeEach } from 'vitest';
import { seedLayout, snapToGrid, layoutFor } from '../../src/playmat/layout.js';
import type { Pile } from '../../src/playmat/sort.js';
import type { DeckbuilderDeck, MatLayout } from '../../src/deckbuilder/types.js';
import { upsertDeck, getDeckById, createEmptyDeck } from '../../src/deckbuilder/storage.js';

function pile(id: string): Pile {
  return { id, label: id, entries: [], count: 0 };
}

describe('playmat layout', () => {
  beforeEach(() => localStorage.clear());

  test('snap rounds to nearest 72px cell', () => {
    expect(snapToGrid(100, 130)).toEqual({ col: 1, row: 2 });
    expect(snapToGrid(35, 36)).toEqual({ col: 0, row: 1 });
  });

  test('seed reserves commander cols 0-1 and lays piles left to right', () => {
    const layout = seedLayout([pile('a'), pile('b')]);
    expect(layout.piles[0]).toMatchObject({ id: 'a', col: 2 });
    expect(layout.piles[1].col).toBeGreaterThan(layout.piles[0].col);
    for (const p of layout.piles) expect(p.col).toBeGreaterThanOrEqual(2);
  });

  test('reconcile keeps existing positions, appends new, drops vanished', () => {
    const deck = createEmptyDeck('L');
    deck.matLayout = { piles: [{ id: 'a', col: 5, row: 3 }, { id: 'gone', col: 9, row: 9 }] } as MatLayout;
    const layout = layoutFor(deck, [pile('a'), pile('b')]);
    expect(layout.piles.find((p) => p.id === 'a')).toMatchObject({ col: 5, row: 3 });
    expect(layout.piles.find((p) => p.id === 'b')).toBeTruthy();
    expect(layout.piles.find((p) => p.id === 'gone')).toBeUndefined();
  });

  test('storage roundtrip preserves matLayout', () => {
    const deck = createEmptyDeck('R');
    deck.matLayout = { piles: [{ id: 'x', col: 4, row: 1 }] };
    upsertDeck(deck);
    const loaded = getDeckById(deck.id);
    expect(loaded?.matLayout).toEqual({ piles: [{ id: 'x', col: 4, row: 1 }] });
  });

  test('old deck without matLayout loads fine', () => {
    const deck = createEmptyDeck('Old');
    delete (deck as Partial<DeckbuilderDeck>).matLayout;
    upsertDeck(deck);
    const loaded = getDeckById(deck.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.matLayout).toBeUndefined();
  });
});
