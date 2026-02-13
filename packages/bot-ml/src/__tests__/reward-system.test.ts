import { describe, it, expect, beforeEach } from 'vitest';
import { calculateReward, calculateRewardBreakdown } from '../rewards/reward-calculator.ts';
import {
  OUTCOME_REWARDS, RESOURCE_REWARDS, BOARD_REWARDS,
  COMBAT_REWARDS, MULLIGAN_REWARDS, DEFAULT_REWARD_CONFIG,
} from '../rewards/reward-config.ts';
import { getGamePhase, getTemporalScale, applyTemporalScaling } from '../rewards/temporal-scaling.ts';
import { ARCHETYPE_MODIFIERS, getArchetypeModifier, getModifier } from '../rewards/archetype-modifiers.ts';
import { resetIds, createMainPhaseState, putOnBattlefield, makeCreature, addToHand, makeLand, setMana, passAction } from './test-helpers.ts';

beforeEach(() => resetIds());

describe('RewardConfig', () => {
  it('should have positive base win reward', () => {
    expect(OUTCOME_REWARDS.baseWin).toBe(100);
  });

  it('should have negative base loss reward', () => {
    expect(OUTCOME_REWARDS.baseLoss).toBe(-100);
  });

  it('should have penalty scale less than 1', () => {
    expect(DEFAULT_REWARD_CONFIG.penaltyScale).toBeLessThan(1);
    expect(DEFAULT_REWARD_CONFIG.penaltyScale).toBeGreaterThan(0);
  });

  it('should have scale factor for neural network', () => {
    expect(DEFAULT_REWARD_CONFIG.scaleFactor).toBe(0.1);
  });
});

describe('Temporal Scaling', () => {
  it('should classify turns 1-4 as early', () => {
    expect(getGamePhase(1)).toBe('early');
    expect(getGamePhase(4)).toBe('early');
  });

  it('should classify turns 5-8 as mid', () => {
    expect(getGamePhase(5)).toBe('mid');
    expect(getGamePhase(8)).toBe('mid');
  });

  it('should classify turns 9+ as late', () => {
    expect(getGamePhase(9)).toBe('late');
    expect(getGamePhase(15)).toBe('late');
  });

  it('should scale ramp higher in early game', () => {
    const earlyRamp = getTemporalScale(2, 'ramp');
    const lateRamp = getTemporalScale(10, 'ramp');
    expect(earlyRamp).toBeGreaterThan(lateRamp);
  });

  it('should scale win conditions higher in late game', () => {
    const earlyWin = getTemporalScale(2, 'winConditions');
    const lateWin = getTemporalScale(10, 'winConditions');
    expect(lateWin).toBeGreaterThan(earlyWin);
  });

  it('should scale interaction higher in late game', () => {
    const earlyInteraction = getTemporalScale(2, 'interaction');
    const lateInteraction = getTemporalScale(10, 'interaction');
    expect(lateInteraction).toBeGreaterThan(earlyInteraction);
  });

  it('should apply temporal scaling to raw reward', () => {
    const raw = 5;
    const scaled = applyTemporalScaling(raw, 2, 'ramp');
    // Early ramp is 1.5x
    expect(scaled).toBe(7.5);
  });
});

describe('Archetype Modifiers', () => {
  it('should have all 6 archetypes', () => {
    expect(Object.keys(ARCHETYPE_MODIFIERS)).toHaveLength(6);
  });

  it('should have midrange as balanced (all 1.0)', () => {
    const mod = getArchetypeModifier('midrange');
    for (const val of Object.values(mod)) {
      expect(val).toBe(1.0);
    }
  });

  it('should boost combo progress for combo archetype', () => {
    const comboProg = getModifier('combo', 'comboProgress');
    const midProg = getModifier('midrange', 'comboProgress');
    expect(comboProg).toBeGreaterThan(midProg);
  });

  it('should boost combat damage for aggro', () => {
    const aggroDmg = getModifier('aggro', 'combatDamage');
    expect(aggroDmg).toBe(1.5);
  });

  it('should boost reanimation for reanimator', () => {
    const reanimate = getModifier('reanimator', 'reanimation');
    expect(reanimate).toBe(2.0);
  });

  it('should default to midrange when undefined', () => {
    const mod = getArchetypeModifier(undefined);
    expect(mod.combatDamage).toBe(1.0);
  });
});

