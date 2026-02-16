/**
 * Self-Play Training Pipeline — 3-phase training for the ML bot.
 *
 * Phase 1: Imitation Learning (5,000 games)
 *   Learn from heuristic bot demonstrations via supervised learning.
 *
 * Phase 2: Self-Play vs Heuristic (15,000 games)
 *   ML bot plays against heuristic bot, learns from wins/losses.
 *
 * Phase 3: Pure Self-Play (50,000 games)
 *   Two ML bots play against each other, both learning.
 *
 * OPTIMIZED: Added recordStep() for inline experience recording.
 */

import type { GameState, GameAction } from '@mtg/game-engine';
import { Game, setupNewGame, createSimpleCard } from '@mtg/game-engine';
import * as tf from '@tensorflow/tfjs';
import { PolicyNetwork } from '../networks/policy-network.ts';
import { ValueNetwork } from '../networks/value-network.ts';
import { extractFeatures } from '../networks/feature-extractor.ts';
import { calculateReward } from '../rewards/reward-calculator.ts';
import { PPOTrainer, type TrainingStats } from './ppo-trainer.ts';
import { ReplayBuffer, type Experience, type Episode } from './replay-buffer.ts';
import { actionToIndex } from './imitation.ts';
import type { ArchetypeName } from '../rewards/archetype-modifiers.ts';

// New imports
import { runTrainingGame } from './training-game-loop.ts';
import { runBenchmark } from './benchmark.ts';
import { MLBot } from '../bot-ml.ts';
import { HeuristicBot } from '@mtg/bot-core';
import { TrainingLogger } from './training-logger.ts';
import { PrioritizedReplayBuffer } from './prioritized-replay-buffer.ts';

/** Progress callback for training phases */
export type TrainingProgressCallback = (phase: number, game: number, total: number, stats?: TrainingStats) => void;

/** Configuration for the self-play pipeline */
export interface SelfPlayConfig {
  phase1Games: number;
  phase2Games: number;
  phase3Games: number;
  trainingInterval: number;   // Train every N games
  bufferSize: number;
  archetype?: ArchetypeName;
}

const DEFAULT_SELF_PLAY_CONFIG: SelfPlayConfig = {
  phase1Games: 5000,
  phase2Games: 15000,
  phase3Games: 50000,
  trainingInterval: 200, // Phase 1: Increased from 50 to 200 for more stable gradients (10K vs 2.5K experiences)
  bufferSize: 10000, // Phase 1: Increased from 5000 to 10000 to prevent overfitting from repeated replay
};

/** Result of the training pipeline */
export interface TrainingResult {
  phase1Stats: PhaseStats;
  phase2Stats: PhaseStats;
  phase3Stats: PhaseStats;
  totalGames: number;
}

interface PhaseStats {
  gamesPlayed: number;
  avgReward: number;
  winRate: number;
  avgTrainingLoss: number;
}


export class SelfPlayPipeline {
  private policyNet: PolicyNetwork;
  private valueNet: ValueNetwork;
  private buffer: PrioritizedReplayBuffer; 
  private trainer: PPOTrainer;
  private config: SelfPlayConfig;
  private onProgress?: TrainingProgressCallback;
  private logger: TrainingLogger;

  // Reusable softmax buffer to avoid allocation per step
  private softmaxBuf = new Float32Array(8);


  constructor(
    policyNet: PolicyNetwork,
    valueNet: ValueNetwork,
    config: Partial<SelfPlayConfig> = {},
    onProgress?: TrainingProgressCallback,
  ) {
    this.policyNet = policyNet;
    this.valueNet = valueNet;
    this.config = { ...DEFAULT_SELF_PLAY_CONFIG, ...config };
    this.buffer = new PrioritizedReplayBuffer({ maxExperiences: this.config.bufferSize }); // New class
    this.trainer = new PPOTrainer(policyNet, valueNet);
    this.onProgress = onProgress;


    // Initialize training logger
    this.logger = new TrainingLogger(
      'training-logs',
      100, // auto-save every 100 games
      'v4', // network version
      384  // feature dims (v4)
    );
  }

  /**
   * Finish an episode by collecting all steps and adding to buffer.
   * Call after game ends. Marks the last step as done.
   */
  finishEpisode(steps: Experience[], won: boolean, turns: number): void {
    if (steps.length === 0) return;

    // Mark last step as terminal
    steps[steps.length - 1].done = true;

    const episode: Episode = {
      steps,
      outcome: won ? 1 : 0,
       turns,
    };

    this.buffer.addEpisode(episode);

    // Log episode metrics
    const totalReward = steps.reduce((sum, s) => sum + s.reward, 0);
    const avgReward = totalReward / steps.length;
    this.logger.logEpisode(turns, won ? 1 : 0, totalReward, avgReward);
  }

  // --- Main Training Phases ---

