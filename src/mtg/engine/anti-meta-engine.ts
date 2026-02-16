/**
 * Anti-Meta Recommendation Engine
 * Generates counter-card recommendations based on detected archetypes and current meta
 */

import type { Deck } from '../../shared/types.js';
import {
  ARCHETYPE_CATALOG,
  type ArchetypeDefinition,
  type ArchetypeId,
  getArchetypeById,
  getCounterCardsForArchetype,
} from './archetype-catalog.js';
import type { ArchetypeDetectionResult } from './archetype-detector.js';

export interface AntiMetaRecommendation {
  targetArchetype: ArchetypeId;
  archetypeName: string;
  metaShare: number; // Estimated % of meta
  counterCards: CounterCardRecommendation[];
  reason: string;
  priority: 'high' | 'medium' | 'low';
}

export interface CounterCardRecommendation {
  cardName: string;
  effectiveness: number; // 0-100
  reason: string;
  fitsColorIdentity: boolean;
  alreadyInDeck: boolean;
}

export interface MetaContext {
  trendingArchetypes: Array<{ id: ArchetypeId; popularity: number }>;
  localMeta?: Array<{ id: ArchetypeId; frequency: number }>; // User's local playgroup
  format: 'commander' | 'cEDH';
}

export interface AntiMetaEngineConfig {
  minMetaShareThreshold: number; // Only show archetypes with >X% meta share
  maxRecommendations: number;
  prioritizeColorFitting: boolean;
  includeAlreadyOwned: boolean;
}

const DEFAULT_CONFIG: AntiMetaEngineConfig = {
  minMetaShareThreshold: 0.1, // 10%
  maxRecommendations: 3,
  prioritizeColorFitting: true,
  includeAlreadyOwned: true,
};

export class AntiMetaEngine {
  private config: AntiMetaEngineConfig;

