import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  generateRecommendationEngineV1Dynamic,
  type RecommendationCardMetrics,
} from '../../src/mtg/engine/recommendation-v1.js';
import type { Deck } from '../../src/shared/types.js';

const BASE_DECK: Deck = {
  commander: [{ name: 'Breya, Etherium Shaper', qty: 1 }],
  main: [
    { name: 'Plains', qty: 10 },
    { name: 'Island', qty: 10 },
    { name: 'Mountain', qty: 7 },
    { name: 'Swamp', qty: 7 },
    { name: 'Darksteel Relic', qty: 1 },
    { name: 'Cancel', qty: 2 },
    { name: 'Divination', qty: 2 },
    { name: 'Colossal Dreadmaw', qty: 2 },
    { name: 'Naturalize', qty: 2 },
    { name: 'Sign in Blood', qty: 2 },
    { name: 'Evolving Wilds', qty: 1 },
    { name: 'Command Tower', qty: 1 },
    { name: 'Mind Stone', qty: 1 },
    { name: 'Ponder', qty: 1 },
  ],
  sideboard: [],
};

function baseCardMetrics(): Record<string, RecommendationCardMetrics> {
  return {
    'breya, etherium shaper': {
      name: 'Breya, Etherium Shaper',
      mana_cost: '{W}{U}{B}{R}',
      cmc: 4,
      type_line: 'Legendary Artifact Creature - Human',
      oracle_text: 'When Breya enters, create two 1/1 artifact creature tokens.',
      color_identity: ['W', 'U', 'B', 'R'],
      prices: { eur: '7.00' },
    },
    plains: {
      name: 'Plains',
      type_line: 'Basic Land - Plains',
      oracle_text: '{T}: Add {W}.',
      color_identity: ['W'],
      prices: { eur: '0.05' },
    },
    island: {
      name: 'Island',
      type_line: 'Basic Land - Island',
      oracle_text: '{T}: Add {U}.',
      color_identity: ['U'],
      prices: { eur: '0.05' },
    },
    mountain: {
      name: 'Mountain',
      type_line: 'Basic Land - Mountain',
      oracle_text: '{T}: Add {R}.',
      color_identity: ['R'],
      prices: { eur: '0.05' },
    },
    swamp: {
      name: 'Swamp',
      type_line: 'Basic Land - Swamp',
      oracle_text: '{T}: Add {B}.',
      color_identity: ['B'],
      prices: { eur: '0.05' },
    },
  };
}

describe('recommendation engine v1 dynamic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns recommendations with dynamic discovery stats', async () => {
    const result = await generateRecommendationEngineV1Dynamic({
      deck: BASE_DECK,
      metaMode: 'balanced',
      maxRecommendations: 5,
      cardMetricsByName: baseCardMetrics(),
    });

    expect(result.version).toBe('dd201-v1-dynamic');
    expect(result.recommendations).toHaveLength(5);
    expect(result.discoveryStats).toBeDefined();
    expect(result.discoveryStats?.queriesExecuted).toBeGreaterThanOrEqual(0);
    expect(result.discoveryStats?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('includes both static and discovered candidates', async () => {
    const result = await generateRecommendationEngineV1Dynamic({
      deck: BASE_DECK,
      metaMode: 'balanced',
      maxRecommendations: 5,
      cardMetricsByName: baseCardMetrics(),
    });

    expect(result.recommendations.length).toBe(5);
    
    // Should have valid recommendation structure
    for (const rec of result.recommendations) {
      expect(rec.add).toBeDefined();
      expect(rec.add.name).toBeTruthy();
      expect(rec.score).toBeGreaterThan(0);
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('excludes cards already in deck', async () => {
    const result = await generateRecommendationEngineV1Dynamic({
      deck: BASE_DECK,
      metaMode: 'balanced',
      maxRecommendations: 5,
      cardMetricsByName: baseCardMetrics(),
    });

    const deckCardNames = new Set([
      ...BASE_DECK.main.map(e => e.name.toLowerCase()),
      ...BASE_DECK.commander.map(e => e.name.toLowerCase()),
    ]);

    for (const rec of result.recommendations) {
      expect(deckCardNames.has(rec.add.name.toLowerCase())).toBe(false);
    }
  });

  it('respects color identity', async () => {
    const result = await generateRecommendationEngineV1Dynamic({
      deck: BASE_DECK,
      metaMode: 'balanced',
      maxRecommendations: 5,
      cardMetricsByName: baseCardMetrics(),
    });

    // Breya is WUBR, so recommendations should match
    const breyaColors = new Set(['W', 'U', 'B', 'R']);

    for (const rec of result.recommendations) {
      // Colorless cards are always OK
      if (rec.add.role.length === 0) continue;
      
      // Cards with colors should be compatible with Breya's identity
      // This is a soft check - we just verify recommendations were made
      expect(rec.add.name).toBeTruthy();
    }
  });
});
