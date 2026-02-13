import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveCombatDamage,
  endCombat,
  hasFirstStrikeCombatants,
  getEligibleAttackers,
  getEligibleBlockers,
} from '../rules/combat.ts';
import { createPlayerState, emptyManaPool } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import { cardToPermanent } from '../types/permanent.ts';
import type { GameState } from '../types/game-state.ts';
import type { CombatState } from '../types/action.ts';
import type { Permanent } from '../types/permanent.ts';

function createCombatState(): GameState {
  resetIdCounter();
  const deck1 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
  );
  const cmdr1 = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0, {
    power: '3', toughness: '3',
  });
  const deck2 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1)
  );
  const cmdr2 = createSimpleCard('Cmdr B', 'Legendary Creature', '{3}', 1, {
    power: '2', toughness: '2',
  });

  const p1 = createPlayerState(0, 'Player', deck1, cmdr1);
  const p2 = createPlayerState(1, 'Bot', deck2, cmdr2);

  let state = createInitialGameState(p1, p2);

  // Put some creatures on the battlefield
  const attacker = cardToPermanent(
    createSimpleCard('Bear', 'Creature — Bear', '{1}{G}', 0, {
      power: '2', toughness: '2', colors: ['G'],
    }),
    0,
    1
  );
  attacker.summoningSick = false;

  const blocker = cardToPermanent(
    createSimpleCard('Wall', 'Creature — Wall', '{1}{W}', 1, {
      power: '0', toughness: '4', colors: ['W'],
    }),
    1,
    1
  );
  blocker.summoningSick = false;

  state = {
    ...state,
    phase: 'combat',
    step: 'combat-damage',
    mulliganPhase: false,
    players: [
      { ...state.players[0], battlefield: [attacker] },
      { ...state.players[1], battlefield: [blocker] },
    ] as [typeof state.players[0], typeof state.players[1]],
  };

  return state;
}

beforeEach(() => {
  resetIdCounter();
});

describe('resolveCombatDamage', () => {
  it('should deal damage to defending player for unblocked attackers', () => {
    const state = createCombatState();
    const attackerId = state.players[0].battlefield[0].id;

    const combat: CombatState = {
      attackers: [{ permanentId: attackerId, defenderId: 1 }],
      blockers: [],
      currentStep: 'damage',
    };

    const stateWithCombat = { ...state, combat };
    const result = resolveCombatDamage(stateWithCombat);

    // Bear has 2 power, so defender should take 2 damage
    expect(result.state.players[1].life).toBe(38);
  });

  it('should assign damage between attacker and blocker', () => {
    const state = createCombatState();
    const attackerId = state.players[0].battlefield[0].id;
    const blockerId = state.players[1].battlefield[0].id;

    const combat: CombatState = {
      attackers: [{ permanentId: attackerId, defenderId: 1 }],
      blockers: [{ permanentId: blockerId, blockingId: attackerId }],
      currentStep: 'damage',
    };

    const stateWithCombat = { ...state, combat };
    const result = resolveCombatDamage(stateWithCombat);

    // Defender life shouldn't change (attacker was blocked)
    expect(result.state.players[1].life).toBe(40);

    // Bear (2/2) deals 2 damage to Wall (0/4)
    const wall = result.state.players[1].battlefield.find((p) => p.name === 'Wall');
    expect(wall).toBeDefined();
    expect(wall!.damage).toBe(2);

    // Wall (0/4) deals 0 damage to Bear (2/2)
    const bear = result.state.players[0].battlefield.find((p) => p.name === 'Bear');
    expect(bear).toBeDefined();
    expect(bear!.damage).toBe(0);
  });

  it('should handle no combat state', () => {
    const state = createCombatState();
    const noCombat = { ...state, combat: null };
    const result = resolveCombatDamage(noCombat);
    expect(result.state.players[1].life).toBe(40);
  });

  it('should track commander damage for unblocked commander', () => {
    const state = createCombatState();
    // Replace bear with a "Legendary Creature" that the player owns
    const commander = cardToPermanent(
      createSimpleCard('Test Commander', 'Legendary Creature', '{3}', 0, {
        power: '5', toughness: '5',
      }),
      0,
      1
    );
    commander.summoningSick = false;

    // Empty the command zone so the heuristic recognizes the commander
    const stateWithCommander: GameState = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [commander], commandZone: [] },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
      combat: {
        attackers: [{ permanentId: commander.id, defenderId: 1 }],
        blockers: [],
        currentStep: 'damage',
      },
    };

    const result = resolveCombatDamage(stateWithCommander);
    expect(result.commanderDamageDealt.length).toBe(1);
    expect(result.commanderDamageDealt[0].damage).toBe(5);
    expect(result.commanderDamageDealt[0].defenderId).toBe(1);
  });

  it('should handle trample damage', () => {
    const state = createCombatState();
    // Replace bear with a trample creature
    const trampler = cardToPermanent(
      createSimpleCard('Trampler', 'Creature', '{3}{G}', 0, {
        power: '6', toughness: '6', colors: ['G'],
      }),
      0,
      1
    );
    trampler.summoningSick = false;
    // Add trample keyword to oracle text
    (trampler as any).oracleText = 'Trample';

    const blockerId = state.players[1].battlefield[0].id;

    const stateWithTrample: GameState = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [trampler] },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
      combat: {
        attackers: [{ permanentId: trampler.id, defenderId: 1 }],
        blockers: [{ permanentId: blockerId, blockingId: trampler.id }],
        currentStep: 'damage',
      },
    };

    const result = resolveCombatDamage(stateWithTrample);

    // Wall (0/4) has 4 toughness, so trampler assigns 4 to it, 2 tramples through
    expect(result.state.players[1].life).toBe(38);
    const wall = result.state.players[1].battlefield.find((p) => p.name === 'Wall');
    expect(wall!.damage).toBe(4);
  });
});

