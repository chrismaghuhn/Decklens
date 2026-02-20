import type { GameState } from '../types/game-state.ts';
import type { GameAction } from '../types/action.ts';

/** A snapshot of the game state with the action that led to it */
export interface GameSnapshot {
  state: GameState;
  action: GameAction | null;
  timestamp: number;
}

/**
 * Serialize a GameState to a plain object for JSON storage.
 * Sets (like playersPassed) are converted to arrays.
 */
function serializeState(state: GameState): object {
  return {
    ...state,
    playersPassed: [...state.playersPassed],
  };
}

/**
 * Deserialize a stored GameState back into a live GameState.
 * Arrays that represent Sets are converted back to Set<number>.
 */
function deserializeState(raw: any): GameState {
  return {
    ...raw,
    playersPassed: new Set<number>(raw.playersPassed ?? []),
  };
}

/**
 * Manages undo/redo and full game replay.
 *
 * Uses JSON serialization for deep copies (same pattern as goldfish.ts undoStack,
 * but extended for 2-player game with larger history).
 */
export class UndoManager {
  private snapshots: GameSnapshot[] = [];
  private maxSnapshots: number;

  constructor(maxSnapshots: number = 100) {
    this.maxSnapshots = maxSnapshots;
  }

  /**
   * Save a game state snapshot.
   * Call this before each action is executed.
   * Sets (playersPassed) are serialized to arrays so JSON round-trips correctly.
   */
  saveSnapshot(state: GameState, action: GameAction | null = null): void {
    const snapshot: GameSnapshot = {
      state: deserializeState(JSON.parse(JSON.stringify(serializeState(state)))),
      action,
      timestamp: Date.now(),
    };

    this.snapshots.push(snapshot);

    // Trim old snapshots if over limit
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(
        this.snapshots.length - this.maxSnapshots
      );
    }
  }

  /**
   * Undo to the previous state.
   * Returns the previous GameState, or null if no history.
   */
  undo(): GameState | null {
    if (this.snapshots.length === 0) return null;

    const snapshot = this.snapshots.pop()!;
    return deserializeState(JSON.parse(JSON.stringify(serializeState(snapshot.state))));
  }

  /**
   * Peek at the previous state without removing it.
   */
  peek(): GameState | null {
    if (this.snapshots.length === 0) return null;
    const snapshot = this.snapshots[this.snapshots.length - 1];
    return deserializeState(JSON.parse(JSON.stringify(serializeState(snapshot.state))));
  }

  /**
   * Get the full replay data (all snapshots).
   */
  getReplayData(): GameSnapshot[] {
    return this.snapshots.map((s) => ({
      ...s,
      state: deserializeState(JSON.parse(JSON.stringify(serializeState(s.state)))),
    }));
  }

  /**
   * Get the number of available undo steps.
   */
  get undoCount(): number {
    return this.snapshots.length;
  }

  /**
   * Check if undo is available.
   */
  get canUndo(): boolean {
    return this.snapshots.length > 0;
  }

  /**
   * Clear all snapshots (e.g., on game restart).
   */
  clear(): void {
    this.snapshots = [];
  }
}
