import { describe, it, expect, beforeEach } from 'vitest';
import * as tf from '@tensorflow/tfjs';
import { HierarchicalPolicy } from '../networks/hierarchical-policy.ts';
import { extractCardFeatures, CARD_FEATURE_DIM } from '../networks/feature-extractor.ts';
import { FEATURE_DIM_V3 } from '../networks/feature-extractor.ts';

describe('HierarchicalPolicy (v3)', () => {
  let policy: HierarchicalPolicy;

  beforeEach(() => {
    policy = new HierarchicalPolicy(FEATURE_DIM_V3);
  });

  it('initializes with correct input size', () => {
    expect(policy).toBeDefined();
    // inputSize is private, but we can verify it runs
  });

  it('predict features returns valid probabilities', () => {
    const features = new Float32Array(FEATURE_DIM_V3).fill(0.1);
    const result = policy.predict(features);
    
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('cast-spell');
    
    // Sum should be close to 1
    const sum = Object.values(result).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it('selectCard scores candidates', () => {
    const embedding = new Float32Array(256).fill(0.1);
    const candidates = [
        new Float32Array(CARD_FEATURE_DIM).fill(0.1),
        new Float32Array(CARD_FEATURE_DIM).fill(0.9), // Should score different
    ];
    
    const idx = policy.selectCard(embedding, candidates);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(candidates.length);
  });
  
  it('handles empty candidates', () => {
    const embedding = new Float32Array(256).fill(0.1);
    const idx = policy.selectCard(embedding, []);
    expect(idx).toBe(-1);
  });

  it('getInternals returns all models', () => {
      const internals = (policy as any).getInternals();
      expect(internals).toHaveProperty('backbone');
      expect(internals).toHaveProperty('actionHead');
      expect(internals).toHaveProperty('cardHead');
  });

  it('fast inference (CPU) works after weight sync', async () => {
     await policy.downloadWeights();
     const features = new Float32Array(FEATURE_DIM_V3).fill(0.1);
     const fastResult = policy.predictFast(features);
     
     expect(fastResult).not.toBeNull();
     
     // Compare with TF result
     const tfResult = policy.predict(features);
     
     // Check one key
     expect(fastResult!['cast-spell']).toBeCloseTo(tfResult['cast-spell'], 1);
  });
});
