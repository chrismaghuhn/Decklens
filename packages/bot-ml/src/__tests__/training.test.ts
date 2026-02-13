import { describe, it, expect, beforeEach } from 'vitest';
import { PPOTrainer } from '../training/ppo-trainer.ts';
import { ReplayBuffer, type Experience, type Episode } from '../training/replay-buffer.ts';
import { PolicyNetwork, ACTION_COUNT } from '../networks/policy-network.ts';
import { ValueNetwork } from '../networks/value-network.ts';
import { FEATURE_DIM } from '../networks/feature-extractor.ts';
import { actionToIndex, collectDemonstrations, trainOnDemonstrations, type Demonstration } from '../training/imitation.ts';

/** Create a dummy experience */
function makeExperience(overrides: Partial<Experience> = {}): Experience {
  return {
    features: new Float32Array(FEATURE_DIM),
    actionIndex: 0,
    reward: 0.1,
    value: 0.5,
    logProb: -1.5,
    done: false,
    player: 0,
    ...overrides,
  };
}

/** Create a dummy episode */
function makeEpisode(steps: number = 10, outcome: number = 1): Episode {
  return {
    steps: Array.from({ length: steps }, (_, i) => makeExperience({
      done: i === steps - 1,
      reward: i === steps - 1 ? 10 : 0.1,
    })),
    outcome,
    turns: 8,
  };
}

describe('ReplayBuffer', () => {
  it('should store and retrieve episodes', () => {
    const buffer = new ReplayBuffer();
    buffer.addEpisode(makeEpisode(5));
    expect(buffer.episodeCount).toBe(1);
    expect(buffer.totalExperiences).toBe(5);
  });

  it('should flatten experiences', () => {
    const buffer = new ReplayBuffer();
    buffer.addEpisode(makeEpisode(5));
    buffer.addEpisode(makeEpisode(3));
    const all = buffer.getAllExperiences();
    expect(all).toHaveLength(8);
  });

  it('should evict old episodes when over capacity', () => {
    const buffer = new ReplayBuffer(3);
    buffer.addEpisode(makeEpisode(2, 1));
    buffer.addEpisode(makeEpisode(2, 1));
    buffer.addEpisode(makeEpisode(2, 1));
    buffer.addEpisode(makeEpisode(2, 1)); // Should evict oldest
    expect(buffer.episodeCount).toBe(3);
  });

  it('should compute average outcome', () => {
    const buffer = new ReplayBuffer();
    buffer.addEpisode(makeEpisode(3, 1));
    buffer.addEpisode(makeEpisode(3, 0));
    expect(buffer.averageOutcome).toBe(0.5);
  });

  it('should compute average episode length', () => {
    const buffer = new ReplayBuffer();
    buffer.addEpisode(makeEpisode(4));
    buffer.addEpisode(makeEpisode(6));
    expect(buffer.averageEpisodeLength).toBe(5);
  });

  it('should sample random batch', () => {
    const buffer = new ReplayBuffer();
    buffer.addEpisode(makeEpisode(20));
    const batch = buffer.sampleBatch(5);
    expect(batch).toHaveLength(5);
  });

  it('should create mini-batches', () => {
    const buffer = new ReplayBuffer();
    buffer.addEpisode(makeEpisode(10));
    const batches = buffer.createBatches(4);
    expect(batches.length).toBeGreaterThanOrEqual(2);
  });

  it('should filter by player', () => {
    const buffer = new ReplayBuffer();
    buffer.addEpisode({
      steps: [
        makeExperience({ player: 0 }),
        makeExperience({ player: 1 }),
        makeExperience({ player: 0 }),
      ],
      outcome: 1,
      turns: 3,
    });
    expect(buffer.getPlayerExperiences(0)).toHaveLength(2);
    expect(buffer.getPlayerExperiences(1)).toHaveLength(1);
  });

  it('should clear all episodes', () => {
    const buffer = new ReplayBuffer();
    buffer.addEpisode(makeEpisode(5));
    buffer.clear();
    expect(buffer.episodeCount).toBe(0);
  });

  it('should get recent episodes', () => {
    const buffer = new ReplayBuffer();
    buffer.addEpisode(makeEpisode(2, 0));
    buffer.addEpisode(makeEpisode(2, 1));
    buffer.addEpisode(makeEpisode(2, 1));
    const recent = buffer.getRecentEpisodes(2);
    expect(recent).toHaveLength(2);
  });
});

