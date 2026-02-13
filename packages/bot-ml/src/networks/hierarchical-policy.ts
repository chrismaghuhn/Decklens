/**
 * Hierarchical Policy Network (v3)
 *
 * Architecture:
 * 1. Shared Backbone (ResNet): Extracts 256-dim embedding from 320-dim state.
 * 2. Action Type Head: 256 -> 128 -> 8 (Softmax) for action type selection.
 * 3. Card Selection Head: Shared weights for scoring multiple card candidates.
 *    Input: [Backbone(256) + CardFeatures(16)] -> 272 -> 64 -> 1
 *    Output: Softmax over candidates.
 */

import * as tf from '@tensorflow/tfjs';
import { ACTION_COUNT, PolicyNetwork, type ActionProbabilities } from './policy-network.ts';
import { AttentionModule, ATTENTION_DIM, CARD_SLOTS, CARD_FEAT_DIM } from './attention.ts';
import { CARD_FEATURE_DIM } from './feature-extractor.ts';

export class HierarchicalPolicy extends PolicyNetwork {
  private backbone!: tf.LayersModel;
  private attention!: AttentionModule;
  private actionHead!: tf.LayersModel;
  private cardHead!: tf.LayersModel;
  private combinedModel: tf.LayersModel | null = null; // For training
  private _inputSize: number;

  // Shadow weights for CPU fast inference
  private weights: {
    backbone: { input: [Float32Array, Float32Array]; blocks: any[] };
    actionHead: { d1: [Float32Array, Float32Array]; d2: [Float32Array, Float32Array] };
    cardHead: { d1: [Float32Array, Float32Array]; d2: [Float32Array, Float32Array] };
  } | null = null;

  constructor(inputSize: number) {
    super(inputSize);
    this._inputSize = inputSize;
    this.createModels();
    // Download weights immediately for fast CPU inference
    this.readyPromise = this.downloadWeights().then(() => {
      console.log('[HierarchicalPolicy] CPU weights downloaded for fast inference');
    }).catch(err => {
      console.warn('[HierarchicalPolicy] Failed to download CPU weights:', err.message);
    });
  }

  private createModels() {
    // 1. Backbone (ResNet) - Same as v2 but input is 320
    const input = tf.input({ shape: [this._inputSize] });
    let x = tf.layers.dense({ units: 256, activation: 'relu', name: 'bb_input' }).apply(input) as tf.SymbolicTensor;
    
    // 3 ResBlocks with named layers
    x = this.applyResBlock(x, 256, 'bb_res1');
    x = this.applyResBlock(x, 256, 'bb_res2');
    x = this.applyResBlock(x, 256, 'bb_res3');
    
    this.backbone = tf.model({ inputs: input, outputs: x, name: 'backbone' });

    // 2. Attention Module
    this.attention = new AttentionModule();

    // 3. Action Type Head
    // Input: Backbone(256) + Attention(32) = 288
    const actionInput = tf.input({ shape: [256 + ATTENTION_DIM] });
    let a = tf.layers.dense({ units: 128, activation: 'relu', name: 'action_d1' }).apply(actionInput) as tf.SymbolicTensor;
    const actionOutput = tf.layers.dense({ units: ACTION_COUNT, activation: 'softmax', name: 'action_d2' }).apply(a) as tf.SymbolicTensor;
    
    this.actionHead = tf.model({ inputs: actionInput, outputs: actionOutput, name: 'action_head' });

    // 4. Card Selection Head (Shared Weights)
    // Input: EnhancedEmbedding(288) + CardFeatures(16) = 304
    const cardInput = tf.input({ shape: [256 + ATTENTION_DIM + CARD_FEATURE_DIM] });
    let c = tf.layers.dense({ units: 64, activation: 'relu', name: 'card_d1' }).apply(cardInput) as tf.SymbolicTensor;
    const cardOutput = tf.layers.dense({ units: 1, name: 'card_d2' }).apply(c) as tf.SymbolicTensor;

    this.cardHead = tf.model({ inputs: cardInput, outputs: cardOutput, name: 'card_head' });
  }

