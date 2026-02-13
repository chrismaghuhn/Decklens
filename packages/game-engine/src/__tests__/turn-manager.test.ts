import { describe, it, expect, beforeEach } from 'vitest';
import {
  getNextStep,
  getNextPhase,
  advanceStep,
  advancePhase,
  startNewTurn,
  getCurrentStepActions,
  createInitialGameState,
} from '../engine/turn-manager.ts';
import { createPlayerState } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import type { GameState } from '../types/game-state.ts';

function createTestDeck(owner: 0 | 1) {
  const cards = [];
  for (let i = 0; i < 99; i++) {
    cards.push(
      createSimpleCard(`Card ${i}`, i < 38 ? 'Basic Land' : 'Creature', '', owner)
    );
  }
  return cards;
}

function createTestState(): GameState {
  const deck1 = createTestDeck(0);
  const commander1 = createSimpleCard('Commander A', 'Legendary Creature', '{2}{W}{U}', 0);
  const deck2 = createTestDeck(1);
  const commander2 = createSimpleCard('Commander B', 'Legendary Creature', '{3}{B}{R}', 1);

  const p1 = createPlayerState(0, 'Player 1', deck1, commander1);
  const p2 = createPlayerState(1, 'Bot', deck2, commander2);

  return createInitialGameState(p1, p2);
}

beforeEach(() => {
  resetIdCounter();
});

describe('getNextStep', () => {
  it('should return next step within beginning phase', () => {
    expect(getNextStep('beginning', 'untap')).toBe('upkeep');
    expect(getNextStep('beginning', 'upkeep')).toBe('draw');
  });

  it('should return null at end of phase', () => {
    expect(getNextStep('beginning', 'draw')).toBeNull();
    expect(getNextStep('precombat-main', 'main')).toBeNull();
  });
});

describe('getNextPhase', () => {
  it('should return next phase in order', () => {
    expect(getNextPhase('beginning')).toBe('precombat-main');
    expect(getNextPhase('precombat-main')).toBe('combat');
    expect(getNextPhase('combat')).toBe('postcombat-main');
    expect(getNextPhase('postcombat-main')).toBe('ending');
  });

  it('should return null at ending phase', () => {
    expect(getNextPhase('ending')).toBeNull();
  });
});

describe('advanceStep', () => {
  it('should advance to next step in same phase', () => {
    const state = createTestState();
    const next = advanceStep(state);
    expect(next.step).toBe('upkeep');
    expect(next.phase).toBe('beginning');
  });

  it('should advance to next phase when at end of phase steps', () => {
    const state = { ...createTestState(), step: 'draw' as const };
    const next = advanceStep(state);
    expect(next.phase).toBe('precombat-main');
    expect(next.step).toBe('main');
  });
});

describe('advancePhase', () => {
  it('should advance to combat from precombat-main', () => {
    const state = {
      ...createTestState(),
      phase: 'precombat-main' as const,
      step: 'main' as const,
    };
    const next = advancePhase(state);
    expect(next.phase).toBe('combat');
    expect(next.step).toBe('begin-combat');
  });

  it('should create combat state when entering combat', () => {
    const state = {
      ...createTestState(),
      phase: 'precombat-main' as const,
      step: 'main' as const,
    };
    const next = advancePhase(state);
    expect(next.combat).not.toBeNull();
    expect(next.combat!.currentStep).toBe('begin');
  });

  it('should start new turn when advancing from ending', () => {
    const state = {
      ...createTestState(),
      phase: 'ending' as const,
      step: 'cleanup' as const,
    };
    const next = advancePhase(state);
    expect(next.activePlayer).toBe(1); // Switches to player 2
    expect(next.phase).toBe('beginning');
    expect(next.step).toBe('untap');
  });
});

describe('startNewTurn', () => {
  it('should switch active player', () => {
    const state = createTestState();
    const next = startNewTurn(state);
    expect(next.activePlayer).toBe(1);
  });

  it('should increment turn when both players have gone', () => {
    const state = { ...createTestState(), activePlayer: 1 as const };
    const next = startNewTurn(state);
    expect(next.turn).toBe(2);
    expect(next.activePlayer).toBe(0);
  });

  it('should untap all permanents of new active player', () => {
    const state = createTestState();
    // Give player 1 a tapped permanent
    state.players[1].battlefield = [
      {
        ...createSimpleCard('Sol Ring', 'Artifact', '{1}', 1),
        controller: 1,
        tapped: true,
        flipped: false,
        faceDown: false,
        damage: 0,
        counters: {},
        summoningSick: false,
        attacking: false,
        blocking: null,
        abilities: [],
        x: 0,
        y: 0,
        enteredBattlefieldTurn: 0,
      },
    ];

    const next = startNewTurn(state);
    expect(next.players[1].battlefield[0].tapped).toBe(false);
  });

  it('should reset land played flag', () => {
    const state = createTestState();
    state.players[1].landPlayedThisTurn = true;
    const next = startNewTurn(state);
    expect(next.players[1].landPlayedThisTurn).toBe(false);
  });

  it('should empty mana pools', () => {
    const state = createTestState();
    state.players[0].manaPool = { W: 3, U: 0, B: 0, R: 0, G: 0, C: 0, S: 0, generic: 0 };
    const next = startNewTurn(state);
    expect(next.players[0].manaPool.W).toBe(0);
  });
});

describe('getCurrentStepActions', () => {
  it('should return no actions during untap', () => {
    const state = createTestState();
    const actions = getCurrentStepActions(state);
    expect(actions).toEqual([]);
  });

  it('should allow land play during main phase', () => {
    const state = {
      ...createTestState(),
      phase: 'precombat-main' as const,
      step: 'main' as const,
    };
    const actions = getCurrentStepActions(state);
    expect(actions).toContain('play-land');
    expect(actions).toContain('cast-spell');
  });

  it('should allow instants during upkeep', () => {
    const state = {
      ...createTestState(),
      step: 'upkeep' as const,
    };
    const actions = getCurrentStepActions(state);
    expect(actions).toContain('cast-instant');
    expect(actions).not.toContain('play-land');
  });
});

describe('createInitialGameState', () => {
  it('should create valid initial state', () => {
    const state = createTestState();
    expect(state.turn).toBe(1);
    expect(state.activePlayer).toBe(0);
    expect(state.phase).toBe('beginning');
    expect(state.step).toBe('untap');
    expect(state.gameOver).toBe(false);
    expect(state.winner).toBeNull();
    expect(state.mulliganPhase).toBe(true);
  });

  it('should have both players with 40 life', () => {
    const state = createTestState();
    expect(state.players[0].life).toBe(40);
    expect(state.players[1].life).toBe(40);
  });
});
