import { describe, expect, test } from 'vitest';
import { normalizeCombo, groupCombos, type ComboData } from '../../src/playmat/combos.js';

const RAW = {
  id: '690-3966',
  uses: [
    { card: { name: 'Sanguine Bond' }, quantity: 1 },
    { card: { name: 'Exquisite Blood' }, quantity: 1 },
  ],
  produces: [{ feature: { name: 'Infinite lifeloss' } }, { feature: { name: 'Infinite lifegain' } }],
  description: 'Gain life.\nSanguine Bond triggers, causing an opponent to lose 1 life.\nRepeat from step 2.',
  notablePrerequisites: 'You have a way to gain life.',
  easyPrerequisites: '',
  manaNeeded: '',
  popularity: 12000,
};

describe('normalizeCombo', () => {
  test('maps uses, splits steps, detects missing cards against the deck', () => {
    const combo = normalizeCombo(RAW, new Set(['sanguine bond']));
    expect(combo.uses.map((u) => u.name)).toEqual(['Sanguine Bond', 'Exquisite Blood']);
    expect(combo.steps).toHaveLength(3);
    expect(combo.steps[0]).toBe('Gain life.');
    expect(combo.missing).toEqual(['Exquisite Blood']);
    expect(combo.prereq).toContain('gain life');
    expect(combo.produces).toEqual(['Infinite lifeloss', 'Infinite lifegain']);
  });

  test('no missing cards when everything is in the deck', () => {
    const combo = normalizeCombo(RAW, new Set(['sanguine bond', 'exquisite blood']));
    expect(combo.missing).toEqual([]);
  });
});

describe('groupCombos', () => {
  const mk = (produces: string[], popularity = 0): ComboData => ({
    id: String(Math.random()), uses: [], produces, steps: [], prereq: '', manaNeeded: '', popularity, missing: [],
  });

  test('buckets by result with Wins first and sorts by popularity', () => {
    const groups = groupCombos([
      mk(['Infinite colorless mana'], 5),
      mk(['Win the game'], 1),
      mk(['Each opponent loses the game'], 9),
      mk(['Infinite card draw'], 3),
      mk(['Infinite lifegain'], 2),
    ]);
    expect(groups[0].label).toBe('Wins the game');
    expect(groups[0].combos.map((c) => c.popularity)).toEqual([9, 1]);
    const labels = groups.map((g) => g.label);
    expect(labels).toContain('Infinite mana');
    expect(labels).toContain('Infinite draw');
    expect(labels[labels.length - 1]).toBe('Value engines');
  });
});
