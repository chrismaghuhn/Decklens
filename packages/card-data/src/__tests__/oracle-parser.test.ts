import { describe, it, expect } from 'vitest';
import { parseCardTags, parseAllCardTags, getTagStatistics } from '../oracle-parser.ts';
import type { CardData } from '../scryfall-loader.ts';

function makeCard(overrides: Partial<CardData>): CardData {
  return {
    oracleId: 'test',
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

describe('parseCardTags — ramp', () => {
  it('should tag mana dork oracle text as ramp', () => {
    const card = makeCard({
      typeLine: 'Creature — Elf Druid',
      oracleText: '{T}: Add {G}.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('ramp');
  });

  it('should tag land search as ramp', () => {
    const card = makeCard({
      typeLine: 'Sorcery',
      oracleText: 'Search your library for a basic land card, put it onto the battlefield tapped.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('ramp');
  });

  it('should NOT tag lands as ramp', () => {
    const card = makeCard({
      typeLine: 'Land — Forest',
      oracleText: '{T}: Add {G}.',
    });
    const tags = parseCardTags(card);
    expect(tags).not.toContain('ramp');
  });
});

describe('parseCardTags — draw', () => {
  it('should tag draw a card', () => {
    const card = makeCard({
      oracleText: 'Draw a card.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('draw');
  });

  it('should tag draw three cards', () => {
    const card = makeCard({
      oracleText: 'Draw three cards.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('draw');
  });
});

describe('parseCardTags — removal', () => {
  it('should tag destroy target creature', () => {
    const card = makeCard({
      oracleText: 'Destroy target creature.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('removal');
  });

  it('should tag exile target permanent', () => {
    const card = makeCard({
      oracleText: 'Exile target permanent.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('removal');
  });

  it('should tag damage-based removal', () => {
    const card = makeCard({
      oracleText: 'Lightning Bolt deals 3 damage to any target.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('removal');
  });

  it('should NOT tag board wipes as removal', () => {
    const card = makeCard({
      oracleText: 'Destroy all creatures.',
    });
    const tags = parseCardTags(card);
    expect(tags).not.toContain('removal');
    expect(tags).toContain('wipe');
  });
});

describe('parseCardTags — counter', () => {
  it('should tag counter target spell', () => {
    const card = makeCard({
      oracleText: 'Counter target spell.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('counter');
  });

  it('should tag conditional counterspells', () => {
    const card = makeCard({
      oracleText: 'Counter target spell unless its controller pays {2}.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('counter');
  });
});

describe('parseCardTags — tutor', () => {
  it('should tag search your library for a card', () => {
    const card = makeCard({
      oracleText: 'Search your library for a card and put it into your hand.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('tutor');
  });

  it('should tag search for creature', () => {
    const card = makeCard({
      oracleText: 'Search your library for a creature card, reveal it, and put it into your hand.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('tutor');
  });

  it('should NOT tag basic land search as tutor', () => {
    const card = makeCard({
      oracleText: 'Search your library for a basic land card, put it onto the battlefield.',
    });
    const tags = parseCardTags(card);
    expect(tags).not.toContain('tutor');
  });
});

describe('parseCardTags — wipe', () => {
  it('should tag destroy all creatures', () => {
    const card = makeCard({
      oracleText: 'Destroy all creatures.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('wipe');
  });

  it('should tag exile all creatures', () => {
    const card = makeCard({
      oracleText: 'Exile all creatures.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('wipe');
  });

  it('should tag mass damage', () => {
    const card = makeCard({
      oracleText: 'Blasphemous Act deals 13 damage to each creature.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('wipe');
  });
});

describe('parseCardTags — engine', () => {
  it('should tag whenever-draw triggers', () => {
    const card = makeCard({
      oracleText: 'Whenever a creature enters the battlefield, draw a card.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('engine');
  });
});

describe('parseCardTags — combo-piece', () => {
  it('should tag extra turn spells', () => {
    const card = makeCard({
      oracleText: 'Take an extra turn after this one.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('combo-piece');
  });

  it('should tag win-the-game effects', () => {
    const card = makeCard({
      oracleText: 'You win the game.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('combo-piece');
    expect(tags).toContain('win-condition');
  });
});

describe('parseCardTags — token-generator', () => {
  it('should tag create token effects', () => {
    const card = makeCard({
      oracleText: 'Create two 1/1 white Soldier creature tokens.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('token-generator');
  });
});

describe('parseCardTags — land-fetch', () => {
  it('should tag basic land search', () => {
    const card = makeCard({
      oracleText: 'Search your library for a basic land card, put it onto the battlefield tapped.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('land-fetch');
  });
});

describe('parseCardTags — card-selection', () => {
  it('should tag scry', () => {
    const card = makeCard({
      oracleText: 'Scry 2.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('card-selection');
  });

  it('should tag surveil', () => {
    const card = makeCard({
      oracleText: 'Surveil 3.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('card-selection');
  });
});

describe('parseCardTags — recursion', () => {
  it('should tag return from graveyard to hand', () => {
    const card = makeCard({
      oracleText: 'Return target creature card from your graveyard to your hand.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('recursion');
  });

  it('should tag flashback keyword', () => {
    const card = makeCard({
      keywords: ['Flashback'],
      oracleText: 'Flashback {2}{R}',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('recursion');
  });
});

describe('parseCardTags — reanimation', () => {
  it('should tag return creature to battlefield from graveyard', () => {
    const card = makeCard({
      oracleText: 'Return target creature card from a graveyard to the battlefield.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('reanimation');
  });
});

describe('parseCardTags — finisher', () => {
  it('should tag double strike keyword', () => {
    const card = makeCard({
      keywords: ['Double strike'],
      oracleText: 'Double strike',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('finisher');
  });

  it('should tag infect', () => {
    const card = makeCard({
      keywords: ['Infect'],
      oracleText: 'Infect',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('finisher');
  });
});

describe('parseCardTags — multiple tags', () => {
  it('should assign multiple tags to a complex card', () => {
    // Mulldrifter-like card: draw + creature with evoke
    const card = makeCard({
      typeLine: 'Creature — Elemental',
      oracleText: 'When Mulldrifter enters the battlefield, draw two cards.',
    });
    const tags = parseCardTags(card);
    expect(tags).toContain('draw');
  });
});

describe('parseAllCardTags', () => {
  it('should parse tags for all cards', () => {
    const cards = [
      makeCard({ oracleText: 'Draw a card.' }),
      makeCard({ oracleText: 'Destroy target creature.' }),
    ];
    const result = parseAllCardTags(cards);
    expect(result[0].tags).toContain('draw');
    expect(result[1].tags).toContain('removal');
  });
});

describe('getTagStatistics', () => {
  it('should count tag occurrences', () => {
    const cards = [
      makeCard({ tags: ['draw', 'engine'] }),
      makeCard({ tags: ['draw', 'removal'] }),
      makeCard({ tags: ['removal'] }),
    ];
    const stats = getTagStatistics(cards);
    expect(stats['draw']).toBe(2);
    expect(stats['removal']).toBe(2);
    expect(stats['engine']).toBe(1);
  });
});
