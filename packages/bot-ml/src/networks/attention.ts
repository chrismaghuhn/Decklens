/**
 * Lightweight Attention Module
 * 
 * Implements Scaled Dot-Product Attention for the Hierarchical Policy (v3).
 * Allows the network to focus on specific card slots (e.g. best spell in hand, biggest threat)
 * based on the current game context.
 * 
 * Architecture:
 * - Query (Q): Projected from Backbone Embedding (256 -> 32)
 * - Key (K): Projected from Card Features (16 -> 32)
 * - Value (V): Projected from Card Features (16 -> 32)
 * 
 * Output: 32-dimensional Context Vector
 */

import * as tf from '@tensorflow/tfjs';

export const ATTENTION_DIM = 32;
export const CARD_SLOTS = 4;
export const CARD_FEAT_DIM = 16;

export class AttentionModule {
  private queryLayer!: tf.LayersModel;
  private keyLayer!: tf.LayersModel;
  private valueLayer!: tf.LayersModel;
  
  // Shadow weights for CPU fast inference
  private weights: {
    q: [Float32Array, Float32Array]; // weight, bias
    k: [Float32Array, Float32Array];
    v: [Float32Array, Float32Array];
  } | null = null;

  constructor() {
    this.createModels();
  }

  private createModels() {
    // 1. Query Projection (Backbone 256 -> 32)
    const qInput = tf.input({ shape: [256] });
    const qOutput = tf.layers.dense({ 
      units: ATTENTION_DIM, 
      activation: 'linear', 
      name: 'attn_q' 
    }).apply(qInput) as tf.SymbolicTensor;
    this.queryLayer = tf.model({ inputs: qInput, outputs: qOutput, name: 'attention_q' });

    // 2. Key Projection (Card Features 16 -> 32)
    const kInput = tf.input({ shape: [CARD_FEAT_DIM] });
    const kOutput = tf.layers.dense({ 
      units: ATTENTION_DIM, 
      activation: 'linear', 
      name: 'attn_k' 
    }).apply(kInput) as tf.SymbolicTensor;
    this.keyLayer = tf.model({ inputs: kInput, outputs: kOutput, name: 'attention_k' });

    // 3. Value Projection (Card Features 16 -> 32)
    const vInput = tf.input({ shape: [CARD_FEAT_DIM] });
    const vOutput = tf.layers.dense({ 
      units: ATTENTION_DIM, 
      activation: 'linear', 
      name: 'attn_v' 
    }).apply(vInput) as tf.SymbolicTensor;
    this.valueLayer = tf.model({ inputs: vInput, outputs: vOutput, name: 'attention_v' });
  }

  /**
   * Forward pass (TensorFlow.js)
   * @param backboneEmbedding [batch, 256]
   * @param cardFeatures [batch, 4, 16] - 4 slots of 16-dim features
   * @returns Context Vector [batch, 32]
   */
  forward(backboneEmbedding: tf.Tensor, cardFeatures: tf.Tensor): tf.Tensor {
    return tf.tidy(() => {
      // 1. Project Query: [batch, 256] -> [batch, 32] -> [batch, 1, 32]
      const Q = (this.queryLayer.predict(backboneEmbedding) as tf.Tensor).expandDims(1);
      
      // 2. Project Keys & Values
      // We process each slot independently. TimeDistributed wrapper is heavy, so we reshape.
      // [batch, 4, 16] -> [batch * 4, 16]
      const batchSize = cardFeatures.shape[0];
      const flatFeatures = cardFeatures.reshape([batchSize * CARD_SLOTS, CARD_FEAT_DIM]);
      
      const flatK = this.keyLayer.predict(flatFeatures) as tf.Tensor; // [batch * 4, 32]
      const flatV = this.valueLayer.predict(flatFeatures) as tf.Tensor; // [batch * 4, 32]
      
      const K = flatK.reshape([batchSize, CARD_SLOTS, ATTENTION_DIM]); // [batch, 4, 32]
      const V = flatV.reshape([batchSize, CARD_SLOTS, ATTENTION_DIM]); // [batch, 4, 32]
      
      // 3. Calculate Scores: Q * K^T
      // [batch, 1, 32] * [batch, 32, 4] -> [batch, 1, 4]
      const scoresRaw = tf.matMul(Q, K, false, true);
      
      // Scale by sqrt(d_k)
      const scale = Math.sqrt(ATTENTION_DIM);
      const scoresScaled = scoresRaw.div(scale);
      
      // Softmax
      const weights = tf.softmax(scoresScaled); // [batch, 1, 4]
      
      // 4. Calculate Context: Weights * V
      // [batch, 1, 4] * [batch, 4, 32] -> [batch, 1, 32]
      const context = tf.matMul(weights, V);
      
      return context.reshape([batchSize, ATTENTION_DIM]); // [batch, 32]
    });
  }

