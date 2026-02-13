// === ML Bot ===
export { MLBot } from './bot-ml.ts';
export type { MLDecision } from './bot-ml.ts';

// === Networks ===
export { PolicyNetwork, ACTION_TYPES, ACTION_COUNT } from './networks/policy-network.ts';
export type { ActionProbabilities } from './networks/policy-network.ts';
export { ValueNetwork } from './networks/value-network.ts';
export { extractFeatures, extractFeaturesV2, extractFeaturesV3, extractCardFeatures, FEATURE_DIM, FEATURE_DIM_V2, FEATURE_DIM_V3, CARD_FEATURE_DIM } from './networks/feature-extractor.ts';

// === v2 ResNet Networks ===
export { ResNetPolicy } from './networks/resnet-policy.ts';
export { ResNetValue } from './networks/resnet-value.ts';
// === v3 Hierarchical Networks ===
export { HierarchicalPolicy } from './networks/hierarchical-policy.ts';
export {
  createPolicyNetwork, createValueNetwork,
  detectModelVersion, loadPolicyNetwork, loadValueNetwork,
  getConfig, V1_CONFIG, V2_CONFIG, V3_CONFIG,
} from './networks/network-factory.ts';
export type { NetworkVersion, MLBotConfig, AnyPolicyNetwork, AnyValueNetwork } from './networks/network-factory.ts';
export {
  saveModel, serializeModel, deserializeModel,
  loadModelWeights, detectVersion, estimateModelSize,
} from './networks/model-persistence.ts';
export type { WeightEntry, ModelMetadata, SavedModelData } from './networks/model-persistence.ts';

// === Rewards ===
export { calculateReward, calculateRewardBreakdown } from './rewards/reward-calculator.ts';
export type { RewardBreakdown } from './rewards/reward-calculator.ts';
export {
  OUTCOME_REWARDS,
  RESOURCE_REWARDS,
  BOARD_REWARDS,
  COMBAT_REWARDS,
  COMBO_REWARDS,
  COMMANDER_REWARDS,
  MULLIGAN_REWARDS,
  MISPLAY_PENALTIES,
  DEFAULT_REWARD_CONFIG,
} from './rewards/reward-config.ts';
export type { RewardConfig } from './rewards/reward-config.ts';
export { getGamePhase, getTemporalScale, applyTemporalScaling } from './rewards/temporal-scaling.ts';
export type { GamePhase, RewardCategory } from './rewards/temporal-scaling.ts';
export { ARCHETYPE_MODIFIERS, getArchetypeModifier, getModifier } from './rewards/archetype-modifiers.ts';
export type { ArchetypeModifier, ArchetypeName } from './rewards/archetype-modifiers.ts';

// === Training ===
export { PPOTrainer } from './training/ppo-trainer.ts';
export type { TrainingStats, PPOConfig } from './training/ppo-trainer.ts';
export { ReplayBuffer } from './training/replay-buffer.ts';
export type { Experience, Episode } from './training/replay-buffer.ts';
export { SelfPlayPipeline } from './training/self-play.ts';
export type { SelfPlayConfig, TrainingResult, TrainingProgressCallback } from './training/self-play.ts';
export { actionToIndex, collectDemonstrations, trainOnDemonstrations } from './training/imitation.ts';
export type { Demonstration, ImitationStats, ImitationConfig } from './training/imitation.ts';
// ...
export { OpponentPool } from './training/opponent-pool.ts';
export type { OpponentSnapshot } from './training/opponent-pool.ts';
export { runTrainingGame } from './training/training-game-loop.ts';
export { runBenchmark } from './training/benchmark.ts';

// === Bots ===
export { SimpleBot } from './bots/simple-bot.ts';