  private applyResBlock(x: tf.SymbolicTensor, units: number, namePrefix: string): tf.SymbolicTensor {
    const skip = x;
    let y = tf.layers.dense({ units, activation: 'relu', name: `${namePrefix}_d1` }).apply(x) as tf.SymbolicTensor;
    y = tf.layers.dense({ units, activation: 'linear', name: `${namePrefix}_d2` }).apply(y) as tf.SymbolicTensor;
    const added = tf.layers.add({ name: `${namePrefix}_add` }).apply([skip, y]) as tf.SymbolicTensor;
    return tf.layers.reLU({ name: `${namePrefix}_relu` }).apply(added) as tf.SymbolicTensor;
  }

  /**
   * Forward pass for Action Type (standard PolicyNetwork interface).
   * Calculates Attention context internally.
   */
  override predict(stateFeatures: Float32Array): ActionProbabilities {
    return tf.tidy(() => {
      const input = tf.tensor2d([Array.from(stateFeatures)], [1, this._inputSize]);
      const embedding = this.backbone.predict(input) as tf.Tensor; // [1, 256]
      
      // Extract card features for attention [1, 4, 16]
      // Indices 256 to 320 (total 64 floats)
      const cardFeatsFlat = input.slice([0, 256], [1, 64]);
      const cardFeats = cardFeatsFlat.reshape([1, CARD_SLOTS, CARD_FEAT_DIM]);
      
      // Attention Context [1, 32]
      const context = this.attention.forward(embedding, cardFeats);
      
      // Enhanced Embedding [1, 288]
      const enhanced = tf.concat([embedding, context], 1);
      
      const logits = this.actionHead.predict(enhanced) as tf.Tensor;
      const data = logits.dataSync();
      
      return {
        pass: data[0],
        'play-land': data[1],
        'cast-spell': data[2],
        'activate-ability': data[3],
        'declare-attackers': data[4],
        'declare-blockers': data[5],
        mulligan: data[6],
        concede: data[7],
      };
    });
  }

  /**
   * Fast CPU Inference for Action Type (Avoids TF.js overhead)
   */
  override predictFast(stateFeatures: Float32Array): ActionProbabilities | null {
    if (!this.weights) return null;

    // Backbone Feature Extraction
    const wB = this.weights.backbone;
    let x = this._denseReLU(stateFeatures, wB.input[0], wB.input[1]);
    for (const block of wB.blocks) {
      x = this._resBlock(x, block.w1[0], block.w1[1], block.w2[0], block.w2[1]);
    }
    
    // Attention Context
    const cardSlots = stateFeatures.subarray(256, 320); // 4 * 16 = 64
    const context = this.attention.forwardFast(x, cardSlots);
    
    // Concat: [256] + [32] = [288]
    const enhanced = new Float32Array(256 + ATTENTION_DIM);
    enhanced.set(x);
    enhanced.set(context, 256);

    // Action Head
    const wA = this.weights.actionHead;
    let a = this._denseReLU(enhanced, wA.d1[0], wA.d1[1]);
    
    // Final dense (no relu) - calculate raw logits first
    const rawLogits = new Float32Array(ACTION_COUNT);
    const wOut = wA.d2[0];
    const bOut = wA.d2[1];
    
    for (let i = 0; i < ACTION_COUNT; i++) {
      let val = bOut[i];
      for (let j = 0; j < 128; j++) {
        val += a[j] * wOut[j * ACTION_COUNT + i];
      }
      rawLogits[i] = val;
    }

    // Find max for numerical stability (max-subtraction trick)
    let maxLogit = rawLogits[0];
    for (let i = 1; i < ACTION_COUNT; i++) {
      if (rawLogits[i] > maxLogit) maxLogit = rawLogits[i];
    }

    // Softmax with max-subtraction to prevent Infinity
    const logits = new Float32Array(ACTION_COUNT);
    let sum = 0;
    for (let i = 0; i < ACTION_COUNT; i++) {
      logits[i] = Math.exp(rawLogits[i] - maxLogit); // Stable!
      sum += logits[i];
    }
    
    const output: any = {};
    const types = ['pass', 'play-land', 'cast-spell', 'activate-ability', 'declare-attackers', 'declare-blockers', 'mulligan', 'concede'];
    
    if (sum === 0 || !isFinite(sum)) {
      const uniform = 1 / ACTION_COUNT;
      for (let i = 0; i < ACTION_COUNT; i++) {
        output[types[i]] = uniform;
      }
    } else {
      for (let i = 0; i < ACTION_COUNT; i++) {
        output[types[i]] = logits[i] / sum;
      }
    }
    return output as ActionProbabilities;
  }

