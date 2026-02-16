/**
 * Card Discovery Engine
 * Dynamically discovers card recommendations based on deck profile
 * Replaces the static ADD_LIBRARY with real-time Scryfall queries
 */

import type { ScryfallClient, ScryfallCard } from './scryfall-client.js';
import type { DiscoveryQueryBuilder, DeckProfile, DiscoveryRole } from './discovery-query-builder.js';
import { getScryfallClient } from './scryfall-client.js';
import { DiscoveryQueryBuilder as QueryBuilder } from './discovery-query-builder.js';
import { getScryfallCache, type ScryfallCacheEntry } from './cache-manager.js';

export interface DiscoveredCard {
  id: string;
  name: string;
  scryfallId: string;
  roles: DiscoveryRole[];
  colorIdentity: string[];
  archetypes: string[];
  tags: string[];
  cmc: number;
  manaFix: boolean;
  reason: string;
  discoveredAt: number;
  source: 'scryfall-search' | 'cache';
  confidence: number;
  priceEur: number | null;
  edhrecRank: number | null;
  oracleText: string;
  typeLine: string;
}

export interface DiscoveryResult {
  cards: DiscoveredCard[];
  totalFound: number;
  fromCache: number;
  fromScryfall: number;
  queriesExecuted: number;
  durationMs: number;
  errors: string[];
}

export interface DiscoveryConfig {
  maxCardsPerQuery?: number;
  maxTotalCards?: number;
  maxQueries?: number;
  minConfidence?: number;
  preferOwnedCards?: boolean;
  excludeCards?: Set<string>;
  collectionByName?: Record<string, number>;
  useCache?: boolean;
}

const DEFAULT_DISCOVERY_CONFIG: Required<DiscoveryConfig> = {
  maxCardsPerQuery: 15,
  maxTotalCards: 100,
  maxQueries: 5,
  minConfidence: 0.3,
  preferOwnedCards: false,
  excludeCards: new Set(),
  collectionByName: {},
  useCache: true,
};

// Oracle text patterns for role detection
const ROLE_PATTERNS: Record<DiscoveryRole, string[]> = {
  ramp: ['add {', 'search your library for a land', 'mana of any color', 'treasure token'],
  draw: ['draw ', 'draw a card', 'draw two cards', 'whenever you draw'],
  removal: ['destroy target', 'exile target', 'sacrifice each', 'destroy all'],
  interaction: ['counter target', 'prevent', "can't cast", 'hexproof'],
  protection: ['indestructible', 'phase out', 'hexproof until', 'protection from'],
  finisher: ['you win the game', 'extra turn', 'combat damage', 'each opponent loses'],
  mana_fix: ['add one mana of any color', 'mana of any color', 'commander'],
  tutor: ['search your library', 'tutor'],
  board_wipe: ['destroy all', 'exile all', 'each player sacrifices'],
  graveyard_hate: ['exile from graveyard', 'from a graveyard'],
  artifact_hate: ['destroy target artifact', 'exile target artifact'],
  combo_piece: ['infinite', 'untap', 'copy', 'storm'],
};

// Archetype detection from oracle text
const ARCHETYPE_PATTERNS: Record<string, string[]> = {
  aggro: ['haste', 'attacks', 'combat damage', 'power', 'double strike'],
  control: ['counter', 'destroy all', 'exile all', 'board wipe', 'wrath'],
  combo: ['tutor', 'infinite', 'storm', 'copy', 'untap', 'draw your deck'],
  reanimator: ['return', 'graveyard', 'discard', 'entomb'],
  storm: ['storm', 'copy', 'ritual', 'grapeshot'],
  artifact: ['artifact', 'welder', 'affinity', 'improvise'],
  graveyard: ['delve', 'escape', 'unearth', 'dredge'],
  tribal: ['changeling', 'tribal', 'lord', 'share creature types'],
};

export class CardDiscoveryEngine {
  private scryfall: ScryfallClient;
  private queryBuilder: DiscoveryQueryBuilder;
  private cache: ReturnType<typeof getScryfallCache>;
  private config: Required<DiscoveryConfig>;

  constructor(config: DiscoveryConfig = {}) {
    this.config = { ...DEFAULT_DISCOVERY_CONFIG, ...config };
    this.scryfall = getScryfallClient();
    this.queryBuilder = new QueryBuilder();
    this.cache = getScryfallCache();
  }

