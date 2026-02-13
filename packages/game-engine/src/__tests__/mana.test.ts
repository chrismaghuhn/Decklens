import { describe, it, expect } from 'vitest';
import {
  parseManaCost,
  canPayCost,
  autoPayCost,
  payCost,
  emptyPool,
  addMana,
  totalMana,
  calculateCMC,
  emptyManaCost,
} from '../rules/mana.ts';

describe('parseManaCost', () => {
  it('should parse empty string', () => {
    const cost = parseManaCost('');
    expect(cost).toEqual(emptyManaCost());
  });

  it('should parse generic mana', () => {
    const cost = parseManaCost('{3}');
    expect(cost.generic).toBe(3);
  });

  it('should parse colored mana', () => {
    const cost = parseManaCost('{W}{U}{B}');
    expect(cost.W).toBe(1);
    expect(cost.U).toBe(1);
    expect(cost.B).toBe(1);
    expect(cost.R).toBe(0);
    expect(cost.G).toBe(0);
  });

  it('should parse mixed costs', () => {
    const cost = parseManaCost('{2}{W}{U}');
    expect(cost.generic).toBe(2);
    expect(cost.W).toBe(1);
    expect(cost.U).toBe(1);
  });

  it('should parse X costs', () => {
    const cost = parseManaCost('{X}{R}{R}');
    expect(cost.X).toBe(1);
    expect(cost.R).toBe(2);
  });

  it('should parse colorless mana {C}', () => {
    const cost = parseManaCost('{2}{C}');
    expect(cost.generic).toBe(2);
    expect(cost.C).toBe(1);
  });

  it('should parse snow mana {S}', () => {
    const cost = parseManaCost('{S}{S}');
    expect(cost.snow).toBe(2);
  });

  it('should parse phyrexian mana', () => {
    const cost = parseManaCost('{W/P}{B/P}');
    expect(cost.phyrexian).toHaveLength(2);
    expect(cost.phyrexian[0].color).toBe('W');
    expect(cost.phyrexian[1].color).toBe('B');
  });

  it('should parse hybrid mana', () => {
    const cost = parseManaCost('{W/U}{B/G}');
    expect(cost.hybrid).toHaveLength(2);
    expect(cost.hybrid[0].colors).toEqual(['W', 'U']);
    expect(cost.hybrid[1].colors).toEqual(['B', 'G']);
  });

  it('should parse complex costs (Sol Ring: {1})', () => {
    const cost = parseManaCost('{1}');
    expect(cost.generic).toBe(1);
  });

  it('should parse Cryptic Command {1}{U}{U}{U}', () => {
    const cost = parseManaCost('{1}{U}{U}{U}');
    expect(cost.generic).toBe(1);
    expect(cost.U).toBe(3);
  });

  it('should parse {0} cost', () => {
    const cost = parseManaCost('{0}');
    expect(cost.generic).toBe(0);
  });

  it('should parse high generic costs {15}', () => {
    const cost = parseManaCost('{15}');
    expect(cost.generic).toBe(15);
  });
});

describe('calculateCMC', () => {
  it('should calculate simple CMC', () => {
    const cost = parseManaCost('{2}{W}{U}');
    expect(calculateCMC(cost)).toBe(4);
  });

  it('should count phyrexian as 1 each', () => {
    const cost = parseManaCost('{W/P}{B/P}');
    expect(calculateCMC(cost)).toBe(2);
  });

  it('should count hybrid as 1 each', () => {
    const cost = parseManaCost('{W/U}');
    expect(calculateCMC(cost)).toBe(1);
  });

  it('should not count X', () => {
    const cost = parseManaCost('{X}{R}');
    expect(calculateCMC(cost)).toBe(1);
  });
});

describe('canPayCost', () => {
  it('should return true for empty cost', () => {
    expect(canPayCost(emptyPool(), emptyManaCost(), 40)).toBe(true);
  });

  it('should return true when pool has exact mana', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'W', 1);
    pool = addMana(pool, 'U', 1);
    const cost = parseManaCost('{W}{U}');
    expect(canPayCost(pool, cost, 40)).toBe(true);
  });

  it('should return false when not enough colored mana', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'W', 1);
    const cost = parseManaCost('{W}{U}');
    expect(canPayCost(pool, cost, 40)).toBe(false);
  });

  it('should allow generic mana from any color', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'R', 3);
    const cost = parseManaCost('{2}{R}');
    expect(canPayCost(pool, cost, 40)).toBe(true);
  });

  it('should handle phyrexian mana with life payment', () => {
    const pool = emptyPool();
    const cost = parseManaCost('{W/P}');
    // No white mana but enough life
    expect(canPayCost(pool, cost, 40)).toBe(true);
    // Not enough life
    expect(canPayCost(pool, cost, 1)).toBe(false);
  });

  it('should handle hybrid mana with either color', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'U', 1);
    const cost = parseManaCost('{W/U}');
    expect(canPayCost(pool, cost, 40)).toBe(true);
  });

  it('should return false for hybrid when neither color available', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'R', 1);
    const cost = parseManaCost('{W/U}');
    expect(canPayCost(pool, cost, 40)).toBe(false);
  });
});

describe('autoPayCost', () => {
  it('should auto-pay simple colored costs', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'W', 2);
    pool = addMana(pool, 'U', 1);
    const cost = parseManaCost('{W}{U}');
    const payment = autoPayCost(pool, cost, 40);
    expect(payment).not.toBeNull();
    expect(payment!.from.W).toBe(1);
    expect(payment!.from.U).toBe(1);
  });

  it('should return null when cannot pay', () => {
    const pool = emptyPool();
    const cost = parseManaCost('{W}');
    expect(autoPayCost(pool, cost, 40)).toBeNull();
  });

  it('should use life for phyrexian when no mana', () => {
    const pool = emptyPool();
    const cost = parseManaCost('{W/P}');
    const payment = autoPayCost(pool, cost, 40);
    expect(payment).not.toBeNull();
    expect(payment!.phyrexianLife).toBe(2);
  });

  it('should prefer mana over life for phyrexian', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'W', 1);
    const cost = parseManaCost('{W/P}');
    const payment = autoPayCost(pool, cost, 40);
    expect(payment).not.toBeNull();
    expect(payment!.phyrexianLife).toBe(0);
    expect(payment!.from.W).toBe(1);
  });
});

describe('pool operations', () => {
  it('totalMana should sum all mana', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'W', 2);
    pool = addMana(pool, 'R', 3);
    pool = addMana(pool, 'C', 1);
    expect(totalMana(pool)).toBe(6);
  });

  it('addMana should not mutate original', () => {
    const pool = emptyPool();
    const newPool = addMana(pool, 'W', 1);
    expect(pool.W).toBe(0);
    expect(newPool.W).toBe(1);
  });

  it('payCost should subtract spent mana', () => {
    let pool = emptyPool();
    pool = addMana(pool, 'W', 3);
    pool = addMana(pool, 'U', 2);
    const cost = parseManaCost('{W}{U}');
    const payment = autoPayCost(pool, cost, 40)!;
    const newPool = payCost(pool, cost, payment);
    expect(newPool.W).toBe(2);
    expect(newPool.U).toBe(1);
  });
});
