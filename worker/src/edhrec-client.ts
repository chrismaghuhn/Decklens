/**
 * EDHREC API Client
 * Interfaces with EDHREC's reverse-engineered API
 * Note: EDHREC does not have an official API - these endpoints may change
 */

export interface EDHRECCardData {
  card: {
    name: string;
    type: string;
    text: string;
    mana_cost?: string;
    cmc?: number;
    colors?: string[];
    color_identity?: string[];
    edhrec_rank?: number;
    prices?: {
      usd?: string;
      eur?: string;
      tix?: string;
    };
  };
  synergy: number; // -100 to +100
  num_decks: number;
  potential_decks: number;
  usage_breakdown?: {
    by_tribe?: Record<string, number>;
    by_theme?: Record<string, number>;
  };
}

export interface EDHRECCommanderData {
  cards: Array<{
    card: {
      name: string;
      type: string;
    };
    synergy: number;
    num_decks: number;
  }>;
  tribes: string[];
  themes: string[];
  high_synergy_cards: string[];
  top_cards: string[];
  new_cards: string[];
}

export interface EDHRECTribeData {
  cards: Array<{
    name: string;
    synergy: number;
    num_decks: number;
  }>;
  top_cards: string[];
  synergy_map: Record<string, number>;
}

export interface EDHRECThemeData {
  cards: Array<{
    name: string;
    synergy: number;
    num_decks: number;
  }>;
  top_cards: string[];
  staples: string[];
}

export interface EDHRECComboData {
  id: string;
  cards: string[];
  color_identity: string[];
  results_in: string;
  prerequisites: string;
  description: string;
  num_decks: number;
}

export class EDHRECClient {
  private baseUrl = 'https://edhrec.com/api';
  private cache: Map<string, { data: unknown; timestamp: number }> = new Map();
  private cacheTtlMs = 1000 * 60 * 60 * 6; // 6 hours

  /**
   * Get card data from EDHREC
   * Includes synergy score and deck statistics
   */
  async getCardData(cardName: string): Promise<EDHRECCardData | null> {
    const cacheKey = `card:${cardName.toLowerCase()}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached as EDHRECCardData;

    try {
      // EDHREC uses URL-friendly card names
      const urlSafeName = this.toUrlSafeName(cardName);
      const response = await fetch(`${this.baseUrl}/cards/${urlSafeName}`);

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`EDHREC API error: ${response.status}`);
      }

      const data = await response.json();
      this.setCache(cacheKey, data);
      return data as EDHRECCardData;
    } catch (error) {
      console.error(`Failed to fetch EDHREC data for ${cardName}:`, error);
      return null;
    }
  }

  /**
   * Get commander-specific recommendations
   */
  async getCommanderData(commanderName: string): Promise<EDHRECCommanderData | null> {
    const cacheKey = `commander:${commanderName.toLowerCase()}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached as EDHRECCommanderData;

    try {
      const urlSafeName = this.toUrlSafeName(commanderName);
      const response = await fetch(`${this.baseUrl}/commanders/${urlSafeName}`);

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`EDHREC API error: ${response.status}`);
      }

