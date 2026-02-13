import type { GameState } from '../types/game-state.ts';
import type { GameAction } from '../types/action.ts';

/** A snapshot of the game state with the action that led to it */
export interface GameSnapshot {
  state: GameState;
  action: GameAction | null;
  timestamp: number;
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
   */
  saveSnapshot(state: GameState, action: GameAction | null = null): void {
    const snapshot: GameSnapshot = {
      state: JSON.parse(JSON.stringify(state)),
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
    return JSON.parse(JSON.stringify(snapshot.state));
  }

  /**
   * Peek at the previous state without removing it.
   */
  peek(): GameState | null {
    if (this.snapshots.length === 0) return null;
    const snapshot = this.snapshots[this.snapshots.length - 1];
    return JSON.parse(JSON.stringify(snapshot.state));
  }

  /**
   * Get the full replay data (all snapshots).
   */
  getReplayData(): GameSnapshot[] {
    return this.snapshots.map((s) => ({
      ...s,
      state: JSON.parse(JSON.stringify(s.state)),
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
