/**
 * ML Recommendation Engine
 * Personalizes recommendations based on user feedback and behavior
 * Uses collaborative filtering and content-based filtering
 */

import type { RecommendationItem } from '../recommendation-impact.js';
import type { UserPreference, FeedbackEvent } from './user-feedback.js';
import type { ArchetypeId } from './archetype-catalog.js';
import type { RecSource } from './recommendation-v1.js';

export interface MLRecommendationConfig {
  collaborativeWeight: number; // 0-1, how much to trust similar users
  contentWeight: number; // 0-1, how much to trust card similarities
  explorationRate: number; // 0-1, how often to try new recommendations
  minConfidenceThreshold: number;
}

export interface CardVector {
  cardName: string;
  features: {
    cmc: number;
    colors: number[]; // One-hot encoded
    types: number[]; // One-hot encoded (creature, instant, etc.)
    powerLevel: number; // 0-1
    synergy: number; // 0-1
    archetypeScores: Record<string, number>;
  };
}

export interface SimilarUser {
  userId: string;
  similarity: number; // 0-1
  preferences: UserPreference[];
}

export interface PersonalizedScore {
  baseScore: number;
  collaborativeScore: number;
  contentScore: number;
  feedbackScore: number;
  finalScore: number;
  confidence: number;
  reason: string;
  source: RecSource;
}

const DEFAULT_CONFIG: MLRecommendationConfig = {
  collaborativeWeight: 0.3,
  contentWeight: 0.3,
  explorationRate: 0.15,
  minConfidenceThreshold: 0.4,
};

export class MLRecommendationEngine {
  private config: MLRecommendationConfig;
  private cardVectors: Map<string, CardVector> = new Map();
  private userSimilarities: Map<string, SimilarUser[]> = new Map();
  private globalStats: {
    totalUsers: number;
    averagePreferences: Map<string, number>;
  } = { totalUsers: 0, averagePreferences: new Map() };

