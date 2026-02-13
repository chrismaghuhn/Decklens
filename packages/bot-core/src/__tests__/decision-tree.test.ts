import { describe, it, expect, beforeEach } from 'vitest';
import { makeDecision } from '../decision-tree.ts';
import { HeuristicBot } from '../bot.ts';
import {
  resetIds, makeCreature, makeInstant, makeLand, makeSorcery,
  createMainPhaseState, putOnBattlefield, addToHand, setMana,
} from './test-helpers.ts';

beforeEach(() => resetIds());

describe('makeDecision — mulligan phase', () => {
  it('should return a mulligan action during mulligan phase', () => {
    let state = createMainPhaseState();
    state = { ...state, mulliganPhase: true, mulliganCount: [0, 0] };

    const decision = makeDecision(state, 1);
    expect(decision.action.type).toBe('mulligan');
    expect(decision.reason).toContain('Mulligan');
  });
});

describe('makeDecision — main phase', () => {
  it('should play a land if available', () => {
    let state = createMainPhaseState();
    const land = makeLand('Forest', 0);
    state = addToHand(state, land, 0);

    const decision = makeDecision(state, 0);
    expect(decision.action.type).toBe('play-land');
  });

  it('should cast a spell if mana available', () => {
    let state = createMainPhaseState();
    // Clear hand and add specific spell
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [] },
        state.players[1],
      ],
    };
    const creature = makeCreature('Ramp Elf', '{G}', '1', '1', 0, { tags: ['ramp'] });
    state = addToHand(state, creature, 0);
    state = setMana(state, 0, { G: 2 });

    const decision = makeDecision(state, 0);
    expect(decision.action.type).toBe('cast-spell');
  });

  it('should pass when nothing to do', () => {
    let state = createMainPhaseState();
    // Clear hand
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [] },
        state.players[1],
      ],
    };

    const decision = makeDecision(state, 0);
    expect(decision.action.type).toBe('pass');
  });
});

describe('makeDecision — combat', () => {
  it('should declare attackers during declare-attackers step', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '2', '2', 0), 0, 1);
    state = {
      ...state,
      activePlayer: 0,
      priorityPlayer: 0,
      phase: 'combat',
      step: 'declare-attackers',
    };

    const decision = makeDecision(state, 0);
    expect(decision.action.type).toBe('declare-attackers');
  });

  it('should declare blockers during declare-blockers step', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Blocker', '{1}{G}', '2', '2', 0), 0, 1);
    state = putOnBattlefield(state, makeCreature('Attacker', '{1}{R}', '3', '3', 1), 1, 1);

    const attacker = state.players[1].battlefield[0];
    state = {
      ...state,
      activePlayer: 1,
      priorityPlayer: 0,
      phase: 'combat',
      step: 'declare-blockers',
      combat: {
        attackers: [{ permanentId: attacker.id, defenderId: 0 }],
        blockers: [],
        currentStep: 'declare-blockers',
      },
    };

    const decision = makeDecision(state, 0);
    expect(decision.action.type).toBe('declare-blockers');
  });
});

describe('makeDecision — lethal detection', () => {
  it('should alpha strike when lethal and no blockers', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Big', '{3}{R}', '5', '5', 0), 0, 1);
    state = {
      ...state,
      activePlayer: 0,
      priorityPlayer: 0,
      phase: 'combat',
      step: 'declare-attackers',
      players: [
        state.players[0],
        { ...state.players[1], life: 4 },
      ],
    };

    const decision = makeDecision(state, 0);
    expect(decision.action.type).toBe('declare-attackers');
    expect(decision.confidence).toBeGreaterThanOrEqual(0.9);
    expect(decision.reason).toContain('Lethal');
  });
});

describe('HeuristicBot', () => {
  it('should be constructed with a player ID', () => {
    const bot = new HeuristicBot(1);
    expect(bot.player).toBe(1);
  });

  it('should choose an action', () => {
    const bot = new HeuristicBot(0);
    const state = createMainPhaseState();
    const action = bot.chooseAction(state);
    expect(action).toBeDefined();
    expect(action.player).toBe(0);
  });

  it('should provide reasoning with chooseActionWithReason', () => {
    const bot = new HeuristicBot(0);
    const state = createMainPhaseState();
    const decision = bot.chooseActionWithReason(state);
    expect(decision.reason).toBeDefined();
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it('should track decision history', () => {
    const bot = new HeuristicBot(0);
    const state = createMainPhaseState();

    bot.chooseAction(state);
    bot.chooseAction(state);

    const history = bot.getDecisionHistory();
    expect(history).toHaveLength(2);
  });

  it('should evaluate position', () => {
    const bot = new HeuristicBot(0);
    const state = createMainPhaseState();
    const eval_ = bot.evaluatePosition(state);

    expect(typeof eval_.boardAdvantage).toBe('number');
    expect(typeof eval_.threats).toBe('number');
    expect(typeof eval_.combosReady).toBe('number');
  });

  it('should reset history', () => {
    const bot = new HeuristicBot(0);
    const state = createMainPhaseState();

    bot.chooseAction(state);
    expect(bot.getDecisionHistory()).toHaveLength(1);

    bot.resetHistory();
    expect(bot.getDecisionHistory()).toHaveLength(0);
  });
});