  /**
   * Select best card from candidates using Card Head.
   * Input: Enhanced Embedding (288) + Card Features (N x 16).
   */
  selectCard(enhancedEmbedding: Float32Array, cardFeatures: Float32Array[]): number {
    if (cardFeatures.length === 0) return -1;
    
    const EMBEDDING_DIM = 256 + ATTENTION_DIM; // 288
    
    // Fast CPU Path
    if (this.weights) {
      const wC = this.weights.cardHead;
      
      // Validate weights structure
      if (!wC || !wC.d1 || !wC.d1[0] || !wC.d1[1] || !wC.d2 || !wC.d2[0] || !wC.d2[1] || wC.d2[1].length === 0) {
        return cardFeatures.length > 0 ? 0 : -1;
      }
      
      const scores = new Float32Array(cardFeatures.length);
      
      for (let i = 0; i < cardFeatures.length; i++) {
        const feats = cardFeatures[i]; // 16 dim
        if (!feats || feats.length !== CARD_FEATURE_DIM) continue;
        
        // Concat enhanced (288) + feats (16) -> 304
        const mixed = new Float32Array(EMBEDDING_DIM + CARD_FEATURE_DIM);
        mixed.set(enhancedEmbedding);
        mixed.set(feats, EMBEDDING_DIM);
        
        let hidden = this._denseReLU(mixed, wC.d1[0], wC.d1[1]); // -> 64
        
        // Final score (Dense -> 1)
        let score = wC.d2[1][0]; // Bias
        const wOut = wC.d2[0];
        for (let j = 0; j < 64; j++) {
          score += hidden[j] * wOut[j];
        }
        scores[i] = score;
      }
      
      // Select max score
      let maxIdx = 0;
      let maxScore = scores[0];
      for(let i=1; i<scores.length; i++) {
        if(scores[i] > maxScore) {
           maxScore = scores[i];
           maxIdx = i;
        }
      }
      return maxIdx;
    }

    // GPU Path
    try {
      return tf.tidy(() => {
        const numCandidates = cardFeatures.length;
        
        // Batch all card features: [N, 16]
        const cardFeatsArray = cardFeatures.map(cf => Array.from(cf));
        const cardFeatsTensor = tf.tensor2d(cardFeatsArray, [numCandidates, CARD_FEATURE_DIM]);
        
        // Expand embedding to match batch size: [1, 288] -> [N, 288]
        const embArray = Array.from(enhancedEmbedding);
        const embTensor = tf.tensor2d([embArray], [1, EMBEDDING_DIM]);
        const expandedEmb = embTensor.tile([numCandidates, 1]);
        
        // Concat: [N, 288] + [N, 16] -> [N, 304]
        const combined = tf.concat([expandedEmb, cardFeatsTensor], 1);
        
        // Single batch prediction: [N, 304] -> [N, 1]
        const scoresTensor = this.cardHead.predict(combined) as tf.Tensor;
        const scores = scoresTensor.dataSync();
        
        // Argmax
        let maxIdx = 0;
        let maxScore = scores[0];
        for (let i = 1; i < scores.length; i++) {
          if (scores[i] > maxScore) {
            maxScore = scores[i];
            maxIdx = i;
          }
        }
        return maxIdx;
      });
    } catch (error) {
      console.error('GPU card selection failed:', error);
      return cardFeatures.length > 0 ? 0 : -1;
    }
  }
  
  /**
   * Get Enhanced Embedding from state (for caching/reuse).
   * Returns Backbone(256) + Attention(32) = 288 dim vector.
   */
  getEmbedding(stateFeatures: Float32Array): Float32Array {
     if (this.weights) {
        const wB = this.weights.backbone;
        let x = this._denseReLU(stateFeatures, wB.input[0], wB.input[1]);
        for (const block of wB.blocks) {
          x = this._resBlock(x, block.w1[0], block.w1[1], block.w2[0], block.w2[1]);
        }
        
        // Attention
        const cardSlots = stateFeatures.subarray(256, 320);
        const context = this.attention.forwardFast(x, cardSlots);
        
        const enhanced = new Float32Array(256 + ATTENTION_DIM);
        enhanced.set(x);
        enhanced.set(context, 256);
        return enhanced;
     }

     return tf.tidy(() => {
        const input = tf.tensor2d([Array.from(stateFeatures)], [1, this._inputSize]);
        const emb = this.backbone.predict(input) as tf.Tensor;
        
        const cardFeatsFlat = input.slice([0, 256], [1, 64]);
        const cardFeats = cardFeatsFlat.reshape([1, CARD_SLOTS, CARD_FEAT_DIM]);
        const context = this.attention.forward(emb, cardFeats);
        const enhanced = tf.concat([emb, context], 1);
        
        return enhanced.dataSync() as Float32Array;
     });
  }

