import { describe, it, expect } from 'vitest';
import {
  transformScryfallCard,
  transformBulkData,
  filterCommanderLegal,
} from '../scryfall-loader.ts';
import type { ScryfallCard } from '../scryfall-types.ts';

function makeScryfallCard(overrides: Partial<ScryfallCard>): ScryfallCard {
  return {
    id: 'test-id',
    oracle_id: 'test-oracle-id',
    name: 'Test Card',
    cmc: 3,
    type_line: 'Creature — Human',
    layout: 'normal',
    set: 'test',
    set_name: 'Test Set',
    ...overrides,
  };
}

describe('transformScryfallCard', () => {
  it('should transform a normal creature card', () => {
    const scryfall = makeScryfallCard({
      name: 'Llanowar Elves',
      mana_cost: '{G}',
      cmc: 1,
      type_line: 'Creature — Elf Druid',
      oracle_text: '{T}: Add {G}.',
      power: '1',
      toughness: '1',
      colors: ['G'],
      color_identity: ['G'],
      keywords: [],
      legalities: { commander: 'legal' },
      image_uris: { normal: 'https://example.com/llanowar.jpg' },
    });

    const card = transformScryfallCard(scryfall);
    expect(card).not.toBeNull();
    expect(card!.name).toBe('Llanowar Elves');
    expect(card!.manaCost).toBe('{G}');
    expect(card!.cmc).toBe(1);
    expect(card!.typeLine).toBe('Creature — Elf Druid');
    expect(card!.oracleText).toBe('{T}: Add {G}.');
    expect(card!.power).toBe('1');
    expect(card!.toughness).toBe('1');
    expect(card!.colors).toEqual(['G']);
    expect(card!.colorIdentity).toEqual(['G']);
    expect(card!.imageUrl).toBe('https://example.com/llanowar.jpg');
  });

  it('should transform an instant/sorcery', () => {
    const scryfall = makeScryfallCard({
      name: 'Lightning Bolt',
      mana_cost: '{R}',
      cmc: 1,
      type_line: 'Instant',
      oracle_text: 'Lightning Bolt deals 3 damage to any target.',
      colors: ['R'],
      color_identity: ['R'],
    });

    const card = transformScryfallCard(scryfall);
    expect(card).not.toBeNull();
    expect(card!.name).toBe('Lightning Bolt');
    expect(card!.power).toBeUndefined();
    expect(card!.toughness).toBeUndefined();
  });

  it('should transform a planeswalker', () => {
    const scryfall = makeScryfallCard({
      name: 'Jace, the Mind Sculptor',
      mana_cost: '{2}{U}{U}',
      cmc: 4,
      type_line: 'Legendary Planeswalker — Jace',
      oracle_text: '+2: Look at the top card...',
      loyalty: '3',
      colors: ['U'],
      color_identity: ['U'],
    });

    const card = transformScryfallCard(scryfall);
    expect(card).not.toBeNull();
    expect(card!.loyalty).toBe('3');
  });

  it('should handle double-faced cards', () => {
    const scryfall = makeScryfallCard({
      name: 'Delver of Secrets // Insectile Aberration',
      layout: 'transform',
      cmc: 1,
      card_faces: [
        {
          name: 'Delver of Secrets',
          mana_cost: '{U}',
          type_line: 'Creature — Human Wizard',
          oracle_text: 'At the beginning of your upkeep, look at the top card...',
          power: '1',
          toughness: '1',
          colors: ['U'],
          image_uris: { normal: 'https://example.com/delver-front.jpg' },
        },
        {
          name: 'Insectile Aberration',
          type_line: 'Creature — Human Insect',
          oracle_text: 'Flying',
          power: '3',
          toughness: '2',
          colors: ['U'],
          image_uris: { normal: 'https://example.com/delver-back.jpg' },
        },
      ],
      colors: ['U'],
      color_identity: ['U'],
    });

    const card = transformScryfallCard(scryfall);
    expect(card).not.toBeNull();
    // Should use front face data for DFCs
    expect(card!.manaCost).toBe('{U}');
    expect(card!.typeLine).toBe('Creature — Human Wizard');
    expect(card!.power).toBe('1');
    expect(card!.imageUrl).toBe('https://example.com/delver-front.jpg');
  });

  it('should skip tokens', () => {
    const scryfall = makeScryfallCard({ layout: 'token' });
    expect(transformScryfallCard(scryfall)).toBeNull();
  });

  it('should skip emblems', () => {
    const scryfall = makeScryfallCard({ layout: 'emblem' });
    expect(transformScryfallCard(scryfall)).toBeNull();
  });

  it('should skip art series', () => {
    const scryfall = makeScryfallCard({ layout: 'art_series' });
    expect(transformScryfallCard(scryfall)).toBeNull();
  });

  it('should handle missing optional fields gracefully', () => {
    const scryfall = makeScryfallCard({
      name: 'Minimal Card',
      layout: 'normal',
    });

    const card = transformScryfallCard(scryfall);
    expect(card).not.toBeNull();
    expect(card!.manaCost).toBe('');
    expect(card!.oracleText).toBe('');
    expect(card!.colors).toEqual([]);
    expect(card!.colorIdentity).toEqual([]);
    expect(card!.keywords).toEqual([]);
    expect(card!.imageUrl).toBe('');
  });

  it('should filter invalid color values', () => {
    const scryfall = makeScryfallCard({
      colors: ['G', 'X', 'W'] as any,
      color_identity: ['G', 'Z', 'W'] as any,
    });

    const card = transformScryfallCard(scryfall);
    expect(card!.colors).toEqual(['G', 'W']);
    expect(card!.colorIdentity).toEqual(['G', 'W']);
  });
});

describe('transformBulkData', () => {
  it('should transform multiple cards and skip invalid ones', () => {
    const cards: ScryfallCard[] = [
      makeScryfallCard({ name: 'Card A', layout: 'normal' }),
      makeScryfallCard({ name: 'Token', layout: 'token' }),
      makeScryfallCard({ name: 'Card B', layout: 'normal' }),
    ];

    const result = transformBulkData(cards);
    expect(result.length).toBe(2);
    expect(result[0].name).toBe('Card A');
    expect(result[1].name).toBe('Card B');
  });
});

describe('filterCommanderLegal', () => {
  it('should keep only commander-legal cards', () => {
    const cards = [
      { ...transformScryfallCard(makeScryfallCard({ legalities: { commander: 'legal' } }))!, name: 'Legal' },
      { ...transformScryfallCard(makeScryfallCard({ legalities: { commander: 'banned' } }))!, name: 'Banned' },
      { ...transformScryfallCard(makeScryfallCard({ legalities: { commander: 'not_legal' } }))!, name: 'Not Legal' },
    ];

    const result = filterCommanderLegal(cards);
    expect(result.length).toBe(1);
    expect(result[0].name).toBe('Legal');
  });
});
