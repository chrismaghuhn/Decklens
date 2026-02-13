import { describe, it, expect, beforeEach } from 'vitest';
import { chooseAttackers, chooseBlockers, shouldAttack } from '../policies/combat-policy.ts';
import { initializeCombat } from '@mtg/game-engine';
import {
  resetIds, makeCreature, createMainPhaseState, putOnBattlefield,
} from './test-helpers.ts';

beforeEach(() => resetIds());

describe('shouldAttack', () => {
  it('should not attack with no creatures', () => {
    const state = createMainPhaseState();
    expect(shouldAttack(state, 0)).toBe(false);
  });

  it('should attack when opponent has no blockers', () => {
    let state = createMainPhaseState();
    const creature = makeCreature('Bear', '{1}{G}', '2', '2', 0);
    state = putOnBattlefield(state, creature, 0, 1); // Entered turn 1, not summoning sick at turn 3

    expect(shouldAttack(state, 0)).toBe(true);
  });

  it('should attack with evasive creatures', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(
      state,
      makeCreature('Bird', '{1}{W}', '1', '1', 0, { oracleText: 'Flying' }),
      0, 1,
    );
    // Give opponent a ground blocker
    state = putOnBattlefield(state, makeCreature('Wall', '{1}', '0', '4', 1), 1, 1);

    expect(shouldAttack(state, 0)).toBe(true);
  });
});

describe('chooseAttackers', () => {
  it('should return declare-attackers action', () => {
    let state = createMainPhaseState();
    state = putOnBattlefield(
      state,
      makeCreature('Bear', '{1}{G}', '2', '2', 0),
      0, 1,
    );

    const action = chooseAttackers(state, 0);
    expect(action.type).toBe('declare-attackers');
  });

  it('should alpha strike when lethal', () => {
    let state = createMainPhaseState();
    // Set opponent to 5 life
    state = {
      ...state,
      players: [
        state.players[0],
        { ...state.players[1], life: 5 },
      ],
    };
    // Give us creatures with 6 total power
    state = putOnBattlefield(state, makeCreature('Bear', '{1}{G}', '3', '3', 0), 0, 1);
    state = putOnBattlefield(state, makeCreature('Elf', '{G}', '3', '3', 0), 0, 1);

    const action = chooseAttackers(state, 0);
    expect(action.type).toBe('declare-attackers');
    if (action.type === 'declare-attackers') {
      // Should attack with all creatures for lethal
      expect(action.attackers.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('should not attack with summoning-sick creatures', () => {
    let state = createMainPhaseState();
    // Creature entered this turn (summoning sick)
    const creature = makeCreature('Bear', '{1}{G}', '2', '2', 0);
    state = putOnBattlefield(state, creature, 0, state.turn);

    const action = chooseAttackers(state, 0);
    if (action.type === 'declare-attackers') {
      // Summoning sick creature (entered same turn) won't be in the list
      const sickPerm = state.players[0].battlefield.find(
        (p) => p.summoningSick
      );
      if (sickPerm) {
        expect(action.attackers).not.toContain(sickPerm.id);
      }
    }
  });
});

describe('chooseBlockers', () => {
  it('should return declare-blockers action', () => {
    let state = createMainPhaseState();
    // Set up combat with opponent attacking
    state = putOnBattlefield(state, makeCreature('Opp Bear', '{1}{G}', '2', '2', 1), 1, 1);
    state = putOnBattlefield(state, makeCreature('My Bear', '{1}{G}', '2', '2', 0), 0, 1);

    // Initialize combat
    const oppCreature = state.players[1].battlefield[0];
    state = {
      ...state,
      combat: {
        attackers: [{ permanentId: oppCreature.id, defenderId: 0 }],
        blockers: [],
        currentStep: 'declare-blockers',
      },
    };

    const action = chooseBlockers(state, 0);
    expect(action.type).toBe('declare-blockers');
  });

  it('should block lethal damage', () => {
    let state = createMainPhaseState();
    // Set our life very low
    state = {
      ...state,
      players: [
        { ...state.players[0], life: 3 },
        state.players[1],
      ],
    };

    // Opponent attacks with a 5/5
    state = putOnBattlefield(state, makeCreature('Big', '{4}{G}', '5', '5', 1), 1, 1);
    state = putOnBattlefield(state, makeCreature('Blocker', '{1}{G}', '2', '3', 0), 0, 1);

    const oppCreature = state.players[1].battlefield[0];
    state = {
      ...state,
      combat: {
        attackers: [{ permanentId: oppCreature.id, defenderId: 0 }],
        blockers: [],
        currentStep: 'declare-blockers',
      },
    };

    const action = chooseBlockers(state, 0);
    if (action.type === 'declare-blockers') {
      // Should block the lethal attacker
      expect(action.blocks.length).toBeGreaterThanOrEqual(1);
    }
  });
});
