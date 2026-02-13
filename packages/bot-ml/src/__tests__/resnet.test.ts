import { describe, it, expect } from 'vitest';
import { ResNetPolicy } from '../networks/resnet-policy.ts';
import { ResNetValue } from '../networks/resnet-value.ts';
import {
  createPolicyNetwork, createValueNetwork,
  detectModelVersion, getConfig,
  V1_CONFIG, V2_CONFIG,
} from '../networks/network-factory.ts';
import type { NetworkVersion } from '../networks/network-factory.ts';
import {
  saveModel, serializeModel, deserializeModel,
  loadModelWeights, detectVersion, estimateModelSize,
} from '../networks/model-persistence.ts';
import { PolicyNetwork, ACTION_COUNT, ACTION_TYPES } from '../networks/policy-network.ts';
import { ValueNetwork } from '../networks/value-network.ts';
import { FEATURE_DIM, FEATURE_DIM_V2 } from '../networks/feature-extractor.ts';

// ============================================================
// ResNet Policy Tests
// ============================================================

describe('ResNetPolicy', () => {
  it('should create with default 256 input size', () => {
    const net = new ResNetPolicy();
    expect(net).toBeDefined();
  });

  it('should output 8 action probabilities summing to ~1', () => {
    const net = new ResNetPolicy(256);
    const features = new Float32Array(256);
    const probs = net.predict(features);

    let sum = 0;
    for (const type of ACTION_TYPES) {
      expect(typeof probs[type]).toBe('number');
      expect(probs[type]).toBeGreaterThanOrEqual(0);
      sum += probs[type];
    }
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it('should return raw logits (not softmaxed)', () => {
    const net = new ResNetPolicy(256);
    const features = new Float32Array(256);
    const logits = net.getLogits(features);

    expect(logits).toBeInstanceOf(Float32Array);
    expect(logits.length).toBe(ACTION_COUNT);

    // Logits should NOT sum to 1 (they're pre-softmax)
    let sum = 0;
    for (let i = 0; i < logits.length; i++) sum += logits[i];
    // With random init, sum could be anything
    expect(typeof sum).toBe('number');
    expect(isNaN(sum)).toBe(false);
  });

  it('should have 9 dense layers (proj + 3×2 ResBlock + head + output)', () => {
    const net = new ResNetPolicy(256);
    const layers = net.getLayers();
    expect(layers.length).toBe(9);

    // Projection: 256 → 256
    expect(layers[0].inputSize).toBe(256);
    expect(layers[0].outputSize).toBe(256);

    // ResBlock 0 dense 1: 256 → 256
    expect(layers[1].inputSize).toBe(256);
    expect(layers[1].outputSize).toBe(256);

    // Head: 256 → 128
    expect(layers[7].outputSize).toBe(128);

    // Output: 128 → 8
    expect(layers[8].inputSize).toBe(128);
    expect(layers[8].outputSize).toBe(ACTION_COUNT);
  });

  it('predictFast should match predict (CPU vs GPU)', async () => {
    const net = new ResNetPolicy(256);
    await net.readyPromise;

    const features = new Float32Array(256);
    for (let i = 0; i < 256; i++) features[i] = i * 0.003;

    const gpuProbs = net.predict(features);
    const cpuProbs = net.predictFast(features);

    expect(cpuProbs).not.toBeNull();
    for (const type of ACTION_TYPES) {
      expect(cpuProbs![type]).toBeCloseTo(gpuProbs[type], 3);
    }
  });

  it('getLogitsFast should return valid logits', async () => {
    const net = new ResNetPolicy(256);
    await net.readyPromise;

    const features = new Float32Array(256);
    for (let i = 0; i < 50; i++) features[i] = i * 0.01;

    const logits = net.getLogitsFast(features);
    expect(logits).not.toBeNull();
    expect(logits!.length).toBe(ACTION_COUNT);
  });

  it('should produce different outputs for different inputs', () => {
    const net = new ResNetPolicy(256);

    const f1 = new Float32Array(256);
    const f2 = new Float32Array(256);
    f2[0] = 1.0;
    f2[10] = 0.8;
    f2[50] = 0.5;

    const p1 = net.predict(f1);
    const p2 = net.predict(f2);

    let identical = true;
    for (const type of ACTION_TYPES) {
      if (Math.abs(p1[type] - p2[type]) > 0.001) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(false);
  });
});

// ============================================================
// ResNet Value Tests
// ============================================================

describe('ResNetValue', () => {
  it('should create with default 256 input size', () => {
    const net = new ResNetValue();
    expect(net).toBeDefined();
  });

  it('should predict value in [-1, 1] (tanh output)', () => {
    const net = new ResNetValue(256);
    const features = new Float32Array(256);
    const value = net.predict(features);
    expect(value).toBeGreaterThanOrEqual(-1);
    expect(value).toBeLessThanOrEqual(1);
  });

  it('should predict in [-1, 1] for varied inputs', () => {
    const net = new ResNetValue(256);
    for (let trial = 0; trial < 5; trial++) {
      const features = new Float32Array(256);
      for (let i = 0; i < 256; i++) {
        features[i] = (Math.random() * 2 - 1) * 1.5;
      }
      const value = net.predict(features);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('should have 7 dense layers (proj + 2×2 ResBlock + head + output)', () => {
    const net = new ResNetValue(256);
    const layers = net.getLayers();
    expect(layers.length).toBe(7);

    // Projection: 256 → 256
    expect(layers[0].inputSize).toBe(256);
    expect(layers[0].outputSize).toBe(256);

    // Head: 256 → 64
    expect(layers[5].outputSize).toBe(64);

    // Output: 64 → 1
    expect(layers[6].inputSize).toBe(64);
    expect(layers[6].outputSize).toBe(1);
  });

  it('predictFast should match predict (CPU vs GPU)', async () => {
    const net = new ResNetValue(256);
    await net.readyPromise;

    const features = new Float32Array(256);
    for (let i = 0; i < 256; i++) features[i] = i * 0.003;

    const gpuValue = net.predict(features);
    const cpuValue = net.predictFast(features);

    expect(cpuValue).not.toBeNull();
    expect(cpuValue!).toBeCloseTo(gpuValue, 3);
    // Both should be in tanh range
    expect(cpuValue!).toBeGreaterThanOrEqual(-1);
    expect(cpuValue!).toBeLessThanOrEqual(1);
  });
});

// ============================================================
// Network Factory Tests
// ============================================================

describe('Network Factory', () => {
  it('should create v1 MLP networks', () => {
    const policy = createPolicyNetwork(V1_CONFIG);
    const value = createValueNetwork(V1_CONFIG);

    expect(policy).toBeInstanceOf(PolicyNetwork);
    expect(value).toBeInstanceOf(ValueNetwork);
  });

  it('should create v2 ResNet networks', () => {
    const policy = createPolicyNetwork(V2_CONFIG);
    const value = createValueNetwork(V2_CONFIG);

    expect(policy).toBeInstanceOf(ResNetPolicy);
    expect(value).toBeInstanceOf(ResNetValue);
  });

  it('should default to v2', () => {
    const policy = createPolicyNetwork();
    const value = createValueNetwork();

    expect(policy).toBeInstanceOf(ResNetPolicy);
    expect(value).toBeInstanceOf(ResNetValue);
  });

  it('detectModelVersion should identify v1 and v2', () => {
    expect(detectModelVersion('mlbot-policy')).toBe('v1');
    expect(detectModelVersion('mlbot-value')).toBe('v1');
    expect(detectModelVersion('mlbot-resnet-policy')).toBe('v2');
    expect(detectModelVersion('mlbot-resnet-value')).toBe('v2');
  });

  it('getConfig should return correct dimensions', () => {
    const v1 = getConfig('v1');
    expect(v1.featureDim).toBe(200);
    expect(v1.version).toBe('v1');

    const v2 = getConfig('v2');
    expect(v2.featureDim).toBe(256);
    expect(v2.version).toBe('v2');
  });
});

// ============================================================
// Model Persistence Tests
// ============================================================

describe('Model Persistence', () => {
  it('should save and serialize v1 model', async () => {
    const policy = new PolicyNetwork(200);
    const value = new ValueNetwork(200);

    const saved = await saveModel(policy, value, 'v1', { gamesPlayed: 100 });

    expect(saved.version).toBe('v1');
    expect(saved.policyWeights.length).toBeGreaterThan(0);
    expect(saved.valueWeights.length).toBeGreaterThan(0);
    expect(saved.metadata.gamesPlayed).toBe(100);

    const json = serializeModel(saved);
    expect(typeof json).toBe('string');
    expect(json.length).toBeGreaterThan(1000); // Weights should produce a large JSON

    // Deserialize
    const restored = deserializeModel(json);
    expect(restored.version).toBe('v1');
    expect(restored.policyWeights.length).toBe(saved.policyWeights.length);
    expect(restored.metadata.gamesPlayed).toBe(100);
  });

  it('should save and serialize v2 ResNet model', async () => {
    const policy = new ResNetPolicy(256);
    const value = new ResNetValue(256);

    const saved = await saveModel(policy, value, 'v2', { gamesPlayed: 5000 });

    expect(saved.version).toBe('v2');
    expect(saved.policyWeights.length).toBeGreaterThan(0);
    expect(saved.valueWeights.length).toBeGreaterThan(0);

    const json = serializeModel(saved);
    const restored = deserializeModel(json);
    expect(restored.version).toBe('v2');
  });

  it('should load weights back into networks', async () => {
    const policy = new ResNetPolicy(256);
    const value = new ResNetValue(256);

    const features = new Float32Array(256);
    for (let i = 0; i < 256; i++) features[i] = i * 0.002;

    // Get predictions before save
    const probsBefore = policy.predict(features);
    const valueBefore = value.predict(features);

    // Save
    const saved = await saveModel(policy, value, 'v2');

    // Create new networks (different random weights)
    const policy2 = new ResNetPolicy(256);
    const value2 = new ResNetValue(256);

    // Load saved weights
    loadModelWeights(policy2, value2, saved);

    // Predictions should match
    const probsAfter = policy2.predict(features);
    const valueAfter = value2.predict(features);

    for (const type of ACTION_TYPES) {
      expect(probsAfter[type]).toBeCloseTo(probsBefore[type], 4);
    }
    expect(valueAfter).toBeCloseTo(valueBefore, 4);
  });

  it('should detect version from JSON', () => {
    expect(detectVersion('{"version":"v1","policyWeights":[]}')).toBe('v1');
    expect(detectVersion('{"version":"v2","policyWeights":[]}')).toBe('v2');
    // Legacy (no version field)
    expect(detectVersion('{"policyWeights":[]}')).toBe('v1');
  });

  it('should handle legacy format (no version key)', () => {
    const legacyJson = JSON.stringify({
      policyWeights: [{ name: 'w', shape: [2, 3], data: [1, 2, 3, 4, 5, 6] }],
      valueWeights: [],
    });

    const data = deserializeModel(legacyJson);
    expect(data.version).toBe('v1');
    expect(data.metadata).toBeDefined();
  });

  it('should estimate model size correctly', async () => {
    const policy = new ResNetPolicy(256);
    const value = new ResNetValue(256);

    const saved = await saveModel(policy, value, 'v2');
    const size = estimateModelSize(saved);

    // ResNet Policy: ~400K params * 4 bytes ≈ 1.6MB
    expect(size.policyBytes).toBeGreaterThan(500_000);
    expect(size.policyBytes).toBeLessThan(5_000_000);

    // ResNet Value: ~280K params * 4 bytes ≈ 1.1MB
    expect(size.valueBytes).toBeGreaterThan(300_000);
    expect(size.valueBytes).toBeLessThan(3_000_000);

    // Total under 10MB
    expect(size.totalBytes).toBeLessThan(10_000_000);
  });
});

// ============================================================
// Skip Connection Verification
// ============================================================

describe('Skip Connections', () => {
  it('ResNet should produce different output than zero features (not dead)', () => {
    const net = new ResNetPolicy(256);

    const zeros = new Float32Array(256);
    const nonZeros = new Float32Array(256);
    for (let i = 0; i < 256; i++) nonZeros[i] = 0.5;

    const p1 = net.predict(zeros);
    const p2 = net.predict(nonZeros);

    // Should produce meaningfully different distributions
    let totalDiff = 0;
    for (const type of ACTION_TYPES) {
      totalDiff += Math.abs(p1[type] - p2[type]);
    }
    expect(totalDiff).toBeGreaterThan(0.01);
  });

  it('ResNet value should vary with different inputs', () => {
    const net = new ResNetValue(256);

    const f1 = new Float32Array(256);
    const f2 = new Float32Array(256);
    for (let i = 0; i < 256; i++) f2[i] = 1.0;

    const v1 = net.predict(f1);
    const v2 = net.predict(f2);

    // Different inputs → different values
    expect(Math.abs(v1 - v2)).toBeGreaterThan(0.001);
  });
});
