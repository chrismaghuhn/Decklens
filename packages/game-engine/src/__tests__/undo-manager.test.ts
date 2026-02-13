import { describe, it, expect, beforeEach } from 'vitest';
import { UndoManager } from '../engine/undo-manager.ts';
import { createPlayerState } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import type { GameState } from '../types/game-state.ts';

function createTestState(): GameState {
  const cards = [];
  for (let i = 0; i < 10; i++) {
    cards.push(createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0));
  }
  const commander = createSimpleCard('Cmdr', 'Legendary Creature', '{3}', 0);
  const p1 = createPlayerState(0, 'P1', cards, commander);

  const cards2 = [];
  for (let i = 0; i < 10; i++) {
    cards2.push(createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1));
  }
  const commander2 = createSimpleCard('Bot Cmdr', 'Legendary Creature', '{3}', 1);
  const p2 = createPlayerState(1, 'Bot', cards2, commander2);

  return createInitialGameState(p1, p2);
}

beforeEach(() => {
  resetIdCounter();
});

describe('UndoManager', () => {
  it('should start with no undo available', () => {
    const um = new UndoManager();
    expect(um.canUndo).toBe(false);
    expect(um.undoCount).toBe(0);
  });

  it('should save and restore snapshots', () => {
    const um = new UndoManager();
    const state = createTestState();
    um.saveSnapshot(state);

    expect(um.canUndo).toBe(true);
    expect(um.undoCount).toBe(1);

    const restored = um.undo();
    expect(restored).not.toBeNull();
    expect(restored!.turn).toBe(state.turn);
    expect(restored!.players[0].name).toBe('P1');
  });

  it('should deep copy state (no shared references)', () => {
    const um = new UndoManager();
    const state = createTestState();
    um.saveSnapshot(state);

    // Mutate original
    state.players[0].life = 0;

    const restored = um.undo();
    expect(restored!.players[0].life).toBe(40);
  });

  it('should support multiple undos', () => {
    const um = new UndoManager();

    const state1 = createTestState();
    state1.turn = 1;
    um.saveSnapshot(state1);

    const state2 = { ...createTestState(), turn: 2 };
    um.saveSnapshot(state2);

    const state3 = { ...createTestState(), turn: 3 };
    um.saveSnapshot(state3);

    expect(um.undoCount).toBe(3);

    const r3 = um.undo();
    expect(r3!.turn).toBe(3);

    const r2 = um.undo();
    expect(r2!.turn).toBe(2);

    const r1 = um.undo();
    expect(r1!.turn).toBe(1);

    expect(um.undo()).toBeNull();
  });

  it('should respect max snapshots', () => {
    const um = new UndoManager(3);

    for (let i = 0; i < 5; i++) {
      const state = { ...createTestState(), turn: i + 1 };
      um.saveSnapshot(state);
    }

    expect(um.undoCount).toBe(3);

    // Should have turns 3, 4, 5 (oldest trimmed)
    const r5 = um.undo();
    expect(r5!.turn).toBe(5);
    const r4 = um.undo();
    expect(r4!.turn).toBe(4);
    const r3 = um.undo();
    expect(r3!.turn).toBe(3);
  });

  it('should peek without removing', () => {
    const um = new UndoManager();
    const state = createTestState();
    um.saveSnapshot(state);

    const peeked = um.peek();
    expect(peeked).not.toBeNull();
    expect(um.undoCount).toBe(1); // Still there
  });

  it('should return replay data', () => {
    const um = new UndoManager();

    const state1 = createTestState();
    um.saveSnapshot(state1, { type: 'pass', player: 0 });

    const state2 = { ...createTestState(), turn: 2 };
    um.saveSnapshot(state2, { type: 'pass', player: 1 });

    const replay = um.getReplayData();
    expect(replay).toHaveLength(2);
    expect(replay[0].action).toEqual({ type: 'pass', player: 0 });
    expect(replay[1].action).toEqual({ type: 'pass', player: 1 });
  });

  it('should clear all snapshots', () => {
    const um = new UndoManager();
    um.saveSnapshot(createTestState());
    um.saveSnapshot(createTestState());

    um.clear();
    expect(um.undoCount).toBe(0);
    expect(um.canUndo).toBe(false);
  });
});
