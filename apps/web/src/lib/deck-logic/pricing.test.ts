import { computeDeckPriceSummary } from './pricing';
import { describe, it, expect } from 'vitest';
import type { DeckbuilderDeck } from './types';

const mockDeck: DeckbuilderDeck = {
  id: '1',
  name: 'Budget Test',
  visibility: 'private',
  createdAt: '',
  updatedAt: '',
  boards: {
    commander: [{ name: 'Atraxa', qty: 1, tags: [] }],
    mainboard: [
      { name: 'Sol Ring', qty: 1, tags: [] },
      { name: 'Forest', qty: 20, tags: [] },
    ],
    sideboard: [],
    maybeboard: []
  }
};

const mockResolver = {
  'atraxa': { prices: { eur: '15.50', usd: '18.00' } },
  'sol ring': { prices: { eur: '1.20', usd: '1.50' } },
  'forest': { prices: { eur: '0.05', usd: '0.05' } },
};

describe('Deck Pricing Logic', () => {
  it('should calculate totals correctly', () => {
    const summary = computeDeckPriceSummary(mockDeck, mockResolver);
    
    // Atraxa (15.50) + Sol Ring (1.20) + 20 * Forest (0.05 = 1.00) = 17.70
    expect(summary.eurTotal).toBeCloseTo(17.70);
    expect(summary.usdTotal).toBeCloseTo(20.50);
    expect(summary.lineItems).toHaveLength(3);
  });
});
