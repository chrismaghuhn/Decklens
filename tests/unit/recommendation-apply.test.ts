import { describe, expect, it } from 'vitest';
import type { Deck } from '../../src/shared/types.js';
import {
  applyRecommendationAtomically,
  cloneDeckState,
  undoRecommendationApply,
} from '../../src/mtg/recommendation-apply.js';

function createDeck(): Deck {
  return {
    main: [
      { name: 'Llanowar Elves', qty: 2 },
      { name: 'Cultivate', qty: 1 },
      { name: 'Naturalize', qty: 1 },
    ],
    sideboard: [{ name: 'Heroic Intervention', qty: 1 }],
    commander: [{ name: 'Selvala, Heart of the Wilds', qty: 1 }],
  };
}

function getMainQty(deck: Deck, cardName: string): number {
  return deck.main
    .filter((entry) => entry.name.toLowerCase() === cardName.toLowerCase())
    .reduce((sum, entry) => sum + entry.qty, 0);
}

describe('recommendation apply transactions', () => {
  it('applies add recommendations atomically and keeps source deck immutable', () => {
    const sourceDeck = createDeck();
    const snapshot = cloneDeckState(sourceDeck);

    const result = applyRecommendationAtomically({
      deck: sourceDeck,
      recommendationId: 'rec-sol-ring',
      recommendationCardName: 'Sol Ring',
      suggestedCutName: null,
      mode: 'add',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(getMainQty(result.deck, 'Sol Ring')).toBe(1);
    expect(result.mainCountAfter).toBe(result.mainCountBefore + 1);
    expect(sourceDeck).toEqual(snapshot);
  });

  it('aborts swap with no deck mutation when cut target is missing', () => {
    const sourceDeck = createDeck();
    const snapshot = cloneDeckState(sourceDeck);

    const result = applyRecommendationAtomically({
      deck: sourceDeck,
      recommendationId: 'rec-ramp',
      recommendationCardName: 'Nature\'s Lore',
      suggestedCutName: 'Nonexistent Card',
      mode: 'swap',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('suggested_cut_not_found');
    expect(sourceDeck).toEqual(snapshot);
    expect(getMainQty(sourceDeck, 'Nature\'s Lore')).toBe(0);
  });

  it('aborts swap when no cut suggestion is provided', () => {
    const sourceDeck = createDeck();

    const result = applyRecommendationAtomically({
      deck: sourceDeck,
      recommendationId: 'rec-ramp',
      recommendationCardName: 'Nature\'s Lore',
      suggestedCutName: null,
      mode: 'swap',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.code).toBe('missing_cut_suggestion');
  });

  it('undoes the latest apply and restores the exact previous deck state', () => {
    const sourceDeck = createDeck();
    const snapshot = cloneDeckState(sourceDeck);

    const applyResult = applyRecommendationAtomically({
      deck: sourceDeck,
      recommendationId: 'rec-ramp',
      recommendationCardName: 'Nature\'s Lore',
      suggestedCutName: 'Naturalize',
      mode: 'swap',
    });

    expect(applyResult.ok).toBe(true);
    if (!applyResult.ok) return;

    const undoResult = undoRecommendationApply(applyResult.deck, applyResult.action);
    expect(undoResult.ok).toBe(true);
    if (!undoResult.ok) return;

    expect(undoResult.deck).toEqual(snapshot);
  });

  it('rejects undo when current deck drifted after apply', () => {
    const sourceDeck = createDeck();

    const applyResult = applyRecommendationAtomically({
      deck: sourceDeck,
      recommendationId: 'rec-sol-ring',
      recommendationCardName: 'Sol Ring',
      suggestedCutName: null,
      mode: 'add',
    });

    expect(applyResult.ok).toBe(true);
    if (!applyResult.ok) return;

    const driftedDeck = cloneDeckState(applyResult.deck);
    driftedDeck.main.push({ name: 'Arcane Signet', qty: 1 });

    const undoResult = undoRecommendationApply(driftedDeck, applyResult.action);
    expect(undoResult.ok).toBe(false);
    if (undoResult.ok) return;

    expect(undoResult.code).toBe('deck_state_mismatch');
  });
});
