/**
 * Meta-Aggregation Service
 * Collects and aggregates meta-data from EDHREC and other sources
 * Runs as Cloudflare Worker with scheduled triggers
 */

import { EDHRECClient } from './edhrec-client.js';

// KV Namespace interface for type safety
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface MetaSnapshot {
  timestamp: string;
  format: 'commander';
  version: string;
  trendingCards: TrendingCard[];
  topCommanders: TopCommander[];
  colorIdentityStats: Record<string, ColorIdentityStats>;
  archetypeInsights: ArchetypeInsight[];
  popularCombos: PopularCombo[];
}

export interface TrendingCard {
  name: string;
  currentRank: number;
  previousRank: number;
  delta: number; // Positive = climbing, negative = falling
  numDecks: number;
}

export interface TopCommander {
  name: string;
  colorIdentity: string[];
  numDecks: number;
  topCards: string[];
  highSynergyCards: string[];
}

export interface ColorIdentityStats {
  colors: string[];
  numDecks: number;
  topCards: string[];
  staples: string[];
}

export interface ArchetypeInsight {
  archetype: string;
  signatureCards: string[];
  popularityTrend: 'rising' | 'stable' | 'falling';
  topCommanders: string[];
}

export interface PopularCombo {
  cards: string[];
  colorIdentity: string[];
  resultsIn: string;
  numDecks: number;
}

export class MetaAggregator {
  private edhrec: EDHRECClient;
  private kv: KVNamespace;
  private snapshotKey = 'meta:snapshot:latest';
  private snapshotHistoryKey = 'meta:snapshot:history';

  constructor(edhrecClient: EDHRECClient, kvNamespace: KVNamespace) {
    this.edhrec = edhrecClient;
    this.kv = kvNamespace;
  }

  /**
   * Main aggregation function - called by scheduled trigger
   */
  async aggregateMeta(): Promise<MetaSnapshot> {
    console.log('[MetaAggregator] Starting meta aggregation...');
    const startTime = Date.now();

    try {
      // Fetch trending cards
      const trendingCards = await this.fetchTrendingCards();

      // Fetch top commanders
      const topCommanders = await this.fetchTopCommanders();

      // Fetch color identity statistics
      const colorIdentityStats = await this.fetchColorIdentityStats();

      // Generate archetype insights
      const archetypeInsights = await this.generateArchetypeInsights(topCommanders);

      // Fetch popular combos
      const popularCombos = await this.fetchPopularCombos();

      const snapshot: MetaSnapshot = {
        timestamp: new Date().toISOString(),
        format: 'commander',
        version: '1.0',
        trendingCards,
        topCommanders,
        colorIdentityStats,
        archetypeInsights,
        popularCombos,
      };

      // Store snapshot
      await this.storeSnapshot(snapshot);

      const duration = Date.now() - startTime;
      console.log(`[MetaAggregator] Aggregation complete in ${duration}ms`);

      return snapshot;
    } catch (error) {
      console.error('[MetaAggregator] Aggregation failed:', error);
      throw error;
    }
  }

  /**
   * Fetch trending cards from EDHREC
   */
  private async fetchTrendingCards(): Promise<TrendingCard[]> {
    console.log('[MetaAggregator] Fetching trending cards...');
    
    try {
      const trending = await this.edhrec.getTrendingCards('week');
      
      return trending.slice(0, 50).map(card => ({
        name: card.name,
        currentRank: card.current_rank,
        previousRank: card.previous_rank,
        delta: card.delta,
        numDecks: 0, // EDHREC trending doesn't include deck count
      }));
    } catch (error) {
      console.error('[MetaAggregator] Failed to fetch trending cards:', error);
      return [];
    }
  }

  /**
   * Fetch top commanders from EDHREC
   */
  private async fetchTopCommanders(): Promise<TopCommander[]> {
    console.log('[MetaAggregator] Fetching top commanders...');
    
    // List of popular commanders to check
    const popularCommanders = [
      'Kraum, Ludevic\'s Opus + Tymna the Weaver',
      'Thrasios, Triton Hero + Tymna the Weaver',
      'Roger, the Cherished Captain',
      'Kinnan, Bonder Prodigy',
      'Malcolm, Keen-Eyed Navigator + Tana, the Bloodsower',
      'Gitrog Monster',
      'K\'rrik, Son of Yawgmoth',
      'Animar, Soul of Elements',
      'Urza, Lord High Artificer',
      'Yuriko, the Tiger\'s Shadow',
      'Kess, Dissident Mage',
      'Najeela, the Blade-Blossom',
      'Heliod, Sun-Crowned',
      'Brago, King Eternal',
      'Zur the Enchanter',
    ];

    const commanders: TopCommander[] = [];

    for (const commander of popularCommanders) {
      try {
        const data = await this.edhrec.getCommanderData(commander);
        if (data) {
          commanders.push({
            name: commander,
            colorIdentity: [], // Would need to extract from card data
            numDecks: data.cards[0]?.num_decks || 0,
            topCards: data.top_cards.slice(0, 10),
            highSynergyCards: data.high_synergy_cards.slice(0, 5),
          });
        }
      } catch (error) {
        console.warn(`[MetaAggregator] Failed to fetch commander ${commander}:`, error);
      }
    }

    return commanders;
  }

