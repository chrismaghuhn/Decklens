import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkStateBasedActions,
  checkCommanderDamageLoss,
  checkEmptyLibraryLoss,
} from '../rules/state-based.ts';
import { createPlayerState, emptyManaPool } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import { cardToPermanent } from '../types/permanent.ts';
import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';

function createTestState(): GameState {
  resetIdCounter();
  const deck1 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
  );
  const cmdr1 = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0);
  const deck2 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1)
  );
  const cmdr2 = createSimpleCard('Cmdr B', 'Legendary Creature', '{3}', 1);

  const p1 = createPlayerState(0, 'Player', deck1, cmdr1);
  const p2 = createPlayerState(1, 'Bot', deck2, cmdr2);

  return {
    ...createInitialGameState(p1, p2),
    phase: 'precombat-main',
    step: 'main',
    mulliganPhase: false,
  };
}

beforeEach(() => {
  resetIdCounter();
});

describe('checkStateBasedActions', () => {
  it('should not change state when nothing to do', () => {
    const state = createTestState();
    const result = checkStateBasedActions(state);
    expect(result.gameOver).toBe(false);
    expect(result.players[0].battlefield.length).toBe(0);
  });

  it('should kill player with 0 life', () => {
    const state = createTestState();
    const stateWithDead: GameState = {
      ...state,
      players: [
        { ...state.players[0], life: 0 },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithDead);
    expect(result.gameOver).toBe(true);
    expect(result.winner).toBe(1);
  });

  it('should kill player with negative life', () => {
    const state = createTestState();
    const stateWithDead: GameState = {
      ...state,
      players: [
        { ...state.players[0], life: -5 },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithDead);
    expect(result.gameOver).toBe(true);
    expect(result.winner).toBe(1);
  });

  it('should destroy creature with lethal damage', () => {
    const state = createTestState();
    const creature = cardToPermanent(
      createSimpleCard('Bear', 'Creature — Bear', '{1}{G}', 0, {
        power: '2', toughness: '2',
      }),
      0,
      1
    );
    creature.damage = 2; // Lethal: 2 damage >= 2 toughness

    const stateWithDamaged: GameState = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [creature] },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithDamaged);
    expect(result.players[0].battlefield.length).toBe(0);
    expect(result.players[0].graveyard.length).toBe(1);
    expect(result.players[0].graveyard[0].name).toBe('Bear');
  });

  it('should not destroy creature with non-lethal damage', () => {
    const state = createTestState();
    const creature = cardToPermanent(
      createSimpleCard('Bear', 'Creature — Bear', '{1}{G}', 0, {
        power: '2', toughness: '2',
      }),
      0,
      1
    );
    creature.damage = 1; // Non-lethal: 1 damage < 2 toughness

    const stateWithDamaged: GameState = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [creature] },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithDamaged);
    expect(result.players[0].battlefield.length).toBe(1);
  });

  it('should destroy creature with 0 toughness', () => {
    const state = createTestState();
    const creature = cardToPermanent(
      createSimpleCard('Tiny', 'Creature', '{0}', 0, {
        power: '0', toughness: '0',
      }),
      0,
      1
    );

    const stateWithZero: GameState = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [creature] },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithZero);
    expect(result.players[0].battlefield.length).toBe(0);
    expect(result.players[0].graveyard.length).toBe(1);
  });

  it('should destroy planeswalker with 0 loyalty', () => {
    const state = createTestState();
    const pw = cardToPermanent(
      createSimpleCard('Jace', 'Planeswalker — Jace', '{2}{U}{U}', 0, {
        loyalty: '0',
        colors: ['U'],
      }),
      0,
      1
    );

    const stateWithPW: GameState = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [pw] },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithPW);
    expect(result.players[0].battlefield.length).toBe(0);
    expect(result.players[0].graveyard.length).toBe(1);
    expect(result.players[0].graveyard[0].name).toBe('Jace');
  });

  it('should enforce legend rule (keep newest)', () => {
    const state = createTestState();

    const legend1 = cardToPermanent(
      createSimpleCard('Thalia', 'Legendary Creature — Human Soldier', '{1}{W}', 0, {
        power: '2', toughness: '1', colors: ['W'],
      }),
      0,
      1
    );
    const legend2 = cardToPermanent(
      createSimpleCard('Thalia', 'Legendary Creature — Human Soldier', '{1}{W}', 0, {
        power: '2', toughness: '1', colors: ['W'],
      }),
      0,
      3 // Newer — entered on turn 3
    );

    const stateWithDupes: GameState = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [legend1, legend2] },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithDupes);
    expect(result.players[0].battlefield.length).toBe(1);
    // Newest (turn 3) should survive
    expect(result.players[0].battlefield[0].enteredBattlefieldTurn).toBe(3);
    expect(result.players[0].graveyard.length).toBe(1);
  });

  it('should not apply legend rule to non-legendary permanents', () => {
    const state = createTestState();
    const creature1 = cardToPermanent(
      createSimpleCard('Elf', 'Creature — Elf', '{G}', 0, {
        power: '1', toughness: '1',
      }),
      0,
      1
    );
    const creature2 = cardToPermanent(
      createSimpleCard('Elf', 'Creature — Elf', '{G}', 0, {
        power: '1', toughness: '1',
      }),
      0,
      2
    );

    const stateWithDupes: GameState = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [creature1, creature2] },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithDupes);
    expect(result.players[0].battlefield.length).toBe(2);
  });

  it('should kill player with 10 poison counters', () => {
    const state = createTestState();
    const stateWithPoison: GameState = {
      ...state,
      players: [
        { ...state.players[0], poisonCounters: 10 },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithPoison);
    expect(result.gameOver).toBe(true);
    expect(result.winner).toBe(1);
  });

  it('should handle multiple SBAs in one pass', () => {
    const state = createTestState();
    // Player at 0 life AND has a damaged creature
    const creature = cardToPermanent(
      createSimpleCard('Bear', 'Creature', '{1}{G}', 0, { power: '2', toughness: '2' }),
      0,
      1
    );
    creature.damage = 5;

    const stateWithMultiple: GameState = {
      ...state,
      players: [
        { ...state.players[0], life: 0, battlefield: [creature] },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkStateBasedActions(stateWithMultiple);
    expect(result.gameOver).toBe(true);
    expect(result.winner).toBe(1);
  });
});

describe('checkCommanderDamageLoss', () => {
  it('should kill player with 21 commander damage from one source', () => {
    const state = createTestState();
    const stateWithCmdDmg: GameState = {
      ...state,
      players: [
        state.players[0],
        { ...state.players[1], commanderDamage: { 'cmd-1': 21 } },
      ] as [PlayerState, PlayerState],
    };

    const result = checkCommanderDamageLoss(stateWithCmdDmg);
    expect(result.changed).toBe(true);
    expect(result.state.gameOver).toBe(true);
    expect(result.state.winner).toBe(0);
  });

  it('should not kill with less than 21 commander damage', () => {
    const state = createTestState();
    const stateWithCmdDmg: GameState = {
      ...state,
      players: [
        state.players[0],
        { ...state.players[1], commanderDamage: { 'cmd-1': 20 } },
      ] as [PlayerState, PlayerState],
    };

    const result = checkCommanderDamageLoss(stateWithCmdDmg);
    expect(result.changed).toBe(false);
  });

  it('should not kill if damage is split across commanders', () => {
    const state = createTestState();
    const stateWithSplit: GameState = {
      ...state,
      players: [
        state.players[0],
        { ...state.players[1], commanderDamage: { 'cmd-1': 15, 'cmd-2': 15 } },
      ] as [PlayerState, PlayerState],
    };

    const result = checkCommanderDamageLoss(stateWithSplit);
    expect(result.changed).toBe(false);
  });
});

describe('checkEmptyLibraryLoss', () => {
  it('should kill player who drew from empty library', () => {
    const state = createTestState();
    const stateWithEmpty: GameState = {
      ...state,
      players: [
        { ...state.players[0], library: [], hasDrawnThisGame: true },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = checkEmptyLibraryLoss(stateWithEmpty, 0);
    expect(result.changed).toBe(true);
    expect(result.state.gameOver).toBe(true);
    expect(result.state.winner).toBe(1);
  });

  it('should not kill player with cards in library', () => {
    const state = createTestState();
    const result = checkEmptyLibraryLoss(state, 0);
    expect(result.changed).toBe(false);
  });
});
