import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluatePermanent,
  evaluatePlayerBoard,
  evaluateBoardPosition,
  hasBoardDominance,
  getOpponentTotalPower,
} from '../evaluators/board-evaluator.ts';
import { cardToPermanent } from '@mtg/game-engine';
import {
  resetIds, makeCreature, createMainPhaseState, putOnBattlefield,
} from './test-helpers.ts';

beforeEach(() => resetIds());

describe('evaluatePermanent', () => {
  it('should score creatures by power + toughness', () => {
    const small = cardToPermanent(makeCreature('Elf', '{G}', '1', '1', 0), 0, 1);
    const big = cardToPermanent(makeCreature('Giant', '{4}{G}', '5', '5', 0), 0, 1);

    const smallScore = evaluatePermanent(small);
    const bigScore = evaluatePermanent(big);

    expect(bigScore).toBeGreaterThan(smallScore);
  });

  it('should penalize tapped permanents', () => {
    const untapped = cardToPermanent(makeCreature('Bear', '{1}{G}', '2', '2', 0), 0, 1);
    const tapped = { ...untapped, tapped: true };

    expect(evaluatePermanent(untapped)).toBeGreaterThan(evaluatePermanent(tapped));
  });

  it('should value planeswalkers highly', () => {
    const creature = cardToPermanent(makeCreature('Bear', '{1}{G}', '2', '2', 0), 0, 1);
    const planeswalker = cardToPermanent(
      makeCreature('Jace', '{2}{U}{U}', '0', '0', 0, {
        typeLine: 'Planeswalker — Jace',
        loyalty: '4',
      }),
      0, 1,
    );
    // Set planeswalker loyalty
    const pw = { ...planeswalker, currentLoyalty: 4, currentPower: undefined, currentToughness: undefined };

    expect(evaluatePermanent(pw)).toBeGreaterThan(evaluatePermanent(creature));
  });
});

describe('evaluatePlayerBoard', () => {
  it('should return board score with details', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 0), 0);
    state = putOnBattlefield(state, makeCreature('Elf', '{G}', '1', '1', 0), 0);

    const score = evaluatePlayerBoard(state.players[0]);

    expect(score.creatureCount).toBe(2);
    expect(score.creaturePower).toBe(3);
    expect(score.creatureToughness).toBe(3);
    expect(score.total).toBeGreaterThan(0);
  });

  it('should include hand size in score', () => {
    let state = createMainPhaseState();
    // Add some cards to hand so it's non-empty
    const withHand = {
      ...state.players[0],
      hand: [makeCreature('Bear', '{1}{G}', '2', '2', 0), makeCreature('Elf', '{G}', '1', '1', 0)],
    };
    const withCards = evaluatePlayerBoard(withHand);

    // Empty hand
    const emptyHand = { ...state.players[0], hand: [] };
    const withoutCards = evaluatePlayerBoard(emptyHand);

    expect(withCards.total).toBeGreaterThan(withoutCards.total);
  });
});

describe('evaluateBoardPosition', () => {
  it('should return positive when ahead on board', () => {
    let state = createMainPhaseState();
    // Give player 0 big creatures
    state = putOnBattlefield(state, makeCreature('Giant', '{4}{G}', '5', '5', 0), 0);
    state = putOnBattlefield(state, makeCreature('Dragon', '{4}{R}', '5', '5', 0), 0);

    expect(evaluateBoardPosition(state, 0)).toBeGreaterThan(0);
    expect(evaluateBoardPosition(state, 1)).toBeLessThan(0);
  });

  it('should return ~0 when boards are equal', () => {
    const state = createMainPhaseState();
    // No creatures on either side, just life totals
    const diff = evaluateBoardPosition(state, 0);
    // Should be close to 0 (slight differences from hand sizes)
    expect(Math.abs(diff)).toBeLessThan(5);
  });
});

describe('hasBoardDominance', () => {
  it('should detect dominance with large board advantage', () => {
    let state = createMainPhaseState();
    for (let i = 0; i < 5; i++) {
      state = putOnBattlefield(state, makeCreature(`Creature ${i}`, '{2}', '3', '3', 0), 0);
    }
    expect(hasBoardDominance(state, 0)).toBe(true);
    expect(hasBoardDominance(state, 1)).toBe(false);
  });
});

describe('getOpponentTotalPower', () => {
  it('should sum opponent creature power', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 1), 1);
    state = putOnBattlefield(state, makeCreature('Giant', '{4}{G}', '5', '5', 1), 1);

    expect(getOpponentTotalPower(state, 0)).toBe(7);
  });

  it('should return 0 with no opponent creatures', () => {
    const state = createMainPhaseState();
    expect(getOpponentTotalPower(state, 0)).toBe(0);
  });
});
