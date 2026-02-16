import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildDeckHistoryKey,
  getDeckRecommendationHistory,
  getOrCreateDeviceProfile,
  recordRecommendationApplyHistory,
  recordRecommendationUndoHistory,
  resetRecommendationHistoryForTest,
} from '../../src/mtg/recommendation-history.js';

describe('recommendation history', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRecommendationHistoryForTest();
  });

  it('creates and reuses a stable local device profile', () => {
    const first = getOrCreateDeviceProfile();
    const second = getOrCreateDeviceProfile();

    expect(first.id).toBe(second.id);
    expect(first.createdAt).toBe(second.createdAt);
  });

  it('stores per-deck recommendation apply history and increments apply count', () => {
    recordRecommendationApplyHistory({
      deckName: 'Atraxa Midrange',
      commanderNames: ['Atraxa, Praetors\' Voice'],
      recommendationId: 'rec_1',
      cardName: 'Teferi\'s Protection',
      mode: 'add',
      cutName: null,
      reason: 'Protects your board while preserving tempo.',
      powerImpactLabel: 'high',
      logicTags: ['protection'],
      appliedAt: 1700000000000,
    });

    recordRecommendationApplyHistory({
      deckName: 'Atraxa Midrange',
      commanderNames: ['Atraxa, Praetors\' Voice'],
      recommendationId: 'rec_2',
      cardName: 'Teferi\'s Protection',
      mode: 'swap',
      cutName: 'Heroic Intervention',
      reason: 'Higher impact protection slot.',
      powerImpactLabel: 'high',
      logicTags: ['protection', 'synergy'],
      appliedAt: 1700000005000,
    });

    const history = getDeckRecommendationHistory('Atraxa Midrange', ['Atraxa, Praetors\' Voice']);
    expect(history).not.toBeNull();
    expect(history?.entries).toHaveLength(1);
    expect(history?.entries[0].cardName).toBe('Teferi\'s Protection');
    expect(history?.entries[0].applyCount).toBe(2);
    expect(history?.entries[0].lastMode).toBe('swap');
  });

  it('isolates history by deck key', () => {
    recordRecommendationApplyHistory({
      deckName: 'Deck A',
      commanderNames: ['Muldrotha, the Gravetide'],
      recommendationId: 'rec_a',
      cardName: 'Cyclonic Rift',
      mode: 'add',
      cutName: null,
      reason: 'Premium interaction.',
      powerImpactLabel: 'high',
      logicTags: ['board-control'],
      appliedAt: 1700000010000,
    });

    recordRecommendationApplyHistory({
      deckName: 'Deck B',
      commanderNames: ['Korvold, Fae-Cursed King'],
      recommendationId: 'rec_b',
      cardName: 'Dockside Extortionist',
      mode: 'add',
      cutName: null,
      reason: 'Explosive mana generation.',
      powerImpactLabel: 'high',
      logicTags: ['mana-fix'],
      appliedAt: 1700000015000,
    });

    const deckAHistory = getDeckRecommendationHistory('Deck A', ['Muldrotha, the Gravetide']);
    const deckBHistory = getDeckRecommendationHistory('Deck B', ['Korvold, Fae-Cursed King']);

    expect(deckAHistory?.entries[0].cardName).toBe('Cyclonic Rift');
    expect(deckBHistory?.entries[0].cardName).toBe('Dockside Extortionist');
    expect(buildDeckHistoryKey('Deck A', ['Muldrotha, the Gravetide']))
      .not.toBe(buildDeckHistoryKey('Deck B', ['Korvold, Fae-Cursed King']));
  });

  it('removes or decrements history on undo', () => {
    recordRecommendationApplyHistory({
      deckName: 'Tymna Deck',
      commanderNames: ['Tymna the Weaver'],
      recommendationId: 'rec_undo',
      cardName: 'Esper Sentinel',
      mode: 'add',
      cutName: null,
      reason: 'Efficient card advantage.',
      powerImpactLabel: 'medium',
      logicTags: ['card-advantage'],
      appliedAt: 1700000020000,
    });

    recordRecommendationUndoHistory({
      deckName: 'Tymna Deck',
      commanderNames: ['Tymna the Weaver'],
      cardName: 'Esper Sentinel',
    });

    const history = getDeckRecommendationHistory('Tymna Deck', ['Tymna the Weaver']);
    expect(history).toBeNull();
  });
});
