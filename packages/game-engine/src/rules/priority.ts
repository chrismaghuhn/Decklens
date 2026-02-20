import type { GameState } from '../types/game-state.ts';
import type { GameAction } from '../types/action.ts';
import { advanceStep } from '../engine/turn-manager.ts';

/**
 * Priority System for N-player EDH.
 *
 * Rules:
 * 1. Active player gets priority first in each phase/step
 * 2. After a player acts (casts/activates), they retain priority (playersPassed cleared)
 * 3. After a player passes, the next player clockwise gets priority
 * 4. Once every player has passed in sequence (playersPassed.size >= players.length):
 *    - Stack not empty → resolve top of stack, active player gets priority
 *    - Stack empty → advance to next step/phase
 * 5. After stack resolves, active player gets priority again
 */

/** Get which player currently has priority */
export function getCurrentPriorityPlayer(state: GameState): number {
  return state.priorityPlayer;
}

/**
 * Pass priority from the current priority player.
 *
 * Adds the current player to playersPassed, then passes clockwise.
 * If all players have now passed in sequence:
 * - Stack not empty → returns state flagged for resolution (caller handles)
 * - Stack empty → advance to next step/phase
 */
export function passPriority(state: GameState): GameState {
  const n = state.players.length;
  // Only count non-eliminated players for the threshold
  const activePlayers = state.players.filter(p => !p.eliminated).length;
  const newPassed = new Set(state.playersPassed);
  newPassed.add(state.priorityPlayer);

  // Build the log entry for this pass
  const passLog = {
    id: `log-${Date.now()}`,
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: state.priorityPlayer,
    message: `${state.players[state.priorityPlayer].name} passes priority.`,
    actionType: 'pass' as const,
  };

  if (newPassed.size >= activePlayers) {
    // All active (non-eliminated) players have passed in sequence
    const clearedPassed = new Set<number>();
    if (state.stack.length > 0) {
      // Stack has items — signal resolution needed; active player gets priority after
      return {
        ...state,
        playersPassed: clearedPassed,
        priorityPlayer: state.activePlayer,
        log: [...state.log, passLog],
      };
    } else {
      // Empty stack → advance step/phase
      return advanceStep({
        ...state,
        playersPassed: clearedPassed,
        priorityPlayer: state.activePlayer,
        log: [...state.log, passLog],
      });
    }
  }

  // Not all active players have passed — pass to next non-eliminated player clockwise
  let next = (state.priorityPlayer + 1) % n;
  let safety = 0;
  while (state.players[next]?.eliminated && safety < n) {
    next = (next + 1) % n;
    safety++;
  }

  return {
    ...state,
    priorityPlayer: next,
    playersPassed: newPassed,
    log: [...state.log, passLog],
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
