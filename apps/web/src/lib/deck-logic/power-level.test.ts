import { estimatePowerLevel, type CardResolverMap } from './power-level';
import { describe, it, expect } from 'vitest';
import type { DeckbuilderDeck } from './types';

// Mock Data
const mockDeck: DeckbuilderDeck = {
  id: '1',
  name: 'Test Deck',
  visibility: 'private',
  createdAt: '',
  updatedAt: '',
  boards: {
    commander: [{ name: 'Atraxa, Praetors\' Voice', qty: 1, tags: [] }],
    mainboard: [
      { name: 'Sol Ring', qty: 1, tags: [] },
      { name: 'Mana Crypt', qty: 1, tags: [] },
      { name: 'Demonic Tutor', qty: 1, tags: [] },
      { name: 'Vampiric Tutor', qty: 1, tags: [] },
      { name: 'Imperial Seal', qty: 1, tags: [] }, // Added 3rd tutor
      { name: 'Force of Will', qty: 1, tags: [] },
      { name: 'Forest', qty: 10, tags: [] },
    ],
    sideboard: [],
    maybeboard: []
  }
};

const mockResolver: CardResolverMap = {
  'atraxa, praetors\' voice': { name: 'Atraxa', cmc: 4, type_line: 'Legendary Creature', oracle_text: 'Flying, vigilance, deathtouch, lifelink' },
  'sol ring': { name: 'Sol Ring', cmc: 1, type_line: 'Artifact', oracle_text: 'Add {C}{C}.' },
  'mana crypt': { name: 'Mana Crypt', cmc: 0, type_line: 'Artifact', oracle_text: 'Add {C}{C}. At the beginning of your upkeep, flip a coin...' },
  'demonic tutor': { name: 'Demonic Tutor', cmc: 2, type_line: 'Sorcery', oracle_text: 'Search your library for a card...' },
  'vampiric tutor': { name: 'Vampiric Tutor', cmc: 1, type_line: 'Instant', oracle_text: 'Search your library for a card...' },
  'imperial seal': { name: 'Imperial Seal', cmc: 1, type_line: 'Sorcery', oracle_text: 'Search your library for a card, then shuffle your library and put that card on top of it. You lose 2 life.' },
  'force of will': { name: 'Force of Will', cmc: 5, type_line: 'Instant', oracle_text: 'Counter target spell.' },
  'forest': { name: 'Forest', cmc: 0, type_line: 'Basic Land — Forest', oracle_text: '{T}: Add {G}.' },
};

describe('Power Level Calculator', () => {
  it('should calculate power level for a high-power deck stub', () => {
    const result = estimatePowerLevel(mockDeck, mockResolver);
    
    console.log('Power Level Result:', result);

    // Checks
    expect(result.power).toBeGreaterThan(5); 
    expect(result.tutorCount).toBe(3); // Demonic + Vampiric + Imperial Seal
    expect(result.factors.some(f => f.label === 'Tutors')).toBe(true);
  });

  it('should handle empty deck gracefully', () => {
    const emptyDeck = { ...mockDeck, boards: { ...mockDeck.boards, mainboard: [] } };
    const result = estimatePowerLevel(emptyDeck, mockResolver);
    expect(result.power).toBe(4); // Base 4, avg CMC defaults to 3 (neutral)
  });
});
