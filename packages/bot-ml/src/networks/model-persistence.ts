/**
 * Model Persistence — Versioned save/load for ML Bot weights.
 *
 * Handles:
 * - Saving policy + value weights with version metadata
 * - Loading with automatic version detection (legacy v1 support)
 * - JSON format for both localStorage (browser) and file system (Node.js training)
 *
 * Format:
 * {
 *   version: 'v1' | 'v2',
 *   policyWeights: WeightEntry[],
 *   valueWeights: WeightEntry[],
 *   metadata: { gamesPlayed, trainedAt, ... }
 * }
 */

import * as tf from '@tensorflow/tfjs';
import type { NetworkVersion, AnyPolicyNetwork, AnyValueNetwork } from './network-factory.ts';
import { HierarchicalPolicy } from './hierarchical-policy.ts';

export interface WeightEntry {
  name: string;
  shape: number[];
  data: number[];  // Flat array for JSON serialization
}

export interface ModelMetadata {
  gamesPlayed?: number;
  trainedAt?: string;
  winRate?: number;
  valueLoss?: number;
  policyLoss?: number;
}

export interface SavedModelData {
  version: NetworkVersion;
  policyWeights: WeightEntry[];
  valueWeights: WeightEntry[];
  // v3: Card Head Weights
  cardWeights?: WeightEntry[]; 
  metadata: ModelMetadata;
}

/**
 * Extract weights from a TF.js model as portable WeightEntry array.
 */
async function extractWeights(model: tf.LayersModel | tf.Sequential): Promise<WeightEntry[]> {
  const weights = model.getWeights();
  const entries: WeightEntry[] = [];

  for (let i = 0; i < weights.length; i++) {
    const tensor = weights[i];
    const data = await tensor.data();
    entries.push({
      name: (tensor as any).name || `weight_${i}`,
      shape: tensor.shape as number[],
      data: Array.from(data),
    });
  }

  return entries;
}

/**
 * Apply saved weights to a TF.js model.
 */
function loadWeights(model: tf.LayersModel | tf.Sequential, entries: WeightEntry[]): void {
  const tensors = entries.map(entry =>
    tf.tensor(entry.data, entry.shape)
  );

  try {
    model.setWeights(tensors);
  } finally {
    // Dispose the temporary tensors
    tensors.forEach(t => t.dispose());
  }
}

/**
 * Save both networks to a portable JSON format.
 */
export async function saveModel(
  policyNet: AnyPolicyNetwork,
  valueNet: AnyValueNetwork,
  version: NetworkVersion,
  metadata: ModelMetadata = {}
): Promise<SavedModelData> {
  const policyWeights = await extractWeights(policyNet.getModel());
  const valueWeights = await extractWeights(valueNet.getModel());
  
  let cardWeights: WeightEntry[] | undefined;
  if (version === 'v3' && policyNet instanceof HierarchicalPolicy) {
      // Extract card head weights
      const internals = (policyNet as any).getInternals();
      if (internals && internals.cardHead) {
          cardWeights = await extractWeights(internals.cardHead);
      }
  }

  return {
    version,
    policyWeights,
    valueWeights,
    cardWeights,
    metadata: {
      ...metadata,
      trainedAt: metadata.trainedAt ?? new Date().toISOString(),
    },
  };
}

/**
 * Serialize saved model to JSON string.
 */
export function serializeModel(data: SavedModelData): string {
  return JSON.stringify(data);
}

/**
 * Deserialize JSON string to saved model data.
 */
export function deserializeModel(json: string): SavedModelData {
  const data = JSON.parse(json);

  // Legacy detection: old format without 'version' key → v1
  if (!data.version) {
    data.version = 'v1';
  }
  if (!data.metadata) {
    data.metadata = {};
  }

  return data as SavedModelData;
}

/**
 * Load weights into existing networks from saved data.
 */
export function loadModelWeights(
  policyNet: AnyPolicyNetwork,
  valueNet: AnyValueNetwork,
  data: SavedModelData
): void {
  loadWeights(policyNet.getModel(), data.policyWeights);
  loadWeights(valueNet.getModel(), data.valueWeights);
  
  if (data.version === 'v3' && data.cardWeights && policyNet instanceof HierarchicalPolicy) {
      const internals = (policyNet as any).getInternals();
      if (internals && internals.cardHead) {
          loadWeights(internals.cardHead, data.cardWeights);
      }
  }
}

/**
 * Detect the version from saved JSON (without full parse).
 * Useful for quickly checking before creating networks.
 */
export function detectVersion(json: string): NetworkVersion {
  // Quick regex check
  const match = json.match(/"version"\s*:\s*"(v[12])"/);
  if (match) return match[1] as NetworkVersion;
  return 'v1'; // Legacy default
}

/**
 * Estimate model size in bytes from saved data.
 */
export function estimateModelSize(data: SavedModelData): {
  policyBytes: number;
  valueBytes: number;
  totalBytes: number;
} {
  const policyBytes = data.policyWeights.reduce(
    (sum, w) => sum + w.data.length * 4, // Float32 = 4 bytes
    0
  );
  const valueBytes = data.valueWeights.reduce(
    (sum, w) => sum + w.data.length * 4,
    0
  );
  return {
    policyBytes,
    valueBytes,
    totalBytes: policyBytes + valueBytes,
  };
}
