import { describe, it, expect } from 'vitest';
import { CardIndex } from '../card-index.ts';
import type { CardData } from '../scryfall-loader.ts';

function makeCard(overrides: Partial<CardData>): CardData {
  return {
    oracleId: 'test-' + Math.random().toString(36).slice(2, 8),
    name: 'Test Card',
    manaCost: '{1}',
    cmc: 1,
    typeLine: 'Creature',
    oracleText: '',
    colors: [],
    colorIdentity: [],
    keywords: [],
    tags: [],
    imageUrl: '',
    legalities: { commander: 'legal' },
    ...overrides,
  };
}

const SOL_RING = makeCard({
  oracleId: 'sol-ring',
  name: 'Sol Ring',
  manaCost: '{1}',
  cmc: 1,
  typeLine: 'Artifact',
  tags: ['ramp', 'fast-mana'],
  edhrecRank: 1,
});

const LLANOWAR_ELVES = makeCard({
  oracleId: 'llanowar',
  name: 'Llanowar Elves',
  manaCost: '{G}',
  cmc: 1,
  typeLine: 'Creature — Elf Druid',
  colors: ['G'],
  colorIdentity: ['G'],
  tags: ['ramp', 'mana-dork'],
  edhrecRank: 50,
});

const COUNTERSPELL = makeCard({
  oracleId: 'counterspell',
  name: 'Counterspell',
  manaCost: '{U}{U}',
  cmc: 2,
  typeLine: 'Instant',
  colors: ['U'],
  colorIdentity: ['U'],
  tags: ['counter'],
  edhrecRank: 10,
});

const SWORDS = makeCard({
  oracleId: 'swords',
  name: 'Swords to Plowshares',
  manaCost: '{W}',
  cmc: 1,
  typeLine: 'Instant',
  colors: ['W'],
  colorIdentity: ['W'],
  tags: ['removal'],
  edhrecRank: 5,
});

const WRATH = makeCard({
  oracleId: 'wrath',
  name: 'Wrath of God',
  manaCost: '{2}{W}{W}',
  cmc: 4,
  typeLine: 'Sorcery',
  colors: ['W'],
  colorIdentity: ['W'],
  tags: ['wipe'],
  edhrecRank: 100,
});

const ATRAXA = makeCard({
  oracleId: 'atraxa',
  name: 'Atraxa, Praetors\' Voice',
  manaCost: '{G}{W}{U}{B}',
  cmc: 4,
  typeLine: 'Legendary Creature — Phyrexian Angel Horror',
  colors: ['W', 'U', 'B', 'G'],
  colorIdentity: ['W', 'U', 'B', 'G'],
  tags: ['finisher'],
  edhrecRank: 20,
});

const KENRITH = makeCard({
  oracleId: 'kenrith',
  name: 'Kenrith, the Returned King',
  manaCost: '{4}{W}',
  cmc: 5,
  typeLine: 'Legendary Creature — Human Noble',
  colors: ['W'],
  colorIdentity: ['W', 'U', 'B', 'R', 'G'],
  tags: [],
  edhrecRank: 30,
});

const COLOSSAL_DREADMAW = makeCard({
  oracleId: 'dreadmaw',
  name: 'Colossal Dreadmaw',
  manaCost: '{4}{G}{G}',
  cmc: 6,
  typeLine: 'Creature — Dinosaur',
  colors: ['G'],
  colorIdentity: ['G'],
  tags: [],
  edhrecRank: 9999,
});

const ALL_CARDS = [
  SOL_RING, LLANOWAR_ELVES, COUNTERSPELL, SWORDS,
  WRATH, ATRAXA, KENRITH, COLOSSAL_DREADMAW,
];

describe('CardIndex — construction', () => {
  it('should build index from cards', () => {
    const index = new CardIndex(ALL_CARDS);
    expect(index.size).toBe(8);
  });

  it('should handle empty card list', () => {
    const index = new CardIndex([]);
    expect(index.size).toBe(0);
  });
});

describe('CardIndex — getByName', () => {
  const index = new CardIndex(ALL_CARDS);

  it('should find card by exact name', () => {
    expect(index.getByName('Sol Ring')).toBe(SOL_RING);
  });

  it('should be case-insensitive', () => {
    expect(index.getByName('sol ring')).toBe(SOL_RING);
    expect(index.getByName('SOL RING')).toBe(SOL_RING);
  });

  it('should return undefined for unknown name', () => {
    expect(index.getByName('Black Lotus')).toBeUndefined();
  });
});

describe('CardIndex — getByOracleId', () => {
  const index = new CardIndex(ALL_CARDS);

  it('should find card by oracle ID', () => {
    expect(index.getByOracleId('sol-ring')).toBe(SOL_RING);
  });

  it('should return undefined for unknown oracle ID', () => {
    expect(index.getByOracleId('nonexistent')).toBeUndefined();
  });
});

