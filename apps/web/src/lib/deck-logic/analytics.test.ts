import { computeAnalyticsData } from './analytics';
import { describe, it, expect } from 'vitest';
import type { DeckbuilderDeck } from './types';
import type { AnalyzerCardView } from './types';

const mockDeck: DeckbuilderDeck = {
  id: '1',
  name: 'Test',
  visibility: 'private',
  createdAt: '',
  updatedAt: '',
  boards: {
    commander: [],
    mainboard: [
      { name: 'Sol Ring', qty: 1, tags: [] },
      { name: 'Forest', qty: 5, tags: [] },
      { name: 'Giant Growth', qty: 4, tags: [] }, // CMC 1
      { name: 'Grizzly Bears', qty: 4, tags: [] }, // CMC 2
    ],
    sideboard: [],
    maybeboard: []
  }
};

const mockResolver: Record<string, AnalyzerCardView> = {
  'sol ring': { name: 'Sol Ring', cmc: 1, type_line: 'Artifact', oracle_text: 'Add {C}{C}.', color_identity: [] },
  'forest': { name: 'Forest', cmc: 0, type_line: 'Basic Land — Forest', oracle_text: '{T}: Add {G}.', color_identity: ['G'] },
  'giant growth': { name: 'Giant Growth', cmc: 1, type_line: 'Instant', oracle_text: 'Target creature gets +3/+3.', color_identity: ['G'] },
  'grizzly bears': { name: 'Grizzly Bears', cmc: 2, type_line: 'Creature — Bear', oracle_text: '', color_identity: ['G'] },
};

describe('Deck Analytics', () => {
  it('should compute mana curve correctly', () => {
    const result = computeAnalyticsData(mockDeck, mockResolver);
    
    // Sol Ring (1) + Giant Growth (4x 1) = 5 at CMC 1
    expect(result.curve['1']).toBe(5);
    // Grizzly Bears (4x 2) = 4 at CMC 2
    expect(result.curve['2']).toBe(4);
    // Lands excluded from curve
    expect(result.curve['0']).toBeUndefined();
  });

  it('should compute colors correctly', () => {
    const result = computeAnalyticsData(mockDeck, mockResolver);
    // Forest (5) + Giant Growth (4) + Grizzly Bears (4) = 13 Green
    expect(result.colors.G).toBe(13);
    // Sol Ring (1) = 1 Colorless
    expect(result.colors.C).toBe(1);
  });

  it('should auto-tag cards', () => {
    const result = computeAnalyticsData(mockDeck, mockResolver);
    // Sol Ring -> Mana Rock (or Ramp)
    expect(result.tags['Mana Rock']).toBeGreaterThan(0);
    // Forest -> Land
    expect(result.tags['Land']).toBe(5);
  });
});
