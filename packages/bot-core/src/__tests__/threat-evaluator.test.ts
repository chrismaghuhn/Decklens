import { describe, it, expect, beforeEach } from 'vitest';
import {
  evaluatePermanentThreat,
  evaluateStackThreat,
  identifyThreats,
  hasMustAnswerThreat,
  getTopThreat,
} from '../evaluators/threat-evaluator.ts';
import { cardToPermanent } from '@mtg/game-engine';
import type { StackObject } from '@mtg/game-engine';
import {
  resetIds, makeCreature, createMainPhaseState, putOnBattlefield,
} from './test-helpers.ts';

beforeEach(() => resetIds());

describe('evaluatePermanentThreat', () => {
  it('should score big creatures as threats', () => {
    const big = cardToPermanent(makeCreature('Dragon', '{4}{R}', '6', '6', 1), 1, 1);
    const threat = evaluatePermanentThreat(big);
    expect(threat).not.toBeNull();
    expect(threat!.score).toBeGreaterThan(5);
    // 6/6 creature: 6*1.5 + 6*0.5 = 12 → critical threshold
    expect(threat!.level === 'high' || threat!.level === 'critical').toBe(true);
  });

  it('should score small creatures as low or null', () => {
    const small = cardToPermanent(makeCreature('Squirrel', '{G}', '1', '1', 1), 1, 1);
    const threat = evaluatePermanentThreat(small);
    // Small creatures may score below threshold
    if (threat) {
      expect(threat.level).toBe('low');
    }
  });

  it('should rate flying creatures higher', () => {
    const ground = cardToPermanent(
      makeCreature('Bear', '{1}{G}', '3', '3', 1), 1, 1,
    );
    const flyer = cardToPermanent(
      makeCreature('Angel', '{3}{W}', '3', '3', 1, { oracleText: 'Flying' }), 1, 1,
    );

    const groundThreat = evaluatePermanentThreat(ground);
    const flyerThreat = evaluatePermanentThreat(flyer);

    expect(flyerThreat!.score).toBeGreaterThan(groundThreat!.score);
  });

  it('should rate win-the-game permanents as critical', () => {
    const winCard = cardToPermanent(
      makeCreature('Felidar', '{3}{W}', '2', '2', 1, {
        oracleText: 'When Felidar enters the battlefield, you win the game.',
      }),
      1, 1,
    );
    const threat = evaluatePermanentThreat(winCard);
    expect(threat!.level).toBe('critical');
    expect(threat!.score).toBeGreaterThanOrEqual(12);
  });
});

describe('evaluateStackThreat', () => {
  it('should evaluate opponent spells on the stack', () => {
    const obj: StackObject = {
      id: 'stack-1',
      type: 'spell',
      controller: 1,
      targets: [],
      text: 'Destroy all creatures.',
      card: makeCreature('Wrath', '{2}{W}{W}', '0', '0', 1),
    };

    const threat = evaluateStackThreat(obj, 0);
    expect(threat).not.toBeNull();
    expect(threat!.score).toBeGreaterThan(10);
  });

  it('should ignore our own spells', () => {
    const obj: StackObject = {
      id: 'stack-1',
      type: 'spell',
      controller: 0,
      targets: [],
      text: 'Draw three cards.',
    };

    expect(evaluateStackThreat(obj, 0)).toBeNull();
  });
});

describe('identifyThreats', () => {
  it('should find all threats on opponent board', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Dragon', '{4}{R}', '5', '5', 1, { oracleText: 'Flying' }), 1);
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 1), 1);

    const threats = identifyThreats(state, 0);
    expect(threats.length).toBeGreaterThanOrEqual(1);
    // Dragon should be the top threat
    expect(threats[0].name).toBe('Dragon');
  });

  it('should return empty for empty board', () => {
    const state = createMainPhaseState();
    expect(identifyThreats(state, 0)).toHaveLength(0);
  });
});

describe('hasMustAnswerThreat', () => {
  it('should detect high-priority threats', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(
      state,
      makeCreature('Doom', '{5}', '8', '8', 1, {
        oracleText: 'Flying, double strike',
      }),
      1,
    );

    expect(hasMustAnswerThreat(state, 0)).toBe(true);
  });

  it('should return false with no threats', () => {
    const state = createMainPhaseState();
    expect(hasMustAnswerThreat(state, 0)).toBe(false);
  });
});

describe('getTopThreat', () => {
  it('should return the highest-score threat', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Small', '{G}', '1', '1', 1), 1);
    state = putOnBattlefield(state, makeCreature('Big', '{5}', '7', '7', 1, { oracleText: 'Flying, trample' }), 1);

    const top = getTopThreat(state, 0);
    expect(top).not.toBeNull();
    expect(top!.name).toBe('Big');
  });

  it('should return null with no threats', () => {
    const state = createMainPhaseState();
    expect(getTopThreat(state, 0)).toBeNull();
  });
});
