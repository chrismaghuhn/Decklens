import type { GameState } from '../types/game-state.ts';
import type { GameAction } from '../types/action.ts';
import { advanceStep } from '../engine/turn-manager.ts';

/**
 * Priority System for 2-player EDH.
 *
 * Rules:
 * 1. Active player gets priority first in each phase/step
 * 2. After a player acts (casts/activates), they retain priority
 * 3. After a player passes, the other player gets priority
 * 4. If both players pass in sequence on an empty stack → advance step/phase
 * 5. If both players pass in sequence with stack → resolve top of stack
 * 6. After stack resolves, active player gets priority again
 */

/** Get which player currently has priority */
export function getCurrentPriorityPlayer(state: GameState): number {
  return state.priorityPlayer;
}

/**
 * Pass priority from the current priority player.
 *
 * If both players have now passed in sequence:
 * - Stack not empty → returns state flagged for resolution (caller handles)
 * - Stack empty → advance to next step/phase
 */
export function passPriority(state: GameState): GameState {
  const otherPlayer: number = state.priorityPlayer === 0 ? 1 : 0;

  if (state.playersPassed.size >= 2) {
    // Both players have now passed in sequence
    if (state.stack.length > 0) {
      // Signal stack resolution needed — active player gets priority after
      return {
        ...state,
        priorityPlayer: state.activePlayer,
        playersPassed: new Set(),
      };
    } else {
      // Empty stack, both passed → advance step
      return advanceStep({
        ...state,
        playersPassed: new Set(),
        priorityPlayer: state.activePlayer,
      });
    }
  }

  // First pass — give priority to other player, mark one pass
  return {
    ...state,
    priorityPlayer: otherPlayer,
    playersPassed: new Set([0, 1]),
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: state.priorityPlayer,
        message: `${state.players[state.priorityPlayer].name} passes priority.`,
        actionType: 'pass',
      },
    ],
  };
}

/**
 * After a player takes an action (not pass), they retain priority.
 * Reset playersPassed since an action was taken.
 */
export function retainPriorityAfterAction(state: GameState): GameState {
  return {
    ...state,
    playersPassed: new Set(),
  };
}

/**
 * After stack resolution, active player gets priority.
 */
export function giveActivePlayerPriority(state: GameState): GameState {
  return {
    ...state,
    priorityPlayer: state.activePlayer,
    playersPassed: new Set(),
  };
}

/**
 * Check if a player can currently take actions.
 * Only the priority player can act (except during untap/cleanup).
 */
export function canPlayerAct(state: GameState, player: number): boolean {
  if (state.gameOver) return false;
  if (state.priorityPlayer !== player) return false;
  if (state.step === 'untap') return false;
  if (state.step === 'cleanup') {
    // Exception: Player must be able to discard to hand size
    return state.pendingDiscard === player;
  }
  return true;
}
