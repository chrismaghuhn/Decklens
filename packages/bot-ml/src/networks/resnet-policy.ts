/**
 * ResNet Policy Network — Deep policy with skip connections.
 *
 * Architecture:
 *   Input (256) → Dense(256, ReLU)
 *   → [ResBlock x3]: Dense(256, ReLU) → Dense(256) → Add(skip) → ReLU
 *   → Dense(128, ReLU) → Dense(8, Softmax)
 *
 * ~400K parameters (1.6MB) — under 10MB localStorage budget.
 * Same API as PolicyNetwork for drop-in replacement.
 */

import * as tf from '@tensorflow/tfjs';
import type { ActionProbabilities } from './policy-network.ts';
import { ACTION_TYPES, ACTION_COUNT } from './policy-network.ts';

export class ResNetPolicy {
  private model: tf.LayersModel;
  private inputSize: number;
  public readyPromise: Promise<void>;

  constructor(inputSize: number = 256) {
    this.inputSize = inputSize;
    this.model = this.buildModel(inputSize);

    this.readyPromise = this.syncWeights().then(() => {
      console.log('ResNetPolicy CPU weights initialized');
    });
  }

  private buildModel(inputSize: number): tf.LayersModel {
    const input = tf.input({ shape: [inputSize] });

    // Projection: input → 256
    let x = tf.layers.dense({
      units: 256,
      activation: 'relu',
      kernelInitializer: 'glorotNormal',
      name: 'proj',
    }).apply(input) as tf.SymbolicTensor;

    // 3 Residual Blocks
    for (let i = 0; i < 3; i++) {
      const skip = x;
      x = tf.layers.dense({
        units: 256,
        activation: 'relu',
        kernelInitializer: 'glorotNormal',
        name: `res${i}_d1`,
      }).apply(x) as tf.SymbolicTensor;

      x = tf.layers.dense({
        units: 256,
        kernelInitializer: 'glorotNormal',
        name: `res${i}_d2`,
      }).apply(x) as tf.SymbolicTensor;

      // Skip connection: add and ReLU
      x = tf.layers.add({ name: `res${i}_add` }).apply([x, skip]) as tf.SymbolicTensor;
      x = tf.layers.activation({ activation: 'relu', name: `res${i}_relu` }).apply(x) as tf.SymbolicTensor;
    }

    // Head: 256 → 128 → 8
    x = tf.layers.dense({
      units: 128,
      activation: 'relu',
      kernelInitializer: 'glorotNormal',
      name: 'head_dense',
    }).apply(x) as tf.SymbolicTensor;

    const output = tf.layers.dense({
      units: ACTION_COUNT,
      activation: 'softmax',
      kernelInitializer: 'glorotNormal',
      name: 'output',
    }).apply(x) as tf.SymbolicTensor;

    return tf.model({ inputs: input, outputs: output });
  }

  // ═══════════════════════════════════════════════
  // CPU Shadow Weights for Fast Inference
  // ═══════════════════════════════════════════════

  /** CPU weights for each dense layer, in order: proj, res0_d1, res0_d2, res1_d1, res1_d2, res2_d1, res2_d2, head, output */
  private cpuWeights: { w: Float32Array; b: Float32Array }[] = [];

  async syncWeights(): Promise<void> {
    const denseLayerNames = [
      'proj',
      'res0_d1', 'res0_d2',
      'res1_d1', 'res1_d2',
      'res2_d1', 'res2_d2',
      'head_dense',
      'output',
    ];

    const promises = denseLayerNames.map(async (name) => {
      const layer = this.model.getLayer(name);
      const weights = layer.getWeights();
      if (weights.length === 0) return { w: new Float32Array(0), b: new Float32Array(0) };
      const w = await weights[0].data() as Float32Array;
      const b = await weights[1].data() as Float32Array;
      return { w, b };
    });

    this.cpuWeights = await Promise.all(promises);
  }

