import { describe, expect, test, beforeEach } from 'vitest';
import { diffBoards, saveVersion, listVersions, VERSION_CAP } from '../../src/playmat/versions.js';
import type { DeckbuilderBoards } from '../../src/deckbuilder/types.js';
import { createEmptyDeck } from '../../src/deckbuilder/storage.js';

function boards(main: Array<[string, number]>, commander: Array<[string, number]> = []): DeckbuilderBoards {
  const mk = ([name, qty]: [string, number]) => ({ name, qty, set: null, collectorNumber: null, tags: [] });
  return { commander: commander.map(mk), mainboard: main.map(mk), sideboard: [], maybeboard: [] };
}

describe('diffBoards', () => {
  test('reports added, removed and quantity changes with deltas', () => {
    const before = boards([['Sol Ring', 1], ['Forest', 10], ['Shock', 2]]);
    const after = boards([['Sol Ring', 1], ['Forest', 12], ['Lightning Bolt', 1]]);
    const diff = diffBoards(before, after);
    expect(diff.added).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Forest', qty: 2, board: 'mainboard' }),
      expect.objectContaining({ name: 'Lightning Bolt', qty: 1, board: 'mainboard' }),
    ]));
    expect(diff.removed).toEqual([expect.objectContaining({ name: 'Shock', qty: 2, board: 'mainboard' })]);
  });

  test('identical boards diff to nothing', () => {
    const a = boards([['Sol Ring', 1]], [['Krenko, Mob Boss', 1]]);
    const diff = diffBoards(a, a);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  test('commander swaps show up under the commander board', () => {
    const before = boards([], [['Krenko, Mob Boss', 1]]);
    const after = boards([], [['Atraxa, Grand Unifier', 1]]);
    const diff = diffBoards(before, after);
    expect(diff.added).toEqual([expect.objectContaining({ name: 'Atraxa, Grand Unifier', board: 'commander' })]);
    expect(diff.removed).toEqual([expect.objectContaining({ name: 'Krenko, Mob Boss', board: 'commander' })]);
  });
});

describe('version storage', () => {
  beforeEach(() => localStorage.clear());

  test('save + list round-trips newest first', () => {
    const deck = createEmptyDeck('V');
    deck.boards = boards([['Sol Ring', 1]]);
    saveVersion(deck, 'first');
    deck.boards = boards([['Sol Ring', 1], ['Shock', 4]]);
    saveVersion(deck, 'second');
    const versions = listVersions(deck.id);
    expect(versions).toHaveLength(2);
    expect(versions[0].label).toBe('second');
    expect(versions[0].total).toBe(5);
    expect(versions[1].label).toBe('first');
  });

  test('caps stored versions, dropping the oldest', () => {
    const deck = createEmptyDeck('Cap');
    for (let i = 0; i < VERSION_CAP + 5; i++) {
      deck.boards = boards([['Forest', i + 1]]);
      saveVersion(deck, `v${i}`);
    }
    const versions = listVersions(deck.id);
    expect(versions).toHaveLength(VERSION_CAP);
    expect(versions[0].label).toBe(`v${VERSION_CAP + 4}`);
    expect(versions.some((v) => v.label === 'v0')).toBe(false);
  });

  test('skips saving when boards equal the newest version', () => {
    const deck = createEmptyDeck('Dup');
    deck.boards = boards([['Sol Ring', 1]]);
    expect(saveVersion(deck, 'a')).not.toBeNull();
    expect(saveVersion(deck, 'b')).toBeNull();
    expect(listVersions(deck.id)).toHaveLength(1);
  });
});
