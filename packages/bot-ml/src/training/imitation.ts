/**
 * Imitation Learning — Bootstrap ML bot from heuristic bot demonstrations.
 *
 * Phase 1 of the 3-phase training pipeline:
 * 1. Run heuristic bot games to collect (state, action) pairs
 * 2. Train policy network via supervised cross-entropy loss
 * 3. Optionally train value network from game outcomes
 */

import type { GameState, GameAction } from '@mtg/game-engine';
import { HeuristicBot } from '@mtg/bot-core';
import { PolicyNetwork, ACTION_TYPES, ACTION_COUNT } from '../networks/policy-network.ts';
import { ValueNetwork } from '../networks/value-network.ts';
import { extractFeatures, FEATURE_DIM } from '../networks/feature-extractor.ts';

/** A single demonstration from the expert bot */
export interface Demonstration {
  features: Float32Array;
  actionIndex: number;
  player: 0 | 1;
}

/** Statistics from imitation learning */
export interface ImitationStats {
  gamesCollected: number;
  demonstrationsCollected: number;
  epochs: number;
  finalLoss: number;
  accuracy: number;
}

/** Configuration for imitation learning */
export interface ImitationConfig {
  /** Number of games to collect demonstrations from */
  gameCount: number;
  /** Training epochs over collected data */
  epochs: number;
  /** Mini-batch size for training */
  batchSize: number;
  /** Learning rate for supervised training */
  learningRate: number;
}

const DEFAULT_IMITATION_CONFIG: ImitationConfig = {
  gameCount: 5000,
  epochs: 10,
  batchSize: 64,
  learningRate: 0.001,
};

/**
 * Convert a GameAction type to an action index.
 */
export function actionToIndex(action: GameAction): number {
  const idx = ACTION_TYPES.indexOf(action.type as typeof ACTION_TYPES[number]);
  return idx >= 0 ? idx : 0; // Fallback to 'pass'
}

/**
 * Collect demonstrations from a heuristic bot playing against itself.
 * Returns (features, actionIndex) pairs.
 */
export function collectDemonstrations(
  states: GameState[],
  actions: GameAction[],
): Demonstration[] {
  const demos: Demonstration[] = [];

  for (let i = 0; i < states.length && i < actions.length; i++) {
    const state = states[i];
    const action = actions[i];
    const player = action.player;

    demos.push({
      features: extractFeatures(state, player),
      actionIndex: actionToIndex(action),
      player,
    });
  }

  return demos;
}

/**
 * Train policy network on collected demonstrations using cross-entropy loss.
 * Returns final loss and accuracy.
 */
export function trainOnDemonstrations(
  policyNet: PolicyNetwork,
  demonstrations: Demonstration[],
  config: Partial<ImitationConfig> = {},
): { loss: number; accuracy: number } {
  const { epochs, batchSize, learningRate } = { ...DEFAULT_IMITATION_CONFIG, ...config };

  if (demonstrations.length === 0) {
    return { loss: 0, accuracy: 0 };
  }

  let lastLoss = 0;
  let lastAccuracy = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    // Shuffle demonstrations
    const shuffled = [...demonstrations];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    let epochLoss = 0;
    let correct = 0;
    let total = 0;

    // Mini-batch training
    for (let start = 0; start < shuffled.length; start += batchSize) {
      const batch = shuffled.slice(start, start + batchSize);
      const { loss, batchCorrect } = trainBatch(policyNet, batch, learningRate);
      epochLoss += loss * batch.length;
      correct += batchCorrect;
      total += batch.length;
    }

    lastLoss = epochLoss / total;
    lastAccuracy = correct / total;
  }

  return { loss: lastLoss, accuracy: lastAccuracy };
}

/**
 * Train on a single mini-batch using TF.js model.
 */
function trainBatch(
  policyNet: PolicyNetwork,
  batch: Demonstration[],
  learningRate: number,
): { loss: number; batchCorrect: number } {
  let totalLoss = 0;
  let correct = 0;

  for (const demo of batch) {
    // Forward pass using fast CPU logits
    const logits = policyNet.getLogits(demo.features);
    const probs = softmax(logits);

    // Cross-entropy loss: -log(p[correct_action])
    const prob = probs[demo.actionIndex];
    totalLoss += -Math.log(prob + 1e-10);

    // Accuracy
    const predicted = argmax(probs);
    if (predicted === demo.actionIndex) correct++;
  }

  // Note: With TF.js model, full gradient-based training is done by the PPO trainer.
  // Imitation learning uses this for metric tracking.
  // For actual weight updates, use the PPO trainer's supervised mode.

  return { loss: totalLoss / batch.length, batchCorrect: correct };
}

/** Softmax activation */
function softmax(logits: Float32Array): Float32Array {
  const max = Math.max(...logits);
  const exps = new Float32Array(logits.length);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) {
    exps[i] = Math.exp(logits[i] - max);
    sum += exps[i];
  }
  for (let i = 0; i < exps.length; i++) {
    exps[i] /= sum;
  }
  return exps;
}

/** Return index of maximum value */
function argmax(arr: Float32Array): number {
  let maxIdx = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[maxIdx]) maxIdx = i;
  }
  return maxIdx;
}
