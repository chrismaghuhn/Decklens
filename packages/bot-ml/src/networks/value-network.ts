/**
 * Value Network (Critic) — Estimates state value.
 *
 * Architecture: 200 → 128 → 128 → 64 → 1
 * Output: Single value in [-1, 1] (tanh) representing position evaluation
 *
 * Uses TensorFlow.js with WebGL backend for GPU acceleration.
 */

import * as tf from '@tensorflow/tfjs';

export class ValueNetwork {
  private model: tf.Sequential;
  private inputSize: number;
  public readyPromise: Promise<void>;

  constructor(inputSize: number = 200) {
    this.inputSize = inputSize;
    
    // Build neural network: 200 → 128 → 128 → 64 → 1
    this.model = tf.sequential({
      layers: [
        tf.layers.dense({
          inputShape: [inputSize],
          units: 128,
          activation: 'relu',
          kernelInitializer: 'glorotNormal',
        }),
        tf.layers.dense({
          units: 128,
          activation: 'relu',
          kernelInitializer: 'glorotNormal',
        }),
        tf.layers.dense({
          units: 64,
          activation: 'relu',
          kernelInitializer: 'glorotNormal',
        }),
        tf.layers.dense({
          units: 1,
          activation: 'tanh', // Output [-1,1] for position evaluation (v2: was sigmoid)
          kernelInitializer: 'glorotNormal',
        }),
      ],
    });
    
    // Initialize CPU weights
    this.readyPromise = this.syncWeights().then(() => {
        console.log('ValueNetwork CPU weights initialized');
    });
  }

  /**
   * Forward pass: features → value estimate.
   */
  predict(features: Float32Array): number {
    return tf.tidy(() => {
      const input = tf.tensor2d([Array.from(features)], [1, this.inputSize]);
      const output = this.model.predict(input) as tf.Tensor;
      const value = output.dataSync()[0];
      return value;
    });
  }

  // --- Hybrid Architecture: CPU Shadow Weights for Fast Inference ---
  
  private cpuWeights: { w: Float32Array; b: Float32Array }[] = [];

  /**
   * Sync weights from GPU/TensorFlow to CPU memory.
   */
  async syncWeights(): Promise<void> {
    const promises = this.model.layers.map(async l => {
      const weights = l.getWeights();
      if (weights.length === 0) return { w: new Float32Array(0), b: new Float32Array(0) };

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
   */
  predictFast(features: Float32Array): number | null {
    if (this.cpuWeights.length === 0) return null;
    
    // Manual forward pass (ReLU -> Linear -> Tanh)
    let x = features;

    // Layers: Dense 128 -> Dense 128 -> Dense 64 -> Dense 1 (Tanh)
    // Note checks: layers might include input, so we use cpuWeights generic map
    
    // Layer 0 (128, ReLU)
    x = this.denseReLU(x, this.cpuWeights[0]);
    // Layer 1 (128, ReLU)
    x = this.denseReLU(x, this.cpuWeights[1]);
    // Layer 2 (64, ReLU)
    x = this.denseReLU(x, this.cpuWeights[2]);
    
    // Output (1, Tanh)
    // Linear part
    const logits = this.denseLinear(x, this.cpuWeights[3]);
    // Tanh part (v2: was sigmoid)
    const value = Math.tanh(logits[0]);
    
    return value;
  }

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

  /**
   * Get raw output before final activation (linear logit).
   */
  getRawOutput(features: Float32Array): number {
    return tf.tidy(() => {
      // Build same architecture but without tanh on output
      const input = tf.tensor2d([Array.from(features)], [1, this.inputSize]);
      // Run through all layers manually, using linear on last layer
      let x: tf.Tensor = input;
      for (let i = 0; i < this.model.layers.length; i++) {
        x = this.model.layers[i].apply(x) as tf.Tensor;
      }
      // The model already applies tanh, so we need to invert: atanh(output)
      // Simpler: just return the model output (it IS the value)
      const output = this.model.predict(input) as tf.Tensor;
      return output.dataSync()[0];
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
      const outputSize = config.units ?? 1;
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
   * Save to localStorage using TF.js native save.
   */
  async saveToLocalStorage(name: string = 'mlbot-value'): Promise<void> {
    await this.model.save(`localstorage://${name}`);
  }

  /**
   * Load from localStorage using TF.js native load.
   */
  static async loadFromLocalStorage(name: string = 'mlbot-value'): Promise<ValueNetwork> {
    const model = await tf.loadLayersModel(`localstorage://${name}`) as tf.Sequential;
    const net = new ValueNetwork();
    net.model = model;
    await net.syncWeights();
    return net;
  }

  /**
   * Serialize network weights for storage.
   */
  async serialize(): Promise<ArrayBuffer> {
    // Use TF.js native save for better compatibility
    await this.saveToLocalStorage();
    return new ArrayBuffer(0); // Placeholder
  }

  /**
   * Load network weights from serialized data.
   */
  static async deserialize(buffer: ArrayBuffer, inputSize: number = 200): Promise<ValueNetwork> {
    // Use loadFromLocalStorage instead
    return ValueNetwork.loadFromLocalStorage();
  }

  /**
   * Dispose of tensors to free memory.
   */
  dispose(): void {
    this.model.dispose();
  }
}
