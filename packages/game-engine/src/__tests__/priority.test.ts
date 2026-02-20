import { describe, it, expect, beforeEach } from 'vitest';
import {
  passPriority,
  canPlayerAct,
  retainPriorityAfterAction,
  giveActivePlayerPriority,
  getCurrentPriorityPlayer,
} from '../rules/priority.ts';
import { createPlayerState } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import type { GameState } from '../types/game-state.ts';

function createTestState(): GameState {
  resetIdCounter();
  const deck1 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
  );
  const cmdr1 = createSimpleCard('Cmdr A', 'Legendary Creature', '{3}', 0);
  const deck2 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1)
  );
  const cmdr2 = createSimpleCard('Cmdr B', 'Legendary Creature', '{3}', 1);

  const p1 = createPlayerState(0, 'Player', deck1, cmdr1);
  const p2 = createPlayerState(1, 'Bot', deck2, cmdr2);

  return {
    ...createInitialGameState(p1, p2),
    // Start in main phase so priority matters
    phase: 'precombat-main',
    step: 'main',
  };
}

beforeEach(() => {
  resetIdCounter();
});

describe('getCurrentPriorityPlayer', () => {
  it('should return active player initially', () => {
    const state = createTestState();
    expect(getCurrentPriorityPlayer(state)).toBe(0);
  });
});

describe('canPlayerAct', () => {
  it('should allow priority player to act', () => {
    const state = createTestState();
    expect(canPlayerAct(state, 0)).toBe(true);
    expect(canPlayerAct(state, 1)).toBe(false);
  });

  it('should not allow actions during untap step', () => {
    const state = { ...createTestState(), step: 'untap' as const };
    expect(canPlayerAct(state, 0)).toBe(false);
  });

  it('should not allow actions during cleanup step', () => {
    const state = { ...createTestState(), step: 'cleanup' as const };
    expect(canPlayerAct(state, 0)).toBe(false);
  });

  it('should not allow actions when game is over', () => {
    const state = { ...createTestState(), gameOver: true };
    expect(canPlayerAct(state, 0)).toBe(false);
  });
});

describe('passPriority', () => {
  it('should give priority to other player on first pass', () => {
    const state = createTestState();
    const after = passPriority(state);
    expect(after.priorityPlayer).toBe(1);
    // N-player: only the passing player (0) is added to the set (size = 1)
    expect(after.playersPassed.size).toBe(1);
    expect(after.playersPassed.has(0)).toBe(true);
  });

  it('should advance step when both pass with empty stack', () => {
    const state = {
      ...createTestState(),
      playersPassed: new Set([0, 1]) as Set<number>,
      priorityPlayer: 1 as const,
    };
    const after = passPriority(state);
    // Both have passed, empty stack → should advance
    // Phase should change from precombat-main to combat
    expect(after.phase).toBe('combat');
  });

  it('should signal resolution when both pass with stack', () => {
    const state = {
      ...createTestState(),
      playersPassed: new Set([0, 1]) as Set<number>,
      priorityPlayer: 1 as const,
      stack: [
        {
          id: 'test-stack',
          type: 'spell' as const,
          card: createSimpleCard('Lightning Bolt', 'Instant', '{R}', 0),
          controller: 0 as const,
          targets: [],
          text: 'Lightning Bolt',
        },
      ],
    };
    const after = passPriority(state);
    // Both passed with stack → active player gets priority, playersPassed reset
    expect(after.priorityPlayer).toBe(state.activePlayer);
    expect(after.playersPassed.size).toBe(0);
    // Stack still has the item (resolution happens separately)
    expect(after.stack.length).toBe(1);
  });

  it('should add log entry', () => {
    const state = createTestState();
    const after = passPriority(state);
    const lastLog = after.log[after.log.length - 1];
    expect(lastLog.message).toContain('passes priority');
  });
});

describe('retainPriorityAfterAction', () => {
  it('should reset bothPlayersPassed', () => {
    const state = { ...createTestState(), playersPassed: new Set([0, 1]) as Set<number> };
    const after = retainPriorityAfterAction(state);
    expect(after.playersPassed.size).toBe(0);
  });
});

describe('giveActivePlayerPriority', () => {
  it('should set priority to active player', () => {
    const state = { ...createTestState(), priorityPlayer: 1 as const };
    const after = giveActivePlayerPriority(state);
    expect(after.priorityPlayer).toBe(0);
    expect(after.playersPassed.size).toBe(0);
  });
});