  /**
   * Sync shadow weights from tensors to CPU buffers.
   * Uses named layers for robust access instead of fragile indexing.
   */
  async downloadWeights() {
    // Helper to download weights from a dense layer
    const getDenseWeights = async (layer: tf.LayersModel) => {
      const w = await layer.getWeights()[0].data();
      const b = await layer.getWeights()[1].data();
      return [w, b] as [Float32Array, Float32Array];
    };

    // Access layers by name for robustness
    const bbInputLayer = this.backbone.getLayer('bb_input');
    const bbInput = await getDenseWeights(bbInputLayer as tf.LayersModel);
    
    // ResBlocks: each has d1 and d2 layers
    const bbBlocks = [];
    for (const blockName of ['bb_res1', 'bb_res2', 'bb_res3']) {
      const d1Layer = this.backbone.getLayer(`${blockName}_d1`);
      const d2Layer = this.backbone.getLayer(`${blockName}_d2`);
      bbBlocks.push({
        w1: await getDenseWeights(d1Layer as tf.LayersModel),
        w2: await getDenseWeights(d2Layer as tf.LayersModel),
      });
    }

    // Download Attention Weights
    await this.attention.downloadWeights();

    // Action Head layers
    const actionD1Layer = this.actionHead.getLayer('action_d1');
    const actionD2Layer = this.actionHead.getLayer('action_d2');

    // Card Head layers
    const cardD1Layer = this.cardHead.getLayer('card_d1');
    const cardD2Layer = this.cardHead.getLayer('card_d2');

    this.weights = {
      backbone: { input: bbInput, blocks: bbBlocks },
      actionHead: { 
        d1: await getDenseWeights(actionD1Layer as tf.LayersModel), 
        d2: await getDenseWeights(actionD2Layer as tf.LayersModel) 
      },
      cardHead: {
        d1: await getDenseWeights(cardD1Layer as tf.LayersModel),
        d2: await getDenseWeights(cardD2Layer as tf.LayersModel)
      }
    };
  }

  // Override model getter to return action head? Or allow access to all?
  // Training will need to construct a combined model usually.
  
  override getModel(): any {
    // For compatibility with PPO trainer which expects .predict()
    // We return the action-head end-to-end model
    if (!this.combinedModel) {
        const input = this.backbone.input as tf.SymbolicTensor;
        const emb = this.backbone.apply(input) as tf.SymbolicTensor;
        
        // TODO: Properly integrate Attention into the Keras Graph.
        // Currently tf.layers.lambda is not available in this context.
        // For now, we bypass attention in the graph model (Backbone -> ActionHead).
        // This means model.fit() won't train attention, but custom gradient loops using forward() will.
        
        // Placeholder for Attention Context (Zero padded or just skipped)
        // Ideally: const context = Attention(emb, cardFeats)
        
        // Hack: For now, we assume Action Head can take just 256 inputs if we didn't resize it?
        // But we DID resize Action Head input to 288.
        // So we must provide 288 dims.
        
        // Pad embedding with zeros to match shape
        const padding = tf.layers.dense({ units: ATTENTION_DIM, trainable: false, weights: [tf.zeros([256, ATTENTION_DIM]), tf.zeros([ATTENTION_DIM])] }).apply(emb) as tf.SymbolicTensor;
        const enhanced = tf.layers.concatenate().apply([emb, padding]) as tf.SymbolicTensor;
        
        const actOut = this.actionHead.apply(enhanced) as tf.SymbolicTensor;
        this.combinedModel = tf.model({ inputs: input, outputs: actOut, name: 'hierarchical_action' });
    }
    return this.combinedModel;
  }
  
