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

  test('seed lays all piles top-aligned in one row, no wrapping', () => {
    const many = Array.from({ length: 9 }, (_, i) => pile(`p${i}`));
    const layout = seedLayout(many);
    expect(layout.piles[0]).toMatchObject({ id: 'p0', col: 2, row: 0 });
    for (const p of layout.piles) {
      expect(p.row).toBe(0);
      expect(p.col).toBeGreaterThanOrEqual(2);
    }
    const cols = layout.piles.map((p) => p.col);
    expect(new Set(cols).size).toBe(cols.length); // no column collisions
  });

  test('reconcile keeps existing positions, fills new piles into free columns from the left', () => {
    const deck = createEmptyDeck('L');
    deck.matLayout = { piles: [{ id: 'a', col: 5, row: 3 }, { id: 'gone', col: 9, row: 9 }] } as MatLayout;
    const layout = layoutFor(deck, [pile('a'), pile('b')]);
    expect(layout.piles.find((p) => p.id === 'a')).toMatchObject({ col: 5, row: 3 });
    // 'b' takes the leftmost free slot (col 2 is clear of 'a' at col 5)
    expect(layout.piles.find((p) => p.id === 'b')).toMatchObject({ row: 0, col: 2 });
    expect(layout.piles.find((p) => p.id === 'gone')).toBeUndefined();
  });

  test('a far-right shared pile does not push new piles to the right', () => {
    const deck = createEmptyDeck('S');
    deck.matLayout = { piles: [{ id: 'pile-lands', col: 20, row: 0 }] } as MatLayout;
    const layout = layoutFor(deck, [pile('pile-lands'), pile('pile-1'), pile('pile-2')]);
    expect(layout.piles.find((p) => p.id === 'pile-1')).toMatchObject({ row: 0, col: 2 });
    expect(layout.piles.find((p) => p.id === 'pile-2')).toMatchObject({ row: 0, col: 4 });
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