  /**
   * Discover cards for a deck profile
   */
  async discover(profile: DeckProfile): Promise<DiscoveryResult> {
    const startTime = performance.now();
    const discoveredCards = new Map<string, DiscoveredCard>();
    const errors: string[] = [];
    let fromCache = 0;
    let fromScryfall = 0;

    // Build queries based on profile
    const queries = this.queryBuilder.buildQueries(profile);
    const queriesToExecute = queries.slice(0, this.config.maxQueries);

    for (const query of queriesToExecute) {
      try {
        // Check cache first
        const cacheKey = `query:${query.params.q}`;
        if (this.config.useCache) {
          const cached = this.cache.get(cacheKey);
          if (cached) {
            fromCache++;
            const card = this.convertCacheToDiscovered(cached, query.role);
            if (!this.config.excludeCards.has(card.name.toLowerCase())) {
              discoveredCards.set(card.name.toLowerCase(), card);
            }
            continue;
          }
        }

        // Execute Scryfall search
        const response = await this.scryfall.search({
          ...query.params,
          page: 1,
        });

        fromScryfall++;

        // Process results
        const cardsToProcess = response.data.slice(0, this.config.maxCardsPerQuery);
        
        for (const scryfallCard of cardsToProcess) {
          const cardName = scryfallCard.name.toLowerCase();
          
          // Skip excluded cards
          if (this.config.excludeCards.has(cardName)) continue;
          
          // Skip if already discovered
          if (discoveredCards.has(cardName)) continue;

          const discovered = this.convertToDiscovered(
            scryfallCard,
            query.role,
            profile
          );

          // Check confidence threshold
          if (discovered.confidence >= this.config.minConfidence) {
            discoveredCards.set(cardName, discovered);
            
            // Cache the card
            if (this.config.useCache) {
              this.cache.set(cardName, this.convertToCacheEntry(scryfallCard));
            }
          }

          // Stop if we have enough cards
          if (discoveredCards.size >= this.config.maxTotalCards) {
            break;
          }
        }

        // Cache the query result
        if (this.config.useCache && cardsToProcess.length > 0) {
          this.cache.set(cacheKey, this.convertToCacheEntry(cardsToProcess[0]));
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(`Query "${query.role}" failed: ${errorMessage}`);
      }

      // Stop if we have enough cards
      if (discoveredCards.size >= this.config.maxTotalCards) {
        break;
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    return {
      cards: Array.from(discoveredCards.values()),
      totalFound: discoveredCards.size,
      fromCache,
      fromScryfall,
      queriesExecuted: queriesToExecute.length,
      durationMs,
      errors,
    };
  }

  /**
   * Discover cards for specific roles
   */
  async discoverForRoles(
    profile: DeckProfile,
    roles: DiscoveryRole[]
  ): Promise<DiscoveryResult> {
    const startTime = performance.now();
    const discoveredCards = new Map<string, DiscoveredCard>();
    const errors: string[] = [];
    let fromCache = 0;
    let fromScryfall = 0;

    for (const role of roles) {
      try {
        // Build specific query for this role
        const query = this.queryBuilder.buildSpecificQuery({
          colors: profile.colors,
          roles: [role],
          cmcMax: role === 'ramp' ? 3 : role === 'finisher' ? 8 : 6,
          orderBy: 'edhrec',
        });

        const cacheKey = `role:${role}:${Array.from(profile.colors).join('')}`;
        
        // Check cache
        if (this.config.useCache) {
          const cached = this.cache.get(cacheKey);
          if (cached) {
            fromCache++;
            const card = this.convertCacheToDiscovered(cached, role);
            if (!this.config.excludeCards.has(card.name.toLowerCase())) {
              discoveredCards.set(card.name.toLowerCase(), card);
            }
            continue;
          }
        }

        // Execute search
        const response = await this.scryfall.search(query);
        fromScryfall++;

        const cardsToProcess = response.data.slice(0, this.config.maxCardsPerQuery);

        for (const scryfallCard of cardsToProcess) {
          const cardName = scryfallCard.name.toLowerCase();
          
          if (this.config.excludeCards.has(cardName)) continue;
          if (discoveredCards.has(cardName)) continue;

          const discovered = this.convertToDiscovered(scryfallCard, role, profile);
          
          if (discovered.confidence >= this.config.minConfidence) {
            discoveredCards.set(cardName, discovered);
            
            if (this.config.useCache) {
              this.cache.set(cardName, this.convertToCacheEntry(scryfallCard));
            }
          }
        }

        // Cache query result
        if (this.config.useCache && cardsToProcess.length > 0) {
          this.cache.set(cacheKey, this.convertToCacheEntry(cardsToProcess[0]));
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(`Role "${role}" discovery failed: ${errorMessage}`);
      }

      if (discoveredCards.size >= this.config.maxTotalCards) {
        break;
      }
    }

    const durationMs = Math.round(performance.now() - startTime);

    return {
      cards: Array.from(discoveredCards.values()),
      totalFound: discoveredCards.size,
      fromCache,
      fromScryfall,
      queriesExecuted: roles.length,
      durationMs,
      errors,
    };
  }

  /**
   * Get cards by exact names (batch lookup)
   */
  async getCardsByNames(names: string[]): Promise<Map<string, DiscoveredCard | null>> {
    const results = new Map<string, DiscoveredCard | null>();
    
    // Use Scryfall batch API
    const scryfallResults = await this.scryfall.getCardsByNames(names);

    for (const [name, card] of scryfallResults) {
      if (card) {
        const discovered = this.convertToDiscovered(card, 'combo_piece', {
          colors: new Set(card.color_identity || []),
          avgCmc: card.cmc || 0,
          roleCounts: {} as Record<DiscoveryRole, number>,
          dominantArchetype: 'combo',
          commanderKeywords: new Set(),
          format: 'commander',
        });
        results.set(name, discovered);
      } else {
        results.set(name, null);
      }
    }

    return results;
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): ReturnType<typeof this.cache.getStats> {
    return this.cache.getStats();
  }

  private convertToDiscovered(
    card: ScryfallCard,
    primaryRole: DiscoveryRole,
    profile: DeckProfile
  ): DiscoveredCard {
    const oracleText = (card.oracle_text || '').toLowerCase();
    const typeLine = (card.type_line || '').toLowerCase();
    
    // Detect all roles
    const roles: DiscoveryRole[] = [];
    for (const [role, patterns] of Object.entries(ROLE_PATTERNS)) {
      if (patterns.some(pattern => oracleText.includes(pattern))) {
        roles.push(role as DiscoveryRole);
      }
    }
    
    if (!roles.includes(primaryRole)) {
      roles.push(primaryRole);
    }

    // Detect archetypes
    const archetypes: string[] = [];
    for (const [archetype, patterns] of Object.entries(ARCHETYPE_PATTERNS)) {
      if (patterns.some(pattern => oracleText.includes(pattern))) {
        archetypes.push(archetype);
      }
    }

    // Generate tags from keywords
    const tags: string[] = [];
    if (card.keywords) {
      tags.push(...card.keywords);
    }
    if (oracleText.includes('artifact')) tags.push('artifact');
    if (oracleText.includes('creature')) tags.push('creature');
    if (oracleText.includes('instant') || oracleText.includes('sorcery')) {
      tags.push('spell');
    }

    // Calculate confidence
    const confidence = this.calculateConfidence(card, primaryRole, profile);

    // Generate reason
    const reason = this.generateReason(card, primaryRole, roles, profile);

    // Check if mana fixer
    const manaFix = oracleText.includes('mana of any color') ||
      oracleText.includes('commander') && oracleText.includes('add');

    // Parse price
    const priceEur = card.prices?.eur ? parseFloat(card.prices.eur) : null;

    return {
      id: card.id,
      name: card.name,
      scryfallId: card.id,
      roles,
      colorIdentity: card.color_identity || card.colors || [],
      archetypes,
      tags,
      cmc: card.cmc || 0,
      manaFix,
      reason,
      discoveredAt: Date.now(),
      source: 'scryfall-search',
      confidence,
      priceEur,
      edhrecRank: card.edhrec_rank || null,
      oracleText: card.oracle_text || '',
      typeLine: card.type_line || '',
    };
  }

  private convertCacheToDiscovered(
    cached: ScryfallCacheEntry,
    primaryRole: DiscoveryRole
  ): DiscoveredCard {
    const oracleText = (cached.oracle_text || '').toLowerCase();
    
    // Detect roles from cached data
    const roles: DiscoveryRole[] = [primaryRole];
    for (const [role, patterns] of Object.entries(ROLE_PATTERNS)) {
      if (patterns.some(pattern => oracleText.includes(pattern))) {
        if (!roles.includes(role as DiscoveryRole)) {
          roles.push(role as DiscoveryRole);
        }
      }
    }

    return {
      id: cached.id,
      name: cached.name,
      scryfallId: cached.id,
      roles,
      colorIdentity: cached.color_identity || cached.colors || [],
      archetypes: [],
      tags: [],
      cmc: cached.cmc || 0,
      manaFix: oracleText.includes('mana of any color'),
      reason: `Recommended for ${primaryRole} based on cached data`,
      discoveredAt: Date.now(),
      source: 'cache',
      confidence: 0.7,
      priceEur: cached.prices?.eur ? parseFloat(cached.prices.eur) : null,
      edhrecRank: cached.edhrec_rank || null,
      oracleText: cached.oracle_text || '',
      typeLine: cached.type_line || '',
    };
  }

  private convertToCacheEntry(card: ScryfallCard): ScryfallCacheEntry {
    return {
      id: card.id,
      name: card.name,
      mana_cost: card.mana_cost,
      cmc: card.cmc,
      type_line: card.type_line,
      oracle_text: card.oracle_text,
      colors: card.colors,
      color_identity: card.color_identity,
      prices: card.prices,
      edhrec_rank: card.edhrec_rank,
    };
  }

  private calculateConfidence(
    card: ScryfallCard,
    role: DiscoveryRole,
    profile: DeckProfile
  ): number {
    let confidence = 0.5;

    // EDHRec rank bonus (lower rank = higher confidence)
    if (card.edhrec_rank) {
      if (card.edhrec_rank < 100) confidence += 0.2;
      else if (card.edhrec_rank < 500) confidence += 0.15;
      else if (card.edhrec_rank < 1000) confidence += 0.1;
    }

    // Color identity match
    const cardColors = new Set(card.color_identity || card.colors || []);
    const profileColors = profile.colors;
    
    if (profileColors.size > 0) {
      const colorMatch = Array.from(cardColors).every(c => 
        profileColors.has(c) || cardColors.size === 0
      );
      if (colorMatch) confidence += 0.1;
    }

    // Role match
    const oracleText = (card.oracle_text || '').toLowerCase();
    const rolePatterns = ROLE_PATTERNS[role];
    if (rolePatterns && rolePatterns.some(p => oracleText.includes(p))) {
      confidence += 0.15;
    }

    // CMC appropriateness
    if (card.cmc) {
      if (role === 'ramp' && card.cmc <= 2) confidence += 0.1;
      if (role === 'finisher' && card.cmc >= 4) confidence += 0.1;
      if (role === 'interaction' && card.cmc <= 3) confidence += 0.1;
    }

    return Math.min(0.95, confidence);
  }

  private generateReason(
    card: ScryfallCard,
    primaryRole: DiscoveryRole,
    allRoles: DiscoveryRole[],
    profile: DeckProfile
  ): string {
    const reasons: string[] = [];

    // Role-based reason
    switch (primaryRole) {
      case 'ramp':
        reasons.push('Accelerates your mana development');
        break;
      case 'draw':
        reasons.push('Provides card advantage');
        break;
      case 'removal':
        reasons.push('Answers opposing threats');
        break;
      case 'interaction':
        reasons.push('Protects your game plan');
        break;
      case 'tutor':
        reasons.push('Finds your key cards consistently');
        break;
      case 'finisher':
        reasons.push('Closes out games');
        break;
      default:
        reasons.push(`Supports your ${primaryRole} strategy`);
    }

    // Secondary roles
    const secondaryRoles = allRoles.filter(r => r !== primaryRole);
    if (secondaryRoles.length > 0) {
      reasons.push(`Also functions as ${secondaryRoles.join(', ')}`);
    }

    // EDHRec popularity
    if (card.edhrec_rank && card.edhrec_rank < 500) {
      reasons.push('Popular choice in Commander');
    }

    return reasons.join('. ') + '.';
  }
}

// Convenience functions
export async function discoverCards(
  profile: DeckProfile,
  config?: DiscoveryConfig
): Promise<DiscoveryResult> {
  const engine = new CardDiscoveryEngine(config);
  return engine.discover(profile);
}

export async function discoverCardsForRoles(
  profile: DeckProfile,
  roles: DiscoveryRole[],
  config?: DiscoveryConfig
): Promise<DiscoveryResult> {
  const engine = new CardDiscoveryEngine(config);
  return engine.discoverForRoles(profile, roles);
}
