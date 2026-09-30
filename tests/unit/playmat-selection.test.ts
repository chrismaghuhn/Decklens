import { describe, expect, test } from 'vitest';
import { toggleName, rangeNames, rectsIntersect } from '../../src/playmat/selection.js';

describe('toggleName', () => {
  test('adds a missing name and removes a present one', () => {
    const sel = new Set<string>();
    toggleName(sel, 'Sol Ring');
    expect(sel.has('Sol Ring')).toBe(true);
    toggleName(sel, 'Sol Ring');
    expect(sel.has('Sol Ring')).toBe(false);
  });
});

describe('rangeNames', () => {
  const order = ['a', 'b', 'c', 'd', 'e'];

  test('returns the inclusive range in reading order', () => {
    expect(rangeNames(order, 'b', 'd')).toEqual(['b', 'c', 'd']);
  });

  test('works backwards', () => {
    expect(rangeNames(order, 'd', 'b')).toEqual(['b', 'c', 'd']);
  });

  test('anchor missing falls back to the target alone', () => {
    expect(rangeNames(order, 'zzz', 'c')).toEqual(['c']);
  });
});

describe('rectsIntersect', () => {
  test('overlapping and touching rects intersect, disjoint do not', () => {
    const a = { left: 0, top: 0, right: 10, bottom: 10 };
    expect(rectsIntersect(a, { left: 5, top: 5, right: 15, bottom: 15 })).toBe(true);
    expect(rectsIntersect(a, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(true);
    expect(rectsIntersect(a, { left: 11, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(rectsIntersect(a, { left: 0, top: 11, right: 10, bottom: 20 })).toBe(false);
  });
});
