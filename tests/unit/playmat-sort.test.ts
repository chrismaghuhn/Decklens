import { describe, expect, test } from 'vitest';
import { projectPiles, type Pile } from '../../src/playmat/sort.js';
import type { DeckbuilderDeck, DeckbuilderCardEntry } from '../../src/deckbuilder/types.js';
import type { DeckbuilderSearchCard } from '../../src/shared/scryfall-client.js';

function entry(name: string, qty = 1, tags: string[] = []): DeckbuilderCardEntry {
  return { name, qty, set: null, collectorNumber: null, tags };
}

function deckWith(main: DeckbuilderCardEntry[]): DeckbuilderDeck {
  return {
    id: 'd1', name: 'T', visibility: 'private', format: 'commander',
    createdAt: 0, updatedAt: 0,
    boards: { commander: [entry('Atraxa, Praetors’ Voice')], mainboard: main, sideboard: [], maybeboard: [] },
  } as unknown as DeckbuilderDeck;
}

function sc(partial: Partial<DeckbuilderSearchCard>): DeckbuilderSearchCard {
  return { id: 'x', name: 'x', cmc: 0, type_line: '', ...partial } as DeckbuilderSearchCard;
}

const cards: Record<string, DeckbuilderSearchCard | undefined> = {
  'sol ring': sc({ name: 'Sol Ring', cmc: 1, type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.', color_identity: [] }),
  'counterspell': sc({ name: 'Counterspell', cmc: 2, type_line: 'Instant', oracle_text: 'Counter target spell.', color_identity: ['U'] }),
  'wrath of god': sc({ name: 'Wrath of God', cmc: 4, type_line: 'Sorcery', oracle_text: 'Destroy all creatures.', color_identity: ['W'] }),
  'atraxa, praetors’ voice': sc({ name: 'Atraxa, Praetors’ Voice', cmc: 4, type_line: 'Legendary Creature — Phyrexian Angel Horror', color_identity: ['W','U','B','G'] }),
  'forest': sc({ name: 'Forest', cmc: 0, type_line: 'Basic Land — Forest', color_identity: ['G'] }),
  'expensive thing': sc({ name: 'Expensive Thing', cmc: 9, type_line: 'Creature — Eldrazi', color_identity: [] }),
  'golgari charm': sc({ name: 'Golgari Charm', cmc: 2, type_line: 'Instant', color_identity: ['B','G'], oracle_text: 'Choose one —' }),
};

function labels(piles: Pile[]): string[] { return piles.map((p) => p.label); }
function find(piles: Pile[], label: string): Pile | undefined { return piles.find((p) => p.label === label); }

describe('projectPiles', () => {
  test('type mode groups and orders; commander excluded', () => {
    const piles = projectPiles(deckWith([entry('Sol Ring'), entry('Counterspell'), entry('Forest', 8)]), cards, 'type');
    expect(labels(piles)).toEqual(['Instants', 'Artifacts', 'Lands']);
    expect(find(piles, 'Lands')?.count).toBe(8);
    expect(piles.flatMap((p) => p.entries.map((e) => e.name))).not.toContain('Atraxa, Praetors’ Voice');
  });

  test('mana mode buckets 7+ and puts lands in their own pile', () => {
    const piles = projectPiles(deckWith([entry('Sol Ring'), entry('Expensive Thing'), entry('Forest', 3)]), cards, 'mana');
    expect(labels(piles)).toEqual(['1', '7+', 'Lands']);
  });

  test('color mode: multicolor and colorless buckets', () => {
    const piles = projectPiles(deckWith([entry('Sol Ring'), entry('Counterspell'), entry('Golgari Charm')]), cards, 'color');
    expect(labels(piles)).toEqual(['Blue', 'Multicolor', 'Colorless']);
  });

  test('role mode uses classifier', () => {
    const piles = projectPiles(deckWith([entry('Counterspell'), entry('Wrath of God'), entry('Sol Ring')]), cards, 'role');
    expect(labels(piles)).toEqual(['Board Wipes', 'Counterspells', 'Ramp']);
  });

  test('tags mode: untagged pile last', () => {
    const piles = projectPiles(deckWith([entry('Sol Ring', 1, ['Combo']), entry('Counterspell')]), cards, 'tags');
    expect(labels(piles)).toEqual(['Combo', 'Untagged']);
  });

  test('unresolved card never crashes and lands in Unknown (last)', () => {
    const piles = projectPiles(deckWith([entry('Sol Ring'), entry('Mystery Card')]), cards, 'type');
    expect(labels(piles)[labels(piles).length - 1]).toBe('Unknown');
    expect(find(piles, 'Unknown')?.entries[0].name).toBe('Mystery Card');
  });
});

describe('tags mode with auto-tags', () => {
  const mixed = [
    entry('Sol Ring'),                      // ramp, no user tags
    entry('Wrath of God'),                  // wipe, no user tags
    entry('Counterspell', 1, ['Combo']),    // user-tagged
    entry('Mystery Card'),                  // unresolved
  ];

  test('untagged cards bucket into auto role piles, user piles stay', () => {
    const piles = projectPiles(deckWith(mixed), cards, 'tags', { autoTags: true });
    const auto = piles.filter((p) => p.auto);
    expect(auto.map((p) => p.label)).toEqual(expect.arrayContaining(['Ramp', 'Board Wipes', 'Utility']));
    expect(find(piles, 'Combo')?.auto).toBeFalsy();
    expect(find(piles, 'Combo')?.entries[0].name).toBe('Counterspell');
    expect(labels(piles)).not.toContain('Untagged');
    // auto pile ids are namespaced so they never collide with user tags
    expect(auto.every((p) => p.id.startsWith('pile-auto-'))).toBe(true);
  });

  test('toggle off keeps exact current behavior', () => {
    const piles = projectPiles(deckWith(mixed), cards, 'tags');
    expect(labels(piles)).toEqual(['Combo', 'Untagged']);
  });

  test('a multi-role card appears in every matching auto pile', () => {
    const multi = { ...cards, 'value kill': sc({ name: 'Value Kill', cmc: 3, type_line: 'Sorcery', oracle_text: 'Destroy target creature. Draw a card.' }) };
    const piles = projectPiles(deckWith([entry('Value Kill')]), multi, 'tags', { autoTags: true });
    expect(find(piles, 'Removal')?.entries[0].name).toBe('Value Kill');
    expect(find(piles, 'Card Draw')?.entries[0].name).toBe('Value Kill');
  });
});

describe('tag rename/delete on boards', () => {
  test('rename replaces the tag everywhere and merges case-insensitively', async () => {
    const { renameTagInBoards } = await import('../../src/playmat/sort.js');
    const boards = deckWith([
      entry('Sol Ring', 1, ['combo']),
      entry('Counterspell', 1, ['combo', 'Ramp']),
      entry('Forest', 1, ['Ramp']),
    ]).boards;
    renameTagInBoards(boards, 'combo', 'ramp');
    expect(boards.mainboard[0].tags).toEqual(['ramp']);
    expect(boards.mainboard[1].tags).toEqual(['Ramp']); // merged, no duplicate
    expect(boards.mainboard[2].tags).toEqual(['Ramp']);
  });

  test('delete removes the tag from every card', async () => {
    const { deleteTagInBoards } = await import('../../src/playmat/sort.js');
    const boards = deckWith([
      entry('Sol Ring', 1, ['Combo', 'Keep']),
      entry('Forest', 1, ['Combo']),
    ]).boards;
    deleteTagInBoards(boards, 'combo');
    expect(boards.mainboard[0].tags).toEqual(['Keep']);
    expect(boards.mainboard[1].tags).toEqual([]);
  });
});
