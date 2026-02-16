import { describe, expect, it } from 'vitest';
import {
  generateRecommendationEngineV1,
  recommendationCandidateNames,
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
  const metrics: Record<string, RecommendationCardMetrics> = {
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
    'darksteel relic': {
      name: 'Darksteel Relic',
      mana_cost: '{0}',
      cmc: 0,
      type_line: 'Artifact',
      oracle_text: 'Indestructible',
      color_identity: [],
      prices: { eur: '0.03' },
    },
    cancel: {
      name: 'Cancel',
      mana_cost: '{1}{U}{U}',
      cmc: 3,
      type_line: 'Instant',
      oracle_text: 'Counter target spell.',
      color_identity: ['U'],
      prices: { eur: '0.05' },
    },
    divination: {
      name: 'Divination',
      mana_cost: '{2}{U}',
      cmc: 3,
      type_line: 'Sorcery',
      oracle_text: 'Draw two cards.',
      color_identity: ['U'],
      prices: { eur: '0.05' },
    },
    'colossal dreadmaw': {
      name: 'Colossal Dreadmaw',
      mana_cost: '{4}{G}{G}',
      cmc: 6,
      type_line: 'Creature - Dinosaur',
      oracle_text: 'Trample',
      color_identity: ['G'],
      prices: { eur: '0.05' },
    },
    naturalize: {
      name: 'Naturalize',
      mana_cost: '{1}{G}',
      cmc: 2,
      type_line: 'Instant',
      oracle_text: 'Destroy target artifact or enchantment.',
      color_identity: ['G'],
      prices: { eur: '0.07' },
    },
    'sign in blood': {
      name: 'Sign in Blood',
      mana_cost: '{B}{B}',
      cmc: 2,
      type_line: 'Sorcery',
      oracle_text: 'Target player draws two cards and loses 2 life.',
      color_identity: ['B'],
      prices: { eur: '0.15' },
    },
    'evolving wilds': {
      name: 'Evolving Wilds',
      type_line: 'Land',
      oracle_text: 'Sacrifice Evolving Wilds: Search your library for a basic land card.',
      color_identity: [],
      prices: { eur: '0.08' },
    },
    'command tower': {
      name: 'Command Tower',
      type_line: 'Land',
      oracle_text: '{T}: Add one mana of any color in your commander\'s color identity.',
      color_identity: [],
      prices: { eur: '0.60' },
    },
    'mind stone': {
      name: 'Mind Stone',
      mana_cost: '{2}',
      cmc: 2,
      type_line: 'Artifact',
      oracle_text: '{T}: Add {C}.',
      color_identity: [],
      prices: { eur: '0.30' },
    },
    ponder: {
      name: 'Ponder',
      mana_cost: '{U}',
      cmc: 1,
      type_line: 'Sorcery',
      oracle_text: 'Look at the top three cards of your library...',
      color_identity: ['U'],
      prices: { eur: '1.00' },
    },
  };

  for (const candidate of recommendationCandidateNames()) {
    const key = candidate.toLowerCase();
    if (!metrics[key]) {
      metrics[key] = {
        name: candidate,
        mana_cost: '{2}',
        cmc: 2,
        type_line: 'Instant',
        oracle_text: 'Generic utility card.',
        color_identity: [],
        prices: { eur: '2.00' },
      };
    }
  }

  return metrics;
}

describe('recommendation engine v1', () => {
  it('returns top-5 recommendations with at least three cut/add pairs when data allows', () => {
    const result = generateRecommendationEngineV1({
      deck: BASE_DECK,
      metaMode: 'balanced',
      maxRecommendations: 5,
      cardMetricsByName: baseCardMetrics(),
    });

    expect(result.recommendations).toHaveLength(5);
    const paired = result.recommendations.filter((rec) => rec.cut !== null);
    expect(paired.length).toBeGreaterThanOrEqual(3);
    expect(result.summary.hasMinimumPairs).toBe(true);
  });

  it('is deterministic for identical inputs', () => {
    const input = {
      deck: BASE_DECK,
      metaMode: 'competitive' as const,
      maxRecommendations: 5,
      cardMetricsByName: baseCardMetrics(),
    };

    const first = generateRecommendationEngineV1(input);
    const second = generateRecommendationEngineV1(input);

    expect(first.recommendations.map((rec) => [rec.id, rec.cut?.name || null])).toEqual(
      second.recommendations.map((rec) => [rec.id, rec.cut?.name || null]),
    );
  });

  it('uses collection data in budget mode to prioritize owned cards', () => {
    const result = generateRecommendationEngineV1({
      deck: BASE_DECK,
      metaMode: 'budget',
      maxRecommendations: 5,
      collectionByName: {
        'arcane signet': 1,
        'beast within': 2,
      },
      cardMetricsByName: baseCardMetrics(),
    });

    const ownedInTop = result.recommendations.filter((rec) => rec.add.ownedCount > 0);
    expect(ownedInTop.length).toBeGreaterThan(0);
  });

  it('handles sparse card metrics without crashing', () => {
    const sparse = generateRecommendationEngineV1({
      deck: BASE_DECK,
      maxRecommendations: 5,
      cardMetricsByName: {
        plains: baseCardMetrics().plains,
        island: baseCardMetrics().island,
      },
    });

    expect(sparse.recommendations.length).toBeGreaterThan(0);
    expect(sparse.summary.topN).toBe(5);
  });
});
