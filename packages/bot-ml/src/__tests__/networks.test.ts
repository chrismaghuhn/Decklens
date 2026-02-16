import { describe, it, expect } from 'vitest';
import { PolicyNetwork, ACTION_TYPES, ACTION_COUNT } from '../networks/policy-network.ts';
import { ValueNetwork } from '../networks/value-network.ts';
import { FEATURE_DIM } from '../networks/feature-extractor.ts';

describe('PolicyNetwork', () => {
  it('should create with default input size', () => {
    const net = new PolicyNetwork();
    expect(net).toBeDefined();
  });

  it('should predict action probabilities', () => {
    const net = new PolicyNetwork(FEATURE_DIM);
    const features = new Float32Array(FEATURE_DIM);
    const probs = net.predict(features);

    // Should have all action types
    for (const type of ACTION_TYPES) {
      expect(typeof probs[type]).toBe('number');
      expect(probs[type]).toBeGreaterThanOrEqual(0);
    }
  });

  it('should output probabilities that sum to ~1', () => {
    const net = new PolicyNetwork(FEATURE_DIM);
    const features = new Float32Array(FEATURE_DIM);
    const probs = net.predict(features);

    let sum = 0;
    for (const type of ACTION_TYPES) {
      sum += probs[type];
    }
    expect(sum).toBeCloseTo(1.0, 4);
  });

  it('should return raw logits', () => {
    const net = new PolicyNetwork(FEATURE_DIM);
    const features = new Float32Array(FEATURE_DIM);
    const logits = net.getLogits(features);

    expect(logits).toBeInstanceOf(Float32Array);
    expect(logits.length).toBe(ACTION_COUNT);
  });

  it('should serialize and deserialize weights', async () => {
    const net = new PolicyNetwork(FEATURE_DIM);
    const features = new Float32Array(FEATURE_DIM);
    features[0] = 0.5;
    features[10] = 1.0;

    const probsBefore = net.predict(features);
    const buffer = await net.serialize();

    const restored = await PolicyNetwork.deserialize(buffer);
    const probsAfter = restored.predict(features);

    for (const type of ACTION_TYPES) {
      expect(probsAfter[type]).toBeCloseTo(probsBefore[type], 5);
    }
  });

  it('should have 8 action types', () => {
    expect(ACTION_COUNT).toBe(8);
    expect(ACTION_TYPES).toHaveLength(8);
  });

  it('should expose layers for gradient computation', () => {
    const net = new PolicyNetwork(FEATURE_DIM);
    const layers = net.getLayers();
    expect(layers).toHaveLength(4);
    // First layer: 200 -> 256
    expect(layers[0].inputSize).toBe(200);
    expect(layers[0].outputSize).toBe(256);
    // Output layer: 128 -> 8
    expect(layers[3].inputSize).toBe(128);
    expect(layers[3].outputSize).toBe(ACTION_COUNT);
  });
});

describe('ValueNetwork', () => {
  it('should create with default input size', () => {
    const net = new ValueNetwork();
    expect(net).toBeDefined();
  });

  it('should predict a value between -1 and 1 (tanh output)', () => {
    const net = new ValueNetwork(FEATURE_DIM);
    const features = new Float32Array(FEATURE_DIM);
    const value = net.predict(features);
    expect(value).toBeGreaterThanOrEqual(-1);
    expect(value).toBeLessThanOrEqual(1);
  });

  it('should predict in [-1,1] for varied inputs', () => {
    const net = new ValueNetwork(FEATURE_DIM);
    // Test with different feature patterns
    for (let trial = 0; trial < 5; trial++) {
      const features = new Float32Array(FEATURE_DIM);
      for (let i = 0; i < FEATURE_DIM; i++) {
        features[i] = (Math.random() * 2 - 1) * 1.5; // Random in [-1.5, 1.5]
      }
      const value = net.predict(features);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it('should return raw output (before tanh)', () => {
    const net = new ValueNetwork(FEATURE_DIM);
    const features = new Float32Array(FEATURE_DIM);
    const raw = net.getRawOutput(features);
    expect(typeof raw).toBe('number');
    // Raw can be any real number
  });

  it('should have predictFast output match predict (tanh)', async () => {
    const net = new ValueNetwork(FEATURE_DIM);
    await net.readyPromise; // Wait for CPU weights
    const features = new Float32Array(FEATURE_DIM);
    for (let i = 0; i < 20; i++) features[i] = i * 0.05;

    const gpuValue = net.predict(features);
    const cpuValue = net.predictFast(features);

    expect(cpuValue).not.toBeNull();
    expect(cpuValue!).toBeCloseTo(gpuValue, 3);
    // Both should be in tanh range
    expect(cpuValue!).toBeGreaterThanOrEqual(-1);
    expect(cpuValue!).toBeLessThanOrEqual(1);
  });

  it('should expose layers', () => {
    const net = new ValueNetwork(FEATURE_DIM);
    const layers = net.getLayers();
    expect(layers).toHaveLength(4);
    // First layer: 200 -> 128
    expect(layers[0].inputSize).toBe(200);
    expect(layers[0].outputSize).toBe(128);
    // Output layer: 64 -> 1
    expect(layers[3].inputSize).toBe(64);
    expect(layers[3].outputSize).toBe(1);
  });
});
