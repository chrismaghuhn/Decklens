/**
 * Prioritized Experience Replay Buffer — SumTree-based priority sampling.
 *
 * Implements Prioritized Experience Replay (PER) as described in Schaul et al. 2015.
 * Uses a SumTree data structure for O(log n) sampling and priority updates.
 *
 * Priority = TD error: |reward + gamma*V(s') - V(s)|
 * Importance sampling weights: (1/N * 1/P_i)^beta
 */

import type { Experience, Episode } from './replay-buffer.ts';

/**
 * SumTree data structure for efficient priority-based sampling.
 * Binary tree where each node stores the sum of its children's priorities.
 */
class SumTree {
  private tree: Float32Array;
  private data: (Experience | null)[];
  private capacity: number;
  private writeIndex: number;
  private count: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    // Tree has capacity-1 internal nodes + capacity leaf nodes = 2*capacity - 1 total
    this.tree = new Float32Array(2 * capacity - 1);
    this.data = new Array(capacity).fill(null);
    this.writeIndex = 0;
    this.count = 0;
  }

  /**
   * Add experience with given priority.
   * Overwrites oldest experience when at capacity.
   */
  add(experience: Experience, priority: number): void {
    const treeIndex = this.writeIndex + this.capacity - 1;
    this.data[this.writeIndex] = experience;
    this.update(treeIndex, priority);

    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    }
  }

  /**
   * Update priority at given tree index.
   */
  update(treeIndex: number, priority: number): void {
    const change = priority - this.tree[treeIndex];
    this.tree[treeIndex] = priority;

    // Propagate change up the tree
    while (treeIndex !== 0) {
      treeIndex = Math.floor((treeIndex - 1) / 2); // Parent index
      this.tree[treeIndex] += change;
    }
  }

  /**
   * Sample experience based on priority.
   * @param value Random value in [0, totalPriority]
   * @returns { dataIndex, treeIndex, priority }
   */
  sample(value: number): { dataIndex: number; treeIndex: number; priority: number } {
    let parent = 0;

    // Traverse tree to find leaf
    while (true) {
      const left = 2 * parent + 1;
      const right = left + 1;

      // Reached leaf node
      if (left >= this.tree.length) {
        const treeIndex = parent;
        const dataIndex = parent - (this.capacity - 1);
        return {
          dataIndex,
          treeIndex,
          priority: this.tree[treeIndex],
        };
      }

      // Traverse to child with higher priority sum
      if (value <= this.tree[left]) {
        parent = left;
      } else {
        value -= this.tree[left];
        parent = right;
      }
    }
  }

  /**
   * Get total priority (root node).
   */
  get totalPriority(): number {
    return this.tree[0];
  }

  /**
   * Get current count of stored experiences.
   */
  get size(): number {
    return this.count;
  }

  /**
   * Get experience at data index.
   */
  get(dataIndex: number): Experience | null {
    return this.data[dataIndex];
  }

  /**
   * Get priority at tree index.
   */
  getPriority(treeIndex: number): number {
    return this.tree[treeIndex];
  }
}

/** Prioritized replay buffer configuration */
export interface PERConfig {
  maxExperiences: number;
  alpha: number; // Priority exponent (0 = uniform, 1 = full priority)
  beta: number; // Importance sampling weight exponent (0 = no correction, 1 = full correction)
  epsilon: number; // Small constant to ensure non-zero priority
  betaAnnealSteps: number; // Steps to anneal beta from initial to 1.0
}

const DEFAULT_PER_CONFIG: PERConfig = {
  maxExperiences: 50000,
  alpha: 0.6,
  beta: 0.4,
  epsilon: 1e-5,
  betaAnnealSteps: 10000,
};

export class PrioritizedReplayBuffer {
  private tree: SumTree;
  private config: PERConfig;
  private currentBeta: number;
  private updateStep: number = 0;
  private maxPriority: number = 1.0;

  // Episode tracking (for statistics)
  private episodes: Episode[] = [];
  private maxEpisodes: number = 10000;

  constructor(config: Partial<PERConfig> = {}) {
    this.config = { ...DEFAULT_PER_CONFIG, ...config };
    this.tree = new SumTree(this.config.maxExperiences);
    this.currentBeta = this.config.beta;
  }

  /**
   * Add episode to buffer.
   * Each step is added individually with initial priority = maxPriority.
   */
  addEpisode(episode: Episode, initialPriority?: number): void {
    const priority = initialPriority ?? this.maxPriority;

    for (const experience of episode.steps) {
      this.tree.add(experience, Math.pow(priority, this.config.alpha));
    }

    // Track episode for statistics
    this.episodes.push(episode);
    if (this.episodes.length > this.maxEpisodes) {
      this.episodes.shift();
    }
  }