  /**
   * Fast CPU Forward pass (No TF.js overhead)
   * @param embedding Float32Array(256)
   * @param slots Float32Array(64) [4 x 16 flattened]
   * @returns Float32Array(32)
   */
  forwardFast(embedding: Float32Array, slots: Float32Array): Float32Array {
    if (!this.weights) return new Float32Array(ATTENTION_DIM);

    // 1. Project Q
    const q = this._denseLinear(embedding, this.weights.q[0], this.weights.q[1]); // [32]
    
    // 2. Process Slots (K, V)
    const k = new Float32Array(CARD_SLOTS * ATTENTION_DIM); // [128]
    const v = new Float32Array(CARD_SLOTS * ATTENTION_DIM); // [128]
    
    for (let i = 0; i < CARD_SLOTS; i++) {
      const offset = i * CARD_FEAT_DIM;
      const slotFeats = slots.subarray(offset, offset + CARD_FEAT_DIM);
      
      // Check if slot is empty (all zeros) -> Optimization
      let isZero = true;
      for(let j=0; j<CARD_FEAT_DIM; j++) {
          if(slotFeats[j] !== 0) { isZero = false; break; }
      }
      
      if (!isZero) {
          const k_i = this._denseLinear(slotFeats, this.weights.k[0], this.weights.k[1]);
          const v_i = this._denseLinear(slotFeats, this.weights.v[0], this.weights.v[1]);
          k.set(k_i, i * ATTENTION_DIM);
          v.set(v_i, i * ATTENTION_DIM);
      }
      // else k, v remain 0 for this slot
    }
    
    // 3. Scores (Dot Product Q * K)
    const scores = new Float32Array(CARD_SLOTS);
    let maxScore = -Infinity;
    
    for (let i = 0; i < CARD_SLOTS; i++) {
      let dot = 0;
      for (let j = 0; j < ATTENTION_DIM; j++) {
        dot += q[j] * k[i * ATTENTION_DIM + j];
      }
      scores[i] = dot / Math.sqrt(ATTENTION_DIM);
      if (scores[i] > maxScore) maxScore = scores[i];
    }
    
    // Softmax
    let sumExp = 0;
    for (let i = 0; i < CARD_SLOTS; i++) {
      scores[i] = Math.exp(scores[i] - maxScore); // Stable softmax
      sumExp += scores[i];
    }
    for (let i = 0; i < CARD_SLOTS; i++) {
      scores[i] /= sumExp;
    }
    
    // 4. Context (Weighted Sum of V)
    const context = new Float32Array(ATTENTION_DIM);
    for (let j = 0; j < ATTENTION_DIM; j++) {
      let sum = 0;
      for (let i = 0; i < CARD_SLOTS; i++) {
        sum += scores[i] * v[i * ATTENTION_DIM + j];
      }
      context[j] = sum;
    }
    
    return context;
  }
  
  /**
   * Helper: Dense Linear Layer (Matrix Mul + Bias)
   */
  private _denseLinear(input: Float32Array, w: Float32Array, b: Float32Array): Float32Array {
    const inputSize = input.length;
    const outputSize = b.length;
    const output = new Float32Array(outputSize);
    
    for (let o = 0; o < outputSize; o++) {
      let sum = b[o];
      for (let i = 0; i < inputSize; i++) {
        sum += input[i] * w[i * outputSize + o];
      }
      output[o] = sum;
    }
    return output;
  }

  /**
   * Sync weights from tensors to CPU
   */
  async downloadWeights() {
    const getWeights = async (layer: tf.LayersModel) => {
      const w = await layer.getWeights()[0].data();
      const b = await layer.getWeights()[1].data();
      return [w, b] as [Float32Array, Float32Array];
    };
    
    this.weights = {
      q: await getWeights(this.queryLayer),
      k: await getWeights(this.keyLayer),
      v: await getWeights(this.valueLayer)
    };
  }
  
  /**
   * Get internal models for saving/training
   */
  getInternals() {
    return {
      query: this.queryLayer,
      key: this.keyLayer,
      value: this.valueLayer
    };
  }
  
  /**
   * Save weights to buffer
   */
  async saveWeights(): Promise<ArrayBuffer> {
     // Helper to get weights as buffer
     const getLayerWeightsBuffer = async (layer: tf.LayersModel): Promise<ArrayBuffer> => {
        const weights = layer.getWeights(); // [kernel, bias]
        const wData = await weights[0].data();
        const bData = await weights[1].data();
        
        const wBytes = new Uint8Array(wData.buffer);
        const bBytes = new Uint8Array(bData.buffer);
        
        const size = 4 + 4 + wBytes.length + bBytes.length; // size headers + data
        const buf = new ArrayBuffer(size);
        const view = new DataView(buf);
        
        let offset = 0;
        view.setUint32(offset, wBytes.length, true); offset += 4;
        new Uint8Array(buf).set(wBytes, offset); offset += wBytes.length;
        
        view.setUint32(offset, bBytes.length, true); offset += 4;
        new Uint8Array(buf).set(bBytes, offset);
        
        return buf;
     };

     const bufQ = await getLayerWeightsBuffer(this.queryLayer);
     const bufK = await getLayerWeightsBuffer(this.keyLayer);
     const bufV = await getLayerWeightsBuffer(this.valueLayer);
     
     const totalSize = bufQ.byteLength + bufK.byteLength + bufV.byteLength;
     const buffer = new ArrayBuffer(totalSize);
     const u8 = new Uint8Array(buffer);
     
     let offset = 0;
     u8.set(new Uint8Array(bufQ), offset); offset += bufQ.byteLength;
     u8.set(new Uint8Array(bufK), offset); offset += bufK.byteLength;
     u8.set(new Uint8Array(bufV), offset);
     
     return buffer;
  }
}
