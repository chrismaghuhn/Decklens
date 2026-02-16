import { describe, it, expect } from 'vitest';
import type { Deck, DeckEntry } from '../../src/shared/types.js';
import {
  analyzeDeckDNA,
  calculateSaltAnalysis,
  detectDeckSynergies,
  type AnalyzerCardView,
} from '../../src/mtg/engine/analyzers.js';
import {
  chunkBySize,
  collectUniqueDeckCardNames,
  processWithConcurrency,
} from '../../src/mtg/engine/fetch-pipeline.js';

function createResolver(cards: Record<string, AnalyzerCardView>) {
  return (name: string): AnalyzerCardView | undefined => cards[name];
}

describe('mtg engine analyzers', () => {
  it('detects aggro as dominant DNA profile', () => {
    const entries: DeckEntry[] = [
      { name: 'Swift Goblin', qty: 4 },
      { name: 'Lightning Bolt', qty: 4 },
      { name: 'Goblin Raider', qty: 4 },
      { name: 'Counterspell', qty: 1 },
    ];

    const resolver = createResolver({
      'Swift Goblin': {
        name: 'Swift Goblin',
        cmc: 1,
        type_line: 'Creature — Goblin',
        oracle_text: 'Haste',
      },
      'Lightning Bolt': {
        name: 'Lightning Bolt',
        cmc: 1,
        type_line: 'Instant',
        oracle_text: 'Lightning Bolt deals 3 damage to any target.',
      },
      'Goblin Raider': {
        name: 'Goblin Raider',
        cmc: 2,
        type_line: 'Creature — Goblin',
        oracle_text: '',
      },
      Counterspell: {
        name: 'Counterspell',
        cmc: 2,
        type_line: 'Instant',
        oracle_text: 'Counter target spell.',
      },
    });

    const result = analyzeDeckDNA(entries, resolver);
    expect(result.dominant).toBe('aggro');
    expect(result.normalized.aggro).toBeGreaterThan(result.normalized.control);
    expect(result.normalized.aggro).toBeGreaterThan(result.normalized.combo);
  });

  it('calculates salt score and labels salty cards', () => {
    const entries: DeckEntry[] = [
      { name: 'Time Warp Clone', qty: 2 },
      { name: 'Hard Lock Piece', qty: 1 },
      { name: 'Fair Creature', qty: 4 },
    ];

    const resolver = createResolver({
      'Time Warp Clone': {
        name: 'Time Warp Clone',
        oracle_text: 'Target player takes an extra turn after this one.',
      },
      'Hard Lock Piece': {
        name: 'Hard Lock Piece',
        oracle_text: 'Opponents can\'t cast spells during your turn.',
      },
      'Fair Creature': {
        name: 'Fair Creature',
        oracle_text: 'A vanilla creature.',
      },
    });

    const result = calculateSaltAnalysis(entries, resolver);
    expect(result.score).toBeGreaterThan(0);
    expect(result.label).toMatch(/Friendly|Mild|Spicy|Salty|Toxic/);
    expect(result.saltyCards.some((c) => c.includes('Time Warp Clone'))).toBe(true);
  });

  it('detects ETB and counter synergies', () => {
    const entries: DeckEntry[] = [
      { name: 'Soul Warden', qty: 1 },
      { name: 'Grizzly Bears', qty: 1 },
      { name: 'Hardened Scales', qty: 1 },
      { name: 'Conclave Mentor', qty: 1 },
    ];

    const resolver = createResolver({
      'Soul Warden': {
        name: 'Soul Warden',
        type_line: 'Creature — Human Cleric',
        oracle_text: 'Whenever another creature enters the battlefield, you gain 1 life.',
      },
      'Grizzly Bears': {
        name: 'Grizzly Bears',
        type_line: 'Creature — Bear',
        oracle_text: '',
      },
      'Hardened Scales': {
        name: 'Hardened Scales',
        type_line: 'Enchantment',
        oracle_text: 'If one or more +1/+1 counters would be put on a creature you control, that many plus one are put on it instead.',
      },
      'Conclave Mentor': {
        name: 'Conclave Mentor',
        type_line: 'Creature — Centaur Cleric',
        oracle_text: 'If one or more +1/+1 counters would be put on a creature you control, that many plus one +1/+1 counters are put on it instead.',
      },
    });

    const result = detectDeckSynergies(entries, resolver, 10);
    expect(result.some((line) => line.includes('Soul Warden') && line.includes('Grizzly Bears'))).toBe(true);
    expect(result.some((line) => line.includes('Hardened Scales') && line.includes('Conclave Mentor'))).toBe(true);
  });
});

describe('mtg fetch pipeline', () => {
  it('chunks arrays by size', () => {
    const chunks = chunkBySize([1, 2, 3, 4, 5], 2);
    expect(chunks).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('collects unique lowercased deck names', () => {
    const deck: Deck = {
      main: [{ name: 'Lightning Bolt', qty: 4 }],
      sideboard: [{ name: 'lightning bolt', qty: 2 }],
      commander: [{ name: ' Sol Ring ', qty: 1 }],
    };

    const names = collectUniqueDeckCardNames(deck);
    expect(names).toContain('lightning bolt');
    expect(names).toContain('sol ring');
    expect(names).toHaveLength(2);
  });

  it('processes items with bounded concurrency', async () => {
    const items = [1, 2, 3, 4, 5, 6];
    const seen: number[] = [];
    let active = 0;
    let maxActive = 0;

    await processWithConcurrency(
      items,
      async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        seen.push(value);
        active -= 1;
      },
      2,
    );

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(seen.sort((a, b) => a - b)).toEqual(items);
  });
});