  constructor(config: Partial<AntiMetaEngineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Generate anti-meta recommendations for a deck
   */
  generateRecommendations(
    deck: Deck,
    detectedArchetypes: ArchetypeDetectionResult,
    metaContext: MetaContext,
    cardResolver: (name: string) => { color_identity?: string[] } | undefined,
    collection?: Set<string>
  ): AntiMetaRecommendation[] {
    const recommendations: AntiMetaRecommendation[] = [];
    const deckColors = this.extractDeckColors(deck, cardResolver);
    const deckCardNames = new Set([
      ...deck.main.map(e => e.name.toLowerCase()),
      ...deck.sideboard.map(e => e.name.toLowerCase()),
      ...deck.commander.map(e => e.name.toLowerCase()),
    ]);

    // Get dominant archetypes from meta context
    const dominantArchetypes = metaContext.trendingArchetypes
      .filter(a => a.popularity >= this.config.minMetaShareThreshold)
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 5);

    for (const archetypeData of dominantArchetypes) {
      const archetype = getArchetypeById(archetypeData.id);
      if (!archetype) continue;

      // Don't recommend counters against your own archetype
      if (detectedArchetypes.primaryArchetype === archetypeData.id) continue;
      if (detectedArchetypes.secondaryArchetypes.some(a => a.id === archetypeData.id)) continue;

      const counterCards = this.evaluateCounterCards(
        archetype,
        deckColors,
        deckCardNames,
        cardResolver,
        collection
      );

      if (counterCards.length === 0) continue;

      recommendations.push({
        targetArchetype: archetypeData.id,
        archetypeName: archetype.name,
        metaShare: archetypeData.popularity,
        counterCards: counterCards.slice(0, 5),
        reason: this.generateReason(archetype, archetypeData.popularity),
        priority: this.calculatePriority(archetypeData.popularity, counterCards),
      });
    }

    // Sort by priority and meta share
    return recommendations
      .sort((a, b) => {
        const priorityOrder = { high: 3, medium: 2, low: 1 };
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[b.priority] - priorityOrder[a.priority];
        }
        return b.metaShare - a.metaShare;
      })
      .slice(0, this.config.maxRecommendations);
  }

  /**
   * Evaluate counter cards for an archetype
   */
  private evaluateCounterCards(
    archetype: ArchetypeDefinition,
    deckColors: Set<string>,
    deckCardNames: Set<string>,
    cardResolver: (name: string) => { color_identity?: string[] } | undefined,
    collection?: Set<string>
  ): CounterCardRecommendation[] {
    const recommendations: CounterCardRecommendation[] = [];

    for (const counterCard of archetype.counterCards) {
      const cardData = cardResolver(counterCard);
      if (!cardData) continue;

      const cardColorIdentity = new Set(cardData.color_identity || []);
      const fitsColors = this.cardFitsColorIdentity(cardColorIdentity, deckColors);
      const alreadyInDeck = deckCardNames.has(counterCard.toLowerCase());

      // Skip if not in collection and we're only showing owned cards
      if (!this.config.includeAlreadyOwned && collection) {
        const normalizedName = counterCard.toLowerCase();
        let inCollection = false;
        for (const owned of collection) {
          if (owned.toLowerCase() === normalizedName) {
            inCollection = true;
            break;
          }
        }
        if (!inCollection) continue;
      }

      // Calculate effectiveness
      let effectiveness = 70; // Base effectiveness

      // Bonus if card specifically targets this archetype
      if (this.isSpecificCounter(counterCard, archetype)) {
        effectiveness += 15;
      }

      // Bonus if fits color identity
      if (fitsColors) {
        effectiveness += 10;
      }

      // Penalty if already in deck
      if (alreadyInDeck) {
        effectiveness = 30;
      }

      recommendations.push({
        cardName: counterCard,
        effectiveness: Math.min(100, effectiveness),
        reason: this.generateCounterReason(counterCard, archetype),
        fitsColorIdentity: fitsColors,
        alreadyInDeck,
      });
    }

    // Sort by effectiveness
    return recommendations.sort((a, b) => b.effectiveness - a.effectiveness);
  }

  /**
   * Check if a card is a specific counter to an archetype
   */
  private isSpecificCounter(cardName: string, archetype: ArchetypeDefinition): boolean {
    // Check if this card is specifically designed to counter this archetype
    // For example, Rest in Peace is specifically good against graveyard strategies
    
    const specificCounters: Record<string, string[]> = {
      'Rest in Peace': ['reanimator', 'underworld-breach', 'gitrog-dredge'],
      "Grafdigger's Cage": ['reanimator', 'underworld-breach', 'aristocrats'],
      'Leyline of the Void': ['reanimator', 'underworld-breach', 'gitrog-dredge'],
      'Rule of Law': ['storm', 'underworld-breach'],
      'Ethersworn Canonist': ['storm', 'underworld-breach'],
      'Deafening Silence': ['storm', 'underworld-breach'],
      'Trinisphere': ['storm', 'artifact-combo'],
      'Collector Ouphe': ['artifact-combo'],
      'Null Rod': ['artifact-combo'],
      'Stony Silence': ['artifact-combo'],
      'Cursed Totem': ['food-chain', 'tribal-elves'],
      'Linvala, Keeper of Silence': ['food-chain', 'tribal-elves'],
      'Blood Moon': ['lands-matter'],
      'Magus of the Moon': ['lands-matter'],
    };

    const countersForCard = specificCounters[cardName];
    if (countersForCard) {
      return countersForCard.includes(archetype.id);
    }

    return false;
  }

  /**
   * Generate reason for counter card
   */
  private generateCounterReason(cardName: string, archetype: ArchetypeDefinition): string {
    const specificReasons: Record<string, string> = {
      'Rest in Peace': 'Shuts down graveyard strategies completely',
      "Grafdigger's Cage": 'Prevents creatures entering from graveyard/library',
      'Leyline of the Void': 'Exiles all cards that would go to graveyard',
      'Rule of Law': 'Limits to one spell per turn, stops Storm',
      'Ethersworn Canonist': 'Prevents multiple non-creature spells per turn',
      'Deafening Silence': 'Makes combos much slower',
      'Trinisphere': 'Forces payment of 3 mana minimum',
      'Collector Ouphe': 'Shuts off all artifact activations',
      'Null Rod': 'Prevents artifact abilities',
      'Stony Silence': 'Disables artifacts',
      'Cursed Totem': 'Stops creature activated abilities',
      'Linvala, Keeper of Silence': 'Disables creature abilities',
      'Blood Moon': 'Turns non-basics into Mountains',
      'Magus of the Moon': 'Blood Moon on a body',
    };

    return specificReasons[cardName] || `Counters ${archetype.name} strategy`;
  }

  /**
   * Generate reason for the anti-meta recommendation
   */
  private generateReason(archetype: ArchetypeDefinition, metaShare: number): string {
    const percentage = Math.round(metaShare * 100);
    
    if (percentage >= 20) {
      return `${archetype.name} is very popular (${percentage}% of meta). These cards significantly improve your matchup.`;
    } else if (percentage >= 10) {
      return `${archetype.name} makes up ${percentage}% of the current meta. Consider these counters.`;
    } else {
      return `${archetype.name} strategy is on the rise. These cards help hedge against it.`;
    }
  }

  /**
   * Calculate priority based on meta share and counter quality
   */
  private calculatePriority(
    metaShare: number,
    counterCards: CounterCardRecommendation[]
  ): 'high' | 'medium' | 'low' {
    const hasHighEffectiveness = counterCards.some(c => c.effectiveness >= 80);
    const hasFittingCards = counterCards.some(c => c.fitsColorIdentity && !c.alreadyInDeck);

    if (metaShare >= 0.2 && hasHighEffectiveness && hasFittingCards) {
      return 'high';
    } else if (metaShare >= 0.1 && hasFittingCards) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * Extract deck colors from commanders and main deck
   */
  private extractDeckColors(
    deck: Deck,
    cardResolver: (name: string) => { color_identity?: string[] } | undefined
  ): Set<string> {
    const colors = new Set<string>();

    // Get colors from commanders
    for (const commander of deck.commander) {
      const card = cardResolver(commander.name);
      if (card?.color_identity) {
        card.color_identity.forEach(c => colors.add(c));
      }
    }

    // If no commanders or no colors found, infer from deck
    if (colors.size === 0) {
      for (const entry of deck.main.slice(0, 20)) { // Check first 20 cards
        const card = cardResolver(entry.name);
        if (card?.color_identity) {
          card.color_identity.forEach(c => colors.add(c));
        }
      }
    }

    return colors;
  }

  /**
   * Check if a card fits within the deck's color identity
   */
  private cardFitsColorIdentity(
    cardColors: Set<string>,
    deckColors: Set<string>
  ): boolean {
    // Colorless cards fit everywhere
    if (cardColors.size === 0) return true;
    
    // All card colors must be in deck colors
    for (const color of cardColors) {
      if (!deckColors.has(color)) return false;
    }
    
    return true;
  }

  /**
   * Get all possible counter cards for the current meta
   */
  getAllCounterCards(metaContext: MetaContext): Map<string, ArchetypeId[]> {
    const counterMap = new Map<string, ArchetypeId[]>();

    for (const archetypeData of metaContext.trendingArchetypes) {
      const archetype = getArchetypeById(archetypeData.id);
      if (!archetype) continue;

      for (const counterCard of archetype.counterCards) {
        const normalizedCard = counterCard.toLowerCase();
        if (!counterMap.has(normalizedCard)) {
          counterMap.set(normalizedCard, []);
        }
        const archetypes = counterMap.get(normalizedCard)!;
        if (!archetypes.includes(archetypeData.id)) {
          archetypes.push(archetypeData.id);
        }
      }
    }

    return counterMap;
  }

  /**
   * Estimate meta share for archetypes (placeholder for real data)
   */
  static estimateMetaShare(format: 'commander' | 'cEDH'): Map<ArchetypeId, number> {
    const estimates: Record<'commander' | 'cEDH', Record<ArchetypeId, number>> = {
      commander: {
        'reanimator': 0.08,
        'storm': 0.05,
        'tribal-elves': 0.12,
        'tribal-goblins': 0.10,
        'lifegain': 0.15,
        'tokens': 0.14,
        'aristocrats': 0.11,
        'voltron': 0.09,
        'lands-matter': 0.07,
      } as Record<ArchetypeId, number>,
      cEDH: {
        'reanimator': 0.15,
        'storm': 0.20,
        'food-chain': 0.12,
        'thassa-oracle': 0.25,
        'underworld-breach': 0.10,
        'artifact-combo': 0.08,
        'stax': 0.10,
      } as Record<ArchetypeId, number>,
    };

    return new Map(Object.entries(estimates[format])) as Map<ArchetypeId, number>;
  }
}

// Convenience function
export function generateAntiMetaRecommendations(
  deck: Deck,
  detectedArchetypes: ArchetypeDetectionResult,
  format: 'commander' | 'cEDH' = 'commander',
  cardResolver: (name: string) => { color_identity?: string[] } | undefined,
  collection?: Set<string>
): AntiMetaRecommendation[] {
  const engine = new AntiMetaEngine();
  
  // Create meta context from estimates
  const metaShares = AntiMetaEngine.estimateMetaShare(format);
  const trendingArchetypes = Array.from(metaShares.entries())
    .map(([id, popularity]) => ({ id, popularity }))
    .sort((a, b) => b.popularity - a.popularity);

  const metaContext: MetaContext = {
    trendingArchetypes,
    format,
  };

  return engine.generateRecommendations(
    deck,
    detectedArchetypes,
    metaContext,
    cardResolver,
    collection
  );
}