describe('CardIndex — search', () => {
  const index = new CardIndex(ALL_CARDS);

  it('should search by name substring', () => {
    // "Sol" matches prefix index (3-char prefix), then includes filter matches
    const results = index.search({ nameContains: 'Sol' });
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Sol Ring');
  });

  it('should search by short substring without prefix optimization', () => {
    // Substrings shorter than 3 chars skip prefix index and scan all cards
    const results = index.search({ nameContains: 'Ri' });
    expect(results.map((c) => c.name)).toContain('Sol Ring');
    expect(results.map((c) => c.name)).toContain('Kenrith, the Returned King');
  });

  it('should search by type', () => {
    const results = index.search({ typeContains: 'instant' });
    expect(results).toHaveLength(2);
    expect(results.map((c) => c.name)).toContain('Counterspell');
    expect(results.map((c) => c.name)).toContain('Swords to Plowshares');
  });

  it('should filter by CMC range', () => {
    const results = index.search({ cmcMin: 4, cmcMax: 5 });
    expect(results).toHaveLength(3); // Wrath (4), Atraxa (4), Kenrith (5)
  });

  it('should filter by tags (all)', () => {
    const results = index.search({ tags: ['ramp'] });
    expect(results).toHaveLength(2);
    expect(results.map((c) => c.name)).toContain('Sol Ring');
    expect(results.map((c) => c.name)).toContain('Llanowar Elves');
  });

  it('should filter by tagsAny', () => {
    const results = index.search({ tagsAny: ['counter', 'removal'] });
    expect(results).toHaveLength(2);
  });

  it('should filter by legendary', () => {
    const results = index.search({ legendary: true });
    expect(results).toHaveLength(2);
    expect(results.map((c) => c.name)).toContain('Atraxa, Praetors\' Voice');
    expect(results.map((c) => c.name)).toContain('Kenrith, the Returned King');
  });

  it('should filter by colorIdentityIncludes', () => {
    const results = index.search({ colorIdentityIncludes: ['U', 'G'] });
    // Atraxa has WUBG, Kenrith has WUBRG — both include U and G
    expect(results).toHaveLength(2);
  });

  it('should filter by colorIdentityExact', () => {
    const results = index.search({ colorIdentityExact: ['G'] });
    expect(results).toHaveLength(2); // Llanowar, Dreadmaw
  });

  it('should filter by colorIdentityWithin', () => {
    // Cards that fit in a mono-green commander deck
    const results = index.search({ colorIdentityWithin: ['G'] });
    // Sol Ring (colorless), Llanowar (G), Dreadmaw (G)
    expect(results).toHaveLength(3);
  });

  it('should apply limit', () => {
    const results = index.search({ limit: 2 });
    expect(results).toHaveLength(2);
  });

  it('should sort by EDHREC rank', () => {
    const results = index.search({});
    expect(results[0].name).toBe('Sol Ring'); // rank 1
    expect(results[1].name).toBe('Swords to Plowshares'); // rank 5
  });

  it('should combine multiple filters', () => {
    const results = index.search({
      colorIdentityWithin: ['W'],
      cmcMax: 2,
    });
    // Sol Ring (colorless, cmc 1), Swords (W, cmc 1)
    expect(results).toHaveLength(2);
  });
});

describe('CardIndex — getCommanders', () => {
  const index = new CardIndex(ALL_CARDS);

  it('should find all legendary creatures', () => {
    const commanders = index.getCommanders();
    expect(commanders).toHaveLength(2);
  });

  it('should filter commanders by color identity', () => {
    const commanders = index.getCommanders(['W', 'U', 'B', 'G']);
    expect(commanders).toHaveLength(1);
    expect(commanders[0].name).toBe('Atraxa, Praetors\' Voice');
  });
});

describe('CardIndex — getCardsForCommander', () => {
  const index = new CardIndex(ALL_CARDS);

  it('should return cards within commander color identity', () => {
    const cards = index.getCardsForCommander(LLANOWAR_ELVES);
    // Mono-green: Sol Ring (colorless), Llanowar (G), Dreadmaw (G)
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.colorIdentity.every((c) => ['G'].includes(c))).toBe(true);
    }
  });
});

describe('CardIndex — getByTag', () => {
  const index = new CardIndex(ALL_CARDS);

  it('should return all cards with the given tag', () => {
    const rampCards = index.getByTag('ramp');
    expect(rampCards).toHaveLength(2);
  });

  it('should return empty for unused tag', () => {
    const combo = index.getByTag('combo-piece');
    expect(combo).toHaveLength(0);
  });
});

describe('CardIndex — getRandomCards', () => {
  const index = new CardIndex(ALL_CARDS);

  it('should return requested number of random cards', () => {
    const random = index.getRandomCards(3);
    expect(random).toHaveLength(3);
  });

  it('should not return duplicates', () => {
    const random = index.getRandomCards(5);
    const names = random.map((c) => c.name);
    expect(new Set(names).size).toBe(5);
  });

  it('should not exceed available cards', () => {
    const random = index.getRandomCards(100);
    expect(random).toHaveLength(8);
  });

  it('should respect search options', () => {
    const random = index.getRandomCards(2, { typeContains: 'instant' });
    expect(random).toHaveLength(2);
    for (const card of random) {
      expect(card.typeLine.toLowerCase()).toContain('instant');
    }
  });
});

describe('CardIndex — autocomplete', () => {
  const index = new CardIndex(ALL_CARDS);

  it('should return cards starting with prefix', () => {
    const results = index.autocomplete('Sol');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Sol Ring');
  });

  it('should be case-insensitive', () => {
    const results = index.autocomplete('sol');
    expect(results).toHaveLength(1);
  });

  it('should return empty for prefix shorter than 2', () => {
    const results = index.autocomplete('S');
    expect(results).toHaveLength(0);
  });

  it('should respect limit', () => {
    const results = index.autocomplete('Co', 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('should find multiple matches', () => {
    const results = index.autocomplete('Co');
    // Counterspell, Colossal Dreadmaw
    expect(results).toHaveLength(2);
  });
});

describe('CardIndex — getAllCards / getAllNames', () => {
  const index = new CardIndex(ALL_CARDS);

  it('should return copy of all cards', () => {
    const all = index.getAllCards();
    expect(all).toHaveLength(8);
    // Should be a copy, not the same array
    expect(all).not.toBe(ALL_CARDS);
  });

  it('should return all unique names', () => {
    const names = index.getAllNames();
    expect(names).toHaveLength(8);
    expect(names).toContain('sol ring'); // lowercase
  });
});