      const data = await response.json();
      this.setCache(cacheKey, data);
      return data as EDHRECCommanderData;
    } catch (error) {
      console.error(`Failed to fetch commander data for ${commanderName}:`, error);
      return null;
    }
  }

  /**
   * Get tribe-specific card recommendations
   */
  async getTribeData(tribeName: string): Promise<EDHRECTribeData | null> {
    const cacheKey = `tribe:${tribeName.toLowerCase()}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached as EDHRECTribeData;

    try {
      const urlSafeName = tribeName.toLowerCase().replace(/\s+/g, '-');
      const response = await fetch(`${this.baseUrl}/tribes/${urlSafeName}`);

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`EDHREC API error: ${response.status}`);
      }

      const data = await response.json();
      this.setCache(cacheKey, data);
      return data as EDHRECTribeData;
    } catch (error) {
      console.error(`Failed to fetch tribe data for ${tribeName}:`, error);
      return null;
    }
  }

  /**
   * Get theme-specific card recommendations
   */
  async getThemeData(themeName: string): Promise<EDHRECThemeData | null> {
    const cacheKey = `theme:${themeName.toLowerCase()}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached as EDHRECThemeData;

    try {
      const urlSafeName = themeName.toLowerCase().replace(/\s+/g, '-');
      const response = await fetch(`${this.baseUrl}/themes/${urlSafeName}`);

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`EDHREC API error: ${response.status}`);
      }

      const data = await response.json();
      this.setCache(cacheKey, data);
      return data as EDHRECThemeData;
    } catch (error) {
      console.error(`Failed to fetch theme data for ${themeName}:`, error);
      return null;
    }
  }

  /**
   * Get combo data for a card
   */
  async getCardCombos(cardName: string): Promise<EDHRECComboData[]> {
    const cacheKey = `combos:${cardName.toLowerCase()}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached as EDHRECComboData[];

    try {
      const urlSafeName = this.toUrlSafeName(cardName);
      const response = await fetch(`${this.baseUrl}/cards/${urlSafeName}/combos`);

      if (!response.ok) {
        if (response.status === 404) return [];
        throw new Error(`EDHREC API error: ${response.status}`);
      }

      const data = await response.json();
      this.setCache(cacheKey, data);
      return data as EDHRECComboData[];
    } catch (error) {
      console.error(`Failed to fetch combo data for ${cardName}:`, error);
      return [];
    }
  }

  /**
   * Get top cards for a specific color identity
   */
  async getTopCardsByColorIdentity(
    colors: string[],
    options: {
      timeframe?: 'week' | 'month' | 'all';
      includeSynergy?: boolean;
    } = {}
  ): Promise<Array<{ name: string; num_decks: number; synergy?: number }>> {
    const colorString = colors.sort().join('');
    const cacheKey = `top:${colorString}:${options.timeframe || 'month'}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached as Array<{ name: string; num_decks: number; synergy?: number }>;

    try {
      const params = new URLSearchParams();
      params.set('f', colorString);
      if (options.timeframe) params.set('time', options.timeframe);

      const response = await fetch(`${this.baseUrl}/cards?${params.toString()}`);

      if (!response.ok) {
        throw new Error(`EDHREC API error: ${response.status}`);
      }

      const data = await response.json();
      this.setCache(cacheKey, data.cards || []);
      return data.cards || [];
    } catch (error) {
      console.error(`Failed to fetch top cards for ${colorString}:`, error);
      return [];
    }
  }

  /**
   * Get trending cards (gaining popularity)
   */
  async getTrendingCards(timeframe: 'week' | 'month' = 'week'): Promise<
    Array<{
      name: string;
      current_rank: number;
      previous_rank: number;
      delta: number;
    }>
  > {
    const cacheKey = `trending:${timeframe}`;
    const cached = this.getCached(cacheKey);
    if (cached) return cached as Array<{ name: string; current_rank: number; previous_rank: number; delta: number }>;

    try {
      const response = await fetch(`${this.baseUrl}/trending?timeframe=${timeframe}`);

      if (!response.ok) {
        throw new Error(`EDHREC API error: ${response.status}`);
      }

      const data = await response.json();
      this.setCache(cacheKey, data);
      return data;
    } catch (error) {
      console.error('Failed to fetch trending cards:', error);
      return [];
    }
  }

  /**
   * Get high synergy cards for a commander
   * (Cards that are particularly good with this commander, not just generally good)
   */
  async getHighSynergyCards(commanderName: string, limit: number = 10): Promise<
    Array<{ name: string; synergy: number; num_decks: number }>
  > {
    const data = await this.getCommanderData(commanderName);
    if (!data) return [];

    return data.high_synergy_cards
      .slice(0, limit)
      .map(cardName => {
        const card = data.cards.find(c => c.card.name === cardName);
        return {
          name: cardName,
          synergy: card?.synergy || 0,
          num_decks: card?.num_decks || 0,
        };
      });
  }

  /**
   * Get staples for a color identity
   * (Cards that are widely played in this color combination)
   */
  async getColorStaples(colors: string[], limit: number = 20): Promise<string[]> {
    const topCards = await this.getTopCardsByColorIdentity(colors, { timeframe: 'all' });
    return topCards.slice(0, limit).map(c => c.name);
  }

  /**
   * Calculate synergy score between a card and commander
   */
  async calculateSynergy(
    cardName: string,
    commanderName: string
  ): Promise<{ synergy: number; isStaple: boolean }> {
    const [cardData, commanderData] = await Promise.all([
      this.getCardData(cardName),
      this.getCommanderData(commanderName),
    ]);

    if (!cardData || !commanderData) {
      return { synergy: 0, isStaple: false };
    }

    // Check if card is in commander's high synergy list
    const isHighSynergy = commanderData.high_synergy_cards.includes(cardName);
    
    // Check if it's a staple (played in many decks of this color)
    const commanderColors = await this.getCommanderColors(commanderName);
    if (commanderColors) {
      const staples = await this.getColorStaples(commanderColors);
      const isStaple = staples.includes(cardName);

      // Calculate final synergy
      let synergy = cardData.synergy;
      
      if (isHighSynergy) {
        synergy += 20; // Bonus for being specifically good with this commander
      }
      
      return { synergy, isStaple };
    }

    return { synergy: cardData.synergy, isStaple: false };
  }

  /**
   * Get color identity of a commander
   */
  private async getCommanderColors(commanderName: string): Promise<string[] | null> {
    // This would require a card database lookup
    // For now, return null - this should be implemented with Scryfall integration
    return null;
  }

  /**
   * Convert card name to URL-safe format
   */
  private toUrlSafeName(cardName: string): string {
    return cardName
      .toLowerCase()
      .replace(/[,']/g, '') // Remove punctuation
      .replace(/\s+/g, '-') // Replace spaces with hyphens
      .replace(/[^a-z0-9-]/g, '') // Remove special characters
      .replace(/-+/g, '-') // Collapse multiple hyphens
      .replace(/^-|-$/g, ''); // Remove leading/trailing hyphens
  }

  /**
   * Get cached data
   */
  private getCached(key: string): unknown | null {
    const cached = this.cache.get(key);
    if (!cached) return null;

    if (Date.now() - cached.timestamp > this.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }

    return cached.data;
  }

  /**
   * Set cached data
   */
  private setCache(key: string, data: unknown): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Clear all cached data
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; oldestEntry: number | null } {
    let oldestTimestamp: number | null = null;
    
    for (const entry of this.cache.values()) {
      if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
    }

    return {
      size: this.cache.size,
      oldestEntry: oldestTimestamp,
    };
  }
}

// Singleton instance
let edhrecClientInstance: EDHRECClient | null = null;

export function getEDHRECClient(): EDHRECClient {
  if (!edhrecClientInstance) {
    edhrecClientInstance = new EDHRECClient();
  }
  return edhrecClientInstance;
}

export function resetEDHRECClient(): void {
  edhrecClientInstance = null;
}