  /**
   * Fast CPU inference (no Tensor overhead).
   */
  predictFast(features: Float32Array): ActionProbabilities | null {
    if (this.cpuWeights.length === 0) return null;

    // proj
    let x = this.denseReLU(features, this.cpuWeights[0]);

    // 3 ResBlocks: each = (denseReLU, denseLinear, add skip, relu)
    for (let i = 0; i < 3; i++) {
      const skip = x;
      const d1Idx = 1 + i * 2;
      const d2Idx = 2 + i * 2;
      x = this.denseReLU(x, this.cpuWeights[d1Idx]);
      x = this.denseLinear(x, this.cpuWeights[d2Idx]);
      // Add skip + ReLU
      x = this.addReLU(x, skip);
    }

    // head
    x = this.denseReLU(x, this.cpuWeights[7]);
    // output
    const logits = this.denseLinear(x, this.cpuWeights[8]);
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
   * Fast CPU Inference for Batched Action Types (5-10x faster for training)
   */
  predictFastBatch(stateFeatures: Float32Array[]): ActionProbabilities[] | null {
    if (this.cpuWeights.length === 0 || stateFeatures.length === 0) return null;
    
    const batchSize = stateFeatures.length;
    const results: ActionProbabilities[] = [];
    
    for (let b = 0; b < batchSize; b++) {
      const result = this.predictFast(stateFeatures[b]);
      if (result) {
        results.push(result);
      } else {
        results.push({
          pass: 0.125, 'play-land': 0.125, 'cast-spell': 0.125, 'activate-ability': 0.125,
          'declare-attackers': 0.125, 'declare-blockers': 0.125, mulligan: 0.125, concede: 0.125
        } as ActionProbabilities);
      }
    }
    
    return results;
  }

  /**
   * Fast CPU logits (no Softmax).
   */
  getLogitsFast(features: Float32Array): Float32Array | null {
    if (this.cpuWeights.length === 0) return null;

    let x = this.denseReLU(features, this.cpuWeights[0]);

    for (let i = 0; i < 3; i++) {
      const skip = x;
      x = this.denseReLU(x, this.cpuWeights[1 + i * 2]);
      x = this.denseLinear(x, this.cpuWeights[2 + i * 2]);
      x = this.addReLU(x, skip);
    }

    x = this.denseReLU(x, this.cpuWeights[7]);
    return this.denseLinear(x, this.cpuWeights[8]);
  }

  // ─── Math helpers ───

  private denseReLU(input: Float32Array, weights: { w: Float32Array; b: Float32Array }): Float32Array {
    const inputSize = input.length;
    const outputSize = weights.b.length;
    const output = new Float32Array(outputSize);
    for (let o = 0; o < outputSize; o++) {
      let sum = weights.b[o];
      for (let i = 0; i < inputSize; i++) {
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

  private addReLU(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) {
      out[i] = Math.max(0, a[i] + b[i]);
    }
    return out;
  }

  private softmax(logits: Float32Array): Float32Array {
    const max = Math.max(...logits);
    const exps = new Float32Array(logits.length);
    let sum = 0;
    for (let i = 0; i < logits.length; i++) {
      exps[i] = Math.exp(logits[i] - max);
      sum += exps[i];
    }
    for (let i = 0; i < exps.length; i++) exps[i] /= sum;
    return exps;
  }

  // ═══════════════════════════════════════════════
  // GPU inference (TF.js)
  // ═══════════════════════════════════════════════

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

  getLogits(features: Float32Array): Float32Array {
    return tf.tidy(() => {
      const input = tf.tensor2d([Array.from(features)], [1, this.inputSize]);
      // Run through model manually, stopping before softmax
      // We need to extract logits before softmax. Build a logits-only model.
      const outputLayer = this.model.getLayer('output');
      const weights = outputLayer.getWeights();

      // Get the input to the output layer (head_dense output)
      const headLayer = this.model.getLayer('head_dense');
      const headModel = tf.model({ inputs: this.model.input, outputs: headLayer.output });
      const headOut = headModel.predict(input) as tf.Tensor;

      // Manual linear: headOut * kernel + bias
      const kernel = weights[0];
      const bias = weights[1];
      const logits = headOut.matMul(kernel).add(bias);
      return logits.dataSync() as Float32Array;
    });
  }

  /**
   * Get layer info for inspection/testing.
   */
  getLayers(): { inputSize: number; outputSize: number }[] {
    const denseLayerNames = [
      'proj',
      'res0_d1', 'res0_d2',
      'res1_d1', 'res1_d2',
      'res2_d1', 'res2_d2',
      'head_dense',
      'output',
    ];

    return denseLayerNames.map((name) => {
      const layer = this.model.getLayer(name);
      const config = layer.getConfig() as any;
      return {
        inputSize: layer.getWeights().length > 0
          ? layer.getWeights()[0].shape[0]
          : this.inputSize,
        outputSize: config.units ?? ACTION_COUNT,
      };
    });
  }

  getModel(): tf.LayersModel {
    return this.model;
  }
  
  async serialize(): Promise<ArrayBuffer> {
    const weights = this.model.getWeights();
    let totalSize = 0;
    const weightBuffers = [];

    for (const w of weights) {
      const data = await w.data();
      const bytes = new Uint8Array(data.buffer);
      weightBuffers.push(bytes);
      totalSize += 4 + bytes.length; // length header + data
    }

    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    let offset = 0;

    for (const bytes of weightBuffers) {
      view.setUint32(offset, bytes.length, true);
      offset += 4;
      new Uint8Array(buf).set(bytes, offset);
      offset += bytes.length;
    }
    return buf;
  }

  async saveToLocalStorage(name: string = 'mlbot-resnet-policy'): Promise<void> {
    await this.model.save(`localstorage://${name}`);
  }

  static async loadFromLocalStorage(name: string = 'mlbot-resnet-policy'): Promise<ResNetPolicy> {
    const model = await tf.loadLayersModel(`localstorage://${name}`);
    const net = new ResNetPolicy();
    net.model.dispose();
    net.model = model;
    await net.syncWeights();
    return net;
  }

  dispose(): void {
    this.model.dispose();
  }
}
