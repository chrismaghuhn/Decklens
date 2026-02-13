/**
 * Replay Buffer — Stores experiences from gameplay for training.
 *
 * Supports both on-policy (PPO) and off-policy usage.
 * Experiences are stored as (state, action, reward, value, done) tuples.
 */

import type { GameAction } from '@mtg/game-engine';

/** A single step of experience */
export interface Experience {
  /** Feature vector at this step */
  features: Float32Array;
  /** Action taken (as index into ACTION_TYPES) */
  actionIndex: number;
  /** Reward received after this action */
  reward: number;
  /** Value estimate from the critic at this state */
  value: number;
  /** Log probability of the chosen action under the old policy */
  logProb: number;
  /** Whether this step is terminal */
  done: boolean;
  /** Player who took this action */
  player: 0 | 1;
  /** v3: Chosen card index (if applicable) */
  cardSelectionIndex?: number;
  /** v3: Features of all candidate cards (if applicable) */
  cardCandidateFeatures?: Float32Array[];
  /** v3: Log probability of the card selection */
  cardLogProb?: number;
}

/** A complete episode (game) of experiences */
export interface Episode {
  /** All experiences in order */
  steps: Experience[];
  /** Final game outcome: 1 = win, 0 = loss, 0.5 = draw */
  outcome: number;
  /** Number of turns the game lasted */
  turns: number;
}

export class ReplayBuffer {
  private episodes: Episode[] = [];
  private maxEpisodes: number;

  constructor(maxEpisodes: number = 1000) {
    this.maxEpisodes = maxEpisodes;
  }

  /** Add a completed episode */
  addEpisode(episode: Episode): void {
    this.episodes.push(episode);
    // Evict oldest if over capacity
    while (this.episodes.length > this.maxEpisodes) {
      this.episodes.shift();
    }
  }

  /** Get all experiences from the buffer (flattened) */
  getAllExperiences(filter?: {
    minEpisodeLength?: number;
    minQuality?: number;
  }): Experience[] {
    let filteredEpisodes = this.episodes;

    // Phase 1: Apply episode filtering
    if (filter) {
      if (filter.minEpisodeLength !== undefined) {
        // Skip episodes shorter than min length (degenerate games)
        const minLen = filter.minEpisodeLength;
        filteredEpisodes = filteredEpisodes.filter(ep => ep.turns >= minLen);
      }

      if (filter.minQuality !== undefined) {
        // Skip episodes with too few actions (e.g., conceded immediately)
        const minQual = filter.minQuality;
        filteredEpisodes = filteredEpisodes.filter(ep => ep.steps.length >= minQual);
      }
    }

    return filteredEpisodes.flatMap(ep => ep.steps);
  }

  /** Get experiences for a specific player only */
  getPlayerExperiences(player: 0 | 1): Experience[] {
    return this.episodes.flatMap(ep =>
      ep.steps.filter(s => s.player === player)
    );
  }

  /** Get the most recent N episodes */
  getRecentEpisodes(count: number): Episode[] {
    return this.episodes.slice(-count);
  }

  /** Get all episodes */
  getEpisodes(): Episode[] {
    return [...this.episodes];
  }

  /** Total experiences across all episodes */
  get totalExperiences(): number {
    return this.episodes.reduce((sum, ep) => sum + ep.steps.length, 0);
  }

  /** Number of episodes stored */
  get episodeCount(): number {
    return this.episodes.length;
  }

  /** Average episode length */
  get averageEpisodeLength(): number {
    if (this.episodes.length === 0) return 0;
    return this.totalExperiences / this.episodes.length;
  }

  /** Average outcome (win rate) */
  get averageOutcome(): number {
    if (this.episodes.length === 0) return 0;
    return this.episodes.reduce((sum, ep) => sum + ep.outcome, 0) / this.episodes.length;
  }

  /** Clear all stored episodes */
  clear(): void {
    this.episodes = [];
  }

  /** Sample a random batch of experiences */
  sampleBatch(batchSize: number): Experience[] {
    const all = this.getAllExperiences();
    if (all.length <= batchSize) return all;

    const batch: Experience[] = [];
    const indices = new Set<number>();
    const MAX_ATTEMPTS = batchSize * 10; // Safety limit to prevent infinite loop
    let attempts = 0;

    while (batch.length < batchSize && attempts < MAX_ATTEMPTS) {
      attempts++;
      const idx = Math.floor(Math.random() * all.length);
      if (!indices.has(idx)) {
        indices.add(idx);
        batch.push(all[idx]);
      }
    }
    
    // If we couldn't fill the batch (shouldn't happen if all.length >= batchSize), return what we have
    if (batch.length < batchSize && attempts >= MAX_ATTEMPTS) {
      console.warn(`[ReplayBuffer] Could not sample full batch: got ${batch.length}/${batchSize} after ${attempts} attempts`);
    }

    return batch;
  }

  /** Create mini-batches from all experiences */
  createBatches(batchSize: number): Experience[][] {
    const all = this.getAllExperiences();
    // Shuffle
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    // Split into batches
    const batches: Experience[][] = [];
    for (let i = 0; i < all.length; i += batchSize) {
      batches.push(all.slice(i, i + batchSize));
    }
    return batches;
  }

  /** Get episode statistics for training logger */
  getEpisodeStats(): {
    totalEpisodes: number;
    avgLength: number;
    winRate: number;
    recentWinRate: number; // last 100 episodes
  } {
    if (this.episodes.length === 0) {
      return {
        totalEpisodes: 0,
        avgLength: 0,
        winRate: 0,
        recentWinRate: 0,
      };
    }

    const recent = this.episodes.slice(-100);

    return {
      totalEpisodes: this.episodes.length,
      avgLength: this.averageEpisodeLength,
      winRate: this.averageOutcome,
      recentWinRate: recent.length > 0
        ? recent.reduce((sum, e) => sum + e.outcome, 0) / recent.length
        : 0,
    };
  }
}