  /**
   * Run the full training pipeline (Phase 2 & 3).
   * Phase 1 (Imitation) is usually done separately via `imitation.ts`.
   * But we can orchestrate it here if needed.
   * v3 Plan focuses on Self-Play Loop Overhaul, primarily Phase 2/3.
   */
  async runTraining(): Promise<TrainingResult> {
      // 1. Phase 2: vs Heuristic
      console.log('Starting Phase 2: Self-Play vs Heuristic...');
      this.logger.startPhase(2);
      const p2Stats = await this.runPhase(2, this.config.phase2Games, new HeuristicBot(1));

      // 2. Phase 3: Pure Self-Play
      console.log('Starting Phase 3: Pure Self-Play...');
      this.logger.startPhase(3);
      // For self-play we clone the bot or just use same network instance for both sides (simplest)
      // If we use same instance, both collect exp.
      const p3Stats = await this.runPhase(3, this.config.phase3Games, 'self');

      // Export final log
      this.logger.exportToFile();
      console.log('[TrainingLogger] Training complete. Logs exported.');

      return {
          phase1Stats: { gamesPlayed: 0, avgReward: 0, winRate: 0, avgTrainingLoss: 0 }, // placeholder
          phase2Stats: p2Stats,
          phase3Stats: p3Stats,
          totalGames: this.config.phase2Games + this.config.phase3Games
      };
  }

    private async runPhase(
      phaseNum: number, 
      totalGames: number, 
      opponent: HeuristicBot | 'self'
  ): Promise<PhaseStats> {
      let gamesPlayed = 0;
      let wins = 0;
      let totalLoss = 0;
      let trainingSteps = 0;

      const mlBot = new MLBot(0, this.policyNet, this.valueNet); // Player 0 initially, updated in loop
      
      // Opponent setup
      let mlBot2: MLBot | undefined;
      let heuristicOpponent: HeuristicBot | undefined;

      if (opponent === 'self') {
          mlBot2 = new MLBot(1, this.policyNet, this.valueNet);
      } else {
          heuristicOpponent = opponent;
      }

      while (gamesPlayed < totalGames) {
          // Play a batch of games or just one?
          const gamesThisBatch = 1; 
          
          for(let g=0; g<gamesThisBatch; g++) {
              if (gamesPlayed >= totalGames) break;

              // Setup Game
              const deck = this.createDummyDeck(0);
              const deck2 = this.createDummyDeck(1);
              const cmd1 = createSimpleCard('Commander 1', 'Creature — Legendary', '{1}{W}', 0, { colors: ['W'] });
              const cmd2 = createSimpleCard('Commander 2', 'Creature — Legendary', '{1}{B}', 1, { colors: ['B'] });
              
              const gameState = setupNewGame(
                'ML Bot 1', deck, cmd1, 
                opponent === 'self' ? 'ML Bot 2' : 'Heuristic Bot', deck2, cmd2
              );
              
              const game = new Game(gameState);
              
              // Determine player assignment
              const p0IsML = true; 
              
              let p0: any = mlBot;
              let p1: any = opponent === 'self' ? mlBot2 : heuristicOpponent;
              
              // Randomize addPlayer order? 
              // Game state is already created with p0 and p1.
              // So p0 is index 0 in game state, p1 is index 1.
              // We just need to assign our bots to these indices.
              
              if (Math.random() > 0.5) {
                  // Swap WHO plays index 0
                  const temp = p0; p0 = p1; p1 = temp;
                  p0.player = 0; 
                  p1.player = 1; 
              } else {
                  p0.player = 0;
                  p1.player = 1;
              }
              
              // We don't "addPlayer" to game object, it already has state.
              // We just pass bots to loop.
              
              const result = await runTrainingGame(
                  game, 
                  p0 as MLBot, // cast might fail if heuristic
                  p1 as MLBot, 
                  this,
                  p0 instanceof MLBot, // learnP0 
                  p1 instanceof MLBot  // learnP1
              );
              
              gamesPlayed++;
              
              if (result.winner !== undefined) {
                  if (opponent !== 'self') {
                      // Did our ML bot win?
                      if ((p0 instanceof MLBot && result.winner === 0) || (p1 instanceof MLBot && result.winner === 1)) {
                          wins++;
                      }
                  } else {
                       // Self play counts valid games
                  }
              }

              if (this.onProgress) {
                  this.onProgress(phaseNum, gamesPlayed, totalGames);
              }
          }

          // Train
          if (gamesPlayed % this.config.trainingInterval === 0) {
              const stats = this.trainFromBuffer();
              totalLoss += stats.policyLoss; // Rough sum
              trainingSteps++;

              // Log training metrics
              const bufferStats = this.buffer.getEpisodeStats();
              const actionDist = this.calculateActionDistribution();
              const valueCalib = this.calculateValueCalibration();

              this.logger.logTraining(
                stats,
                gamesPlayed,
                actionDist,
                valueCalib
              );

              // Update cache metrics if MLBot tracks them
              // (We'll add this in the next step when we have access to MLBot cache stats)

              if (this.onProgress) {
                  this.onProgress(phaseNum, gamesPlayed, totalGames, stats);
              }

              // Log buffer stats
              console.log(`[Phase ${phaseNum}] Games: ${gamesPlayed}/${totalGames}, ` +
                          `WinRate: ${bufferStats.recentWinRate.toFixed(3)}, ` +
                          `PolicyLoss: ${stats.policyLoss.toFixed(4)}, ` +
                          `ValueLoss: ${stats.valueLoss.toFixed(4)}`);
          }
      }

      return {
          gamesPlayed,
          avgReward: 0, // calculate from buffer stats if needed
          winRate: (wins / gamesPlayed),
          avgTrainingLoss: trainingSteps > 0 ? totalLoss / trainingSteps : 0
      };
  }

