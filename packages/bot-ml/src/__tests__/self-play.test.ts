import { describe, it, expect, beforeEach } from 'vitest';
import { SelfPlayPipeline } from '../training/self-play.ts';
import { PolicyNetwork } from '../networks/policy-network.ts';
import { ValueNetwork } from '../networks/value-network.ts';
import { FEATURE_DIM } from '../networks/feature-extractor.ts';
import { resetIds, createMainPhaseState, passAction } from './test-helpers.ts';
import type { GameState } from '@mtg/game-engine';

beforeEach(() => resetIds());

describe('SelfPlayPipeline', () => {
  it('should create with default config', () => {
    const pipeline = new SelfPlayPipeline(
      new PolicyNetwork(FEATURE_DIM),
      new ValueNetwork(FEATURE_DIM),
    );
    expect(pipeline).toBeDefined();
  });

  it('should start with empty buffer', () => {
    const pipeline = new SelfPlayPipeline(
      new PolicyNetwork(FEATURE_DIM),
      new ValueNetwork(FEATURE_DIM),
    );
    const stats = pipeline.getBufferStats();
    expect(stats.episodes).toBe(0);
    expect(stats.experiences).toBe(0);
  });

  it('should record an episode from states and actions', async () => {
    const pipeline = new SelfPlayPipeline(
      new PolicyNetwork(FEATURE_DIM),
      new ValueNetwork(FEATURE_DIM),
    );

    const states: GameState[] = [
      createMainPhaseState(),
      createMainPhaseState(),
      createMainPhaseState(),
    ];
    const actions = [
      passAction(0),
      passAction(1),
      passAction(0),
    ];

    await pipeline.recordEpisode(states, actions, 0, true);

    const stats = pipeline.getBufferStats();
    expect(stats.episodes).toBe(1);
    // Only player 0's actions (2 out of 3)
    expect(stats.experiences).toBe(2);
  });

  it('should train from buffer', async () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const valueNet = new ValueNetwork(FEATURE_DIM);
    const pipeline = new SelfPlayPipeline(policyNet, valueNet);

    // Record some episodes
    const states = [createMainPhaseState(), createMainPhaseState()];
    const actions = [passAction(0), passAction(0)];
    await pipeline.recordEpisode(states, actions, 0, true);

    const stats = pipeline.trainFromBuffer();
    expect(typeof stats.policyLoss).toBe('number');
    expect(typeof stats.valueLoss).toBe('number');
  });

  it('should handle empty buffer training', () => {
    const pipeline = new SelfPlayPipeline(
      new PolicyNetwork(FEATURE_DIM),
      new ValueNetwork(FEATURE_DIM),
    );
    const stats = pipeline.trainFromBuffer();
    expect(stats.epochsCompleted).toBe(0);
  });

  it('should clear buffer', async () => {
    const pipeline = new SelfPlayPipeline(
      new PolicyNetwork(FEATURE_DIM),
      new ValueNetwork(FEATURE_DIM),
    );

    const states = [createMainPhaseState()];
    const actions = [passAction(0)];
    await pipeline.recordEpisode(states, actions, 0, true);
    expect(pipeline.getBufferStats().episodes).toBe(1);

    pipeline.clearBuffer();
    expect(pipeline.getBufferStats().episodes).toBe(0);
  });

  it('should get policy and value networks', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const valueNet = new ValueNetwork(FEATURE_DIM);
    const pipeline = new SelfPlayPipeline(policyNet, valueNet);

    expect(pipeline.getPolicyNetwork()).toBe(policyNet);
    expect(pipeline.getValueNetwork()).toBe(valueNet);
  });

  it('should record multiple episodes', async () => {
    const pipeline = new SelfPlayPipeline(
      new PolicyNetwork(FEATURE_DIM),
      new ValueNetwork(FEATURE_DIM),
    );

    for (let i = 0; i < 5; i++) {
      const states = [createMainPhaseState(), createMainPhaseState()];
      const actions = [passAction(0), passAction(0)];
      await pipeline.recordEpisode(states, actions, 0, i % 2 === 0);
    }

    const stats = pipeline.getBufferStats();
    expect(stats.episodes).toBe(5);
    expect(stats.avgOutcome).toBeCloseTo(0.6, 1); // 3/5 wins
  });
});
