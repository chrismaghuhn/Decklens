import { describe, expect, test } from 'vitest';
import { planDrop } from '../../src/playmat/drag.js';
import { isTypingContext } from '../../src/playmat/state.js';
import { ROLE_PROB_KEYS } from '../../src/deckbuilder/role-classifier.js';
import { rememberCard } from '../../src/playmat/hand.js';
import type { DeckbuilderSearchCard } from '../../src/shared/scryfall-client.js';

describe('planDrop', () => {
  test('any drop outside the mat is a no-op, including hand cards', () => {
    expect(planDrop('hand-card', false, null, 'type')).toEqual({ type: 'none' });
    expect(planDrop('hand-card', false, { kind: 'pile', id: 'pile-x' }, 'tags')).toEqual({ type: 'none' });
    expect(planDrop('pile', false, { kind: 'cell', col: 1, row: 1 }, 'free')).toEqual({ type: 'none' });
  });

  test('hand card inside mat without a pile target adds plainly', () => {
    expect(planDrop('hand-card', true, null, 'type')).toEqual({ type: 'add' });
    expect(planDrop('hand-card', true, { kind: 'cell', col: 2, row: 1 }, 'free')).toEqual({ type: 'add' });
  });

  test('hand card on a pile in tags mode adds into that pile', () => {
    expect(planDrop('hand-card', true, { kind: 'pile', id: 'pile-combo' }, 'tags'))
      .toEqual({ type: 'add-to-pile', pileId: 'pile-combo' });
    // outside tags mode a pile hit is still a plain add
    expect(planDrop('hand-card', true, { kind: 'pile', id: 'pile-creatures' }, 'type'))
      .toEqual({ type: 'add' });
  });

  test('mat card onto a pile assigns the tag only in tags mode', () => {
    expect(planDrop('card', true, { kind: 'pile', id: 'pile-combo' }, 'tags'))
      .toEqual({ type: 'assign-to-pile', pileId: 'pile-combo' });
    expect(planDrop('card', true, { kind: 'pile', id: 'pile-creatures' }, 'type'))
      .toEqual({ type: 'none' });
  });

  test('pile onto an empty cell moves it; anything else is a no-op', () => {
    expect(planDrop('pile', true, { kind: 'cell', col: 4, row: 2 }, 'free'))
      .toEqual({ type: 'move-pile', col: 4, row: 2 });
    expect(planDrop('pile', true, { kind: 'pile', id: 'pile-other' }, 'free'))
      .toEqual({ type: 'none' });
    expect(planDrop('pile', true, null, 'free')).toEqual({ type: 'none' });
  });
});

describe('isTypingContext', () => {
  test('inputs, textareas, selects and contenteditable are typing contexts', () => {
    expect(isTypingContext(document.createElement('input'))).toBe(true);
    expect(isTypingContext(document.createElement('textarea'))).toBe(true);
    expect(isTypingContext(document.createElement('select'))).toBe(true);
    const div = document.createElement('div');
    expect(isTypingContext(div)).toBe(false);
    expect(isTypingContext(null)).toBe(false);
  });
});

describe('ROLE_PROB_KEYS', () => {
  test('maps roles onto the draw-probability preset keys', () => {
    expect(ROLE_PROB_KEYS.land).toBe('Land');
    expect(ROLE_PROB_KEYS.ramp).toBe('Ramp');
    expect(ROLE_PROB_KEYS.draw).toBe('Draw');
    expect(ROLE_PROB_KEYS.wipe).toBe('Board Wipe');
    expect(ROLE_PROB_KEYS.protection).toBe('Protection');
    expect(ROLE_PROB_KEYS.removal).toBe('Removal');
    expect(ROLE_PROB_KEYS.counter).toBe('Counter');
  });
});

describe('rememberCard', () => {
  test('stores the card under its normalized name key', () => {
    const state = { deck: { boards: {} }, cardByName: {}, sortMode: 'type' } as never;
    const card = { id: 'x', name: 'Fyndhorn Elves', cmc: 1, type_line: 'Creature' } as DeckbuilderSearchCard;
    rememberCard(state, card);
    expect((state as { cardByName: Record<string, unknown> }).cardByName['fyndhorn elves']).toBe(card);
  });
});

describe('pile reordering in sorted modes', () => {
  test('pile onto another pile inserts before it', () => {
    expect(planDrop('pile', true, { kind: 'pile', id: 'pile-b' }, 'type', 'pile-a'))
      .toEqual({ type: 'reorder-pile', beforeId: 'pile-b' });
  });

  test('pile onto itself is a no-op', () => {
    expect(planDrop('pile', true, { kind: 'pile', id: 'pile-a' }, 'type', 'pile-a'))
      .toEqual({ type: 'none' });
  });

  test('pile onto empty mat area moves it to the end', () => {
    expect(planDrop('pile', true, null, 'type', 'pile-a'))
      .toEqual({ type: 'reorder-pile', beforeId: null });
  });

  test('free mode still moves piles to cells, never reorders', () => {
    expect(planDrop('pile', true, { kind: 'cell', col: 4, row: 2 }, 'free', 'pile-a'))
      .toEqual({ type: 'move-pile', col: 4, row: 2 });
    expect(planDrop('pile', true, { kind: 'pile', id: 'pile-b' }, 'free', 'pile-a'))
      .toEqual({ type: 'none' });
  });
});

describe('applyPileOrder', () => {
  test('sorts piles by the saved order, unknown ids keep default order at the end', async () => {
    const { applyPileOrder } = await import('../../src/playmat/sort.js');
    const mk = (id: string) => ({ id, label: id, entries: [], count: 0 });
    const piles = [mk('pile-a'), mk('pile-b'), mk('pile-c'), mk('pile-d')];
    const out = applyPileOrder(piles, ['pile-c', 'pile-a']);
    expect(out.map((p) => p.id)).toEqual(['pile-c', 'pile-a', 'pile-b', 'pile-d']);
  });

  test('without a saved order the projection order stands', async () => {
    const { applyPileOrder } = await import('../../src/playmat/sort.js');
    const mk = (id: string) => ({ id, label: id, entries: [], count: 0 });
    const piles = [mk('pile-a'), mk('pile-b')];
    expect(applyPileOrder(piles, undefined).map((p) => p.id)).toEqual(['pile-a', 'pile-b']);
  });
});
