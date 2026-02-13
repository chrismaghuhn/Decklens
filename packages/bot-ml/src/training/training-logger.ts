/**
 * Training Logger — Comprehensive metrics tracking and JSON export for ML training.
 *
 * Tracks per-episode metrics, training stats, and exports to disk for analysis.
 * Auto-saves every 100 games to `training-logs/phase-{N}-{timestamp}.json`
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TrainingStats } from './ppo-trainer.ts';

/** Per-episode metrics */
export interface EpisodeMetrics {
  episodeNum: number;
  phase: number;
  length: number; // turns
  outcome: number; // 1 = win, 0 = loss, 0.5 = draw
  totalReward: number;
  avgReward: number;
  timestamp: number;
}

/** Training cycle metrics */
export interface TrainingCycleMetrics {
  cycleNum: number;
  phase: number;
  gamesPlayed: number;
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  clipFraction: number;
  epochsCompleted: number;
  batchesProcessed: number;
  // Action distribution (how often each action type chosen)
  actionDistribution: Record<string, number>;
  // Value calibration (predicted vs. actual)
  valueCalibration: number;
  // Gradient magnitudes
  gradientMagnitude?: number;
  timestamp: number;
}

/** Phase summary statistics */
export interface PhaseSummary {
  phase: number;
  totalGames: number;
  totalTrainingCycles: number;
  avgEpisodeLength: number;
  winRate: number;
  avgReward: number;
  avgPolicyLoss: number;
  avgValueLoss: number;
  avgEntropy: number;
  smoothedWinRate: number; // 100-game moving average
  cacheHitRate?: number;
  startTime: number;
  endTime?: number;
}

/** Cache efficiency metrics */
export interface CacheMetrics {
  hits: number;
  misses: number;
  hitRate: number;
}

/** Complete training log */
export interface TrainingLog {
  startTime: number;
  episodes: EpisodeMetrics[];
  trainingCycles: TrainingCycleMetrics[];
  phaseSummaries: PhaseSummary[];
  cacheMetrics?: CacheMetrics;
  metadata: {
    version: string;
    networkVersion: 'v1' | 'v2' | 'v3' | 'v4';
    featureDims: number;
  };
}

export class TrainingLogger {
  private episodes: EpisodeMetrics[] = [];
  private trainingCycles: TrainingCycleMetrics[] = [];
  private phaseSummaries: PhaseSummary[] = [];
  private cacheMetrics: CacheMetrics = { hits: 0, misses: 0, hitRate: 0 };

  private currentPhase: number = 1;
  private episodeCount: number = 0;
  private trainingCycleCount: number = 0;
  private startTime: number;

  private logDir: string;
  private autoSaveInterval: number;
  private lastAutoSave: number = 0;

  constructor(
    logDir: string = 'training-logs',
    autoSaveInterval: number = 100,
    private networkVersion: 'v1' | 'v2' | 'v3' | 'v4' = 'v4',
    private featureDims: number = 384
  ) {
    this.logDir = logDir;
    this.autoSaveInterval = autoSaveInterval;
    this.startTime = Date.now();

    // Create log directory if it doesn't exist
    this.ensureLogDir();
  }

