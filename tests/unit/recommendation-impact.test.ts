import { describe, expect, it } from 'vitest';
import {
  buildRecommendationCollectionView,
  buildRecommendations,
  formatRecommendationGapHint,
  summarizeRecommendations,
  type RecommendationCardSnapshot,
  type RecommendationDeckEntry,
} from '../../src/mtg/recommendation-impact.js';
import type { PriceQuote } from '../../src/shared/price-adapter.js';

const CARD_DB: Record<string, RecommendationCardSnapshot> = {
  'llanowar elves': {
    name: 'Llanowar Elves',
    cmc: 1,
    type_line: 'Creature - Elf Druid',
    oracle_text: 'Tap: Add {G}.',
    color_identity: ['G'],
  },
  cultivate: {
    name: 'Cultivate',
    cmc: 3,
    type_line: 'Sorcery',
    oracle_text: 'Search your library for up to two basic land cards...',
    color_identity: ['G'],
  },
  giant: {
    name: 'Colossal Dreadmaw',
    cmc: 6,
    type_line: 'Creature - Dinosaur',
    oracle_text: 'Trample',
    color_identity: ['G'],
  },
  naturalize: {
    name: 'Naturalize',
    cmc: 2,
    type_line: 'Instant',
    oracle_text: 'Destroy target artifact or enchantment.',
    color_identity: ['G'],
  },
};

const DECK_MAIN: RecommendationDeckEntry[] = [
  { name: 'Llanowar Elves', qty: 1 },
  { name: 'Cultivate', qty: 1 },
  { name: 'Colossal Dreadmaw', qty: 2 },
  { name: 'Naturalize', qty: 1 },
];

function createQuote(cardName: string, amount: number | null, currency: PriceQuote['currency'] = 'EUR', status: PriceQuote['status'] = 'ok'): PriceQuote {
  return {
    cardName,
    amount,
    currency,
    source: 'scryfall.prices',
    asOf: 1700000000000,
    stale: false,
    status,
  };
}