  getCardModel() {
     const stateInput = this.backbone.input as tf.SymbolicTensor;
     const cardFeatInput = tf.input({ shape: [CARD_FEATURE_DIM] });
     
     const emb = this.backbone.apply(stateInput) as tf.SymbolicTensor;
     
     // TODO: Integrate Attention
     const padding = tf.layers.dense({ units: ATTENTION_DIM, trainable: false, weights: [tf.zeros([256, ATTENTION_DIM]), tf.zeros([ATTENTION_DIM])] }).apply(emb) as tf.SymbolicTensor;
     const enhanced = tf.layers.concatenate().apply([emb, padding]) as tf.SymbolicTensor;
     
     const concat = tf.layers.concatenate().apply([enhanced, cardFeatInput]) as tf.SymbolicTensor;
     const score = this.cardHead.apply(concat) as tf.SymbolicTensor;
     
     return tf.model({ inputs: [stateInput, cardFeatInput], outputs: score, name: 'hierarchical_card' });
  }

  override async serialize(): Promise<ArrayBuffer> {
    // Helper to get weights buffer from a model (iterates all weights)
    const getModelWeightsBuffer = async (model: tf.LayersModel): Promise<ArrayBuffer> => {
        const weights = model.getWeights();
        let totalSize = 0;
        const weightBuffers = [];
        
        for(const w of weights) {
            const data = await w.data();
            const bytes = new Uint8Array(data.buffer);
            weightBuffers.push(bytes);
            totalSize += 4 + bytes.length; // length header + data
        }
        
        const buf = new ArrayBuffer(totalSize);
        const view = new DataView(buf);
        let offset = 0;
        
        for(const bytes of weightBuffers) {
            view.setUint32(offset, bytes.length, true); offset += 4;
            new Uint8Array(buf).set(bytes, offset); offset += bytes.length;
        }
        return buf;
    };

    const bbBuf = await getModelWeightsBuffer(this.backbone);
    const attnBuf = await this.attention.saveWeights();
    const actBuf = await getModelWeightsBuffer(this.actionHead);
    const cardBuf = await getModelWeightsBuffer(this.cardHead);
    
    // Combine into single buffer with metadata
    // Format: [version:4][bbSize:4][attnSize:4][actSize:4][cardSize:4][Data...]
    const version = 3; 
    
    const headerSize = 20; // 5 * 4 bytes
    const totalSize = headerSize + bbBuf.byteLength + attnBuf.byteLength + actBuf.byteLength + cardBuf.byteLength;
    
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    
    let offset = 0;
    view.setUint32(offset, version, true); offset += 4;
    view.setUint32(offset, bbBuf.byteLength, true); offset += 4;
    view.setUint32(offset, attnBuf.byteLength, true); offset += 4;
    view.setUint32(offset, actBuf.byteLength, true); offset += 4;
    view.setUint32(offset, cardBuf.byteLength, true); offset += 4;
    
    u8.set(new Uint8Array(bbBuf), offset); offset += bbBuf.byteLength;
    u8.set(new Uint8Array(attnBuf), offset); offset += attnBuf.byteLength;
    u8.set(new Uint8Array(actBuf), offset); offset += actBuf.byteLength;
    u8.set(new Uint8Array(cardBuf), offset);
    
    return buffer;
  }
  
  getInternals() {
    return {
      backbone: this.backbone,
      attention: this.attention,
      actionHead: this.actionHead,
      cardHead: this.cardHead
    };
  }



  
  // --- Helper Methods (Renamed to avoid conflict) ---
  
  private _denseReLU(input: Float32Array, w: Float32Array, b: Float32Array): Float32Array {
    const inputSize = input.length;
    const outputSize = b.length;
    const output = new Float32Array(outputSize);
    for (let o = 0; o < outputSize; o++) {
      let sum = b[o];
      for (let i = 0; i < inputSize; i++) {
        sum += input[i] * w[i * outputSize + o];
      }
      output[o] = Math.max(0, sum);
    }
    return output;
  }

  private _resBlock(input: Float32Array, w1: Float32Array, b1: Float32Array, w2: Float32Array, b2: Float32Array): Float32Array {
     // 1. Dense + ReLU
     const h1 = this._denseReLU(input, w1, b1);
     // 2. Dense (Linear)
     const outputSize = b2.length;
     const h2 = new Float32Array(outputSize);
     const h1Size = h1.length;
     for (let o = 0; o < outputSize; o++) {
         let sum = b2[o];
         for (let i = 0; i < h1Size; i++) {
             sum += h1[i] * w2[i * outputSize + o];
         }
         h2[o] = sum;
     }
     // 3. Add Skip + ReLU
     const out = new Float32Array(outputSize);
     for(let i=0; i<outputSize; i++) {
         out[i] = Math.max(0, h2[i] + input[i]);
     }
     return out;
  }
}
