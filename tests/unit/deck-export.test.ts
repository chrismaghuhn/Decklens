import { describe, expect, it } from 'vitest';
import { normalizeDeckForExport, serializeDeckForExport } from '../../src/shared/deck-export.js';
import type { Deck } from '../../src/shared/types.js';

function makeDeck(): Deck {
  return {
    main: [
      { name: '  Lightning   Bolt  ', qty: 2 },
      { name: 'Arcane Signet', qty: 1 },
      { name: 'Lightning Bolt', qty: 1 },
      { name: 'Ponder', qty: 0 },
    ],
    sideboard: [
      { name: 'Disenchant', qty: 1 },
      { name: 'Disenchant', qty: 2 },
    ],
    commander: [
      { name: 'Breya, Etherium Shaper', qty: 1 },
    ],
  };
}

describe('deck export serializer', () => {
  it('normalizes quantities, merges duplicates, and sorts deterministically', () => {
    const normalized = normalizeDeckForExport(makeDeck());

    expect(normalized.main).toHaveLength(2);
    expect(normalized.main[0]).toEqual({ name: 'Arcane Signet', qty: 1, set: null, num: null });

    const bolt = normalized.main.find((entry) => entry.name.toLowerCase() === 'lightning bolt');
    expect(bolt?.qty).toBe(3);

    expect(normalized.sideboard).toEqual([
      { name: 'Disenchant', qty: 3, set: null, num: null },
    ]);
  });

  it('serializes text format with main/sideboard/commander sections', () => {
    const text = serializeDeckForExport(makeDeck(), { format: 'text', deckName: 'Test Deck' });

    expect(text).toContain('1 Arcane Signet');
    expect(text).toContain('3 Lightning Bolt');
    expect(text).toContain('Sideboard:');
    expect(text).toContain('3 Disenchant');
    expect(text).toContain('Commander:');
    expect(text).toContain('1 Breya, Etherium Shaper');
  });

  it('is deterministic regardless of input ordering', () => {
    const deckA: Deck = {
      main: [
        { name: 'Arcane Signet', qty: 1 },
        { name: 'Lightning Bolt', qty: 2 },
      ],
      sideboard: [{ name: 'Negate', qty: 2 }],
      commander: [{ name: 'Kess, Dissident Mage', qty: 1 }],
    };

    const deckB: Deck = {
      main: [
        { name: 'Lightning Bolt', qty: 1 },
        { name: 'Arcane Signet', qty: 1 },
        { name: 'Lightning Bolt', qty: 1 },
      ],
      sideboard: [{ name: 'Negate', qty: 1 }, { name: 'Negate', qty: 1 }],
      commander: [{ name: 'Kess, Dissident Mage', qty: 1 }],
    };

    const a = serializeDeckForExport(deckA, { format: 'mtgo', deckName: 'Deck A' });
    const b = serializeDeckForExport(deckB, { format: 'mtgo', deckName: 'Deck B' });
    expect(a).toBe(b);
  });

  it('matches current state after apply/undo style mutations', () => {
    const deck: Deck = {
      main: [
        { name: 'Cancel', qty: 2 },
        { name: 'Divination', qty: 1 },
      ],
      sideboard: [{ name: 'Negate', qty: 1 }],
      commander: [],
    };

    const baseline = serializeDeckForExport(deck, { format: 'text', deckName: 'Mutating Deck' });

    // Apply recommendation-like mutation: +Arcane Signet, -Cancel
    deck.main.push({ name: 'Arcane Signet', qty: 1 });
    const cancel = deck.main.find((entry) => entry.name === 'Cancel');
    if (cancel) cancel.qty -= 1;

    const afterApply = serializeDeckForExport(deck, { format: 'text', deckName: 'Mutating Deck' });
    expect(afterApply).toContain('1 Arcane Signet');
    expect(afterApply).toContain('1 Cancel');

    // Undo mutation: -Arcane Signet, +Cancel
    deck.main = deck.main.filter((entry) => entry.name !== 'Arcane Signet');
    const cancelUndo = deck.main.find((entry) => entry.name === 'Cancel');
    if (cancelUndo) cancelUndo.qty += 1;

    const afterUndo = serializeDeckForExport(deck, { format: 'text', deckName: 'Mutating Deck' });
    expect(afterUndo).toBe(baseline);
  });
});