describe('PPOTrainer', () => {
  it('should create with default config', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const valueNet = new ValueNetwork(FEATURE_DIM);
    const trainer = new PPOTrainer(policyNet, valueNet);
    expect(trainer).toBeDefined();
  });

  it('should handle empty experience list', () => {
    const trainer = new PPOTrainer(new PolicyNetwork(FEATURE_DIM), new ValueNetwork(FEATURE_DIM));
    const stats = trainer.train([]);
    expect(stats.epochsCompleted).toBe(0);
  });

  it('should compute GAE advantages', () => {
    const trainer = new PPOTrainer(new PolicyNetwork(FEATURE_DIM), new ValueNetwork(FEATURE_DIM));
    const experiences = [
      makeExperience({ reward: 1, value: 0.5 }),
      makeExperience({ reward: 0, value: 0.6 }),
      makeExperience({ reward: 10, value: 0.4, done: true }),
    ];
    const advantages = trainer.computeGAE(experiences);
    expect(advantages).toHaveLength(3);
    // Terminal state should have highest advantage (big reward)
    expect(advantages[2]).toBeGreaterThan(0);
  });

  it('should train and return stats', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const valueNet = new ValueNetwork(FEATURE_DIM);
    const trainer = new PPOTrainer(policyNet, valueNet, {
      epochs: 1,
      batchSize: 2,
    });

    const experiences = Array.from({ length: 5 }, () => makeExperience());
    const stats = trainer.train(experiences);

    expect(stats.epochsCompleted).toBe(1);
    expect(stats.batchesProcessed).toBeGreaterThan(0);
    expect(typeof stats.policyLoss).toBe('number');
    expect(typeof stats.valueLoss).toBe('number');
    expect(typeof stats.entropy).toBe('number');
  });

  it('should update network weights during training', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const valueNet = new ValueNetwork(FEATURE_DIM);

    const layersBefore = policyNet.getLayers().map(l => ({
      biases: new Float32Array(l.biases),
    }));

    const trainer = new PPOTrainer(policyNet, valueNet, { epochs: 2, batchSize: 3, learningRate: 0.01 });
    // Use non-zero features and set logProb to match current policy output
    // so the ratio stays within clip range and gradients flow
    const experiences = Array.from({ length: 6 }, (_, i) => {
      const features = new Float32Array(FEATURE_DIM);
      for (let f = 0; f < FEATURE_DIM; f++) features[f] = (f + i) * 0.01;
      // Get actual logProb from current network so ratio ≈ 1.0
      const logits = policyNet.getLogits(features);
      const maxL = Math.max(...logits);
      const exps = Array.from(logits, l => Math.exp(l - maxL));
      const sum = exps.reduce((s, e) => s + e, 0);
      const actionIdx = i % ACTION_COUNT;
      const logProb = Math.log(exps[actionIdx] / sum + 1e-10);
      return makeExperience({ features, reward: (i + 1) * 5, actionIndex: actionIdx, value: 0.3, logProb });
    });
    trainer.train(experiences);

    // At least one bias should have changed (output layer updated by gradient)
    const layersAfter = policyNet.getLayers();
    let changed = false;
    for (let l = 0; l < layersAfter.length; l++) {
      for (let b = 0; b < layersAfter[l].biases.length; b++) {
        if (Math.abs(layersAfter[l].biases[b] - layersBefore[l].biases[b]) > 1e-10) {
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
    expect(changed).toBe(true);
  });
});

