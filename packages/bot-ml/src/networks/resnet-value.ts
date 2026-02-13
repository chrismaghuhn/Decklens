/**
 * ResNet Value Network — Deep critic with skip connections.
 *
 * Architecture:
 *   Input (256) → Dense(256, ReLU)
 *   → [ResBlock x2]: Dense(256, ReLU) → Dense(256) → Add(skip) → ReLU
 *   → Dense(64, ReLU) → Dense(1, Tanh)
 *
 * ~280K parameters (1.1MB) — under 10MB localStorage budget.
 * Same API as ValueNetwork for drop-in replacement.
 */

import * as tf from '@tensorflow/tfjs';

export class ResNetValue {
  private model: tf.LayersModel;
  private inputSize: number;
  public readyPromise: Promise<void>;

  constructor(inputSize: number = 256) {
    this.inputSize = inputSize;
    this.model = this.buildModel(inputSize);

    this.readyPromise = this.syncWeights().then(() => {
      console.log('ResNetValue CPU weights initialized');
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

    // 2 Residual Blocks
    for (let i = 0; i < 2; i++) {
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

      x = tf.layers.add({ name: `res${i}_add` }).apply([x, skip]) as tf.SymbolicTensor;
      x = tf.layers.activation({ activation: 'relu', name: `res${i}_relu` }).apply(x) as tf.SymbolicTensor;
    }

    // Head: 256 → 64 → 1 (tanh)
    x = tf.layers.dense({
      units: 64,
      activation: 'relu',
      kernelInitializer: 'glorotNormal',
      name: 'head_dense',
    }).apply(x) as tf.SymbolicTensor;

    const output = tf.layers.dense({
      units: 1,
      activation: 'tanh',
      kernelInitializer: 'glorotNormal',
      name: 'output',
    }).apply(x) as tf.SymbolicTensor;

    return tf.model({ inputs: input, outputs: output });
  }

  // ═══════════════════════════════════════════════
  // CPU Shadow Weights for Fast Inference
  // ═══════════════════════════════════════════════

  /** CPU weights: proj, res0_d1, res0_d2, res1_d1, res1_d2, head_dense, output */
  private cpuWeights: { w: Float32Array; b: Float32Array }[] = [];

  async syncWeights(): Promise<void> {
    const denseLayerNames = [
      'proj',
      'res0_d1', 'res0_d2',
      'res1_d1', 'res1_d2',
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
   * Fast CPU inference — returns value in [-1, 1].
   */
  predictFast(features: Float32Array): number | null {
    if (this.cpuWeights.length === 0) return null;

    // proj
    let x = this.denseReLU(features, this.cpuWeights[0]);

    // 2 ResBlocks
    for (let i = 0; i < 2; i++) {
      const skip = x;
      const d1Idx = 1 + i * 2;
      const d2Idx = 2 + i * 2;
      x = this.denseReLU(x, this.cpuWeights[d1Idx]);
      x = this.denseLinear(x, this.cpuWeights[d2Idx]);
      x = this.addReLU(x, skip);
    }

    // head
    x = this.denseReLU(x, this.cpuWeights[5]);
    // output (linear, then tanh)
    const logits = this.denseLinear(x, this.cpuWeights[6]);
    return Math.tanh(logits[0]);
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

  // ═══════════════════════════════════════════════
  // GPU inference (TF.js)
  // ═══════════════════════════════════════════════

  predict(features: Float32Array): number {
    return tf.tidy(() => {
      const input = tf.tensor2d([Array.from(features)], [1, this.inputSize]);
      const output = this.model.predict(input) as tf.Tensor;
      return output.dataSync()[0];
    });
  }

  /**
   * Get raw output (model already has tanh, so this returns tanh-applied value).
   */
  getRawOutput(features: Float32Array): number {
    return this.predict(features);
  }

  getLayers(): { inputSize: number; outputSize: number }[] {
    const denseLayerNames = [
      'proj',
      'res0_d1', 'res0_d2',
      'res1_d1', 'res1_d2',
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
        outputSize: config.units ?? 1,
      };
    });
  }

  getModel(): tf.LayersModel {
    return this.model;
  }

  async saveToLocalStorage(name: string = 'mlbot-resnet-value'): Promise<void> {
    await this.model.save(`localstorage://${name}`);
  }

  static async loadFromLocalStorage(name: string = 'mlbot-resnet-value'): Promise<ResNetValue> {
    const model = await tf.loadLayersModel(`localstorage://${name}`);
    const net = new ResNetValue();
    net.model.dispose();
    net.model = model;
    await net.syncWeights();
    return net;
  }

  dispose(): void {
    this.model.dispose();
  }
}
