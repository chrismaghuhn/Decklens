import { STORAGE_KEYS } from '../shared/storage.js';

export type MetaMode = 'local' | 'fnm' | 'commander-pod';

type MetaModeStorageTarget = 'local' | 'session' | 'none';

interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface MetaModeStoragePair {
  local: StorageLike | null;
  session: StorageLike | null;
}

export interface MetaContextProperties {
  meta_mode: MetaMode;
  meta_context: {
    mode: MetaMode;
    label: string;
    cadence: 'casual-local' | 'weekly-fnm' | 'pod-long-game';
    interaction_bias: number;
    removal_bias: number;
    ramp_bias: number;
    value_bias: number;
  };
}

export const DEFAULT_META_MODE: MetaMode = 'local';

const META_MODE_LABELS: Record<MetaMode, string> = {
  local: 'Local',
  fnm: 'FNM',
  'commander-pod': 'Commander-Pod',
};

const META_MODE_CONTEXT: Record<MetaMode, MetaContextProperties['meta_context']> = {
  local: {
    mode: 'local',
    label: 'Local',
    cadence: 'casual-local',
    interaction_bias: 1,
    removal_bias: 1,
    ramp_bias: 1,
    value_bias: 1,
  },
  fnm: {
    mode: 'fnm',
    label: 'FNM',
    cadence: 'weekly-fnm',
    interaction_bias: 1.25,
    removal_bias: 1.2,
    ramp_bias: 0.9,
    value_bias: 0.95,
  },
  'commander-pod': {
    mode: 'commander-pod',
    label: 'Commander-Pod',
    cadence: 'pod-long-game',
    interaction_bias: 0.95,
    removal_bias: 0.95,
    ramp_bias: 1.2,
    value_bias: 1.15,
  },
};

function parseMetaMode(raw: unknown): MetaMode | null {
  if (raw === 'local' || raw === 'fnm' || raw === 'commander-pod') {
    return raw;
  }

  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'local' || normalized === 'fnm' || normalized === 'commander-pod') {
      return normalized;
    }
  }

  return null;
}

function resolveStoragePair(): MetaModeStoragePair {
  return {
    local: typeof localStorage === 'undefined' ? null : localStorage,
    session: typeof sessionStorage === 'undefined' ? null : sessionStorage,
  };
}

function parseStoredMode(raw: string | null): MetaMode | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const parsedMode = parseMetaMode(parsed);
    if (parsedMode) return parsedMode;
  } catch {
    // Stored values may already be plain strings.
  }

  return parseMetaMode(trimmed);
}

function readMode(storage: StorageLike | null, key: string): MetaMode | null {
  if (!storage) return null;
  try {
    return parseStoredMode(storage.getItem(key));
  } catch {
    return null;
  }
}

function writeMode(storage: StorageLike | null, key: string, mode: MetaMode): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, JSON.stringify(mode));
    return true;
  } catch {
    return false;
  }
}

export function normalizeMetaMode(raw: unknown): MetaMode {
  return parseMetaMode(raw) || DEFAULT_META_MODE;
}

export function loadMetaModePreference(
  key: string = STORAGE_KEYS.MTG_META_MODE,
  storages: MetaModeStoragePair = resolveStoragePair(),
): MetaMode {
  const localMode = readMode(storages.local, key);
  if (localMode) return localMode;

  const sessionMode = readMode(storages.session, key);
  if (sessionMode) return sessionMode;

  return DEFAULT_META_MODE;
}

export function persistMetaModePreference(
  mode: MetaMode,
  key: string = STORAGE_KEYS.MTG_META_MODE,
  storages: MetaModeStoragePair = resolveStoragePair(),
): MetaModeStorageTarget {
  const normalized = normalizeMetaMode(mode);
  if (writeMode(storages.local, key, normalized)) return 'local';
  if (writeMode(storages.session, key, normalized)) return 'session';
  return 'none';
}

export function formatMetaModeLabel(mode: MetaMode): string {
  return META_MODE_LABELS[mode];
}

export function createMetaContextProperties(mode: MetaMode): MetaContextProperties {
  const normalized = normalizeMetaMode(mode);
  const context = META_MODE_CONTEXT[normalized];
  return {
    meta_mode: normalized,
    meta_context: { ...context },
  };
}