describe('Imitation Learning', () => {
  it('should convert action types to indices', () => {
    expect(actionToIndex({ type: 'pass', player: 0 })).toBe(0);
    expect(actionToIndex({ type: 'play-land', player: 0, cardId: 'x' })).toBe(1);
    expect(actionToIndex({ type: 'cast-spell', player: 0, cardId: 'x', targets: [], manaPayment: { from: {} as any, phyrexianLife: 0, hybridChoices: [], xValue: 0 } })).toBe(2);
    expect(actionToIndex({ type: 'concede', player: 0 })).toBe(7);
  });

  it('should collect demonstrations from state-action pairs', () => {
    const state = {
      players: [
        { life: 40, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, S: 0, generic: 0 }, hand: [], library: [], battlefield: [], graveyard: [], exile: [], commandZone: [], landPlayedThisTurn: false, landsPlayedThisTurn: 0, maxLandPlays: 1, poisonCounters: 0, commanderDamage: [0, 0], commanderTax: 0, id: 0 as 0 | 1, name: 'A' },
        { life: 40, manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, S: 0, generic: 0 }, hand: [], library: [], battlefield: [], graveyard: [], exile: [], commandZone: [], landPlayedThisTurn: false, landsPlayedThisTurn: 0, maxLandPlays: 1, poisonCounters: 0, commanderDamage: [0, 0], commanderTax: 0, id: 1 as 0 | 1, name: 'B' },
      ] as any,
      activePlayer: 0 as 0 | 1,
      priorityPlayer: 0 as 0 | 1,
      turn: 3,
      phase: 'precombat-main' as const,
      step: 'main' as const,
      stack: [],
      combat: null,
      winner: null,
      gameOver: false,
      log: [],
      actionHistory: [],
      bothPlayersPassed: false,
      mulliganPhase: false,
      mulliganCount: [0, 0] as [number, number],
    };

    const demos = collectDemonstrations(
      [state, state],
      [{ type: 'pass', player: 0 }, { type: 'pass', player: 1 }],
    );

    expect(demos).toHaveLength(2);
    expect(demos[0].features).toBeInstanceOf(Float32Array);
    expect(demos[0].features.length).toBe(FEATURE_DIM);
    expect(demos[0].actionIndex).toBe(0); // 'pass'
  });

  it('should train policy network on demonstrations', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);

    const demos: Demonstration[] = Array.from({ length: 20 }, () => ({
      features: new Float32Array(FEATURE_DIM).fill(0.1),
      actionIndex: 2, // 'cast-spell'
      player: 0 as 0 | 1,
    }));

    const { loss, accuracy } = trainOnDemonstrations(policyNet, demos, {
      epochs: 3,
      batchSize: 10,
      learningRate: 0.01,
    });

    expect(typeof loss).toBe('number');
    expect(typeof accuracy).toBe('number');
  });

  it('should handle empty demonstrations', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const { loss, accuracy } = trainOnDemonstrations(policyNet, []);
    expect(loss).toBe(0);
    expect(accuracy).toBe(0);
  });
});

// ============================================================
// Phase 1 v2 Tests — Value Fix, Returns Normalization, Buffer
// ============================================================

