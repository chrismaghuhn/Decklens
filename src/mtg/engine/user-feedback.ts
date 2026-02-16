/**
 * User Feedback System
 * Tracks user interactions with recommendations to improve ML model
 */

import type { RecommendationItem } from '../recommendation-impact.js';
import type { ArchetypeId } from './archetype-catalog.js';

export interface FeedbackEvent {
  id: string;
  timestamp: number;
  userId: string;
  sessionId: string;
  type: FeedbackType;
  recommendationId: string;
  cardName: string;
  context: FeedbackContext;
  metadata: FeedbackMetadata;
}

export type FeedbackType = 
  | 'recommendation_applied'
  | 'recommendation_ignored'
  | 'recommendation_viewed'
  | 'recommendation_rated'
  | 'recommendation_removed'
  | 'feedback_thumbs_up'
  | 'feedback_thumbs_down';

export interface FeedbackContext {
  deckId?: string;
  commanderName?: string;
  detectedArchetypes: ArchetypeId[];
  metaMode: string;
  discoveryStats?: {
    totalFound: number;
    fromCache: number;
  };
}

export interface FeedbackMetadata {
  rating?: number; // -1 to 1
  reason?: string;
  effectivenessScore?: number;
  timeToDecideMs?: number;
  similarRecommendations?: string[];
}

export interface UserPreference {
  cardName: string;
  score: number; // -1 to 1, learned preference
  confidence: number; // 0 to 1, how certain we are
  interactions: {
    applied: number;
    ignored: number;
    thumbsUp: number;
    thumbsDown: number;
    viewed: number;
  };
  contexts: Array<{
    archetype: ArchetypeId;
    weight: number;
  }>;
  lastUpdated: number;
}

export interface FeedbackAnalytics {
  totalEvents: number;
  applyRate: number;
  averageRating: number;
  topCards: Array<{ cardName: string; score: number }>;
  worstCards: Array<{ cardName: string; score: number }>;
  archetypePreferences: Record<ArchetypeId, number>;
}

const STORAGE_KEY = 'decklens_user_feedback';
const ANALYTICS_KEY = 'decklens_feedback_analytics';
const MAX_EVENTS = 1000;
const MAX_PREFERENCES = 500;

export class UserFeedbackSystem {
  private events: FeedbackEvent[] = [];
  private preferences: Map<string, UserPreference> = new Map();
  private userId: string;
  private sessionId: string;

  constructor() {
    this.userId = this.getOrCreateUserId();
    this.sessionId = this.generateSessionId();
    this.loadFromStorage();
  }

  /**
   * Track when user applies a recommendation
   */
  trackApplied(
    recommendation: RecommendationItem,
    context: FeedbackContext,
    timeToDecideMs?: number
  ): void {
    this.trackEvent({
      type: 'recommendation_applied',
      recommendationId: recommendation.id,
      cardName: recommendation.cardName,
      context,
      metadata: {
        timeToDecideMs,
        effectivenessScore: recommendation.powerImpactScore,
      },
    });

    // Update preference with positive signal
    this.updatePreference(recommendation.cardName, 0.5, context);
  }

  /**
   * Track when user ignores a recommendation
   */
  trackIgnored(
    recommendation: RecommendationItem,
    context: FeedbackContext,
    timeToDecideMs?: number
  ): void {
    this.trackEvent({
      type: 'recommendation_ignored',
      recommendationId: recommendation.id,
      cardName: recommendation.cardName,
      context,
      metadata: {
        timeToDecideMs,
        effectivenessScore: recommendation.powerImpactScore,
      },
    });

    // Update preference with negative signal
    this.updatePreference(recommendation.cardName, -0.2, context);
  }

  /**
   * Track when user views recommendation details
   */
  trackViewed(
    recommendation: RecommendationItem,
    context: FeedbackContext
  ): void {
    this.trackEvent({
      type: 'recommendation_viewed',
      recommendationId: recommendation.id,
      cardName: recommendation.cardName,
      context,
      metadata: {
        effectivenessScore: recommendation.powerImpactScore,
      },
    });

    // Small positive signal for viewing
    this.updatePreference(recommendation.cardName, 0.05, context);
  }

