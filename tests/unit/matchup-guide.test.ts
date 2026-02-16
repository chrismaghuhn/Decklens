import { describe, expect, it } from 'vitest';
import type { Deck } from '../../src/shared/types.js';
import {
  buildMatchupGuide,
  type MatchupMetaMode,
} from '../../src/mtg/engine/matchup-guide.js';
import type { RecommendationCardSnapshot } from '../../src/mtg/recommendation-impact.js';

const CARD_DB: Record<string, RecommendationCardSnapshot> = {
  'lightning bolt': {
    name: 'Lightning Bolt',
    cmc: 1,
    type_line: 'Instant',
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    color_identity: ['R'],
  },
  counterspell: {
    name: 'Counterspell',
    cmc: 2,
    type_line: 'Instant',
    oracle_text: 'Counter target spell.',
    color_identity: ['U'],
  },
  cultivate: {
    name: 'Cultivate',
    cmc: 3,
    type_line: 'Sorcery',
    oracle_text: 'Search your library for up to two basic land cards.',
    color_identity: ['G'],
  },
  wrath: {
    name: 'Wrath of God',
    cmc: 4,
    type_line: 'Sorcery',
    oracle_text: 'Destroy all creatures. They cannot be regenerated.',
    color_identity: ['W'],
  },
  arena: {
    name: 'Phyrexian Arena',
    cmc: 3,
    type_line: 'Enchantment',
    oracle_text: 'At the beginning of your upkeep, you draw a card and you lose 1 life.',
    color_identity: ['B'],
  },
  negatesb: {
    name: 'Negate',
    cmc: 2,
    type_line: 'Instant',
    oracle_text: 'Counter target noncreature spell.',
    color_identity: ['U'],
  },
  disenchantsb: {
    name: 'Disenchant',
    cmc: 2,
    type_line: 'Instant',
    oracle_text: 'Destroy target artifact or enchantment.',
    color_identity: ['W'],
  },
  sweepersb: {
    name: 'Pyroclasm',
    cmc: 2,
    type_line: 'Sorcery',
    oracle_text: 'Pyroclasm deals 2 damage to each creature.',
    color_identity: ['R'],
  },
};

const BASE_DECK: Deck = {
  main: [
    { name: 'Lightning Bolt', qty: 4 },
    { name: 'Counterspell', qty: 3 },
    { name: 'Cultivate', qty: 2 },
    { name: 'Wrath', qty: 2 },
    { name: 'Arena', qty: 2 },
  ],
  sideboard: [
    { name: 'NegateSB', qty: 2 },
    { name: 'DisenchantSB', qty: 2 },
    { name: 'SweeperSB', qty: 2 },
  ],
  commander: [],
};

const MODES: MatchupMetaMode[] = ['local', 'fnm', 'commander-pod'];

function resolveCard(name: string): RecommendationCardSnapshot | null {
  return CARD_DB[name.toLowerCase()] || null;
}

describe('matchup guide generator', () => {
  it('returns at least three structured plans for each meta mode', () => {
    for (const mode of MODES) {
      const guide = buildMatchupGuide({
        deck: BASE_DECK,
        resolveCard,
        metaMode: mode,
      });

      expect(guide.schemaVersion).toBe('matchup-guide.v1');
      expect(guide.metaMode).toBe(mode);
      expect(guide.minMatchupsSatisfied).toBe(true);
      expect(guide.plans.length).toBeGreaterThanOrEqual(3);

      for (const plan of guide.plans) {
        expect(plan.relevanceScore).toBeGreaterThan(0);
        expect(plan.threats.length).toBeGreaterThan(0);
        expect(plan.wincons.length).toBeGreaterThan(0);
        expect(plan.corePlan.early.length).toBeGreaterThan(0);
        expect(plan.corePlan.mid.length).toBeGreaterThan(0);
        expect(plan.corePlan.late.length).toBeGreaterThan(0);
        expect(plan.sequencingPriorities.length).toBeGreaterThan(0);
        expect(plan.interactionPriorities.length).toBeGreaterThan(0);
      }
    }
  });

  it('generates concrete and balanced sideboard in/out moves when sideboard exists', () => {
    const guide = buildMatchupGuide({
      deck: BASE_DECK,
      resolveCard,
      metaMode: 'fnm',
    });

    expect(guide.hasSideboard).toBe(true);
    for (const plan of guide.plans) {
      expect(plan.sideboard.available).toBe(true);
      expect(plan.sideboard.in.length).toBeGreaterThan(0);
      expect(plan.sideboard.out.length).toBeGreaterThan(0);

      const inQty = plan.sideboard.in.reduce((sum, move) => sum + move.qty, 0);
      const outQty = plan.sideboard.out.reduce((sum, move) => sum + move.qty, 0);
      expect(inQty).toBeGreaterThan(0);
      expect(outQty).toBe(inQty);

      expect(plan.sideboard.in.every((move) => move.reason.trim().length > 8)).toBe(true);
      expect(plan.sideboard.out.every((move) => move.reason.trim().length > 8)).toBe(true);
    }
  });

  it('changes top matchup ordering between modes', () => {
    const local = buildMatchupGuide({
      deck: BASE_DECK,
      resolveCard,
      metaMode: 'local',
    });
    const pod = buildMatchupGuide({
      deck: BASE_DECK,
      resolveCard,
      metaMode: 'commander-pod',
    });

    expect(local.plans.map((plan) => plan.matchup)).not.toEqual(pod.plans.map((plan) => plan.matchup));
    expect(local.plans[0].matchup).not.toBe(pod.plans[0].matchup);
  });

  it('activates data-gap fallback when card data is missing', () => {
    const guide = buildMatchupGuide({
      deck: BASE_DECK,
      resolveCard: () => null,
      metaMode: 'fnm',
    });

    expect(guide.cardDataCoverage).toBe(0);
    expect(guide.fallbackReasons).toContain('low_card_data_coverage');
    expect(guide.plans.length).toBeGreaterThanOrEqual(3);
    expect(guide.plans[0].corePlan.early.some((line) => line.toLowerCase().includes('coverage'))).toBe(true);
  });

  it('uses no-sideboard fallback when sideboard is empty', () => {
    const deckWithoutSideboard: Deck = {
      ...BASE_DECK,
      sideboard: [],
    };

    const guide = buildMatchupGuide({
      deck: deckWithoutSideboard,
      resolveCard,
      metaMode: 'local',
    });

    expect(guide.hasSideboard).toBe(false);
    expect(guide.fallbackReasons).toContain('missing_sideboard');
    expect(guide.plans.every((plan) => !plan.sideboard.available)).toBe(true);
    expect(guide.plans.every((plan) => plan.sideboard.fallback)).toBe(true);
  });
});
