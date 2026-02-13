/**
 * Network Factory — Creates the correct network architecture based on version.
 *
 * v1: MLP PolicyNetwork (200→256→256→128→8) + ValueNetwork (200→128→128→64→1)
 * v2: ResNet ResNetPolicy (256→ResBlock×3→128→8) + ResNetValue (256→ResBlock×2→64→1)
 *
 * Ensures backward compatibility: v1 models continue to load and play.
 */

import { PolicyNetwork, ACTION_COUNT } from './policy-network.ts';
import { ValueNetwork } from './value-network.ts';
import { ResNetPolicy } from './resnet-policy.ts';
import { ResNetValue } from './resnet-value.ts';
import { HierarchicalPolicy } from './hierarchical-policy.ts';
import { FEATURE_DIM, FEATURE_DIM_V2, FEATURE_DIM_V3, FEATURE_DIM_V4 } from './feature-extractor.ts';

export type NetworkVersion = 'v1' | 'v2' | 'v3' | 'v4';

export interface MLBotConfig {
  version: NetworkVersion;
  featureDim: number;
}

export const V1_CONFIG: MLBotConfig = {
  version: 'v1',
  featureDim: FEATURE_DIM,     // 200
};

export const V2_CONFIG: MLBotConfig = {
  version: 'v2',
  featureDim: FEATURE_DIM_V2,  // 256
};

export const V3_CONFIG: MLBotConfig = {
  version: 'v3',
  featureDim: FEATURE_DIM_V3,  // 320
};

export const V4_CONFIG: MLBotConfig = {
  version: 'v4',
  featureDim: FEATURE_DIM_V4,  // 384
};

/** Unified type for any policy network (v1 MLP, v2 ResNet, v3 Hierarchical, v4 Hierarchical) */
export type AnyPolicyNetwork = PolicyNetwork | ResNetPolicy | HierarchicalPolicy;

/** Unified type for any value network (v1 MLP, v2 ResNet, v3 uses ResNetValue) */
export type AnyValueNetwork = ValueNetwork | ResNetValue;

/**
 * Create a policy network for the given config.
 */
export function createPolicyNetwork(config: MLBotConfig = V4_CONFIG): AnyPolicyNetwork {
  if (config.version === 'v4' || config.version === 'v3') {
    return new HierarchicalPolicy(config.featureDim);
  }
  if (config.version === 'v2') {
    return new ResNetPolicy(config.featureDim);
  }
  return new PolicyNetwork(config.featureDim);
}

/**
 * Create a value network for the given config.
 */
export function createValueNetwork(config: MLBotConfig = V4_CONFIG): AnyValueNetwork {
  if (config.version === 'v2' || config.version === 'v3' || config.version === 'v4') {
    // v3/v4 shares value network arch with v2 (ResNetValue handles variable input dims)
    // ResNetValue constructor takes inputSize
    return new ResNetValue(config.featureDim);
  }
  return new ValueNetwork(config.featureDim);
}

/**
 * Detect version from a localStorage saved model key pattern.
 * v1 models use 'mlbot-policy' / 'mlbot-value'
 * v2 models use 'mlbot-resnet-policy' / 'mlbot-resnet-value'
 * v3 models use 'mlbot-hierarchical-policy' / 'mlbot-hierarchical-value'
 * v4 models use 'mlbot-hierarchical-v4-policy' / 'mlbot-hierarchical-v4-value'
 */
export function detectModelVersion(policyKey: string): NetworkVersion {
  if (policyKey.includes('v4')) return 'v4';
  if (policyKey.includes('hierarchical')) return 'v3';
  if (policyKey.includes('resnet')) return 'v2';
  return 'v1';
}

/**
 * Load policy network from localStorage, auto-detecting version.
 */
export async function loadPolicyNetwork(
  name: string = 'mlbot-policy'
): Promise<{ network: AnyPolicyNetwork; version: NetworkVersion }> {
  const version = detectModelVersion(name);
  if (version === 'v4') {
    const network = new HierarchicalPolicy(V4_CONFIG.featureDim);
    return { network, version };
  }
  if (version === 'v3') {
    const network = new HierarchicalPolicy(V3_CONFIG.featureDim);
    return { network, version };
  }
  if (version === 'v2') {
    const network = await ResNetPolicy.loadFromLocalStorage(name);
    return { network, version };
  }
  const network = await PolicyNetwork.loadFromLocalStorage(name);
  return { network, version };
}

/**
 * Load value network from localStorage, auto-detecting version.
 */
export async function loadValueNetwork(
  name: string = 'mlbot-value'
): Promise<{ network: AnyValueNetwork; version: NetworkVersion }> {
  const version = detectModelVersion(name);
  if (version === 'v4') {
    const network = await ResNetValue.loadFromLocalStorage(name);
    return { network, version };
  }
  if (version === 'v3') {
    const network = await ResNetValue.loadFromLocalStorage(name);
    return { network, version };
  }
  if (version === 'v2') {
    const network = await ResNetValue.loadFromLocalStorage(name);
    return { network, version };
  }
  const network = await ValueNetwork.loadFromLocalStorage(name);
  return { network, version };
}

/**
 * Get the config for a given version string.
 */
export function getConfig(version: NetworkVersion): MLBotConfig {
    switch(version) {
        case 'v4': return V4_CONFIG;
        case 'v3': return V3_CONFIG;
        case 'v2': return V2_CONFIG;
        default: return V1_CONFIG;
    }
}