  /**
   * Track explicit user rating (👍/👎)
   */
  trackRating(
    recommendation: RecommendationItem,
    rating: 'up' | 'down',
    context: FeedbackContext,
    reason?: string
  ): void {
    const type = rating === 'up' ? 'feedback_thumbs_up' : 'feedback_thumbs_down';
    const score = rating === 'up' ? 1.0 : -1.0;

    this.trackEvent({
      type,
      recommendationId: recommendation.id,
      cardName: recommendation.cardName,
      context,
      metadata: {
        rating: score,
        reason,
        effectivenessScore: recommendation.powerImpactScore,
      },
    });

    // Strong signal from explicit feedback
    this.updatePreference(recommendation.cardName, score * 0.8, context);
  }

  /**
   * Track when user removes a previously applied recommendation
   */
  trackRemoved(
    recommendation: RecommendationItem,
    context: FeedbackContext
  ): void {
    this.trackEvent({
      type: 'recommendation_removed',
      recommendationId: recommendation.id,
      cardName: recommendation.cardName,
      context,
      metadata: {
        effectivenessScore: recommendation.powerImpactScore,
      },
    });

    // Strong negative signal
    this.updatePreference(recommendation.cardName, -0.7, context);
  }

  /**
   * Get user's preference score for a card
   */
  getPreference(cardName: string): UserPreference | null {
    return this.preferences.get(cardName.toLowerCase()) || null;
  }

  /**
   * Get all preferences sorted by score
   */
  getAllPreferences(): UserPreference[] {
    return Array.from(this.preferences.values())
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Get top preferred cards
   */
  getTopPreferences(limit: number = 10): UserPreference[] {
    return this.getAllPreferences()
      .filter(p => p.score > 0)
      .slice(0, limit);
  }

  /**
   * Get disliked cards
   */
  getDislikedCards(limit: number = 10): UserPreference[] {
    return this.getAllPreferences()
      .filter(p => p.score < 0)
      .slice(0, limit);
  }

  /**
   * Get analytics summary
   */
  getAnalytics(): FeedbackAnalytics {
    const prefs = Array.from(this.preferences.values());
    
    const totalInteractions = prefs.reduce((sum, p) => 
      sum + p.interactions.applied + p.interactions.ignored + 
      p.interactions.thumbsUp + p.interactions.thumbsDown, 0
    );

    const totalApplied = prefs.reduce((sum, p) => 
      sum + p.interactions.applied + p.interactions.thumbsUp, 0
    );

    const applyRate = totalInteractions > 0 ? totalApplied / totalInteractions : 0;

    const averageRating = prefs.length > 0 
      ? prefs.reduce((sum, p) => sum + p.score, 0) / prefs.length 
      : 0;

    const sortedByScore = [...prefs].sort((a, b) => b.score - a.score);

    // Calculate archetype preferences
    const archetypeScores: Record<string, number[]> = {};
    for (const pref of prefs) {
      for (const ctx of pref.contexts) {
        if (!archetypeScores[ctx.archetype]) {
          archetypeScores[ctx.archetype] = [];
        }
        archetypeScores[ctx.archetype].push(pref.score * ctx.weight);
      }
    }

    const archetypePreferences: Record<string, number> = {};
    for (const [archetype, scores] of Object.entries(archetypeScores)) {
      archetypePreferences[archetype] = 
        scores.reduce((a, b) => a + b, 0) / scores.length;
    }

    return {
      totalEvents: this.events.length,
      applyRate,
      averageRating,
      topCards: sortedByScore.slice(0, 5).map(p => ({
        cardName: p.cardName,
        score: p.score,
      })),
      worstCards: sortedByScore.slice(-5).reverse().map(p => ({
        cardName: p.cardName,
        score: p.score,
      })),
      archetypePreferences,
    };
  }

  /**
   * Export feedback data for analysis
   */
  exportData(): {
    userId: string;
    events: FeedbackEvent[];
    preferences: UserPreference[];
    analytics: FeedbackAnalytics;
  } {
    return {
      userId: this.userId,
      events: this.events,
      preferences: Array.from(this.preferences.values()),
      analytics: this.getAnalytics(),
    };
  }

  /**
   * Clear all feedback data
   */
  clearAll(): void {
    this.events = [];
    this.preferences.clear();
    this.saveToStorage();
  }

  /**
   * Core tracking method
   */
  private trackEvent(partialEvent: Omit<FeedbackEvent, 'id' | 'timestamp' | 'userId' | 'sessionId'>): void {
    const event: FeedbackEvent = {
      id: this.generateId(),
      timestamp: Date.now(),
      userId: this.userId,
      sessionId: this.sessionId,
      ...partialEvent,
    };

    this.events.push(event);

    // Limit event history
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }

    this.saveToStorage();
  }