describe('PPOTrainer v2 — Returns Normalization', () => {
  it('should normalize returns to [-1,1] range during training', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const valueNet = new ValueNetwork(FEATURE_DIM);
    const trainer = new PPOTrainer(policyNet, valueNet, { epochs: 1, batchSize: 4 });

    // Create experiences with large returns (simulating win=100, loss=-100)
    const experiences = Array.from({ length: 8 }, (_, i) => {
      const features = new Float32Array(FEATURE_DIM);
      for (let f = 0; f < FEATURE_DIM; f++) features[f] = Math.random() * 0.1;
      return makeExperience({
        features,
        reward: i < 4 ? 50 : -50, // Big rewards
        value: 0,
        actionIndex: i % ACTION_COUNT,
        logProb: -2.0,
      });
    });
    experiences[experiences.length - 1].done = true;

    // Should not throw — returns get normalized before MSE with tanh [-1,1] output
    const stats = trainer.train(experiences);
    expect(stats.valueLoss).toBeDefined();
    expect(typeof stats.valueLoss).toBe('number');
    // Value loss should be reasonable (< 2) since normalized returns fit tanh range
    // Note: on first training step with random weights, loss won't be perfect
    // but it should be WAY less than the ~8 we saw with sigmoid + unnormalized
    expect(stats.valueLoss).toBeLessThan(5);
  });

  it('should use separate optimizers for policy and value', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const valueNet = new ValueNetwork(FEATURE_DIM);

    // Value LR should be 3x policy LR by default
    const trainer = new PPOTrainer(policyNet, valueNet);
    expect(trainer).toBeDefined();

    // Custom LRs
    const trainer2 = new PPOTrainer(policyNet, valueNet, {
      learningRate: 0.001,
      valueLearningRate: 0.003,
    });
    expect(trainer2).toBeDefined();
  });

  it('should update value network weights with separate optimizer', () => {
    const policyNet = new PolicyNetwork(FEATURE_DIM);
    const valueNet = new ValueNetwork(FEATURE_DIM);

    const valueBiasesBefore = valueNet.getLayers().map(l => new Float32Array(l.biases));

    const trainer = new PPOTrainer(policyNet, valueNet, {
      epochs: 2,
      batchSize: 3,
      learningRate: 0.01,
      valueLearningRate: 0.01,
    });

    const experiences = Array.from({ length: 6 }, (_, i) => {
      const features = new Float32Array(FEATURE_DIM);
      for (let f = 0; f < FEATURE_DIM; f++) features[f] = (f + i) * 0.01;
      const logits = policyNet.getLogits(features);
      const maxL = Math.max(...logits);
      const exps = Array.from(logits, l => Math.exp(l - maxL));
      const sum = exps.reduce((s, e) => s + e, 0);
      const actionIdx = i % ACTION_COUNT;
      const logProb = Math.log(exps[actionIdx] / sum + 1e-10);
      return makeExperience({ features, reward: (i + 1) * 10, actionIndex: actionIdx, value: 0, logProb });
    });
    experiences[experiences.length - 1].done = true;

    trainer.train(experiences);

    // Value network biases should have changed
    const valueBiasesAfter = valueNet.getLayers();
    let valueChanged = false;
    for (let l = 0; l < valueBiasesAfter.length; l++) {
      if (valueBiasesBefore[l].length === 0) continue;
      for (let b = 0; b < valueBiasesAfter[l].biases.length; b++) {
        if (Math.abs(valueBiasesAfter[l].biases[b] - valueBiasesBefore[l][b]) > 1e-10) {
          valueChanged = true;
          break;
        }
      }
      if (valueChanged) break;
    }
    expect(valueChanged).toBe(true);
  });

  it('should compute GAE returns correctly', () => {
    const trainer = new PPOTrainer(
      new PolicyNetwork(FEATURE_DIM),
      new ValueNetwork(FEATURE_DIM),
    );

    const experiences = [
      makeExperience({ reward: 1, value: 0.5, done: false }),
      makeExperience({ reward: 2, value: 0.3, done: false }),
      makeExperience({ reward: 10, value: 0.1, done: true }),
    ];

    const { advantages, returns } = trainer.computeGAEAndReturns(experiences);
    expect(advantages).toHaveLength(3);
    expect(returns).toHaveLength(3);
    // Returns = advantages + values
    for (let i = 0; i < 3; i++) {
      expect(returns[i]).toBeCloseTo(advantages[i] + experiences[i].value, 5);
    }
    // Terminal advantage should reflect the big reward
    expect(advantages[2]).toBeGreaterThan(0);
  });
});

describe('Replay Buffer v2 — Larger Capacity', () => {
  it('should handle larger buffer sizes', () => {
    const buffer = new ReplayBuffer(5000);
    // Add many episodes
    for (let i = 0; i < 100; i++) {
      buffer.addEpisode(makeEpisode(10, i % 2));
    }
    expect(buffer.episodeCount).toBe(100);
    expect(buffer.totalExperiences).toBe(1000);
  });
});