describe('calculateReward', () => {
  it('should return a number', () => {
    const state = createMainPhaseState();
    const action = passAction(0);
    const reward = calculateReward(state, action, state, 0);
    expect(typeof reward).toBe('number');
  });

  it('should give positive reward for winning', () => {
    const state = createMainPhaseState();
    const action = passAction(0);
    const nextState = {
      ...state,
      gameOver: true,
      winner: 0 as 0 | 1,
    };
    const reward = calculateReward(state, action, nextState, 0);
    expect(reward).toBeGreaterThan(0);
  });

  it('should give negative reward for losing', () => {
    const state = createMainPhaseState();
    const action = passAction(0);
    const nextState = {
      ...state,
      gameOver: true,
      winner: 1 as 0 | 1,
    };
    const reward = calculateReward(state, action, nextState, 0);
    expect(reward).toBeLessThan(0);
  });

  it('should give fast win bonus for turn <= 7', () => {
    let state = createMainPhaseState();
    state = { ...state, turn: 5 };
    const action = passAction(0);
    const nextState = { ...state, gameOver: true, winner: 0 as 0 | 1 };

    const breakdown = calculateRewardBreakdown(state, action, nextState, 0);
    expect(breakdown.outcome).toBeGreaterThan(OUTCOME_REWARDS.baseWin);
  });

  it('should penalize missed lethal', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(state, makeCreature('Big', '{3}{R}', '20', '20', 0), 0, 1);
    state = {
      ...state,
      activePlayer: 0,
      priorityPlayer: 0,
      phase: 'combat',
      step: 'declare-attackers',
      players: [
        state.players[0],
        { ...state.players[1], life: 5 },
      ] as [typeof state.players[0], typeof state.players[1]],
    };

    const action = passAction(0);
    const breakdown = calculateRewardBreakdown(state, action, state, 0);
    expect(breakdown.misplay).toBeLessThan(0);
  });

  it('should give comeback win bonus', () => {
    let state = createMainPhaseState();
    state = {
      ...state,
      players: [
        { ...state.players[0], life: 5 },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    const action = passAction(0);
    const nextState = { ...state, gameOver: true, winner: 0 as 0 | 1 };

    const breakdown = calculateRewardBreakdown(state, action, nextState, 0);
    expect(breakdown.outcome).toBeGreaterThanOrEqual(
      OUTCOME_REWARDS.baseWin + OUTCOME_REWARDS.comebackWinBonus
    );
  });
});

describe('calculateRewardBreakdown', () => {
  it('should return all reward components', () => {
    const state = createMainPhaseState();
    const action = passAction(0);
    const breakdown = calculateRewardBreakdown(state, action, state, 0);

    expect(typeof breakdown.outcome).toBe('number');
    expect(typeof breakdown.resources).toBe('number');
    expect(typeof breakdown.board).toBe('number');
    expect(typeof breakdown.combat).toBe('number');
    expect(typeof breakdown.combo).toBe('number');
    expect(typeof breakdown.commander).toBe('number');
    expect(typeof breakdown.mulligan).toBe('number');
    expect(typeof breakdown.misplay).toBe('number');
    expect(typeof breakdown.raw).toBe('number');
    expect(typeof breakdown.scaled).toBe('number');
  });

  it('should scale output by scaleFactor', () => {
    const state = createMainPhaseState();
    const action = passAction(0);
    const breakdown = calculateRewardBreakdown(state, action, state, 0);

    // For non-terminal, scaled = clamp(raw) * 0.1
    if (breakdown.outcome === 0) {
      const clamped = Math.max(-20, Math.min(30, breakdown.raw));
      expect(breakdown.scaled).toBeCloseTo(clamped * 0.1, 5);
    }
  });
});
