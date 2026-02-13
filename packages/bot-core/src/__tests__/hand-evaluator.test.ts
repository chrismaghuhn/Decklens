import { describe, it, expect, beforeEach } from 'vitest';
import {
  assessHand,
  scoreCardInHand,
  countLands,
  getLandsInHand,
  getSpellsInHand,
  getCastableSpells,
  chooseMulliganBottoms,
} from '../evaluators/hand-evaluator.ts';
import { emptyPool, addMana } from '@mtg/game-engine';
import { resetIds, makeCreature, makeInstant, makeLand } from './test-helpers.ts';

beforeEach(() => resetIds());

describe('countLands', () => {
  it('should count land cards', () => {
    const cards = [
      makeLand('Forest', 0),
      makeLand('Island', 0, { typeLine: 'Land — Island' }),
      makeCreature('Elf', '{G}', '1', '1', 0),
    ];
    expect(countLands(cards)).toBe(2);
  });

  it('should return 0 with no lands', () => {
    const cards = [makeCreature('Elf', '{G}', '1', '1', 0)];
    expect(countLands(cards)).toBe(0);
  });
});

describe('getLandsInHand / getSpellsInHand', () => {
  it('should split hand into lands and spells', () => {
    const hand = [
      makeLand('Forest', 0),
      makeCreature('Elf', '{G}', '1', '1', 0),
      makeInstant('Bolt', '{R}', 0),
    ];
    expect(getLandsInHand(hand)).toHaveLength(1);
    expect(getSpellsInHand(hand)).toHaveLength(2);
  });
});

describe('getCastableSpells', () => {
  it('should find spells castable with available mana', () => {
    const hand = [
      makeLand('Forest', 0),
      makeCreature('Elf', '{G}', '1', '1', 0),
      makeCreature('Giant', '{4}{G}{G}', '5', '5', 0),
    ];
    const pool = addMana(emptyPool(), 'G', 2);
    const castable = getCastableSpells(hand, pool, 40);
    expect(castable).toHaveLength(1);
    expect(castable[0].name).toBe('Elf');
  });

  it('should return empty when no mana', () => {
    const hand = [makeCreature('Elf', '{G}', '1', '1', 0)];
    const castable = getCastableSpells(hand, emptyPool(), 40);
    expect(castable).toHaveLength(0);
  });
});

describe('scoreCardInHand', () => {
  it('should value lands higher when few in hand', () => {
    const land = makeLand('Forest', 0);
    const scoreFewLands = scoreCardInHand(land, 1, 0);
    const scoreManyLands = scoreCardInHand(land, 5, 0);
    expect(scoreFewLands).toBeGreaterThan(scoreManyLands);
  });

  it('should value ramp early', () => {
    const ramp = makeCreature('Elf', '{G}', '1', '1', 0, { tags: ['ramp'] });
    const vanilla = makeCreature('Bear', '{1}{G}', '2', '2', 0, { tags: [] });
    const rampScore = scoreCardInHand(ramp, 3, 1);
    const vanillaScore = scoreCardInHand(vanilla, 3, 1);
    expect(rampScore).toBeGreaterThan(vanillaScore);
  });
});

describe('assessHand', () => {
  it('should rate a balanced hand highly', () => {
    const hand = [
      makeLand('Forest', 0),
      makeLand('Plains', 0, { typeLine: 'Land — Plains' }),
      makeLand('Island', 0, { typeLine: 'Land — Island' }),
      makeCreature('Ramp Elf', '{G}', '1', '1', 0, { tags: ['ramp'] }),
      makeCreature('Bear', '{1}{G}', '2', '2', 0),
      makeInstant('Draw Spell', '{1}{U}', 0, { tags: ['draw'] }),
      makeInstant('Swords', '{W}', 0, { tags: ['removal'] }),
    ];
    const result = assessHand(hand, emptyPool(), 40);

    expect(result.quality).toBeGreaterThanOrEqual(6);
    expect(result.landCount).toBe(3);
    expect(result.hasRamp).toBe(true);
    expect(result.hasDraw).toBe(true);
    expect(result.hasInteraction).toBe(true);
    expect(result.hasEarlyGame).toBe(true);
  });

  it('should rate all-land hand poorly', () => {
    const hand = Array.from({ length: 7 }, (_, i) => makeLand(`Land ${i}`, 0));
    const result = assessHand(hand, emptyPool(), 40);
    expect(result.quality).toBeLessThan(3);
  });

  it('should rate no-land hand poorly', () => {
    const hand = Array.from({ length: 7 }, (_, i) =>
      makeCreature(`Creature ${i}`, `{${i + 1}}`, `${i + 1}`, `${i + 1}`, 0)
    );
    const result = assessHand(hand, emptyPool(), 40);
    expect(result.quality).toBeLessThan(3);
    expect(result.landCount).toBe(0);
  });
});

describe('chooseMulliganBottoms', () => {
  it('should bottom the worst cards', () => {
    const hand = [
      makeLand('Forest', 0),
      makeLand('Plains', 0, { typeLine: 'Land — Plains' }),
      makeCreature('Ramp', '{G}', '1', '1', 0, { tags: ['ramp'] }),
      makeCreature('Expensive', '{7}', '7', '7', 0),
    ];
    const bottoms = chooseMulliganBottoms(hand, 1);
    expect(bottoms).toHaveLength(1);
    // The expensive card should be bottomed
    expect(bottoms[0]).toBe(hand[3].id);
  });

  it('should return empty for count 0', () => {
    const hand = [makeLand('Forest', 0)];
    expect(chooseMulliganBottoms(hand, 0)).toHaveLength(0);
  });
});
