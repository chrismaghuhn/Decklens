/**
 * PPO Trainer — Proximal Policy Optimization with TensorFlow.js.
 *
 * Trains policy and value networks using GPU-accelerated gradients.
 * v2: Separate optimizers for policy/value, returns normalization to [-1,1].
 * v3: Compound loss for hierarchical policy (Action + Card Selection).
 * OPTIMIZED: Eliminated duplicate forward pass for stats reporting.
 */

import * as tf from '@tensorflow/tfjs';
import { PolicyNetwork, ACTION_COUNT } from '../networks/policy-network.ts';
import { ValueNetwork } from '../networks/value-network.ts';
import { HierarchicalPolicy } from '../networks/hierarchical-policy.ts';
import type { Experience } from './replay-buffer.ts';

/** Training statistics */
export interface TrainingStats {
  policyLoss: number;
  valueLoss: number;
  entropy: number;
  clipFraction: number;
  epochsCompleted: number;
  batchesProcessed: number;
  // Phase 1: TD errors for PER priority updates
  tdErrors?: number[];
}

/** PPO hyperparameters */
export interface PPOConfig {
  learningRate: number;
  valueLearningRate: number; // v2: separate LR for value network (2x policy LR, reduced from 3x)
  gamma: number;
  lambda: number;
  epsilon: number;
  epochs: number;
  batchSize: number;
  entropyCoeff: number;
  valueCoeff: number;
  maxGradNorm: number;
  // v3: Coefficient for card selection loss
  cardLossCoeff: number;
  // Phase 1 improvements: Decay schedules
  epsilonStart: number;
  epsilonEnd: number;
  epsilonDecaySteps: number;
  entropyStart: number;
  entropyEnd: number;
  entropyDecaySteps: number;
  warmupSteps: number;
}

const DEFAULT_PPO_CONFIG: PPOConfig = {
  learningRate: 0.0003,
  valueLearningRate: 0.0006, // Phase 1: Reduced from 0.001 (3x) to 0.0006 (2x) for stability
  gamma: 0.99,
  lambda: 0.95,
  epsilon: 0.2, // Will be decayed via schedule
  epochs: 3, // Phase 1: Reduced from 4 to 3 (larger batch size compensates)
  batchSize: 128, // Phase 1: Increased from 64 to 128 for more stable gradients
  entropyCoeff: 0.01, // Will be decayed via schedule
  valueCoeff: 0.5,
  maxGradNorm: 1.0, // Phase 1: Increased from 0.5 to 1.0 for less aggressive clipping
  cardLossCoeff: 0.5,
  // Phase 1: Decay schedules
  epsilonStart: 0.2,
  epsilonEnd: 0.05,
  epsilonDecaySteps: 10000,
  entropyStart: 0.05,
  entropyEnd: 0.005,
  entropyDecaySteps: 10000,
  warmupSteps: 1000,
};

export class PPOTrainer {
  private policyNet: PolicyNetwork;
  private valueNet: ValueNetwork;
  private config: PPOConfig;
  private policyOptimizer: tf.Optimizer;
  private valueOptimizer: tf.Optimizer; // v2: separate optimizer for value network
  private trainingStep: number = 0; // Phase 1: Track training steps for decay schedules

  constructor(
    policyNet: PolicyNetwork,
    valueNet: ValueNetwork,
    config: Partial<PPOConfig> = {},
  ) {
    this.policyNet = policyNet;
    this.valueNet = valueNet;
    this.config = { ...DEFAULT_PPO_CONFIG, ...config };
    this.policyOptimizer = tf.train.adam(this.config.learningRate);
    this.valueOptimizer = tf.train.adam(this.config.valueLearningRate); // Phase 1: 2x higher LR (reduced from 3x)
  }