describe('recommendation impact', () => {
  it('builds recommendations with explainability and confidence metadata', () => {
    const recommendations = buildRecommendations({
      deckMain: DECK_MAIN,
      getCard: (name) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name) => createQuote(name, 2.5),
    });

    expect(recommendations.length).toBeGreaterThan(0);
    for (const rec of recommendations) {
      expect(rec.powerImpactScore).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(rec.powerImpactLabel);
      expect(rec.unitPrice.status).toBeDefined();
      expect(rec.reason.trim().length).toBeGreaterThan(20);
      expect(rec.logicTags.length).toBeGreaterThan(0);
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(1);
      expect(rec.confidenceBreakdown.signalStrength).toBeGreaterThanOrEqual(0);
      expect(rec.confidenceBreakdown.signalStrength).toBeLessThanOrEqual(1);
      expect(rec.confidenceBreakdown.dataCoverage).toBeGreaterThanOrEqual(0);
      expect(rec.confidenceBreakdown.dataCoverage).toBeLessThanOrEqual(1);
      expect(rec.confidenceBreakdown.heuristicConsensus).toBeGreaterThanOrEqual(0);
      expect(rec.confidenceBreakdown.heuristicConsensus).toBeLessThanOrEqual(1);
    }
  });

  it('keeps summary totals consistent with selected detail rows', () => {
    const recommendations = buildRecommendations({
      deckMain: DECK_MAIN,
      getCard: (name) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name) => createQuote(name, 3),
      maxRecommendations: 4,
    });

    const selectedIds = new Set(recommendations.slice(0, 2).map((item) => item.id));
    const selected = recommendations.filter((item) => selectedIds.has(item.id));
    const summary = summarizeRecommendations(recommendations, selectedIds);

    const manualUnit = selected.reduce((sum, item) => sum + (item.unitPrice.amount || 0), 0);
    const manualDelta = selected.reduce((sum, item) => sum + (item.deltaPrice || 0), 0);
    const manualAvgConfidence = selected.reduce((sum, item) => sum + item.confidence, 0) / selected.length;

    expect(summary.itemCount).toBe(2);
    expect(summary.totalKnownUnitPrice).toBeCloseTo(manualUnit, 5);
    expect(summary.totalKnownDelta).toBeCloseTo(manualDelta, 5);
    expect(summary.averageConfidence).toBeCloseTo(manualAvgConfidence, 5);
  });

  it('handles missing and non-EUR prices without throwing', () => {
    const recommendations = buildRecommendations({
      deckMain: DECK_MAIN,
      getCard: (name) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name) => {
        if (name.includes('Ring')) return createQuote(name, 1.4, 'USD', 'ok');
        if (name.includes('Signet')) return createQuote(name, null, null, 'missing_price');
        return createQuote(name, 2.2, 'EUR', 'ok');
      },
    });

    const summary = summarizeRecommendations(recommendations);
    expect(summary.itemCount).toBeGreaterThan(0);
    expect(summary.missingPriceCount + summary.nonEurPriceCount).toBeGreaterThan(0);
  });

  it('changes recommendation scoring by selected meta mode', () => {
    const baseInput = {
      deckMain: DECK_MAIN,
      getCard: (name: string) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name: string) => createQuote(name, 2.2),
      maxRecommendations: 6,
    };

    const local = buildRecommendations({
      ...baseInput,
      metaMode: 'local',
    });
    const fnm = buildRecommendations({
      ...baseInput,
      metaMode: 'fnm',
    });
    const commanderPod = buildRecommendations({
      ...baseInput,
      metaMode: 'commander-pod',
    });

    const localScoreById = new Map(local.map((item) => [item.id, item.powerImpactScore]));
    const fnmScoreById = new Map(fnm.map((item) => [item.id, item.powerImpactScore]));
    const commanderScoreById = new Map(commanderPod.map((item) => [item.id, item.powerImpactScore]));

    const fnmDiffers = fnm.some((item) => localScoreById.get(item.id) !== item.powerImpactScore);
    const commanderDiffers = commanderPod.some((item) => localScoreById.get(item.id) !== item.powerImpactScore);
    const fnmVsCommanderDiffer = fnm.some((item) => commanderScoreById.get(item.id) !== fnmScoreById.get(item.id));

    expect(fnmDiffers).toBe(true);
    expect(commanderDiffers).toBe(true);
    expect(fnmVsCommanderDiffer).toBe(true);
  });

  it('applies owned-only collection filtering by default', () => {
    const recommendations = buildRecommendations({
      deckMain: DECK_MAIN,
      getCard: (name) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name) => createQuote(name, 2),
      maxRecommendations: 5,
    });

    expect(recommendations.length).toBeGreaterThanOrEqual(4);
    const owned = new Set<string>([
      recommendations[0]?.cardName || '',
      recommendations[2]?.cardName || '',
    ]);

    const view = buildRecommendationCollectionView({
      recommendations,
      getOwnedCount: (cardName) => (owned.has(cardName) ? 2 : 0),
    });

    expect(view.includeMissingCards).toBe(false);
    expect(view.visibleItems.map((item) => item.cardName)).toEqual(
      recommendations
        .filter((item) => owned.has(item.cardName))
        .map((item) => item.cardName),
    );
    expect(view.visibleItems.length).toBe(2);
    expect(view.missingItems.length).toBe(recommendations.length - 2);
  });

  it('supports include-missing toggle without changing ranking order', () => {
    const recommendations = buildRecommendations({
      deckMain: DECK_MAIN,
      getCard: (name) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name) => createQuote(name, 2),
      maxRecommendations: 5,
    });

    const ownedFirstOnly = new Set<string>([recommendations[0]?.cardName || '']);
    const ownedOnlyView = buildRecommendationCollectionView({
      recommendations,
      includeMissingCards: false,
      getOwnedCount: (cardName) => (ownedFirstOnly.has(cardName) ? 1 : 0),
    });
    const includeMissingView = buildRecommendationCollectionView({
      recommendations,
      includeMissingCards: true,
      getOwnedCount: (cardName) => (ownedFirstOnly.has(cardName) ? 1 : 0),
    });

    expect(ownedOnlyView.visibleItems.map((item) => item.cardName)).toEqual([
      recommendations[0]?.cardName,
    ]);
    expect(includeMissingView.visibleItems.map((item) => item.cardName)).toEqual(
      recommendations.map((item) => item.cardName),
    );
  });

  it('computes strong-build gap hint with configured label', () => {
    const recommendations = buildRecommendations({
      deckMain: DECK_MAIN,
      getCard: (name) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name) => createQuote(name, 2),
      maxRecommendations: 5,
    });

    const topOneOwned = recommendations[0]?.cardName || '';
    const view = buildRecommendationCollectionView({
      recommendations,
      strongBuildSize: 3,
      strongBuildLabel: 'Y',
      getOwnedCount: (cardName) => (cardName === topOneOwned ? 1 : 0),
    });

    expect(view.gap).toEqual({ missingCount: 2, buildLabel: 'Y' });
    expect(formatRecommendationGapHint(view.gap)).toBe('Fehlen noch 2 Karten für Build Y');
  });

  it('handles empty recommendations and invalid owned counts safely', () => {
    const emptyView = buildRecommendationCollectionView({
      recommendations: [],
      getOwnedCount: () => 0,
      strongBuildSize: 10,
    });
    expect(emptyView.visibleItems).toHaveLength(0);
    expect(emptyView.gap).toBeNull();

    const recommendations = buildRecommendations({
      deckMain: DECK_MAIN,
      getCard: (name) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name) => createQuote(name, 2),
      maxRecommendations: 3,
    });
    expect(recommendations.length).toBe(3);

    const view = buildRecommendationCollectionView({
      recommendations,
      strongBuildSize: 99,
      getOwnedCount: (cardName) => {
        if (cardName === recommendations[0]?.cardName) return Number.NaN;
        if (cardName === recommendations[1]?.cardName) return -3;
        return 1.9;
      },
    });

    expect(view.strongBuildItems).toHaveLength(3);
    expect(view.ownedItems.map((item) => item.cardName)).toEqual([
      recommendations[2]?.cardName,
    ]);
    expect(view.gap?.missingCount).toBe(2);
  });

  it('runs efficiently on larger deck inputs', () => {
    const largeDeck: RecommendationDeckEntry[] = Array.from({ length: 600 }, (_, idx) => ({
      name: `Card ${idx}`,
      qty: 1,
    }));

    const start = Date.now();
    const recommendations = buildRecommendations({
      deckMain: largeDeck,
      getCard: (name) => ({
        name,
        cmc: 3,
        type_line: 'Creature',
        oracle_text: 'Vanilla creature.',
        color_identity: ['G'],
      }),
      getPrice: (name) => createQuote(name, 1),
      maxRecommendations: 8,
    });
    const elapsed = Date.now() - start;

    expect(recommendations.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(250);
  });

  it('keeps confidence stable across repeated runs with same inputs', () => {
    const input = {
      deckMain: DECK_MAIN,
      getCard: (name: string) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name: string) => createQuote(name, 2.5),
      maxRecommendations: 6,
    };

    const runA = buildRecommendations(input).map((rec) => ({
      id: rec.id,
      reason: rec.reason,
      confidence: rec.confidence,
      tags: rec.logicTags,
    }));

    const runB = buildRecommendations(input).map((rec) => ({
      id: rec.id,
      reason: rec.reason,
      confidence: rec.confidence,
      tags: rec.logicTags,
    }));

    expect(runB).toEqual(runA);
  });

  it('lowers confidence when deck data coverage is partial', () => {
    const fullCoverage = buildRecommendations({
      deckMain: DECK_MAIN,
      getCard: (name) => CARD_DB[name.toLowerCase()] || null,
      getPrice: (name) => createQuote(name, 2.4),
      maxRecommendations: 6,
    });

    const partialCoverage = buildRecommendations({
      deckMain: DECK_MAIN,
      getCard: (name) => (name === 'Llanowar Elves' ? CARD_DB['llanowar elves'] : null),
      getPrice: (name) => createQuote(name, 2.4),
      maxRecommendations: 6,
    });

    const fullAverage = fullCoverage.reduce((sum, rec) => sum + rec.confidence, 0) / fullCoverage.length;
    const partialAverage = partialCoverage.reduce((sum, rec) => sum + rec.confidence, 0) / partialCoverage.length;

    expect(partialAverage).toBeLessThan(fullAverage);
  });
});
