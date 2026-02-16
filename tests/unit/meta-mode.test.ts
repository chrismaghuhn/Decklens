import { describe, expect, it } from 'vitest';
import {
  DEFAULT_META_MODE,
  createMetaContextProperties,
  formatMetaModeLabel,
  loadMetaModePreference,
  normalizeMetaMode,
  persistMetaModePreference,
  type MetaModeStoragePair,
} from '../../src/mtg/meta-mode.js';

class MemoryStorage {
  private store = new Map<string, string>();

  constructor(private readonly failWrites = false) {}

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key) || null : null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) {
      throw new Error('write failed');
    }
    this.store.set(key, value);
  }
}

function createStoragePair(options?: {
  local?: MemoryStorage | null;
  session?: MemoryStorage | null;
}): MetaModeStoragePair {
  return {
    local: options?.local ?? new MemoryStorage(),
    session: options?.session ?? new MemoryStorage(),
  };
}

describe('meta mode preference', () => {
  it('defaults to local when no value is persisted', () => {
    const mode = loadMetaModePreference('test_meta_mode', createStoragePair());
    expect(mode).toBe(DEFAULT_META_MODE);
  });

  it('loads persisted mode from local storage first', () => {
    const local = new MemoryStorage();
    local.setItem('test_meta_mode', JSON.stringify('fnm'));

    const mode = loadMetaModePreference('test_meta_mode', createStoragePair({ local }));
    expect(mode).toBe('fnm');
  });

  it('falls back to session storage when local value is invalid', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem('test_meta_mode', JSON.stringify('unexpected-value'));
    session.setItem('test_meta_mode', JSON.stringify('commander-pod'));

    const mode = loadMetaModePreference('test_meta_mode', createStoragePair({ local, session }));
    expect(mode).toBe('commander-pod');
  });

  it('persists mode to local storage when available', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const target = persistMetaModePreference('fnm', 'test_meta_mode', createStoragePair({ local, session }));

    expect(target).toBe('local');
    expect(local.getItem('test_meta_mode')).toBe(JSON.stringify('fnm'));
    expect(session.getItem('test_meta_mode')).toBeNull();
  });

  it('falls back to session storage when local write fails', () => {
    const local = new MemoryStorage(true);
    const session = new MemoryStorage();
    const target = persistMetaModePreference('commander-pod', 'test_meta_mode', createStoragePair({ local, session }));

    expect(target).toBe('session');
    expect(session.getItem('test_meta_mode')).toBe(JSON.stringify('commander-pod'));
  });
});

describe('meta mode context payload', () => {
  it('normalizes invalid values to default mode', () => {
    expect(normalizeMetaMode('')).toBe(DEFAULT_META_MODE);
    expect(normalizeMetaMode('LOCAL')).toBe('local');
    expect(normalizeMetaMode('commander-pod')).toBe('commander-pod');
    expect(normalizeMetaMode('broken')).toBe(DEFAULT_META_MODE);
  });

  it('builds API payload with meta_mode and meta_context', () => {
    const payload = createMetaContextProperties('fnm');
    expect(payload.meta_mode).toBe('fnm');
    expect(payload.meta_context.mode).toBe('fnm');
    expect(payload.meta_context.interaction_bias).toBeGreaterThan(1);
    expect(formatMetaModeLabel(payload.meta_mode)).toBe('FNM');
  });
});