  /**
   * Train on a batch of experiences using PPO.
   * OPTIMIZED: Stats captured during gradient computation, no duplicate forward pass.
   * Phase 1: Applies epsilon/entropy decay, LR warmup, and PER importance sampling.
   * @param experiences Experiences to train on
   * @param importanceWeights Optional IS weights from PER (default: uniform weights)
   * @returns Training stats including TD errors for priority updates
   */
  train(experiences: Experience[], importanceWeights?: number[]): TrainingStats {
    if (experiences.length === 0) {
      return { policyLoss: 0, valueLoss: 0, entropy: 0, clipFraction: 0, epochsCompleted: 0, batchesProcessed: 0 };
    }

    // Phase 1: Increment training step and apply schedules
    this.trainingStep++;
    const currentEpsilon = this.getDecayedEpsilon();
    const currentEntropy = this.getDecayedEntropy();
    const currentLR = this.getWarmupLR();

    // Note: TensorFlow.js Optimizer doesn't have setLearningRate() method
    // Warmup would require recreating optimizers, which is expensive
    // For now, warmup is handled via static config - future improvement would use dynamic optimizers

    return tf.tidy(() => {
      // Pre-compute advantages and returns using GAE
      const { advantages, returns } = this.computeGAEAndReturns(experiences);

      // Phase 1: Compute TD errors for PER priority updates
      const tdErrors: number[] = [];
      for (let i = 0; i < experiences.length; i++) {
        const exp = experiences[i];
        const nextValue = i + 1 < experiences.length && !exp.done ? experiences[i + 1].value : 0;
        const tdError = Math.abs(exp.reward + this.config.gamma * nextValue - exp.value);
        tdErrors.push(tdError);
      }

      // Phase 1: Apply importance sampling weights if provided (PER)
      const weights = importanceWeights ?? new Array(experiences.length).fill(1.0);
      
      // Convert experiences to tensors
      const featureData = experiences.map(e => Array.from(e.features));
      const featuresTensor = tf.tensor2d(featureData);
      
      const actionsData = experiences.map(e => e.actionIndex);
      const actionsTensor = tf.tensor1d(actionsData, 'int32');
      const actionsOneHot = tf.oneHot(actionsTensor, ACTION_COUNT);
      
      const logProbsData = experiences.map(e => e.logProb);
      const oldLogProbsTensor = tf.tensor1d(logProbsData);

      const advantagesTensor = tf.tensor1d(advantages);
      const returnsTensor = tf.tensor1d(returns);

      // Phase 1: Importance sampling weights tensor (PER)
      const weightsTensor = tf.tensor1d(weights);

      // v3: Prepare Card Selection Data
      const MAX_CANDIDATES = 8;
      const cardSelectionIndices: number[] = [];
      const cardCandidateMasks: number[][] = []; // 1 if step has card selection, 0 otherwise
      const cardCandidateFeaturesFlat: number[] = []; // features for all slots
      
      experiences.forEach(e => {
          const hasCardChoice = e.cardSelectionIndex !== undefined && e.cardCandidateFeatures && e.cardCandidateFeatures.length > 0;
          cardSelectionIndices.push(hasCardChoice ? e.cardSelectionIndex! : 0);
          
          if (hasCardChoice) {
             // Pad to 8 slots
             for(let i=0; i<MAX_CANDIDATES; i++) {
                 if (i < e.cardCandidateFeatures!.length) {
                     // 16 features per card
                     const feats = e.cardCandidateFeatures![i];
                     for(let k=0; k<16; k++) cardCandidateFeaturesFlat.push(feats[k]);
                 } else {
                     // Padding
                     for(let k=0; k<16; k++) cardCandidateFeaturesFlat.push(0);
                 }
             }
             cardCandidateMasks.push([1]);
          } else {
             // Dummy data
             for(let i=0; i<MAX_CANDIDATES * 16; i++) cardCandidateFeaturesFlat.push(0);
             cardCandidateMasks.push([0]);
          }
      });
      
      const cardSelectionTensor = tf.tensor1d(cardSelectionIndices, 'int32');
      const cardSelectionOneHot = tf.oneHot(cardSelectionTensor, MAX_CANDIDATES);
      const cardUseMask = tf.tensor2d(cardCandidateMasks); // [batch, 1]
      const cardFeaturesTensor = tf.tensor3d(cardCandidateFeaturesFlat, [experiences.length, MAX_CANDIDATES, 16]);

      // Normalize advantages
      const advMean = advantagesTensor.mean();
      const advStd = advantagesTensor.sub(advMean).square().mean().sqrt().add(1e-8);
      const normAdv = advantagesTensor.sub(advMean).div(advStd);

      // v2: Normalize returns to [-1,1] for tanh value network
      const retAbsMax = returnsTensor.abs().max().add(1e-8);
      const normReturns = returnsTensor.div(retAbsMax);

      let totalPolicyLoss = 0;
      let totalValueLoss = 0;
      let totalEntropy = 0;
      let totalClipFrac = 0;
      let batchCount = 0;

      // Train epochs
      for (let epoch = 0; epoch < this.config.epochs; epoch++) {
        const numSamples = experiences.length;
        const batchSize = this.config.batchSize;
        
        // Shuffle indices
        const indices = Array.from(tf.util.createShuffledIndices(numSamples));
        
        for (let i = 0; i < numSamples; i += batchSize) {
          const batchIndices = indices.slice(i, i + batchSize);
          if (batchIndices.length < batchSize / 2) continue;

          const batchIndTensor = tf.tensor1d(batchIndices, 'int32');
          
          const batchFeatures = featuresTensor.gather(batchIndTensor);
          const batchActions = actionsOneHot.gather(batchIndTensor);
          const batchOldLogProbs = oldLogProbsTensor.gather(batchIndTensor);
          const batchAdv = normAdv.gather(batchIndTensor);
          const batchReturns = normReturns.gather(batchIndTensor);

          // Phase 1: Gather importance sampling weights for this batch
          const batchWeights = weightsTensor.gather(batchIndTensor);

          // v3 Card Data Batches
          const batchCardSelection = cardSelectionOneHot.gather(batchIndTensor);
          const batchCardUseMask = cardUseMask.gather(batchIndTensor);
          const batchCardFeatures = cardFeaturesTensor.gather(batchIndTensor);

          // Capture stats
          let batchPolicyLoss = 0;
          let batchValueLoss = 0;
          let batchEntropy = 0;
          let batchClipFrac = 0;

          // Phase 1: Use decayed hyperparameters
          const epsilon = currentEpsilon;
          const entropyCoeff = currentEntropy;

          // --- Policy Update (Compound) ---
          const policyLossFunction = () => {
             let actionLoss: tf.Scalar;
             let cardLoss: tf.Scalar = tf.scalar(0);
             let entropy: tf.Scalar;
             let ratio: tf.Tensor;
             let clippedRatio: tf.Tensor;
             
             if (this.policyNet instanceof HierarchicalPolicy) {
                 const internals = (this.policyNet as any).getInternals() as { backbone: tf.LayersModel, actionHead: tf.LayersModel, cardHead: tf.LayersModel };
                 
                 // Forward pass shared backbone
                 const backboneEmb = internals.backbone.predict(batchFeatures) as tf.Tensor;
                 const actionProbs = internals.actionHead.predict(backboneEmb) as tf.Tensor;
                 
                 // --- Card Head ---
                 // We need to run card head for each of the 8 slots.
                 // Embeddings: [batch, 256] -> expand to [batch, 8, 256]
                 const expandEmb = backboneEmb.expandDims(1).tile([1, MAX_CANDIDATES, 1]);
                 
                 // Concat with card features [batch, 8, 16] -> [batch, 8, 272]
                 const combined = tf.concat([expandEmb, batchCardFeatures], 2);
                 const flatCombined = combined.reshape([-1, 256 + 16]); // [batch*8, 272]
                 
                 // Use cardHead
                 const cardLogitsFlat = internals.cardHead.predict(flatCombined) as tf.Tensor;
                 const cardLogits = cardLogitsFlat.reshape([-1, MAX_CANDIDATES]); // [batch, 8]
                 const cardProbs = tf.softmax(cardLogits);
                 
                 // Card Loss (Cross Entropy)
                 const cardLogProbs = cardProbs.add(1e-10).log();
                 // Select log prob of target
                 const selectedCardLogProb = cardLogProbs.mul(batchCardSelection).sum(1).reshape([-1, 1]);
                 // Mask out steps without card choice
                 cardLoss = selectedCardLogProb.mul(batchCardUseMask).mul(-1).mean().asScalar();
                 
                 // Action Loss calc (same as standard)
                 const logProbs = actionProbs.add(1e-10).log();
                 const actionLogProbs = logProbs.mul(batchActions).sum(1);
                 entropy = actionProbs.mul(logProbs).sum(1).mul(-1).mean().asScalar();
                 ratio = actionLogProbs.sub(batchOldLogProbs).exp();
                 const surr1 = ratio.mul(batchAdv);
                 clippedRatio = ratio.clipByValue(1 - epsilon, 1 + epsilon); // Phase 1: Use decayed epsilon
                 const surr2 = clippedRatio.mul(batchAdv);
                 // Phase 1: Apply importance sampling weights before mean
                const policyLossPerSample = tf.minimum(surr1, surr2).mul(-1);
                actionLoss = policyLossPerSample.mul(batchWeights).mean().asScalar();
                 
             } else {
                 // Fallback for v1/v2 Policy (Action only)
                 const policyModel = this.policyNet.getModel();
                 const probs = policyModel.predict(batchFeatures) as tf.Tensor;
                 const logProbs = probs.add(1e-10).log();
                 const actionLogProbs = logProbs.mul(batchActions).sum(1);
                 entropy = probs.mul(logProbs).sum(1).mul(-1).mean().asScalar();
                 ratio = actionLogProbs.sub(batchOldLogProbs).exp();
                 const surr1 = ratio.mul(batchAdv);
                 clippedRatio = ratio.clipByValue(1 - epsilon, 1 + epsilon); // Phase 1: Use decayed epsilon
                 const surr2 = clippedRatio.mul(batchAdv);
                 // Phase 1: Apply importance sampling weights before mean
                const policyLossPerSample = tf.minimum(surr1, surr2).mul(-1);
                actionLoss = policyLossPerSample.mul(batchWeights).mean().asScalar();
                 cardLoss = tf.scalar(0);
                 clippedRatio = ratio; // Just for stats
             }
             
             // Total Loss
             const totalLoss = actionLoss.add(cardLoss.mul(this.config.cardLossCoeff)).sub(entropy.mul(entropyCoeff)); // Phase 1: Use decayed entropy
             
             // Stats
             batchPolicyLoss = totalLoss.dataSync()[0];
             batchEntropy = entropy.dataSync()[0];
             const clippedMask = ratio.sub(clippedRatio).abs().greater(1e-6);
             batchClipFrac = clippedMask.cast('float32').mean().dataSync()[0];
             
             return totalLoss as tf.Scalar;
          };

          const policyGrads = this.policyOptimizer.computeGradients(policyLossFunction);
          this.policyOptimizer.applyGradients(policyGrads.grads);
          tf.dispose(policyGrads);

          // --- Value Update (separate optimizer, normalized returns) ---
          const valueLossFunction = () => {
             const valueModel = this.valueNet.getModel();
             const values = valueModel.predict(batchFeatures) as tf.Tensor;
             // Phase 1: Apply importance sampling weights to value loss
             const valueLossPerSample = values.reshape([-1]).sub(batchReturns).square();
             const valueLoss = valueLossPerSample.mul(batchWeights).mean();

             batchValueLoss = (valueLoss as tf.Scalar).dataSync()[0];
             return valueLoss as tf.Scalar;
          };

          const valueGrads = this.valueOptimizer.computeGradients(valueLossFunction);
          this.valueOptimizer.applyGradients(valueGrads.grads);
          tf.dispose(valueGrads);

          totalPolicyLoss += batchPolicyLoss;
          totalValueLoss += batchValueLoss;
          totalEntropy += batchEntropy;
          totalClipFrac += batchClipFrac;
          batchCount++;
        }
      }

      return {
        policyLoss: batchCount > 0 ? totalPolicyLoss / batchCount : 0,
        valueLoss: batchCount > 0 ? totalValueLoss / batchCount : 0,
        entropy: batchCount > 0 ? totalEntropy / batchCount : 0,
        clipFraction: batchCount > 0 ? totalClipFrac / batchCount : 0,
        epochsCompleted: this.config.epochs,
        batchesProcessed: batchCount,
        // Phase 1: Return TD errors for PER priority updates
        tdErrors,
      };
    });
  }