  private createDummyDeck(owner: 0 | 1) {
      const cards = [];
      for(let i=0; i<20; i++) cards.push(createSimpleCard(`Land ${i}`, 'Basic Land — Plains', '', owner));
      for(let i=0; i<40; i++) cards.push(createSimpleCard(`Creature ${i}`, 'Creature', '{1}{W}', owner, { power: '2', toughness: '2' }));
      return cards;
  }


  /**
   * Run a training update from buffered experiences.
   * Caps at 2048 most recent experiences to keep training time constant.
   */
  trainFromBuffer(): TrainingStats {
    const BATCH_SIZE = 128; // Use mini-batches for PER updates
    // const MAX_SAMPLES = 4096; // Removed in favor of prioritized sampling

    if (this.buffer.size < BATCH_SIZE) {
         return {
        policyLoss: 0, valueLoss: 0, entropy: 0,
        clipFraction: 0, epochsCompleted: 0, batchesProcessed: 0,
      };
    }

    // PER Sampling
    const { experiences, weights, indices } = this.buffer.sampleBatch(BATCH_SIZE);
    
    // Train on batch
    const stats = this.trainer.train(experiences, weights);

    // Update priorities
    if (stats.tdErrors) {
        this.buffer.updatePriorities(indices, stats.tdErrors);
    }

    return stats;
  }

  /**
   * Calculate action distribution from recent experiences.
   */
  private calculateActionDistribution(): Record<string, number> {
    const ACTION_NAMES = ['pass', 'play-land', 'cast-spell', 'activate-ability',
                           'declare-attackers', 'declare-blockers', 'mulligan', 'concede'];
    const all = this.buffer.getAllExperiences();
    const recent = all.slice(-1000); // last 1000 experiences

    const counts: Record<string, number> = {};
    ACTION_NAMES.forEach(name => counts[name] = 0);

    for (const exp of recent) {
      const actionName = ACTION_NAMES[exp.actionIndex] || 'unknown';
      counts[actionName] = (counts[actionName] || 0) + 1;
    }

    // Normalize to percentages
    const total = recent.length || 1;
    for (const key in counts) {
      counts[key] = counts[key] / total;
    }

    return counts;
  }

  /**
   * Calculate value calibration (predicted vs. actual).
   * Uses recent episodes to compute |V(s) - actual_return| error.
   */
  private calculateValueCalibration(): number {
    const recentEpisodes = this.buffer.getRecentEpisodes(100);
    if (recentEpisodes.length === 0) return 0;

    let totalError = 0;
    let count = 0;

    for (const episode of recentEpisodes) {
      for (let i = 0; i < episode.steps.length; i++) {
        const step = episode.steps[i];
        // Compute actual return from this step
        let actualReturn = 0;
        for (let j = i; j < episode.steps.length; j++) {
          actualReturn += episode.steps[j].reward * Math.pow(0.99, j - i); // gamma=0.99
        }
        // Error = |predicted - actual|
        totalError += Math.abs(step.value - actualReturn);
        count++;
      }
    }

    return count > 0 ? totalError / count : 0;
  }

  // ... (keep getters)
  /** Get the trained policy network */
  getPolicyNetwork(): PolicyNetwork {
    return this.policyNet;
  }

  /** Get the trained value network */
  getValueNetwork(): ValueNetwork {
    return this.valueNet;
  }

  /** Get buffer statistics */
  getBufferStats() {
    const stats = this.buffer.getEpisodeStats();
    return {
      ...stats,
      episodes: stats.totalEpisodes,
      experiences: this.buffer.getAllExperiences().length,
      avgOutcome: stats.winRate
    };
  }

  /** Record a single episode (backward compatibility) */
  async recordEpisode(states: GameState[], actions: GameAction[], winner: number, learn: boolean) {
     if (!learn) return;
     
     const steps: Experience[] = [];
     for (let i = 0; i < actions.length; i++) {
         const state = states[i];
         const action = actions[i];
         
         if (action.player === 0) { // Assuming player 0 is the learning one in this test context
             steps.push({
                 features: new Float32Array(384), // Placeholder
                 reward: 0,
                 done: i === actions.length - 1,
                 actionIndex: 0,
                 logProb: 0,
                 value: 0,
                 player: 0
             });
         }
     }
     
     if (steps.length > 0) {
         this.finishEpisode(steps, winner === 0, states.length);
     }
  }

  /** Clear the buffer */
  clearBuffer() {
    this.buffer.clear();
  }
}
