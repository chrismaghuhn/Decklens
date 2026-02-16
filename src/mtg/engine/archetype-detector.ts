/**
 * Enhanced Archetype Detection
 * Uses the archetype catalog to detect deck archetypes with confidence scores
 */

import type { Deck, DeckEntry } from '../../shared/types.js';
import {
  ARCHETYPE_CATALOG,
  type ArchetypeDefinition,
  type ArchetypeId,
  getArchetypeById,
  getCounterCardsForArchetype,
} from './archetype-catalog.js';

export interface ArchetypeDetectionResult {
  primaryArchetype: ArchetypeId | null;
  secondaryArchetypes: Array<{ id: ArchetypeId; confidence: number }>;
  allScores: Array<{ id: ArchetypeId; score: number; confidence: number }>;
  detectedCards: Map<ArchetypeId, string[]>;
  counterCards: string[];
  hybridArchetype: boolean;
}

export interface ArchetypeDetectionConfig {
  minConfidenceThreshold: number;
  secondaryArchetypeThreshold: number;
  maxSecondaryArchetypes: number;
}

const DEFAULT_CONFIG: ArchetypeDetectionConfig = {
  minConfidenceThreshold: 0.4,
  secondaryArchetypeThreshold: 0.25,
  maxSecondaryArchetypes: 2,
};

function normalizeCardName(name: string): string {
  return name.toLowerCase().trim();
}

function calculateArchetypeScore(
  deck: Deck,
  archetype: ArchetypeDefinition,
  cardResolver: (name: string) => { name: string; type_line?: string; oracle_text?: string } | undefined
): { score: number; confidence: number; detectedCards: string[] } {
  const detectedCards: string[] = [];
  let keyCardCount = 0;
  let signatureCardCount = 0;
  let synergisticCardCount = 0;
  
  const deckCardNames = new Set([
    ...deck.main.map(e => normalizeCardName(e.name)),
    ...deck.sideboard.map(e => normalizeCardName(e.name)),
    ...deck.commander.map(e => normalizeCardName(e.name)),
  ]);
  
  // Check for key cards
  for (const cardName of archetype.keyCards) {
    if (deckCardNames.has(normalizeCardName(cardName))) {
      keyCardCount++;
      detectedCards.push(cardName);
    }
  }
  
  // Check for signature cards
  for (const cardName of archetype.signatureCards) {
    if (deckCardNames.has(normalizeCardName(cardName))) {
      signatureCardCount++;
      if (!detectedCards.includes(cardName)) {
        detectedCards.push(cardName);
      }
    }
  }
  
  // Check for synergistic cards (less weight)
  for (const cardName of archetype.synergisticCards) {
    if (deckCardNames.has(normalizeCardName(cardName))) {
      synergisticCardCount++;
      if (!detectedCards.includes(cardName)) {
        detectedCards.push(cardName);
      }
    }
  }
  
  // Check commander compatibility
  const commanders = deck.commander.map(c => cardResolver(c.name));
  let commanderBonus = 0;
  
  for (const commander of commanders) {
    if (!commander) continue;
    
    // Check if commander matches preferred colors
    // (This would need proper color identity extraction from the card data)
    
    // Check commander text for archetype indicators
    const oracleText = (commander.oracle_text || '').toLowerCase();
    if (archetype.keyCards.some(c => oracleText.includes(c.toLowerCase()))) {
      commanderBonus += 2;
    }
  }
  
  // Calculate raw score
  const keyScore = keyCardCount * 3;
  const signatureScore = signatureCardCount * 2;
  const synergisticScore = synergisticCardCount * 0.5;
  
  const rawScore = (keyScore + signatureScore + synergisticScore + commanderBonus) * archetype.detection.weightMultiplier;
  
  // Calculate confidence (0-1)
  const meetsKeyThreshold = keyCardCount >= archetype.detection.minKeyCards;
  const meetsSignatureThreshold = signatureCardCount >= archetype.detection.minSignatureCards;
  
  let confidence = 0;
  if (meetsKeyThreshold && meetsSignatureThreshold) {
    confidence = Math.min(1, rawScore / 20);
  } else if (meetsKeyThreshold || meetsSignatureThreshold) {
    confidence = Math.min(0.7, rawScore / 20);
  } else {
    confidence = Math.min(0.4, rawScore / 30);
  }
  
  return { score: rawScore, confidence, detectedCards };
}