  /**
   * Update preference for a card using Bayesian updating
   */
  private updatePreference(
    cardName: string,
    signal: number,
    context: FeedbackContext
  ): void {
    const normalizedName = cardName.toLowerCase();
    let pref = this.preferences.get(normalizedName);

    if (!pref) {
      pref = {
        cardName,
        score: 0,
        confidence: 0,
        interactions: {
          applied: 0,
          ignored: 0,
          thumbsUp: 0,
          thumbsDown: 0,
          viewed: 0,
        },
        contexts: [],
        lastUpdated: Date.now(),
      };
      this.preferences.set(normalizedName, pref);
    }

    // Update score using weighted average
    const oldConfidence = pref.confidence;
    const newConfidence = Math.min(1, oldConfidence + 0.1);
    
    pref.score = (pref.score * oldConfidence + signal * 0.5) / newConfidence;
    pref.confidence = newConfidence;
    pref.lastUpdated = Date.now();

    // Update interaction counts
    if (signal > 0.3) pref.interactions.applied++;
    else if (signal < -0.1) pref.interactions.ignored++;
    else if (signal > 0) pref.interactions.thumbsUp++;
    else if (signal < 0) pref.interactions.thumbsDown++;
    else pref.interactions.viewed++;

    // Update archetype contexts
    for (const archetype of context.detectedArchetypes) {
      const existingContext = pref.contexts.find(c => c.archetype === archetype);
      if (existingContext) {
        existingContext.weight = Math.min(1, existingContext.weight + 0.1);
      } else {
        pref.contexts.push({ archetype, weight: 0.5 });
      }
    }

    // Limit preferences stored
    if (this.preferences.size > MAX_PREFERENCES) {
      const sorted = Array.from(this.preferences.entries())
        .sort((a, b) => b[1].lastUpdated - a[1].lastUpdated);
      const toRemove = sorted.slice(MAX_PREFERENCES);
      for (const [key] of toRemove) {
        this.preferences.delete(key);
      }
    }

    this.saveToStorage();
  }

  /**
   * Save to localStorage
   */
  private saveToStorage(): void {
    try {
      const data = {
        userId: this.userId,
        events: this.events,
        preferences: Array.from(this.preferences.entries()),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Failed to save feedback data:', e);
    }
  }

  /**
   * Load from localStorage
   */
  private loadFromStorage(): void {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        this.userId = parsed.userId || this.userId;
        this.events = parsed.events || [];
        this.preferences = new Map(parsed.preferences || []);
      }
    } catch (e) {
      console.warn('Failed to load feedback data:', e);
    }
  }

  /**
   * Get or create persistent user ID
   */
  private getOrCreateUserId(): string {
    const key = 'decklens_user_id';
    let id = localStorage.getItem(key);
    if (!id) {
      id = `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(key, id);
    }
    return id;
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

// Singleton instance
let feedbackSystemInstance: UserFeedbackSystem | null = null;

export function getUserFeedbackSystem(): UserFeedbackSystem {
  if (!feedbackSystemInstance) {
    feedbackSystemInstance = new UserFeedbackSystem();
  }
  return feedbackSystemInstance;
}

export function resetUserFeedbackSystem(): void {
  feedbackSystemInstance = null;
}
