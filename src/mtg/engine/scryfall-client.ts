/**
 * Scryfall API Client with caching and rate limiting
 * Provides type-safe access to Scryfall search and card data
 */

export interface ScryfallCard {
  id: string;
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  prices?: {
    eur?: string | null;
    usd?: string | null;
  };
  edhrec_rank?: number;
  power?: string;
  toughness?: string;
  loyalty?: string;
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
  };
}

export interface ScryfallSearchResponse {
  object: 'list';
  total_cards: number;
  has_more: boolean;
  next_page?: string;
  data: ScryfallCard[];
}

export interface ScryfallCatalogResponse {
  object: 'catalog';
  total_values: number;
  data: string[];
}

export interface ScryfallError {
  object: 'error';
  code: string;
  status: number;
  details?: string;
  type?: string;
  warnings?: string[];
}

export interface ScryfallSearchParams {
  q: string;
  unique?: 'cards' | 'art' | 'prints';
  order?: 'name' | 'set' | 'released' | 'rarity' | 'color' | 'usd' | 'tix' | 'eur' | 'cmc' | 'power' | 'toughness' | 'edhrec' | 'penny';
  dir?: 'auto' | 'asc' | 'desc';
  include_extras?: boolean;
  include_multilingual?: boolean;
  include_variations?: boolean;
  page?: number;
}

export interface CachedScryfallEntry {
  card: ScryfallCard;
  cachedAt: number;
  expiresAt: number;
}

export interface ScryfallClientConfig {
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  cacheTtlMs?: number;
  maxCacheSize?: number;
  rateLimitPerSecond?: number;
}

const DEFAULT_CONFIG: Required<ScryfallClientConfig> = {
  baseUrl: 'https://api.scryfall.com',
  timeoutMs: 10000,
  maxRetries: 2,
  retryDelayMs: 200,
  cacheTtlMs: 1000 * 60 * 60 * 24, // 24 hours
  maxCacheSize: 5000,
  rateLimitPerSecond: 10,
};

export class ScryfallClient {
  private config: Required<ScryfallClientConfig>;
  private cache: Map<string, CachedScryfallEntry>;
  private requestTimestamps: number[] = [];
  private pendingRequests: Map<string, Promise<ScryfallCard | null>> = new Map();

  constructor(config: ScryfallClientConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cache = new Map();
  }

  /**
   * Search for cards with query
   */
  async search(params: ScryfallSearchParams): Promise<ScryfallSearchResponse> {
    const queryString = this.buildQueryString(params);
    const url = `${this.config.baseUrl}/cards/search?${queryString}`;
    
    return this.fetchWithRetry<ScryfallSearchResponse>(url);
  }

  /**
   * Get a single card by exact name
   */
  async getCardByName(name: string, set?: string): Promise<ScryfallCard | null> {
    const cacheKey = `name:${name.toLowerCase()}${set ? `:${set.toLowerCase()}` : ''}`;
    
    // Check cache
    const cached = this.getCached(cacheKey);
    if (cached) return cached.card;

    // Check pending request (deduplication)
    const pending = this.pendingRequests.get(cacheKey);
    if (pending) return pending;

    // Create new request
    const requestPromise = this.fetchCardByName(name, set, cacheKey);
    this.pendingRequests.set(cacheKey, requestPromise);

    try {
      const result = await requestPromise;
      return result;
    } finally {
      this.pendingRequests.delete(cacheKey);
    }
  }

