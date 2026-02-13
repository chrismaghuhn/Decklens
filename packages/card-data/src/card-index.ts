import type { Color, CardTag } from '@mtg/game-engine';
import type { CardData } from './scryfall-loader.ts';

/**
 * Card Index — Fast O(1) card lookup and search.
 *
 * Provides:
 * - Exact name lookup (case-insensitive)
 * - Oracle ID lookup
 * - Search by name substring
 * - Filter by color identity, type line, tags, CMC range
 * - Commander-specific queries (legendary creatures)
 * - Random card selection
 */

/** Search/filter options */
export interface CardSearchOptions {
  /** Name contains (case-insensitive) */
  nameContains?: string;
  /** Must include these colors in color identity */
  colorIdentityIncludes?: Color[];
  /** Color identity must be EXACTLY these colors (for commander decks) */
  colorIdentityExact?: Color[];
  /** Color identity must be subset of these colors */
  colorIdentityWithin?: Color[];
  /** Type line contains (case-insensitive) */
  typeContains?: string;
  /** Must have all these tags */
  tags?: CardTag[];
  /** Must have at least one of these tags */
  tagsAny?: CardTag[];
  /** CMC minimum */
  cmcMin?: number;
  /** CMC maximum */
  cmcMax?: number;
  /** Must be legendary */
  legendary?: boolean;
  /** Limit results */
  limit?: number;
}

export class CardIndex {
  /** All cards in the index */
  private cards: CardData[];
  /** Name → CardData (lowercase, exact match) */
  private byName: Map<string, CardData>;
  /** Oracle ID → CardData */
  private byOracleId: Map<string, CardData>;
  /** Name prefix trie for autocomplete/search (lowercase first 3 chars → cards) */
  private namePrefixes: Map<string, CardData[]>;

  constructor(cards: CardData[]) {
    this.cards = cards;
    this.byName = new Map();
    this.byOracleId = new Map();
    this.namePrefixes = new Map();

    this.buildIndex(cards);
  }

  private buildIndex(cards: CardData[]): void {
    for (const card of cards) {
      const lowerName = card.name.toLowerCase();

      // Exact name index (first encountered wins — oracle_cards should be unique)
      if (!this.byName.has(lowerName)) {
        this.byName.set(lowerName, card);
      }

      // Oracle ID index
      if (!this.byOracleId.has(card.oracleId)) {
        this.byOracleId.set(card.oracleId, card);
      }

      // Prefix index (3-character prefixes)
      const prefix = lowerName.slice(0, 3);
      if (!this.namePrefixes.has(prefix)) {
        this.namePrefixes.set(prefix, []);
      }
      this.namePrefixes.get(prefix)!.push(card);
    }
  }

  /** Get total number of cards */
  get size(): number {
    return this.cards.length;
  }

  /** O(1) lookup by exact name (case-insensitive) */
  getByName(name: string): CardData | undefined {
    return this.byName.get(name.toLowerCase());
  }

  /** O(1) lookup by oracle ID */
  getByOracleId(oracleId: string): CardData | undefined {
    return this.byOracleId.get(oracleId);
  }

  /**
   * Search cards with various filters.
   * Returns matching cards sorted by EDHREC rank (most popular first).
   */
  search(options: CardSearchOptions): CardData[] {
    let candidates: CardData[];

    // Use prefix index for name searches to narrow candidates
    if (options.nameContains && options.nameContains.length >= 3) {
      const prefix = options.nameContains.toLowerCase().slice(0, 3);
      candidates = this.namePrefixes.get(prefix) || [];
    } else {
      candidates = this.cards;
    }

    let results = candidates.filter((card) => {
      // Name filter
      if (options.nameContains) {
        if (!card.name.toLowerCase().includes(options.nameContains.toLowerCase())) {
          return false;
        }
      }

      // Color identity includes
      if (options.colorIdentityIncludes) {
        const identity = new Set(card.colorIdentity);
        if (!options.colorIdentityIncludes.every((c) => identity.has(c))) {
          return false;
        }
      }

      // Color identity exact
      if (options.colorIdentityExact) {
        const exact = new Set(options.colorIdentityExact);
        const identity = new Set(card.colorIdentity);
        if (exact.size !== identity.size || !Array.from(exact).every((c) => identity.has(c))) {
          return false;
        }
      }

      // Color identity within (for deck building — card must fit within commander's identity)
      if (options.colorIdentityWithin) {
        const allowed = new Set(options.colorIdentityWithin);
        if (!card.colorIdentity.every((c) => allowed.has(c))) {
          return false;
        }
      }

      // Type filter
      if (options.typeContains) {
        if (!card.typeLine.toLowerCase().includes(options.typeContains.toLowerCase())) {
          return false;
        }
      }

      // Tags (all must match)
      if (options.tags) {
        const cardTags = new Set(card.tags);
        if (!options.tags.every((t) => cardTags.has(t))) {
          return false;
        }
      }

      // Tags (any must match)
      if (options.tagsAny) {
        const cardTags = new Set(card.tags);
        if (!options.tagsAny.some((t) => cardTags.has(t))) {
          return false;
        }
      }

      // CMC range
      if (options.cmcMin !== undefined && card.cmc < options.cmcMin) return false;
      if (options.cmcMax !== undefined && card.cmc > options.cmcMax) return false;

      // Legendary
      if (options.legendary !== undefined) {
        const isLegendary = card.typeLine.toLowerCase().includes('legendary');
        if (options.legendary !== isLegendary) return false;
      }

      return true;
    });

    // Sort by EDHREC rank (lower = more popular)
    results.sort((a, b) => (a.edhrecRank ?? 99999) - (b.edhrecRank ?? 99999));

    // Limit
    if (options.limit !== undefined) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  /** Find all legendary creatures (potential commanders) */
  getCommanders(colorIdentity?: Color[]): CardData[] {
    return this.search({
      typeContains: 'creature',
      legendary: true,
      colorIdentityExact: colorIdentity,
    });
  }

  /**
   * Get cards that fit within a commander's color identity.
   * This is the main query for building EDH decks.
   */
  getCardsForCommander(commander: CardData): CardData[] {
    return this.search({
      colorIdentityWithin: commander.colorIdentity,
    });
  }

  /** Get all cards with a specific tag */
  getByTag(tag: CardTag): CardData[] {
    return this.cards.filter((card) => card.tags.includes(tag));
  }

  /** Get N random cards (for random deck generation) */
  getRandomCards(count: number, options?: CardSearchOptions): CardData[] {
    const pool = options ? this.search(options) : this.cards;
    const result: CardData[] = [];
    const used = new Set<number>();

    const max = Math.min(count, pool.length);
    while (result.length < max) {
      const idx = Math.floor(Math.random() * pool.length);
      if (!used.has(idx)) {
        used.add(idx);
        result.push(pool[idx]);
      }
    }

    return result;
  }

  /** Get all cards in the index */
  getAllCards(): CardData[] {
    return [...this.cards];
  }

  /** Get all unique card names */
  getAllNames(): string[] {
    return Array.from(this.byName.keys());
  }

  /**
   * Autocomplete card name (prefix search).
   * Returns up to `limit` matches sorted by name.
   */
  autocomplete(prefix: string, limit: number = 10): CardData[] {
    const lower = prefix.toLowerCase();
    if (lower.length < 2) return [];

    const results: CardData[] = [];
    for (const card of this.cards) {
      if (card.name.toLowerCase().startsWith(lower)) {
        results.push(card);
        if (results.length >= limit) break;
      }
    }

    return results;
  }
}
