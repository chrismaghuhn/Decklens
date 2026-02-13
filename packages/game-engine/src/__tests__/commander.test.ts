import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCommanderCost,
  trackCommanderDamage,
  handleCommanderDeath,
  handleCommanderExile,
  takeCommanderFromCommandZone,
  validateColorIdentity,
  cardFitsColorIdentity,
  processCommanderZoneReplacements,
} from '../rules/commander.ts';
import { createPlayerState, emptyManaPool } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Card, Color } from '../types/card.ts';

function createTestState(): GameState {
  resetIdCounter();
  const deck1 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
  );
  const cmdr1 = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0, {
    colors: ['G'],
    colorIdentity: ['G'],
  });
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

describe('getCommanderCost', () => {
  it('should return base cost with 0 tax', () => {
    const cmdr = createSimpleCard('Cmdr', 'Legendary Creature', '{2}{G}', 0);
    const cost = getCommanderCost(cmdr, 0);
    expect(cost.generic).toBe(2);
    expect(cost.G).toBe(1);
  });

  it('should add {2} per tax', () => {
    const cmdr = createSimpleCard('Cmdr', 'Legendary Creature', '{2}{G}', 0);
    const cost1 = getCommanderCost(cmdr, 1);
    expect(cost1.generic).toBe(4); // 2 + 2

    const cost2 = getCommanderCost(cmdr, 2);
    expect(cost2.generic).toBe(6); // 2 + 4

    const cost3 = getCommanderCost(cmdr, 3);
    expect(cost3.generic).toBe(8); // 2 + 6
  });

  it('should preserve colored mana requirements', () => {
    const cmdr = createSimpleCard('Cmdr', 'Legendary Creature', '{1}{W}{U}', 0);
    const cost = getCommanderCost(cmdr, 2);
    expect(cost.W).toBe(1);
    expect(cost.U).toBe(1);
    expect(cost.generic).toBe(5); // 1 + 4
  });
});

describe('trackCommanderDamage', () => {
  it('should track damage from a commander', () => {
    const state = createTestState();
    const result = trackCommanderDamage(state, 'cmd-1', 5, 1);
    expect(result.players[1].commanderDamage['cmd-1']).toBe(5);
  });

  it('should accumulate damage', () => {
    const state = createTestState();
    let result = trackCommanderDamage(state, 'cmd-1', 5, 1);
    result = trackCommanderDamage(result, 'cmd-1', 3, 1);
    expect(result.players[1].commanderDamage['cmd-1']).toBe(8);
  });

  it('should track damage from different commanders separately', () => {
    const state = createTestState();
    let result = trackCommanderDamage(state, 'cmd-1', 10, 1);
    result = trackCommanderDamage(result, 'cmd-2', 15, 1);
    expect(result.players[1].commanderDamage['cmd-1']).toBe(10);
    expect(result.players[1].commanderDamage['cmd-2']).toBe(15);
  });

  it('should not change state for 0 damage', () => {
    const state = createTestState();
    const result = trackCommanderDamage(state, 'cmd-1', 0, 1);
    expect(result).toBe(state);
  });
});