  constructor(config: Partial<MLRecommendationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Score a recommendation with ML personalization
   */
  scoreRecommendation(
    recommendation: RecommendationItem,
    userPreferences: UserPreference[],
    detectedArchetypes: ArchetypeId[],
    similarUsers: SimilarUser[] = []
  ): PersonalizedScore {
    const cardName = recommendation.cardName.toLowerCase();
    const userPref = userPreferences.find(p => 
      p.cardName.toLowerCase() === cardName
    );

    // 1. Base score from recommendation engine
    const baseScore = recommendation.powerImpactScore / 100;

    // 2. Feedback score (user's historical preference)
    let feedbackScore = 0;
    let feedbackConfidence = 0;
    if (userPref) {
      feedbackScore = userPref.score; // -1 to 1
      feedbackConfidence = userPref.confidence;
    }

    // 3. Collaborative score (what similar users like)
    let collaborativeScore = 0;
    if (similarUsers.length > 0) {
      collaborativeScore = this.calculateCollaborativeScore(
        recommendation,
        similarUsers
      );
    }

    // 4. Content score (similar cards the user likes)
    const contentScore = this.calculateContentScore(
      recommendation,
      userPreferences,
      detectedArchetypes
    );

    // Weighted combination
    const weights = this.normalizeWeights();
    const finalScore = 
      baseScore * weights.base +
      feedbackScore * weights.feedback * feedbackConfidence +
      collaborativeScore * weights.collaborative +
      contentScore * weights.content;

    // Calculate confidence
    const confidence = this.calculateConfidence(
      feedbackConfidence,
      similarUsers.length,
      userPreferences.length
    );

    // Generate explanation
    const reason = this.generateExplanation(
      userPref,
      collaborativeScore,
      contentScore,
      detectedArchetypes
    );

    // Determine source: 'learned' when feedback significantly influences the score
    const feedbackContribution = Math.abs(feedbackScore * weights.feedback * feedbackConfidence);
    const totalMagnitude = Math.abs(finalScore) || 1;
    const source: RecSource = feedbackContribution / totalMagnitude > 0.2 ? 'learned' : 'archetype';

    return {
      baseScore,
      collaborativeScore,
      contentScore,
      feedbackScore,
      finalScore: Math.max(-1, Math.min(1, finalScore)),
      confidence,
      reason,
      source,
    };
  }

  /**
   * Rank and filter recommendations with ML
   */
  rankRecommendations(
    recommendations: RecommendationItem[],
    userPreferences: UserPreference[],
    detectedArchetypes: ArchetypeId[],
    similarUsers: SimilarUser[] = [],
    limit: number = 8
  ): Array<{ recommendation: RecommendationItem; score: PersonalizedScore }> {
    // Score all recommendations
    const scored = recommendations.map(rec => ({
      recommendation: rec,
      score: this.scoreRecommendation(rec, userPreferences, detectedArchetypes, similarUsers),
    }));

    // Sort by final score
    scored.sort((a, b) => b.score.finalScore - a.score.finalScore);

    // Filter by confidence
    const filtered = scored.filter(s => s.score.confidence >= this.config.minConfidenceThreshold);

    // Exploration: inject some randomness for diversity
    const exploreCount = Math.floor(limit * this.config.explorationRate);
    const exploitCount = limit - exploreCount;

    const result = filtered.slice(0, exploitCount);

    // Add exploration recommendations
    if (exploreCount > 0 && scored.length > exploitCount) {
      const unexplored = scored.slice(exploitCount).filter(
        s => !result.some(r => r.recommendation.id === s.recommendation.id)
      );
      const randomPicks = this.shuffleArray(unexplored).slice(0, exploreCount);
      result.push(...randomPicks);
    }

    // Re-sort
    result.sort((a, b) => b.score.finalScore - a.score.finalScore);

    return result.slice(0, limit);
  }

  /**
   * Find similar cards to ones the user likes
   */
  findSimilarCards(
    likedCards: string[],
    allCards: string[],
    limit: number = 5
  ): Array<{ cardName: string; similarity: number; reason: string }> {
    const similarCards: Array<{ cardName: string; similarity: number; reason: string }> = [];

    for (const card of allCards) {
      if (likedCards.includes(card.toLowerCase())) continue;

      const cardVec = this.cardVectors.get(card.toLowerCase());
      if (!cardVec) continue;

      let totalSimilarity = 0;
      let count = 0;

      for (const likedCard of likedCards) {
        const likedVec = this.cardVectors.get(likedCard.toLowerCase());
        if (!likedVec) continue;

        const similarity = this.calculateVectorSimilarity(cardVec, likedVec);
        totalSimilarity += similarity;
        count++;
      }

      if (count > 0) {
        const avgSimilarity = totalSimilarity / count;
        if (avgSimilarity > 0.6) {
          similarCards.push({
            cardName: card,
            similarity: avgSimilarity,
            reason: `Similar to ${likedCards[0]}`,
          });
        }
      }
    }

    return similarCards
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Calculate collaborative filtering score
   */
  private calculateCollaborativeScore(
    recommendation: RecommendationItem,
    similarUsers: SimilarUser[]
  ): number {
    let totalScore = 0;
    let totalWeight = 0;

    for (const user of similarUsers) {
      const preference = user.preferences.find(
        p => p.cardName.toLowerCase() === recommendation.cardName.toLowerCase()
      );

      if (preference) {
        totalScore += preference.score * user.similarity;
        totalWeight += user.similarity;
      }
    }

    return totalWeight > 0 ? totalScore / totalWeight : 0;
  }

  /**
   * Calculate content-based score
   */
  private calculateContentScore(
    recommendation: RecommendationItem,
    userPreferences: UserPreference[],
    detectedArchetypes: ArchetypeId[]
  ): number {
    const cardVec = this.cardVectors.get(recommendation.cardName.toLowerCase());
    if (!cardVec) return 0;

    // Check archetype match
    let archetypeScore = 0;
    for (const archetype of detectedArchetypes) {
      if (cardVec.features.archetypeScores[archetype]) {
        archetypeScore += cardVec.features.archetypeScores[archetype];
      }
    }

    // Check similarity to liked cards
    let similarityScore = 0;
    let similarityCount = 0;
    const likedCards = userPreferences.filter(p => p.score > 0.3);

    for (const liked of likedCards) {
      const likedVec = this.cardVectors.get(liked.cardName.toLowerCase());
      if (likedVec) {
        similarityScore += this.calculateVectorSimilarity(cardVec, likedVec) * liked.score;
        similarityCount += liked.score;
      }
    }

    const avgSimilarity = similarityCount > 0 ? similarityScore / similarityCount : 0;

    return (archetypeScore * 0.4 + avgSimilarity * 0.6);
  }

  /**
   * Calculate cosine similarity between card vectors
   */
  private calculateVectorSimilarity(a: CardVector, b: CardVector): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    // Compare CMC
    const cmcDiff = 1 - Math.abs(a.features.cmc - b.features.cmc) / 10;
    dotProduct += cmcDiff;
    normA += 1;
    normB += 1;

    // Compare colors
    for (let i = 0; i < a.features.colors.length; i++) {
      dotProduct += a.features.colors[i] * b.features.colors[i];
      normA += a.features.colors[i] ** 2;
      normB += b.features.colors[i] ** 2;
    }

    // Compare types
    for (let i = 0; i < a.features.types.length; i++) {
      dotProduct += a.features.types[i] * b.features.types[i];
      normA += a.features.types[i] ** 2;
      normB += b.features.types[i] ** 2;
    }

    // Compare archetype scores
    for (const archetype of Object.keys(a.features.archetypeScores)) {
      const scoreA = a.features.archetypeScores[archetype] || 0;
      const scoreB = b.features.archetypeScores[archetype] || 0;
      dotProduct += scoreA * scoreB;
      normA += scoreA ** 2;
      normB += scoreB ** 2;
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Calculate confidence in the prediction
   */
  private calculateConfidence(
    feedbackConfidence: number,
    similarUserCount: number,
    totalPreferences: number
  ): number {
    // More feedback = higher confidence
    const feedbackFactor = Math.min(1, totalPreferences / 20);
    
    // More similar users = higher confidence
    const collaborativeFactor = Math.min(1, similarUserCount / 5);

    // Weighted average
    return (
      feedbackConfidence * 0.5 +
      feedbackFactor * 0.3 +
      collaborativeFactor * 0.2
    );
  }

  /**
   * Generate human-readable explanation
   */
  private generateExplanation(
    userPref: UserPreference | undefined,
    collaborativeScore: number,
    contentScore: number,
    detectedArchetypes: ArchetypeId[]
  ): string {
    const parts: string[] = [];

    if (userPref && userPref.score > 0.5) {
      parts.push('You liked similar cards before');
    }

    if (collaborativeScore > 0.3) {
      parts.push('Popular with players like you');
    }

    if (contentScore > 0.5 && detectedArchetypes.length > 0) {
      parts.push(`Great fit for ${detectedArchetypes[0]}`);
    }

    if (parts.length === 0) {
      return 'Recommended based on deck analysis';
    }

    return parts.join(' • ');
  }

  /**
   * Normalize weights to sum to 1
   */
  private normalizeWeights(): { base: number; feedback: number; collaborative: number; content: number } {
    const total = 1 + this.config.collaborativeWeight + this.config.contentWeight;
    
    return {
      base: 1 / total,
      feedback: 1 / total,
      collaborative: this.config.collaborativeWeight / total,
      content: this.config.contentWeight / total,
    };
  }

  /**
   * Shuffle array (Fisher-Yates)
   */
  private shuffleArray<T>(array: T[]): T[] {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Create card vector from card data
   */
  createCardVector(
    cardName: string,
    cardData: {
      cmc?: number;
      color_identity?: string[];
      type_line?: string;
      oracle_text?: string;
    }
  ): CardVector {
    const colors = ['W', 'U', 'B', 'R', 'G'];
    const types = ['creature', 'instant', 'sorcery', 'artifact', 'enchantment', 'land', 'planeswalker'];

    // One-hot encode colors
    const colorVector = colors.map(c => 
      cardData.color_identity?.includes(c) ? 1 : 0
    );

    // One-hot encode types
    const typeLine = (cardData.type_line || '').toLowerCase();
    const typeVector = types.map(t => 
      typeLine.includes(t) ? 1 : 0
    );

    // Detect archetype scores from oracle text
    const oracleText = (cardData.oracle_text || '').toLowerCase();
    const archetypeScores: Record<string, number> = {};

    if (oracleText.includes('search your library') || oracleText.includes('tutor')) {
      archetypeScores['combo'] = 0.8;
    }
    if (oracleText.includes('draw') && oracleText.includes('card')) {
      archetypeScores['control'] = 0.6;
      archetypeScores['combo'] = 0.5;
    }
    if (oracleText.includes('add') && oracleText.includes('mana')) {
      archetypeScores['ramp'] = 0.9;
    }
    if (oracleText.includes('destroy target') || oracleText.includes('exile target')) {
      archetypeScores['control'] = 0.7;
    }

    return {
      cardName,
      features: {
        cmc: cardData.cmc || 0,
        colors: colorVector,
        types: typeVector,
        powerLevel: this.estimatePowerLevel(cardData),
        synergy: 0.5, // Default, would be calculated from EDHREC data
        archetypeScores,
      },
    };
  }

  /**
   * Estimate power level from card data
   */
  private estimatePowerLevel(cardData: { oracle_text?: string; cmc?: number }): number {
    let score = 0.5;
    const text = (cardData.oracle_text || '').toLowerCase();

    // High power indicators
    if (text.includes('search your library')) score += 0.2;
    if (text.includes('draw') && text.includes('card')) score += 0.15;
    if (text.includes('counter target')) score += 0.1;
    if (text.includes('destroy all')) score += 0.15;
    if (text.includes('you win the game')) score += 0.3;
    if (text.includes('extra turn')) score += 0.25;
    if (text.includes('infinite')) score += 0.2;

    // Low power indicators
    if (text.includes('vanilla')) score -= 0.3;
    if (cardData.cmc && cardData.cmc > 6 && !text.includes('add')) score -= 0.1;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Add card vector to engine
   */
  addCardVector(vector: CardVector): void {
    this.cardVectors.set(vector.cardName.toLowerCase(), vector);
  }

  /**
   * Get model statistics
   */
  getStats(): {
    totalCards: number;
    totalUserSimilarities: number;
    config: MLRecommendationConfig;
  } {
    return {
      totalCards: this.cardVectors.size,
      totalUserSimilarities: this.userSimilarities.size,
      config: this.config,
    };
  }
}

// Singleton instance
let mlEngineInstance: MLRecommendationEngine | null = null;

export function getMLRecommendationEngine(config?: Partial<MLRecommendationConfig>): MLRecommendationEngine {
  if (!mlEngineInstance) {
    mlEngineInstance = new MLRecommendationEngine(config);
  }
  return mlEngineInstance;
}

export function resetMLRecommendationEngine(): void {
  mlEngineInstance = null;
}