  /**
   * Fetch color identity statistics
   */
  private async fetchColorIdentityStats(): Promise<Record<string, ColorIdentityStats>> {
    console.log('[MetaAggregator] Fetching color identity stats...');
    
    const colorCombinations = [
      ['W'], ['U'], ['B'], ['R'], ['G'],
      ['W', 'U'], ['U', 'B'], ['B', 'R'], ['R', 'G'], ['G', 'W'],
      ['W', 'B'], ['U', 'R'], ['B', 'G'], ['R', 'W'], ['G', 'U'],
      ['W', 'U', 'B'], ['U', 'B', 'R'], ['B', 'R', 'G'], ['R', 'G', 'W'], ['G', 'W', 'U'],
      ['W', 'B', 'G'], ['U', 'R', 'W'], ['B', 'G', 'U'], ['R', 'W', 'B'], ['G', 'U', 'R'],
      ['W', 'U', 'B', 'R'], ['U', 'B', 'R', 'G'], ['B', 'R', 'G', 'W'], ['R', 'G', 'W', 'U'], ['G', 'W', 'U', 'B'],
      ['W', 'U', 'B', 'R', 'G'],
    ];

    const stats: Record<string, ColorIdentityStats> = {};

    for (const colors of colorCombinations) {
      try {
        const topCards = await this.edhrec.getTopCardsByColorIdentity(colors, { timeframe: 'month' });
        const staples = await this.edhrec.getColorStaples(colors, 20);

        const colorKey = colors.join('') || 'C';
        stats[colorKey] = {
          colors,
          numDecks: topCards.reduce((sum, c) => sum + (c.num_decks || 0), 0),
          topCards: topCards.slice(0, 10).map(c => c.name),
          staples,
        };
      } catch (error) {
        console.warn(`[MetaAggregator] Failed to fetch stats for ${colors.join('')}:`, error);
      }
    }

    return stats;
  }

  /**
   * Generate archetype insights based on top commanders and cards
   */
  private async generateArchetypeInsights(
    topCommanders: TopCommander[]
  ): Promise<ArchetypeInsight[]> {
    console.log('[MetaAggregator] Generating archetype insights...');
    
    // Define archetype signatures
    const archetypeSignatures: Record<string, string[]> = {
      'Storm': ['Underworld Breach', 'Brain Freeze', 'High Tide', 'Aetherflux Reservoir'],
      'Reanimator': ['Entomb', 'Reanimate', 'Animate Dead', 'Grief', 'Archon of Cruelty'],
      'Food Chain': ['Food Chain', 'Eternal Scourge', 'Misthollow Griffin'],
      'Thassa Oracle': ['Thassa\'s Oracle', 'Demonic Consultation', 'Tainted Pact'],
      'Stax': ['Winter Orb', 'Static Orb', 'Stasis', 'Trinisphere'],
      'Artifact Combo': ['Grim Monolith', 'Basalt Monolith', 'Power Artifact'],
      'Tribal Elves': ['Priest of Titania', 'Elvish Archdruid', 'Craterhoof Behemoth'],
      'Tribal Goblins': ['Krenko, Mob Boss', 'Goblin Lackey', 'Conspicuous Snoop'],
      'Lifegain': ['Soul Warden', 'Serra Ascendant', 'Felidar Sovereign'],
      'Tokens': ['Anointed Procession', 'Doubling Season', 'Craterhoof Behemoth'],
      'Aristocrats': ['Blood Artist', 'Zulaport Cutthroat', 'Ashnod\'s Altar'],
      'Lands Matter': ['Gitrog Monster', 'Titania, Protector of Argoth', 'Azusa, Lost but Seeking'],
    };

    const insights: ArchetypeInsight[] = [];

    for (const [archetype, signatureCards] of Object.entries(archetypeSignatures)) {
      // Check which commanders play these cards
      const topCommandersForArchetype = topCommanders
        .filter(cmd => 
          signatureCards.some(sig => 
            cmd.topCards.includes(sig) || cmd.highSynergyCards.includes(sig)
          )
        )
        .map(cmd => cmd.name);

      if (topCommandersForArchetype.length > 0) {
        insights.push({
          archetype,
          signatureCards,
          popularityTrend: 'stable', // Would need historical data to calculate
          topCommanders: topCommandersForArchetype,
        });
      }
    }

    return insights;
  }