describe('handleCommanderDeath', () => {
  it('should move commander from graveyard to command zone', () => {
    const state = createTestState();
    const cmdr = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0);

    // Simulate commander dying — it's in graveyard
    const stateWithDeadCmdr: GameState = {
      ...state,
      players: [
        {
          ...state.players[0],
          graveyard: [cmdr],
          commandZone: [], // Empty because it left
        },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = handleCommanderDeath(stateWithDeadCmdr, 'Cmdr A', 0);
    expect(result.players[0].graveyard.length).toBe(0);
    expect(result.players[0].commandZone.length).toBe(1);
    expect(result.players[0].commandZone[0].name).toBe('Cmdr A');
    expect(result.players[0].commanderTax).toBe(1);
  });

  it('should increment commander tax', () => {
    const state = createTestState();
    const cmdr = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0);

    const stateWithTax: GameState = {
      ...state,
      players: [
        {
          ...state.players[0],
          graveyard: [cmdr],
          commandZone: [],
          commanderTax: 2, // Already cast twice
        },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = handleCommanderDeath(stateWithTax, 'Cmdr A', 0);
    expect(result.players[0].commanderTax).toBe(3);
  });

  it('should not do anything if commander not in graveyard', () => {
    const state = createTestState();
    const result = handleCommanderDeath(state, 'Nonexistent', 0);
    expect(result).toBe(state);
  });
});

describe('handleCommanderExile', () => {
  it('should move commander from exile to command zone', () => {
    const state = createTestState();
    const cmdr = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0);

    const stateWithExiled: GameState = {
      ...state,
      players: [
        {
          ...state.players[0],
          exile: [cmdr],
          commandZone: [],
        },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = handleCommanderExile(stateWithExiled, 'Cmdr A', 0);
    expect(result.players[0].exile.length).toBe(0);
    expect(result.players[0].commandZone.length).toBe(1);
    expect(result.players[0].commanderTax).toBe(1);
  });
});

describe('takeCommanderFromCommandZone', () => {
  it('should move commander from command zone to hand', () => {
    const state = createTestState();
    // Command zone already has the commander from createPlayerState
    expect(state.players[0].commandZone.length).toBe(1);

    const result = takeCommanderFromCommandZone(state, 0);
    expect(result.commander).not.toBeNull();
    expect(result.commander!.name).toBe('Cmdr A');
    expect(result.state.players[0].commandZone.length).toBe(0);
    expect(result.state.players[0].hand.length).toBe(1);
  });

  it('should return null if command zone is empty', () => {
    const state = createTestState();
    const stateWithEmpty: GameState = {
      ...state,
      players: [
        { ...state.players[0], commandZone: [] },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = takeCommanderFromCommandZone(stateWithEmpty, 0);
    expect(result.commander).toBeNull();
  });
});

describe('validateColorIdentity', () => {
  it('should pass for valid deck', () => {
    const cmdr = createSimpleCard('Cmdr', 'Legendary Creature', '{2}{G}{W}', 0, {
      colorIdentity: ['G', 'W'],
    });
    const deck = [
      createSimpleCard('Forest', 'Basic Land', '', 0, { colorIdentity: ['G'] }),
      createSimpleCard('Plains', 'Basic Land', '', 0, { colorIdentity: ['W'] }),
      createSimpleCard('Elf', 'Creature', '{G}', 0, { colorIdentity: ['G'] }),
    ];

    const result = validateColorIdentity(deck, cmdr);
    expect(result.valid).toBe(true);
    expect(result.violations.length).toBe(0);
  });

  it('should detect color identity violations', () => {
    const cmdr = createSimpleCard('Cmdr', 'Legendary Creature', '{2}{G}', 0, {
      colorIdentity: ['G'],
    });
    const offColorCard = createSimpleCard('Bolt', 'Instant', '{R}', 0, {
      colorIdentity: ['R'],
    });
    const deck = [
      createSimpleCard('Forest', 'Basic Land', '', 0, { colorIdentity: ['G'] }),
      offColorCard,
    ];

    const result = validateColorIdentity(deck, cmdr);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBe(1);
    expect(result.violations[0].name).toBe('Bolt');
  });

  it('should allow colorless cards in any deck', () => {
    const cmdr = createSimpleCard('Cmdr', 'Legendary Creature', '{2}{G}', 0, {
      colorIdentity: ['G'],
    });
    const deck = [
      createSimpleCard('Sol Ring', 'Artifact', '{1}', 0, { colorIdentity: [] }),
    ];

    const result = validateColorIdentity(deck, cmdr);
    expect(result.valid).toBe(true);
  });
});

describe('cardFitsColorIdentity', () => {
  it('should return true for matching identity', () => {
    const card = createSimpleCard('Elf', 'Creature', '{G}', 0, { colorIdentity: ['G'] });
    expect(cardFitsColorIdentity(card, ['G', 'W'])).toBe(true);
  });

  it('should return false for non-matching identity', () => {
    const card = createSimpleCard('Bolt', 'Instant', '{R}', 0, { colorIdentity: ['R'] });
    expect(cardFitsColorIdentity(card, ['G', 'W'])).toBe(false);
  });

  it('should return true for colorless cards', () => {
    const card = createSimpleCard('Sol Ring', 'Artifact', '{1}', 0, { colorIdentity: [] });
    expect(cardFitsColorIdentity(card, ['G'])).toBe(true);
  });
});

describe('processCommanderZoneReplacements', () => {
  it('should move commander from graveyard to command zone', () => {
    const state = createTestState();
    const cmdr = state.players[0].commandZone[0]; // Cmdr A

    // Simulate commander dying — in graveyard, but also still has a copy in commandZone
    // (this represents the state where the commander name matches)
    const stateWithDeadCmdr: GameState = {
      ...state,
      players: [
        {
          ...state.players[0],
          graveyard: [cmdr], // Commander is here
          commandZone: [cmdr], // Name match used for identification
        },
        state.players[1],
      ] as [PlayerState, PlayerState],
    };

    const result = processCommanderZoneReplacements(stateWithDeadCmdr);
    // The commander in graveyard should be moved back
    expect(result.players[0].graveyard.length).toBe(0);
    // Should have 2 in command zone (original + returned)
    expect(result.players[0].commandZone.length).toBe(2);
  });
});