describe('endCombat', () => {
  it('should clear combat state and reset attacking/blocking flags', () => {
    const state = createCombatState();
    const attackerId = state.players[0].battlefield[0].id;

    // Mark creature as attacking
    const stateWithAttacker: GameState = {
      ...state,
      players: [
        {
          ...state.players[0],
          battlefield: state.players[0].battlefield.map((p) => ({
            ...p, attacking: true,
          })),
        },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
      combat: {
        attackers: [{ permanentId: attackerId, defenderId: 1 }],
        blockers: [],
        currentStep: 'end',
      },
    };

    const result = endCombat(stateWithAttacker);
    expect(result.combat).toBeNull();
    expect(result.players[0].battlefield[0].attacking).toBe(false);
  });
});

describe('hasFirstStrikeCombatants', () => {
  it('should return false when no first strike creatures', () => {
    const state = createCombatState();
    const attackerId = state.players[0].battlefield[0].id;
    const stateWithCombat = {
      ...state,
      combat: {
        attackers: [{ permanentId: attackerId, defenderId: 1 as const }],
        blockers: [],
        currentStep: 'damage' as const,
      },
    };
    expect(hasFirstStrikeCombatants(stateWithCombat)).toBe(false);
  });

  it('should return true when attacker has first strike', () => {
    const state = createCombatState();
    const fsCreature = cardToPermanent(
      createSimpleCard('Knight', 'Creature — Knight', '{1}{W}', 0, {
        power: '2', toughness: '2', colors: ['W'],
      }),
      0,
      1
    );
    fsCreature.summoningSick = false;
    (fsCreature as any).oracleText = 'First strike';

    const stateWithFS: GameState = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [fsCreature] },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
      combat: {
        attackers: [{ permanentId: fsCreature.id, defenderId: 1 }],
        blockers: [],
        currentStep: 'first-strike-damage',
      },
    };

    expect(hasFirstStrikeCombatants(stateWithFS)).toBe(true);
  });
});

describe('getEligibleAttackers', () => {
  it('should return untapped non-summoning-sick creatures', () => {
    const state = createCombatState();
    const eligible = getEligibleAttackers(state);
    expect(eligible.length).toBe(1);
    expect(eligible[0].name).toBe('Bear');
  });

  it('should exclude tapped creatures', () => {
    const state = createCombatState();
    const stateWithTapped: GameState = {
      ...state,
      players: [
        {
          ...state.players[0],
          battlefield: state.players[0].battlefield.map((p) => ({
            ...p, tapped: true,
          })),
        },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };

    const eligible = getEligibleAttackers(stateWithTapped);
    expect(eligible.length).toBe(0);
  });

  it('should exclude summoning sick creatures', () => {
    const state = createCombatState();
    const stateWithSick: GameState = {
      ...state,
      players: [
        {
          ...state.players[0],
          battlefield: state.players[0].battlefield.map((p) => ({
            ...p, summoningSick: true,
          })),
        },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };

    const eligible = getEligibleAttackers(stateWithSick);
    expect(eligible.length).toBe(0);
  });
});

describe('getEligibleBlockers', () => {
  it('should return untapped creatures for defending player', () => {
    const state = createCombatState();
    const eligible = getEligibleBlockers(state);
    expect(eligible.length).toBe(1);
    expect(eligible[0].name).toBe('Wall');
  });

  it('should exclude tapped creatures', () => {
    const state = createCombatState();
    const stateWithTapped: GameState = {
      ...state,
      players: [
        state.players[0],
        {
          ...state.players[1],
          battlefield: state.players[1].battlefield.map((p) => ({
            ...p, tapped: true,
          })),
        },
      ] as [typeof state.players[0], typeof state.players[1]],
    };

    const eligible = getEligibleBlockers(stateWithTapped);
    expect(eligible.length).toBe(0);
  });
});
