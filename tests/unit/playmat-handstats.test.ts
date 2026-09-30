import { describe, expect, test } from 'vitest';
import { simulateHands, type SimCard } from '../../src/playmat/handstats.js';

function lib(lands: number, spells: number, spellMv = 3): SimCard[] {
  return [
    ...Array.from({ length: lands }, () => ({ isLand: true, mv: 0 })),
    ...Array.from({ length: spells }, () => ({ isLand: false, mv: spellMv })),
  ];
}

describe('simulateHands', () => {
  test('all-land deck always draws 7 lands', () => {
    const stats = simulateHands(lib(60, 0), 200);
    expect(stats.avgLands).toBe(7);
    expect(stats.landHist[7]).toBe(200);
    expect(stats.pct2to4).toBe(0);
  });

  test('no-land deck never draws lands and averages the spell mana value', () => {
    const stats = simulateHands(lib(0, 60, 4), 200);
    expect(stats.avgLands).toBe(0);
    expect(stats.landHist[0]).toBe(200);
    expect(stats.avgMv).toBe(4);
  });

  test('mixed deck: histogram sums to hand count, averages are plausible', () => {
    const stats = simulateHands(lib(38, 61), 500);
    expect(stats.landHist.reduce((a, b) => a + b, 0)).toBe(500);
    expect(stats.avgLands).toBeGreaterThan(1.8);
    expect(stats.avgLands).toBeLessThan(3.6);
    expect(stats.pct2to4).toBeGreaterThan(50);
  });

  test('library smaller than a hand returns zeroed stats', () => {
    const stats = simulateHands(lib(3, 2), 100);
    expect(stats.hands).toBe(0);
  });
});