  /**
   * Fetch popular combos from various sources
   */
  private async fetchPopularCombos(): Promise<PopularCombo[]> {
    console.log('[MetaAggregator] Fetching popular combos...');
    
    // Known popular combos
    const knownCombos = [
      {
        cards: ['Thassa\'s Oracle', 'Demonic Consultation'],
        colorIdentity: ['U', 'B'],
        resultsIn: 'Win the game',
      },
      {
        cards: ['Underworld Breach', 'Lion\'s Eye Diamond', 'Brain Freeze'],
        colorIdentity: ['U', 'R'],
        resultsIn: 'Win with mill',
      },
      {
        cards: ['Food Chain', 'Eternal Scourge'],
        colorIdentity: ['G'],
        resultsIn: 'Infinite mana',
      },
      {
        cards: ['Grim Monolith', 'Power Artifact'],
        colorIdentity: ['U'],
        resultsIn: 'Infinite mana',
      },
      {
        cards: ['Basalt Monolith', 'Rings of Brighthearth'],
        colorIdentity: ['C'],
        resultsIn: 'Infinite mana',
      },
    ];

    const combos: PopularCombo[] = [];

    for (const combo of knownCombos) {
      try {
        // Check popularity of combo pieces
        let totalDecks = 0;
        for (const card of combo.cards) {
          const data = await this.edhrec.getCardData(card);
          if (data) {
            totalDecks += data.num_decks;
          }
        }

        combos.push({
          cards: combo.cards,
          colorIdentity: combo.colorIdentity,
          resultsIn: combo.resultsIn,
          numDecks: Math.round(totalDecks / combo.cards.length),
        });
      } catch (error) {
        console.warn(`[MetaAggregator] Failed to fetch combo data:`, error);
      }
    }

    return combos.sort((a, b) => b.numDecks - a.numDecks);
  }

  /**
   * Store snapshot in KV
   */
  private async storeSnapshot(snapshot: MetaSnapshot): Promise<void> {
    // Store latest snapshot
    await this.kv.put(this.snapshotKey, JSON.stringify(snapshot), {
      expirationTtl: 60 * 60 * 24 * 7, // 7 days
    });

    // Add to history
    const history = await this.getSnapshotHistory();
    history.push(snapshot);
    
    // Keep only last 30 snapshots
    if (history.length > 30) {
      history.shift();
    }

    await this.kv.put(this.snapshotHistoryKey, JSON.stringify(history), {
      expirationTtl: 60 * 60 * 24 * 30, // 30 days
    });

    console.log('[MetaAggregator] Snapshot stored');
  }

  /**
   * Get latest snapshot
   */
  async getLatestSnapshot(): Promise<MetaSnapshot | null> {
    try {
      const data = await this.kv.get(this.snapshotKey);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('[MetaAggregator] Failed to get snapshot:', error);
      return null;
    }
  }

  /**
   * Get snapshot history
   */
  async getSnapshotHistory(): Promise<MetaSnapshot[]> {
    try {
      const data = await this.kv.get(this.snapshotHistoryKey);
      return data ? JSON.parse(data) : [];
    } catch (error) {
      console.error('[MetaAggregator] Failed to get history:', error);
      return [];
    }
  }

  /**
   * Get anti-meta recommendations
   */
  async getAntiMetaRecommendations(
    detectedArchetypes: string[],
    deckColors: string[]
  ): Promise<Array<{ targetArchetype: string; counterCards: string[]; reason: string }>> {
    const snapshot = await this.getLatestSnapshot();
    if (!snapshot) return [];

    const recommendations: Array<{ targetArchetype: string; counterCards: string[]; reason: string }> = [];

    for (const archetype of detectedArchetypes) {
      const insight = snapshot.archetypeInsights.find(i => i.archetype === archetype);
      if (!insight) continue;

      // Get counter cards that fit deck colors
      // This would need the archetype catalog integration
      // For now, return generic advice
      recommendations.push({
        targetArchetype: archetype,
        counterCards: [],
        reason: `${archetype} is popular in the current meta. Consider cards that disrupt its strategy.`,
      });
    }

    return recommendations;
  }
}
