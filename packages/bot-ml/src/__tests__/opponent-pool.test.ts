import { describe, it, expect } from 'vitest';
import * as tf from '@tensorflow/tfjs';
import { OpponentPool } from '../training/opponent-pool.ts';
import { PolicyNetwork } from '../networks/policy-network.ts';
import { ValueNetwork } from '../networks/value-network.ts';
import { FEATURE_DIM } from '../networks/feature-extractor.ts';

describe('OpponentPool', () => {
  it('should create with default settings', () => {
    const pool = new OpponentPool();
    expect(pool.size).toBe(0);
    expect(pool.historicalRate).toBe(0.2);
  });

  it('should create with custom settings', () => {
    const pool = new OpponentPool(3, 0.5);
    expect(pool.size).toBe(0);
    expect(pool.historicalRate).toBe(0.5);
  });

  it('should take a snapshot when interval is met', () => {
    const pool = new OpponentPool(5);
    const policy = new PolicyNetwork(FEATURE_DIM);
    const value = new ValueNetwork(FEATURE_DIM);

    // First snapshot at game 2000
    const took = pool.maybeSnapshot(policy.getModel(), value.getModel(), 2000, 2000);
    expect(took).toBe(true);
    expect(pool.size).toBe(1);
  });

  it('should NOT take a snapshot before interval', () => {
    const pool = new OpponentPool(5);
    const policy = new PolicyNetwork(FEATURE_DIM);
    const value = new ValueNetwork(FEATURE_DIM);

    const took = pool.maybeSnapshot(policy.getModel(), value.getModel(), 500, 2000);
    expect(took).toBe(false);
    expect(pool.size).toBe(0);
  });

  it('should limit max snapshots', () => {
    const pool = new OpponentPool(3); // Max 3
    const policy = new PolicyNetwork(FEATURE_DIM);
    const value = new ValueNetwork(FEATURE_DIM);

    pool.maybeSnapshot(policy.getModel(), value.getModel(), 2000, 2000);
    pool.maybeSnapshot(policy.getModel(), value.getModel(), 4000, 2000);
    pool.maybeSnapshot(policy.getModel(), value.getModel(), 6000, 2000);
    pool.maybeSnapshot(policy.getModel(), value.getModel(), 8000, 2000);
    pool.maybeSnapshot(policy.getModel(), value.getModel(), 10000, 2000);

    expect(pool.size).toBe(3); // Oldest 2 removed
  });

  it('should return null when no snapshots', () => {
    const pool = new OpponentPool(5);
    expect(pool.getRandomOpponent()).toBeNull();
  });

  it('should return null when random chance selects self-play', () => {
    const pool = new OpponentPool(5, 0.0); // 0% historical rate
    const policy = new PolicyNetwork(FEATURE_DIM);
    const value = new ValueNetwork(FEATURE_DIM);

    pool.maybeSnapshot(policy.getModel(), value.getModel(), 2000, 2000);

    // With 0% rate, should always return null
    for (let i = 0; i < 10; i++) {
      expect(pool.getRandomOpponent()).toBeNull();
    }
  });

  it('should return a snapshot when rate is 100%', () => {
    const pool = new OpponentPool(5, 1.0); // 100% historical rate
    const policy = new PolicyNetwork(FEATURE_DIM);
    const value = new ValueNetwork(FEATURE_DIM);

    pool.maybeSnapshot(policy.getModel(), value.getModel(), 2000, 2000);

    // With 100% rate, should always return a snapshot
    const snapshot = pool.getRandomOpponent();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.gamesPlayed).toBe(2000);
    expect(snapshot!.policyWeights.length).toBeGreaterThan(0);
    expect(snapshot!.valueWeights.length).toBeGreaterThan(0);
  });

  it('should apply snapshot weights to models', () => {
    const pool = new OpponentPool(5, 1.0);
    const policy = new PolicyNetwork(FEATURE_DIM);
    const value = new ValueNetwork(FEATURE_DIM);

    // Get original predictions
    const features = new Float32Array(FEATURE_DIM);
    for (let i = 0; i < 20; i++) features[i] = i * 0.05;
    const originalProbs = policy.predict(features);

    // Take snapshot
    pool.maybeSnapshot(policy.getModel(), value.getModel(), 2000, 2000);
    const snapshot = pool.getRandomOpponent()!;

    // Create new networks (different random weights)
    const policy2 = new PolicyNetwork(FEATURE_DIM);
    const value2 = new ValueNetwork(FEATURE_DIM);

    // Apply snapshot weights
    OpponentPool.applySnapshot(snapshot, policy2.getModel(), value2.getModel());

    // Predictions should now match
    const restoredProbs = policy2.predict(features);
    expect(restoredProbs.pass).toBeCloseTo(originalProbs.pass, 3);
  });

  it('getSnapshots should return all snapshots', () => {
    const pool = new OpponentPool(5);
    const policy = new PolicyNetwork(FEATURE_DIM);
    const value = new ValueNetwork(FEATURE_DIM);

    pool.maybeSnapshot(policy.getModel(), value.getModel(), 2000, 2000);
    pool.maybeSnapshot(policy.getModel(), value.getModel(), 4000, 2000);

    const snapshots = pool.getSnapshots();
    expect(snapshots.length).toBe(2);
    expect(snapshots[0].gamesPlayed).toBe(2000);
    expect(snapshots[1].gamesPlayed).toBe(4000);
  });
});