  private ensureLogDir(): void {
    // Check if we're in a Node.js environment (not browser)
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      // Node.js environment
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    }
  }

  /**
   * Log a completed episode.
   */
  logEpisode(
    length: number,
    outcome: number,
    totalReward: number,
    avgReward: number
  ): void {
    this.episodeCount++;

    const metrics: EpisodeMetrics = {
      episodeNum: this.episodeCount,
      phase: this.currentPhase,
      length,
      outcome,
      totalReward,
      avgReward,
      timestamp: Date.now(),
    };

    this.episodes.push(metrics);

    // Check if auto-save needed
    if (this.episodeCount - this.lastAutoSave >= this.autoSaveInterval) {
      this.exportToFile();
      this.lastAutoSave = this.episodeCount;
    }
  }

  /**
   * Log a training cycle (PPO update).
   */
  logTraining(
    stats: TrainingStats,
    gamesPlayed: number,
    actionDistribution: Record<string, number>,
    valueCalibration: number,
    gradientMagnitude?: number
  ): void {
    this.trainingCycleCount++;

    const metrics: TrainingCycleMetrics = {
      cycleNum: this.trainingCycleCount,
      phase: this.currentPhase,
      gamesPlayed,
      policyLoss: stats.policyLoss,
      valueLoss: stats.valueLoss,
      entropy: stats.entropy,
      clipFraction: stats.clipFraction,
      epochsCompleted: stats.epochsCompleted,
      batchesProcessed: stats.batchesProcessed,
      actionDistribution,
      valueCalibration,
      gradientMagnitude,
      timestamp: Date.now(),
    };

    this.trainingCycles.push(metrics);
  }

  /**
   * Update cache efficiency metrics.
   */
  updateCacheMetrics(hits: number, misses: number): void {
    this.cacheMetrics.hits = hits;
    this.cacheMetrics.misses = misses;
    this.cacheMetrics.hitRate = hits / (hits + misses) || 0;
  }

  /**
   * Start a new training phase.
   */
  startPhase(phaseNum: number): void {
    // Finalize previous phase summary if exists
    if (this.currentPhase > 0) {
      this.finalizePhase();
    }

    this.currentPhase = phaseNum;

    // Create new phase summary
    this.phaseSummaries.push({
      phase: phaseNum,
      totalGames: 0,
      totalTrainingCycles: 0,
      avgEpisodeLength: 0,
      winRate: 0,
      avgReward: 0,
      avgPolicyLoss: 0,
      avgValueLoss: 0,
      avgEntropy: 0,
      smoothedWinRate: 0,
      startTime: Date.now(),
    });
  }

  /**
   * Finalize the current phase and compute summary statistics.
   */
  private finalizePhase(): void {
    const summary = this.phaseSummaries[this.currentPhase - 1];
    if (!summary) return;

    const phaseEpisodes = this.episodes.filter(e => e.phase === this.currentPhase);
    const phaseCycles = this.trainingCycles.filter(c => c.phase === this.currentPhase);

    if (phaseEpisodes.length === 0) return;

    summary.totalGames = phaseEpisodes.length;
    summary.totalTrainingCycles = phaseCycles.length;
    summary.avgEpisodeLength = phaseEpisodes.reduce((sum, e) => sum + e.length, 0) / phaseEpisodes.length;
    summary.winRate = phaseEpisodes.reduce((sum, e) => sum + e.outcome, 0) / phaseEpisodes.length;
    summary.avgReward = phaseEpisodes.reduce((sum, e) => sum + e.avgReward, 0) / phaseEpisodes.length;

    if (phaseCycles.length > 0) {
      summary.avgPolicyLoss = phaseCycles.reduce((sum, c) => sum + c.policyLoss, 0) / phaseCycles.length;
      summary.avgValueLoss = phaseCycles.reduce((sum, c) => sum + c.valueLoss, 0) / phaseCycles.length;
      summary.avgEntropy = phaseCycles.reduce((sum, c) => sum + c.entropy, 0) / phaseCycles.length;
    }

    // Compute 100-game smoothed win rate
    const recentEpisodes = phaseEpisodes.slice(-100);
    summary.smoothedWinRate = recentEpisodes.reduce((sum, e) => sum + e.outcome, 0) / recentEpisodes.length;

    summary.cacheHitRate = this.cacheMetrics.hitRate;
    summary.endTime = Date.now();
  }

  /**
   * Get current phase statistics.
   */
  getCurrentPhaseStats(): {
    totalGames: number;
    avgReward: number;
    winRate: number;
    recentWinRate: number; // last 100 games
  } {
    const phaseEpisodes = this.episodes.filter(e => e.phase === this.currentPhase);

    if (phaseEpisodes.length === 0) {
      return { totalGames: 0, avgReward: 0, winRate: 0, recentWinRate: 0 };
    }

    const totalGames = phaseEpisodes.length;
    const avgReward = phaseEpisodes.reduce((sum, e) => sum + e.avgReward, 0) / totalGames;
    const winRate = phaseEpisodes.reduce((sum, e) => sum + e.outcome, 0) / totalGames;

    const recent = phaseEpisodes.slice(-100);
    const recentWinRate = recent.reduce((sum, e) => sum + e.outcome, 0) / recent.length;

    return { totalGames, avgReward, winRate, recentWinRate };
  }

  /**
   * Export training log to JSON file.
   */
  exportToFile(filename?: string): void {
    // Finalize current phase before export
    this.finalizePhase();

    const log: TrainingLog = {
      startTime: this.startTime,
      episodes: this.episodes,
      trainingCycles: this.trainingCycles,
      phaseSummaries: this.phaseSummaries,
      cacheMetrics: this.cacheMetrics,
      metadata: {
        version: '1.0',
        networkVersion: this.networkVersion,
        featureDims: this.featureDims,
      },
    };

    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const defaultFilename = `phase-${this.currentPhase}-${timestamp}.json`;
    const filepath = path.join(this.logDir, filename || defaultFilename);

    // Check if we're in a Node.js environment
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      // Node.js environment
      fs.writeFileSync(filepath, JSON.stringify(log, null, 2), 'utf-8');
      console.log(`[TrainingLogger] Exported training log to ${filepath}`);
    } else if (typeof localStorage !== 'undefined') {
      // Browser environment - save to localStorage
      localStorage.setItem('training-log', JSON.stringify(log));
      console.log('[TrainingLogger] Saved training log to localStorage');
    } else {
      console.warn('[TrainingLogger] No storage method available');
    }
  }

  /**
   * Get aggregated statistics for reporting.
   */
  getStats(): {
    totalEpisodes: number;
    totalTrainingCycles: number;
    overallWinRate: number;
    phaseStats: PhaseSummary[];
  } {
    return {
      totalEpisodes: this.episodes.length,
      totalTrainingCycles: this.trainingCycles.length,
      overallWinRate: this.episodes.reduce((sum, e) => sum + e.outcome, 0) / this.episodes.length || 0,
      phaseStats: this.phaseSummaries,
    };
  }

  /**
   * Reset logger (for testing).
   */
  reset(): void {
    this.episodes = [];
    this.trainingCycles = [];
    this.phaseSummaries = [];
    this.cacheMetrics = { hits: 0, misses: 0, hitRate: 0 };
    this.episodeCount = 0;
    this.trainingCycleCount = 0;
    this.currentPhase = 1;
    this.startTime = Date.now();
    this.lastAutoSave = 0;
  }
}
