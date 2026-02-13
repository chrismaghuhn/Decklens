import { describe, it, expect, beforeEach } from 'vitest';
import { Game } from '../engine/game.ts';
import { createPlayerState, emptyManaPool } from '../types/player.ts';
import { createSimpleCard, resetIdCounter, setupNewGame } from '../engine/factory.ts';
import { addMana, emptyPool } from '../rules/mana.ts';
import type { GameState } from '../types/game-state.ts';
import type { ManaPayment } from '../types/mana.ts';

function createTestGame(): Game {
  resetIdCounter();
  const deck1 = [];
  for (let i = 0; i < 38; i++) {
    deck1.push(createSimpleCard('Forest', 'Basic Land — Forest', '', 0));
  }
  for (let i = 0; i < 55; i++) {
    deck1.push(createSimpleCard('Elf', 'Creature — Elf', '{G}', 0, {
      power: '1', toughness: '1', colors: ['G'],
    }));
  }
  for (let i = 0; i < 6; i++) {
    deck1.push(createSimpleCard('Giant Growth', 'Instant', '{G}', 0, { colors: ['G'] }));
  }
  const cmdr1 = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0);

  const deck2 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1)
  );
  const cmdr2 = createSimpleCard('Cmdr B', 'Legendary Creature', '{3}', 1);

  const state = setupNewGame('Player', deck1, cmdr1, 'Bot', deck2, cmdr2);

  // Move past mulligan phase, into main phase for easier testing
  const gameState: GameState = {
    ...state,
    phase: 'precombat-main',
    step: 'main',
    mulliganPhase: false,
  };

  return new Game(gameState);
}

beforeEach(() => {
  resetIdCounter();
});

describe('Game class', () => {
  it('should initialize with correct state', () => {
    const game = createTestGame();
    expect(game.isOver()).toBe(false);
    expect(game.getWinner()).toBeNull();
    expect(game.getTurn()).toBe(1);
    expect(game.getPriorityPlayer()).toBe(0);
    expect(game.getActivePlayer()).toBe(0);
  });

  it('should accept pass action', () => {
    const game = createTestGame();
    const accepted = game.submitAction({ type: 'pass', player: 0 });
    expect(accepted).toBe(true);
    // After pass, player 1 should have priority
    expect(game.getPriorityPlayer()).toBe(1);
  });

  it('should accept concede action', () => {
    const game = createTestGame();
    const accepted = game.submitAction({ type: 'concede', player: 0 });
    expect(accepted).toBe(true);
    expect(game.isOver()).toBe(true);
    expect(game.getWinner()).toBe(1);
  });

  it('should reject actions from non-priority player', () => {
    const game = createTestGame();
    // Player 1 doesn't have priority
    const accepted = game.submitAction({ type: 'pass', player: 1 });
    expect(accepted).toBe(false);
  });

  it('should allow playing a land', () => {
    const game = createTestGame();
    const state = game.getState();
    const landCard = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('land')
    );
    if (!landCard) return;

    const accepted = game.submitAction({
      type: 'play-land',
      player: 0,
      cardId: landCard.id,
    });
    expect(accepted).toBe(true);

    const newState = game.getState();
    expect(newState.players[0].battlefield.length).toBeGreaterThan(0);
    expect(newState.players[0].landsPlayedThisTurn).toBe(1);
  });

  it('should support undo', () => {
    const game = createTestGame();
    const state = game.getState();
    const landCard = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('land')
    );
    if (!landCard) return;

    const handSizeBefore = state.players[0].hand.length;

    game.submitAction({
      type: 'play-land',
      player: 0,
      cardId: landCard.id,
    });

    expect(game.getState().players[0].hand.length).toBe(handSizeBefore - 1);

    const undone = game.undo();
    expect(undone).toBe(true);
    expect(game.getState().players[0].hand.length).toBe(handSizeBefore);
  });

  it('should advance phases when both players pass', () => {
    const game = createTestGame();

    // Player 0 passes
    game.submitAction({ type: 'pass', player: 0 });
    expect(game.getPriorityPlayer()).toBe(1);

    // Player 1 passes
    game.submitAction({ type: 'pass', player: 1 });

    // Both passed with empty stack → should advance to combat
    const state = game.getState();
    expect(state.phase).toBe('combat');
  });

  it('should handle casting and resolving a spell', () => {
    const game = createTestGame();
    const state = game.getState();

    // Give player green mana
    const modState = {
      ...state,
      players: [
        { ...state.players[0], manaPool: addMana(emptyPool(), 'G', 3) },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    game.setState(modState);

    // Find a creature to cast
    const creature = game.getState().players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('creature') && c.manaCost === '{G}'
    );
    if (!creature) return;

    const payment: ManaPayment = {
      from: addMana(emptyPool(), 'G', 1),
      phyrexianLife: 0,
      hybridChoices: [],
      xValue: 0,
    };

    // Cast the creature
    const castResult = game.submitAction({
      type: 'cast-spell',
      player: 0,
      cardId: creature.id,
      targets: [],
      manaPayment: payment,
    });
    expect(castResult).toBe(true);

    // Creature should be on stack
    expect(game.getState().stack.length).toBe(1);

    // Both players pass → resolve
    game.submitAction({ type: 'pass', player: 0 });
    game.submitAction({ type: 'pass', player: 1 });

    // Creature should now be on battlefield
    const finalState = game.getState();
    expect(finalState.stack.length).toBe(0);
    const onBattlefield = finalState.players[0].battlefield.find(
      (p) => p.name === creature.name
    );
    expect(onBattlefield).toBeDefined();
  });

  it('should provide replay data', () => {
    const game = createTestGame();
    game.submitAction({ type: 'pass', player: 0 });
    game.submitAction({ type: 'pass', player: 1 });

    const replay = game.getReplayData();
    expect(replay.length).toBeGreaterThan(0);
  });

  it('should not accept actions after game over', () => {
    const game = createTestGame();
    game.submitAction({ type: 'concede', player: 0 });
    expect(game.isOver()).toBe(true);

    const accepted = game.submitAction({ type: 'pass', player: 1 });
    expect(accepted).toBe(false);
  });
});