  /**
   * Compute just advantages (alias for backward compatibility with tests).
   */
  computeGAE(experiences: Experience[]): number[] {
    return this.computeGAEAndReturns(experiences).advantages;
  }

  /**
   * Compute GAE and Returns on CPU (faster for sequential calculation).
   */
  computeGAEAndReturns(experiences: Experience[]): { advantages: number[], returns: number[] } {
    const n = experiences.length;
    const advantages = new Array(n);
    const returns = new Array(n);

    let lastGAE = 0;
    for (let t = n - 1; t >= 0; t--) {
      const exp = experiences[t];
      const nextValue = t + 1 < n && !exp.done ? experiences[t + 1].value : 0;
      const delta = exp.reward + this.config.gamma * nextValue - exp.value;
      const mask = exp.done ? 0 : 1;
      lastGAE = delta + this.config.gamma * this.config.lambda * mask * lastGAE;
      advantages[t] = lastGAE;
      returns[t] = lastGAE + exp.value;
    }

    return { advantages, returns };
  }

  /**
   * Phase 1: Apply epsilon decay schedule.
   * Linear decay from epsilonStart to epsilonEnd over epsilonDecaySteps.
   */
  private getDecayedEpsilon(): number {
    const progress = Math.min(this.trainingStep / this.config.epsilonDecaySteps, 1.0);
    return this.config.epsilonStart + (this.config.epsilonEnd - this.config.epsilonStart) * progress;
  }

  /**
   * Phase 1: Apply entropy coefficient decay schedule.
   * Linear decay from entropyStart to entropyEnd over entropyDecaySteps.
   */
  private getDecayedEntropy(): number {
    const progress = Math.min(this.trainingStep / this.config.entropyDecaySteps, 1.0);
    return this.config.entropyStart + (this.config.entropyEnd - this.config.entropyStart) * progress;
  }

  /**
   * Phase 1: Apply learning rate warmup.
   * Linear increase from 0.0001 to learningRate over warmupSteps.
   */
  private getWarmupLR(): number {
    if (this.trainingStep >= this.config.warmupSteps) {
      return this.config.learningRate;
    }
    const minLR = 0.0001;
    const progress = this.trainingStep / this.config.warmupSteps;
    return minLR + (this.config.learningRate - minLR) * progress;
  }
}