  /**
   * Get multiple cards by names (batch request)
   */
  async getCardsByNames(names: string[]): Promise<Map<string, ScryfallCard | null>> {
    const results = new Map<string, ScryfallCard | null>();
    const toFetch: string[] = [];

    // Check cache first
    for (const name of names) {
      const cacheKey = `name:${name.toLowerCase()}`;
      const cached = this.getCached(cacheKey);
      if (cached) {
        results.set(name, cached.card);
      } else {
        toFetch.push(name);
      }
    }

    if (toFetch.length === 0) return results;

    // Batch fetch using collection endpoint
    const url = `${this.config.baseUrl}/cards/collection`;
    const body = {
      identifiers: toFetch.map(name => ({ name })),
    };

    try {
      const response = await this.fetchWithRetry<{
        object: 'list';
        data: ScryfallCard[];
        not_found?: Array<{ name: string }>;
      }>(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      // Process found cards
      for (const card of response.data) {
        results.set(card.name, card);
        this.setCache(`name:${card.name.toLowerCase()}`, card);
      }

      // Process not found
      if (response.not_found) {
        for (const notFound of response.not_found) {
          results.set(notFound.name, null);
        }
      }
    } catch (error) {
      // Fallback to individual requests on batch failure
      for (const name of toFetch) {
        try {
          const card = await this.getCardByName(name);
          results.set(name, card);
        } catch {
          results.set(name, null);
        }
      }
    }

    return results;
  }

  /**
   * Get card catalog (e.g., card types, supertypes)
   */
  async getCatalog(catalogType: string): Promise<string[]> {
    const url = `${this.config.baseUrl}/catalog/${catalogType}`;
    const response = await this.fetchWithRetry<ScryfallCatalogResponse>(url);
    return response.data;
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache.clear();
    this.requestTimestamps = [];
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; hitRate: number } {
    return {
      size: this.cache.size,
      hitRate: 0, // Would need to track hits/misses
    };
  }

  private async fetchCardByName(
    name: string,
    set: string | undefined,
    cacheKey: string
  ): Promise<ScryfallCard | null> {
    await this.rateLimit();

    const encodedName = encodeURIComponent(name);
    let url = `${this.config.baseUrl}/cards/named?exact=${encodedName}`;
    
    if (set) {
      url += `&set=${encodeURIComponent(set)}`;
    }

    try {
      const card = await this.fetchWithRetry<ScryfallCard>(url);
      this.setCache(cacheKey, card);
      return card;
    } catch (error) {
      if (error instanceof ScryfallApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async fetchWithRetry<T>(
    url: string,
    options?: RequestInit
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        await this.rateLimit();
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new ScryfallApiError(
            errorData.details || `HTTP ${response.status}`,
            errorData.code || 'unknown',
            response.status
          );
        }

        return await response.json();
      } catch (error) {
        lastError = error as Error;
        
        // Don't retry on 404s
        if (error instanceof ScryfallApiError && error.status === 404) {
          throw error;
        }

        if (attempt < this.config.maxRetries) {
          await this.delay(this.config.retryDelayMs * Math.pow(2, attempt));
        }
      }
    }

    throw lastError;
  }

  private async rateLimit(): Promise<void> {
    const now = Date.now();
    const windowMs = 1000; // 1 second window
    
    // Remove timestamps outside the window
    this.requestTimestamps = this.requestTimestamps.filter(
      ts => now - ts < windowMs
    );

    // If at rate limit, wait
    if (this.requestTimestamps.length >= this.config.rateLimitPerSecond) {
      const oldestTs = this.requestTimestamps[0];
      const waitMs = windowMs - (now - oldestTs);
      if (waitMs > 0) {
        await this.delay(waitMs);
      }
    }

    this.requestTimestamps.push(Date.now());
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private buildQueryString(params: ScryfallSearchParams): string {
    const parts: string[] = [`q=${encodeURIComponent(params.q)}`];
    
    if (params.unique) parts.push(`unique=${params.unique}`);
    if (params.order) parts.push(`order=${params.order}`);
    if (params.dir) parts.push(`dir=${params.dir}`);
    if (params.include_extras) parts.push('include_extras=true');
    if (params.include_multilingual) parts.push('include_multilingual=true');
    if (params.include_variations) parts.push('include_variations=true');
    if (params.page) parts.push(`page=${params.page}`);

    return parts.join('&');
  }

  private getCached(key: string): CachedScryfallEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  private setCache(key: string, card: ScryfallCard): void {
    // LRU eviction
    if (this.cache.size >= this.config.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, {
      card,
      cachedAt: Date.now(),
      expiresAt: Date.now() + this.config.cacheTtlMs,
    });
  }
}

export class ScryfallApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number
  ) {
    super(message);
    this.name = 'ScryfallApiError';
  }
}

// Singleton instance for convenience
let defaultClient: ScryfallClient | null = null;

export function getScryfallClient(config?: ScryfallClientConfig): ScryfallClient {
  if (!defaultClient || config) {
    defaultClient = new ScryfallClient(config);
  }
  return defaultClient;
}

export function resetScryfallClient(): void {
  defaultClient = null;
}