  /**
   * Sample batch of experiences with importance sampling weights.
   * @param batchSize Number of experiences to sample
   * @param beta Importance sampling exponent (optional, uses current annealed beta if not provided)
   * @returns { experiences, weights, indices } where weights are IS weights and indices are tree indices
   */
  sampleBatch(
    batchSize: number,
    beta?: number
  ): { experiences: Experience[]; weights: number[]; indices: number[] } {
    if (this.tree.size === 0) {
      return { experiences: [], weights: [], indices: [] };
    }

    const actualBeta = beta ?? this.currentBeta;
    const actualBatchSize = Math.min(batchSize, this.tree.size);

    const experiences: Experience[] = [];
    const weights: number[] = [];
    const indices: number[] = [];

    const totalPriority = this.tree.totalPriority;
    const segmentSize = totalPriority / actualBatchSize;

    // Sample from each segment (stratified sampling)
    for (let i = 0; i < actualBatchSize; i++) {
      const a = segmentSize * i;
      const b = segmentSize * (i + 1);
      const value = a + Math.random() * (b - a);

      const { dataIndex, treeIndex, priority } = this.tree.sample(value);
      const experience = this.tree.get(dataIndex);

      if (experience) {
        experiences.push(experience);
        indices.push(treeIndex);

        // Importance sampling weight: (1/N * 1/P_i)^beta
        const samplingProb = priority / totalPriority;
        const weight = Math.pow((1.0 / this.tree.size) * (1.0 / samplingProb), actualBeta);
        weights.push(weight);
      }
    }

    // Normalize weights to [0, 1] range (max weight = 1)
    if (weights.length > 0) {
      const maxWeight = Math.max(...weights);
      for (let i = 0; i < weights.length; i++) {
        weights[i] /= maxWeight;
      }
    }

    return { experiences, weights, indices };
  }

  /**
   * Update priorities for sampled experiences.
   * @param indices Tree indices from sampleBatch
   * @param priorities New priority values (TD errors)
   */
  updatePriorities(indices: number[], priorities: number[]): void {
    if (indices.length !== priorities.length) {
      throw new Error('Indices and priorities must have same length');
    }

    for (let i = 0; i < indices.length; i++) {
      const priority = Math.max(priorities[i], this.config.epsilon);
      this.maxPriority = Math.max(this.maxPriority, priority);
      this.tree.update(indices[i], Math.pow(priority, this.config.alpha));
    }

    this.updateStep++;
    this.annealBeta();
  }

  /**
   * Anneal beta from initial value to 1.0 over betaAnnealSteps.
   */
  private annealBeta(): void {
    if (this.updateStep >= this.config.betaAnnealSteps) {
      this.currentBeta = 1.0;
    } else {
      const progress = this.updateStep / this.config.betaAnnealSteps;
      this.currentBeta = this.config.beta + (1.0 - this.config.beta) * progress;
    }
  }

  /**
   * Get all experiences (for compatibility with standard ReplayBuffer).
   * Note: Returns experiences in arbitrary order (not prioritized).
   */
  getAllExperiences(): Experience[] {
    const experiences: Experience[] = [];
    for (let i = 0; i < this.tree.size; i++) {
      const exp = this.tree.get(i);
      if (exp) experiences.push(exp);
    }
    return experiences;
  }

  /**
   * Get episode statistics (for training logger).
   */
  getEpisodeStats(): {
    totalEpisodes: number;
    avgLength: number;
    winRate: number;
    recentWinRate: number;
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
    const avgLength = this.episodes.reduce((sum, e) => sum + e.turns, 0) / this.episodes.length;
    const winRate = this.episodes.reduce((sum, e) => sum + e.outcome, 0) / this.episodes.length;
    const recentWinRate = recent.reduce((sum, e) => sum + e.outcome, 0) / recent.length;

    return {
      totalEpisodes: this.episodes.length,
      avgLength,
      winRate,
      recentWinRate,
    };
  }

  /**
   * Get recent episodes (for compatibility).
   */
  getRecentEpisodes(count: number): Episode[] {
    return this.episodes.slice(-count);
  }

  /**
   * Get all episodes (for compatibility).
   */
  getEpisodes(): Episode[] {
    return [...this.episodes];
  }

  /**
   * Get current buffer size.
   */
  get size(): number {
    return this.tree.size;
  }

  /**
   * Get current beta value.
   */
  get beta(): number {
    return this.currentBeta;
  }

  /**
   * Clear buffer.
   */
  clear(): void {
    this.tree = new SumTree(this.config.maxExperiences);
    this.episodes = [];
    this.updateStep = 0;
    this.currentBeta = this.config.beta;
    this.maxPriority = 1.0;
  }
}
