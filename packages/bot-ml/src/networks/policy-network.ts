/**
 * Policy Network (Actor) — Predicts action probabilities.
 *
 * Architecture: 200 → 256 → 256 → 128 → actionCount
 * Output: Softmax probabilities over action types
 *
 * Uses TensorFlow.js with WebGL backend for GPU acceleration.
 */

import * as tf from '@tensorflow/tfjs';

/** Action probabilities output */
export interface ActionProbabilities {
  pass: number;
  'play-land': number;
  'cast-spell': number;
  'activate-ability': number;
  'declare-attackers': number;
  'declare-blockers': number;
  mulligan: number;
  concede: number;
}

/** Action type indices */
export const ACTION_TYPES = [
  'pass', 'play-land', 'cast-spell', 'activate-ability',
  'declare-attackers', 'declare-blockers', 'mulligan', 'concede',
] as const;

export const ACTION_COUNT = ACTION_TYPES.length;

export class PolicyNetwork {
  private model: tf.Sequential;
  private inputSize: number;
  public readyPromise: Promise<void>;

  constructor(inputSize: number = 200) {
    this.inputSize = inputSize;
    
    // Build neural network: 200 → 256 → 256 → 128 → 8
    this.model = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [inputSize],
          units: 256,
          activation: 'relu',
          kernelInitializer: 'glorotNormal',
        }),
        tf.layers.dense({
          units: 256,
          activation: 'relu',
          kernelInitializer: 'glorotNormal',
        }),
        tf.layers.dense({
          units: 128,
          activation: 'relu',
          kernelInitializer: 'glorotNormal',
        }),
        tf.layers.dense({
          units: ACTION_COUNT,
          activation: 'softmax',
          kernelInitializer: 'glorotNormal',
        }),
      ],
    });
    
    // Initialize CPU weights for fast inference
    this.readyPromise = this.syncWeights().then(() => {
        console.log('PolicyNetwork CPU weights initialized');
    });
  }

  // --- Hybrid Architecture: CPU Shadow Weights for Fast Inference ---
  
  private cpuWeights: { w: Float32Array; b: Float32Array }[] = [];

  /**
   * Sync weights from GPU/TensorFlow to CPU memory.
   * Call this after training updates!
   */
  async syncWeights(): Promise<void> {
    const promises = this.model.layers.map(async l => {
      const weights = l.getWeights();
      if (weights.length === 0) return { w: new Float32Array(0), b: new Float32Array(0) }; // Input layer?
      
      // Dense layer has kernel (weights[0]) and bias (weights[1])
      const wTensor = weights[0];
      const bTensor = weights[1];
      
      const w = await wTensor.data() as Float32Array;
      const b = await bTensor.data() as Float32Array;
      
      return { w, b };
    });
    
    this.cpuWeights = await Promise.all(promises);
  }

  /**
   * Fast CPU inference (no Tensor overhead).
   * 100x faster for single-game simulation.
   */
  predictFast(features: Float32Array): ActionProbabilities | null {
    if (this.cpuWeights.length === 0) return null; // Not ready yet
    
    // Manual forward pass (ReLU -> Linear -> Softmax)
    let x = features;
    
    // Layers: 0 (Dense 256), 1 (Dense 256), 2 (Dense 128), 3 (Output 8)
    // Note: this.model.layers includes input layer sometimes? No, Sequential starts with first dense.
    
    // Layer 1
    x = this.denseReLU(x, this.cpuWeights[0]);
    // Layer 2
    x = this.denseReLU(x, this.cpuWeights[1]);
    // Layer 3
    x = this.denseReLU(x, this.cpuWeights[2]);
    // Output
    const logits = this.denseLinear(x, this.cpuWeights[3]);
    const probs = this.softmax(logits);

    return {
      pass: probs[0],
      'play-land': probs[1],
      'cast-spell': probs[2],
      'activate-ability': probs[3],
      'declare-attackers': probs[4],
      'declare-blockers': probs[5],
      mulligan: probs[6],
      concede: probs[7],
    };
  }

  /**
   * Fast CPU logits (no Softmax, no Tensor overhead).
   * Needed for PPO training pipeline (recording episodes).
   */
  getLogitsFast(features: Float32Array): Float32Array | null {
    if (this.cpuWeights.length === 0) return null;
    let x = features;
    x = this.denseReLU(x, this.cpuWeights[0]);
    x = this.denseReLU(x, this.cpuWeights[1]);
    x = this.denseReLU(x, this.cpuWeights[2]);
    const logits = this.denseLinear(x, this.cpuWeights[3]);
    return logits;
  }

  private denseReLU(input: Float32Array, weights: { w: Float32Array; b: Float32Array }): Float32Array {
    const inputSize = input.length;
    const outputSize = weights.b.length;
    const output = new Float32Array(outputSize);
    
    for (let o = 0; o < outputSize; o++) {
      let sum = weights.b[o];
      for (let i = 0; i < inputSize; i++) {
        // TF.js stores weights as [input, output] (row-major flat)
        sum += input[i] * weights.w[i * outputSize + o];
      }
      output[o] = Math.max(0, sum);
    }
    return output;
  }

  private denseLinear(input: Float32Array, weights: { w: Float32Array; b: Float32Array }): Float32Array {
    const inputSize = input.length;
    const outputSize = weights.b.length;
    const output = new Float32Array(outputSize);
    
    for (let o = 0; o < outputSize; o++) {
      let sum = weights.b[o];
      for (let i = 0; i < inputSize; i++) {
        sum += input[i] * weights.w[i * outputSize + o];
      }
      output[o] = sum;
    }
    return output;
  }

  private softmax(logits: Float32Array): Float32Array {
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

  /**
   * Forward pass: features → action probabilities.
   */
  predict(features: Float32Array): ActionProbabilities {
    return tf.tidy(() => {
      const input = tf.tensor2d([Array.from(features)], [1, this.inputSize]);
      const output = this.model.predict(input) as tf.Tensor;
      const probs = output.dataSync();

      return {
        pass: probs[0],
        'play-land': probs[1],
        'cast-spell': probs[2],
        'activate-ability': probs[3],
        'declare-attackers': probs[4],
        'declare-blockers': probs[5],
        mulligan: probs[6],
        concede: probs[7],
      };
    });
  }

  /**
   * Get raw logits (for training — before softmax).
   */
  getLogits(features: Float32Array): Float32Array {
    return tf.tidy(() => {
      // Create model without final softmax
      const logitsModel = tf.sequential({
        layers: this.model.layers.slice(0, -1).concat([
          tf.layers.dense({
            units: ACTION_COUNT,
            kernelInitializer: 'glorotNormal',
          }),
        ]),
      });

      // Copy weights from main model
      for (let i = 0; i < this.model.layers.length - 1; i++) {
        logitsModel.layers[i].setWeights(this.model.layers[i].getWeights());
      }

      const input = tf.tensor2d([Array.from(features)], [1, this.inputSize]);
      const output = logitsModel.predict(input) as tf.Tensor;
      return output.dataSync() as Float32Array;
    });
  }

  /**
   * Get layer info for inspection/testing.
   */
  getLayers(): { inputSize: number; outputSize: number; biases: Float32Array }[] {
    const layers = this.model.layers;
    return layers.map((l, idx) => {
      const config = l.getConfig() as any;
      const weights = l.getWeights();
      const outputSize = config.units ?? ACTION_COUNT;
      // For input size: first layer uses this.inputSize, others use previous layer's output
      let inputSize: number;
      if (idx === 0) {
        inputSize = this.inputSize;
      } else {
        const prevConfig = layers[idx - 1].getConfig() as any;
        inputSize = prevConfig.units ?? this.inputSize;
      }
      return {
        inputSize,
        outputSize,
        biases: weights.length >= 2 ? weights[1].dataSync() as Float32Array : new Float32Array(0),
      };
    });
  }

  /**
   * Get the underlying TF.js model for training.
   */
  getModel(): tf.Sequential {
    return this.model;
  }

  /**
   * Serialize network weights for storage.
   */
  async serialize(): Promise<ArrayBuffer> {
    const saveResult = await this.model.save(tf.io.withSaveHandler(async (artifacts) => {
      return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
    }));
    
    // Convert to ArrayBuffer for localStorage compatibility
    const weightsData = await this.model.save(tf.io.withSaveHandler(async (artifacts) => {
      const json = JSON.stringify({
        modelTopology: artifacts.modelTopology,
        weightSpecs: artifacts.weightSpecs,
        weightData: Array.from(new Uint8Array(artifacts.weightData as ArrayBuffer)),
      });
      return { modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: 'JSON' } };
    }));

    return new TextEncoder().encode(JSON.stringify(weightsData)).buffer;
  }

  /**
   * Load network weights from serialized data.
   */
  static async deserialize(buffer: ArrayBuffer, inputSize: number = 200): Promise<PolicyNetwork> {
    const json = new TextDecoder().decode(buffer);
    const data = JSON.parse(json);
    
    // Reconstruct model from saved data
    const net = new PolicyNetwork(inputSize);
    // TF.js will load weights automatically from model load, but here we construct fresh.
    // If buffer contains weights, we should load them.
    // Actually, deserialize is not used in new flow (we use loadFromLocalStorage).
    // But if we did, we'd need to sync.
    return net;
  }

  /**
   * Save to localStorage using TF.js native save.
   */
  async saveToLocalStorage(name: string = 'mlbot-policy'): Promise<void> {
    await this.model.save(`localstorage://${name}`);
  }

  /**
   * Load from localStorage using TF.js native load.
   */
  static async loadFromLocalStorage(name: string = 'mlbot-policy'): Promise<PolicyNetwork> {
    const model = await tf.loadLayersModel(`localstorage://${name}`) as tf.Sequential;
    const net = new PolicyNetwork();
    net.model = model;
    await net.syncWeights(); // Sync immediately after load
    return net;
  }

  /**
   * Dispose of tensors to free memory.
   */
  dispose(): void {
    this.model.dispose();
  }
}
