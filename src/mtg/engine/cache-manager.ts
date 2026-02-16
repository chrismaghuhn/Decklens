/**
 * LRU Cache implementation for browser storage
 * Combines in-memory cache with localStorage persistence
 */

export interface CacheEntry<T> {
  value: T;
  accessedAt: number;
  expiresAt: number;
  hits: number;
}

export interface CacheStats {
  size: number;
  maxSize: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

export interface LRUCacheConfig {
  maxSize: number;
  ttlMs: number;
  storageKey?: string;
  persistToStorage?: boolean;
}

export class LRUCache<T> {
  private cache: Map<string, CacheEntry<T>>;
  private config: Required<LRUCacheConfig>;
  private stats: { hits: number; misses: number; evictions: number };

  constructor(config: LRUCacheConfig) {
    this.config = {
      storageKey: 'lru-cache',
      persistToStorage: true,
      ...config,
    };
    this.cache = new Map();
    this.stats = { hits: 0, misses: 0, evictions: 0 };

    if (this.config.persistToStorage) {
      this.loadFromStorage();
    }
  }

  /**
   * Get a value from the cache
   */
  get(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    // Check expiration
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.stats.misses++;
      this.persist();
      return null;
    }

    // Update access time and hits
    entry.accessedAt = Date.now();
    entry.hits++;
    
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);

    this.stats.hits++;
    return entry.value;
  }

  /**
   * Set a value in the cache
   */
  set(key: string, value: T, customTtlMs?: number): void {
    const ttl = customTtlMs ?? this.config.ttlMs;
    const now = Date.now();

    // Evict oldest if at capacity
    if (this.cache.size >= this.config.maxSize && !this.cache.has(key)) {
      this.evictLRU();
    }

    const entry: CacheEntry<T> = {
      value,
      accessedAt: now,
      expiresAt: now + ttl,
      hits: 0,
    };

    this.cache.set(key, entry);
    this.persist();
  }

  /**
   * Check if a key exists in cache (not expired)
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Delete a key from the cache
   */
  delete(key: string): boolean {
    const existed = this.cache.delete(key);
    if (existed) {
      this.persist();
    }
    return existed;
  }

  /**
   * Clear all entries
   */
  clear(): void {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0 };
    this.persist();
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total = this.stats.hits + this.stats.misses;
    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hits: this.stats.hits,
      misses: this.stats.misses,
      evictions: this.stats.evictions,
      hitRate: total > 0 ? this.stats.hits / total : 0,
    };
  }

  /**
   * Get all keys (excluding expired)
   */
  keys(): string[] {
    const now = Date.now();
    const validKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (now <= entry.expiresAt) {
        validKeys.push(key);
      } else {
        this.cache.delete(key);
      }
    }

    return validKeys;
  }

  /**
   * Get multiple values at once
   */
  getMany(keys: string[]): Map<string, T> {
    const results = new Map<string, T>();
    for (const key of keys) {
      const value = this.get(key);
      if (value !== null) {
        results.set(key, value);
      }
    }
    return results;
  }

  /**
   * Set multiple values at once
   */
  setMany(entries: Map<string, T>, customTtlMs?: number): void {
    for (const [key, value] of entries) {
      this.set(key, value, customTtlMs);
    }
  }

  /**
   * Evict the least recently used entry
   */
  private evictLRU(): void {
    const firstKey = this.cache.keys().next().value;
    if (firstKey) {
      this.cache.delete(firstKey);
      this.stats.evictions++;
    }
  }

  /**
   * Persist cache to localStorage
   */
  private persist(): void {
    if (!this.config.persistToStorage || typeof localStorage === 'undefined') {
      return;
    }

    try {
      // Filter out expired entries before saving
      const now = Date.now();
      const validEntries: Array<[string, CacheEntry<T>]> = [];

      for (const [key, entry] of this.cache.entries()) {
        if (now <= entry.expiresAt) {
          validEntries.push([key, entry]);
        }
      }

      const data = {
        entries: validEntries,
        stats: this.stats,
        savedAt: now,
      };

      localStorage.setItem(this.config.storageKey, JSON.stringify(data));
    } catch (e) {
      // localStorage might be full or unavailable
      console.warn('Failed to persist cache:', e);
    }
  }

  /**
   * Load cache from localStorage
   */
  private loadFromStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const data = localStorage.getItem(this.config.storageKey);
      if (!data) return;

      const parsed = JSON.parse(data) as {
        entries: Array<[string, CacheEntry<T>]>;
        stats: { hits: number; misses: number; evictions: number };
        savedAt: number;
      };

      const now = Date.now();

      // Restore valid entries
      for (const [key, entry] of parsed.entries) {
        if (now <= entry.expiresAt) {
          this.cache.set(key, entry);
        }
      }

      // Restore stats
      this.stats = parsed.stats;
    } catch (e) {
      // Invalid or corrupted storage
      console.warn('Failed to load cache from storage:', e);
    }
  }

  /**
   * Preload cache with initial data
   */
  preload(entries: Map<string, T>, ttlMs?: number): void {
    const ttl = ttlMs ?? this.config.ttlMs;
    const now = Date.now();

    for (const [key, value] of entries) {
      // Don't overwrite existing entries
      if (!this.cache.has(key)) {
        this.cache.set(key, {
          value,
          accessedAt: now,
          expiresAt: now + ttl,
          hits: 0,
        });
      }
    }

    this.persist();
  }
}

// Specialized cache for Scryfall cards
export interface ScryfallCacheEntry {
  id: string;
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  prices?: {
    eur?: string | null;
    usd?: string | null;
  };
  edhrec_rank?: number;
}

export function createScryfallCache(): LRUCache<ScryfallCacheEntry> {
  return new LRUCache<ScryfallCacheEntry>({
    maxSize: 5000,
    ttlMs: 1000 * 60 * 60 * 24 * 7, // 7 days
    storageKey: 'decklens-scryfall-cache',
    persistToStorage: true,
  });
}

// Cache for discovered card recommendations
export interface DiscoveryCacheEntry {
  queries: string[];
  discoveredCards: string[];
  timestamp: number;
  deckHash: string;
}

export function createDiscoveryCache(): LRUCache<DiscoveryCacheEntry> {
  return new LRUCache<DiscoveryCacheEntry>({
    maxSize: 100,
    ttlMs: 1000 * 60 * 60 * 6, // 6 hours
    storageKey: 'decklens-discovery-cache',
    persistToStorage: true,
  });
}

// Global cache instances
let scryfallCacheInstance: LRUCache<ScryfallCacheEntry> | null = null;
let discoveryCacheInstance: LRUCache<DiscoveryCacheEntry> | null = null;

export function getScryfallCache(): LRUCache<ScryfallCacheEntry> {
  if (!scryfallCacheInstance) {
    scryfallCacheInstance = createScryfallCache();
  }
  return scryfallCacheInstance;
}

export function getDiscoveryCache(): LRUCache<DiscoveryCacheEntry> {
  if (!discoveryCacheInstance) {
    discoveryCacheInstance = createDiscoveryCache();
  }
  return discoveryCacheInstance;
}

export function clearAllCaches(): void {
  getScryfallCache().clear();
  getDiscoveryCache().clear();
}
