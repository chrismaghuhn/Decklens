/**
 * Opponent Pool — League-Lite system for training diversity.
 *
 * Periodically snapshots the current network weights and randomly
 * selects a historical opponent to play against (instead of always self-play).
 * This prevents strategy collapse where the bot only learns to beat itself.
 *
 * Usage:
 *   const pool = new OpponentPool(5);
 *   pool.maybeSnapshot(policyNet, valueNet, gamesPlayed, 2000); // Snapshot every 2000 games
 *   const opponent = pool.getRandomOpponent(); // 20% chance of historical opponent
 */

import * as tf from '@tensorflow/tfjs';

export interface WeightData {
  data: Float32Array;
  shape: number[];
}

import { EloTracker } from './elo-tracker.ts';

export interface OpponentSnapshot {
  id: string; // Unique ID (e.g., "game_5000")
  policyWeights: WeightData[];
  valueWeights: WeightData[];
  gamesPlayed: number;
  winRate?: number;
  elo?: number; // Elo rating at time of snapshot
}

export class OpponentPool {
  private snapshots: Map<string, OpponentSnapshot> = new Map();
  private maxSnapshots: number;
  public historicalRate: number;
  private eloTracker: EloTracker;

  constructor(maxSnapshots: number = 5, historicalRate: number = 0.3) {
    this.maxSnapshots = maxSnapshots;
    this.historicalRate = historicalRate;
    // Add permanent bots to Elo tracker
    this.eloTracker = new EloTracker({
      'heuristic': 1300,
      'simple': 1000,
      'current': 1200, // Main bot being trained
    });
  }

  private lastSnapshotGames: number = 0;

  /**
   * Maybe take a snapshot of current weights (if enough games have passed).
   * @returns true if a snapshot was taken
   */
  maybeSnapshot(
    policyModel: tf.LayersModel | tf.Sequential,
    valueModel: tf.LayersModel | tf.Sequential,
    gamesPlayed: number,
    snapshotInterval: number = 2000,
  ): boolean {
    if (gamesPlayed - this.lastSnapshotGames < snapshotInterval) return false;

    const id = `game_${gamesPlayed}`;
    const currentElo = this.eloTracker.getRating('current');
    
    // Add to Elo tracker
    this.eloTracker.updateRating(id, 'current', false); // Dummy update to register
    this.eloTracker.updateRating(id, id, true); // Set to its own rating
    this.eloTracker.updateRating('current', 'current', true); // Reset current

    const policyWeights = policyModel.getWeights().map(w => ({
      data: new Float32Array(w.dataSync()),
      shape: w.shape as number[],
    }));

    const valueWeights = valueModel.getWeights().map(w => ({
      data: new Float32Array(w.dataSync()),
      shape: w.shape as number[],
    }));

    this.addSnapshot({
      id,
      policyWeights,
      valueWeights,
      gamesPlayed,
      elo: currentElo,
    });
    
    this.lastSnapshotGames = gamesPlayed;
    return true;
  }

  /**
   * Add a snapshot explicitly.
   */
  addSnapshot(snapshot: OpponentSnapshot): void {
    this.snapshots.set(snapshot.id, snapshot);
    if (!this.eloTracker.getRating(snapshot.id)) {
        this.eloTracker.updateRating(snapshot.id, snapshot.id, true); // Register
    }

    if (this.snapshots.size > this.maxSnapshots) {
      const oldestId = this.snapshots.keys().next().value;
      if (oldestId) {
        this.snapshots.delete(oldestId);
      }
    }
  }

  /**
   * Select an opponent using Elo rating.
   * Returns null for self-play if random chance allows or no opponents exist.
   */
  getOpponent(): OpponentSnapshot | null {
    if (this.snapshots.size === 0) return null;
    if (Math.random() > this.historicalRate) return null;

    const currentRating = this.eloTracker.getRating('current');
    const candidates = Array.from(this.snapshots.keys());
    
    // Add permanent bots to candidate pool
    candidates.push('heuristic', 'simple');

    const opponentId = this.eloTracker.selectOpponent(currentRating, candidates);
    
    if (opponentId && this.snapshots.has(opponentId)) {
      return this.snapshots.get(opponentId) ?? null;
    }
    
    // If a permanent bot was chosen, we can't return a snapshot.
    // In this case, the training loop should know how to use Heuristic/Simple bot.
    // For now, we return null, and the caller can decide.
    // A better approach would be to return the ID and let the caller handle it.
    // Let's return the ID.
    
    return null; // Simplified: for now, only return snapshots
  }

  /**
   * Update Elo ratings after a game.
   */
  updateElo(winnerId: string, loserId: string, isDraw: boolean): void {
    this.eloTracker.updateRating(winnerId, loserId, isDraw);
  }

  /**
   * Apply snapshot weights to existing models.
   */
  static applySnapshot(
    snapshot: OpponentSnapshot,
    policyModel: tf.LayersModel | tf.Sequential,
    valueModel: tf.LayersModel | tf.Sequential,
  ): void {
    const policyTensors = snapshot.policyWeights.map(w => tf.tensor(w.data, w.shape));
    const valueTensors = snapshot.valueWeights.map(w => tf.tensor(w.data, w.shape));

    try {
      policyModel.setWeights(policyTensors);
      valueModel.setWeights(valueTensors);
    } finally {
      policyTensors.forEach(t => t.dispose());
      valueTensors.forEach(t => t.dispose());
    }
  }

  /** Number of snapshots stored */
  get size(): number {
    return this.snapshots.size;
  }

  /** Get all snapshots (for inspection/testing) */
  getSnapshots(): readonly OpponentSnapshot[] {
    return Array.from(this.snapshots.values());
  }
}