export function detectDeckArchetype(
  deck: Deck,
  cardResolver: (name: string) => { name: string; type_line?: string; oracle_text?: string } | undefined,
  config: Partial<ArchetypeDetectionConfig> = {}
): ArchetypeDetectionResult {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  
  const scores: Array<{ id: ArchetypeId; score: number; confidence: number; detectedCards: string[] }> = [];
  
  // Calculate score for each archetype
  for (const archetype of ARCHETYPE_CATALOG) {
    const result = calculateArchetypeScore(deck, archetype, cardResolver);
    scores.push({
      id: archetype.id,
      score: result.score,
      confidence: result.confidence,
      detectedCards: result.detectedCards,
    });
  }
  
  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);
  
  // Determine primary archetype
  const primaryArchetype = scores[0]?.confidence >= fullConfig.minConfidenceThreshold
    ? scores[0].id
    : null;
  
  // Determine secondary archetypes
  const secondaryArchetypes: Array<{ id: ArchetypeId; confidence: number }> = [];
  for (let i = 1; i < scores.length && secondaryArchetypes.length < fullConfig.maxSecondaryArchetypes; i++) {
    if (scores[i].confidence >= fullConfig.secondaryArchetypeThreshold) {
      secondaryArchetypes.push({
        id: scores[i].id,
        confidence: scores[i].confidence,
      });
    }
  }
  
  // Build detected cards map
  const detectedCards = new Map<ArchetypeId, string[]>();
  for (const score of scores) {
    if (score.detectedCards.length > 0) {
      detectedCards.set(score.id, score.detectedCards);
    }
  }
  
  // Get counter cards for detected archetypes
  const counterCards = new Set<string>();
  if (primaryArchetype) {
    const cards = getCounterCardsForArchetype(primaryArchetype);
    cards.forEach(c => counterCards.add(c));
  }
  for (const secondary of secondaryArchetypes) {
    const cards = getCounterCardsForArchetype(secondary.id);
    cards.forEach(c => counterCards.add(c));
  }
  
  // Check if hybrid (multiple archetypes with similar scores)
  const hybridArchetype = secondaryArchetypes.length > 0 && 
    scores[0].confidence - (scores[1]?.confidence || 0) < 0.2;
  
  return {
    primaryArchetype,
    secondaryArchetypes,
    allScores: scores.map(s => ({ id: s.id, score: s.score, confidence: s.confidence })),
    detectedCards,
    counterCards: Array.from(counterCards),
    hybridArchetype,
  };
}

export function getArchetypeRecommendations(
  archetypeId: ArchetypeId,
  maxRecommendations: number = 5
): Array<{ card: string; reason: string; priority: 'high' | 'medium' | 'low' }> {
  const archetype = getArchetypeById(archetypeId);
  if (!archetype) return [];
  
  const recommendations: Array<{ card: string; reason: string; priority: 'high' | 'medium' | 'low' }> = [];
  
  // Recommend missing key cards
  for (const card of archetype.keyCards.slice(0, 2)) {
    recommendations.push({
      card,
      reason: `Key card for ${archetype.name}`,
      priority: 'high',
    });
  }
  
  // Recommend signature cards
  for (const card of archetype.signatureCards.slice(0, maxRecommendations - recommendations.length)) {
    if (!recommendations.some(r => r.card === card)) {
      recommendations.push({
        card,
        reason: `Signature ${archetype.name} card`,
        priority: 'high',
      });
    }
  }
  
  // Recommend synergistic cards if needed
  if (recommendations.length < maxRecommendations) {
    for (const card of archetype.synergisticCards.slice(0, maxRecommendations - recommendations.length)) {
      if (!recommendations.some(r => r.card === card)) {
        recommendations.push({
          card,
          reason: `Synergistic with ${archetype.name}`,
          priority: 'medium',
        });
      }
    }
  }
  
  return recommendations.slice(0, maxRecommendations);
}

export function formatArchetypeDetectionResult(result: ArchetypeDetectionResult): string {
  const parts: string[] = [];
  
  if (result.primaryArchetype) {
    const archetype = getArchetypeById(result.primaryArchetype);
    parts.push(`Primary: ${archetype?.name || result.primaryArchetype}`);
  }
  
  if (result.secondaryArchetypes.length > 0) {
    const secondary = result.secondaryArchetypes
      .map(a => getArchetypeById(a.id)?.name || a.id)
      .join(', ');
    parts.push(`Secondary: ${secondary}`);
  }
  
  if (result.hybridArchetype) {
    parts.push('(Hybrid archetype)');
  }
  
  return parts.join(' | ');
}
