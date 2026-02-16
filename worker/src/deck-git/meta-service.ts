// ============================================================
// Meta Service — Meta snapshots and update feed
// ============================================================
// Periodic snapshots of meta data (top commanders, staples).
// Generates feed events when meta shifts affect decks.
// Integrates with release-service for auto-releases.
// ============================================================

import { generateId, now } from './types.js';

// ==================== Types ====================

export interface MetaSnapshot {
  id: string;
  format: string;
  snapshotDate: string;
  topCommanders: MetaCardEntry[];
  topStaples: MetaCardEntry[];
  banList: string[];
  avgDeckPrice: number;
  totalDecksAnalyzed: number;
}

export interface MetaCardEntry {
  name: string;
  usagePercent: number;       // % of decks using this card
  avgCopies: number;
  priceUsd: number;
  trend: 'rising' | 'stable' | 'falling';
  changePercent: number;      // change in usage since last snapshot
}

export interface MetaFeedEvent {
  id: string;
  type: 'ban' | 'unban' | 'price_drop' | 'price_spike' | 'new_staple' | 'falling_staple' | 'reprint' | 'meta_shift';
  title: string;
  description: string;
  cardNames: string[];
  affectedFormats: string[];
  createdAt: string;
  severity: 'low' | 'medium' | 'high';
}

export interface MetaDeckImpact {
  repoId: string;
  deckName: string;
  events: MetaFeedEvent[];
  suggestedActions: string[];
}

// ==================== Service ====================

export class MetaService {
  constructor(private db: D1Database) {}

  /**
   * Create a meta snapshot for a format.
   * In production, this would aggregate from all public decks.
   */
  async createSnapshot(format: string): Promise<MetaSnapshot> {
    // Count total public decks for this format
    const deckCount = await this.db.prepare(
      'SELECT COUNT(*) as count FROM deck_repos WHERE format = ? AND visibility = ?'
    ).bind(format, 'public').first<{ count: number }>();

    const snapshot: MetaSnapshot = {
      id: generateId(),
      format,
      snapshotDate: now(),
      topCommanders: [],
      topStaples: [],
      banList: [],
      avgDeckPrice: 0,
      totalDecksAnalyzed: deckCount?.count || 0,
    };

    // Store snapshot as a release-like record (using KV or a meta_snapshots table)
    // For now, store in a generic table or KV
    await this.db.prepare(
      `INSERT INTO repo_releases (id, repo_id, tag_name, title, body, commit_id, author_id, author_name, deck_state_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      snapshot.id,
      `meta_${format}`,  // pseudo-repo for meta
      `meta-${format}-${snapshot.snapshotDate.slice(0, 10)}`,
      `Meta Snapshot: ${format}`,
      `Auto-generated meta snapshot for ${format} format`,
      'meta',
      'system',
      'DeckLens Meta Bot',
      JSON.stringify(snapshot),
      snapshot.snapshotDate
    ).run();

    return snapshot;
  }

  /**
   * Get the latest meta snapshot for a format.
   */
  async getLatestSnapshot(format: string): Promise<MetaSnapshot | null> {
    const row = await this.db.prepare(
      `SELECT deck_state_json FROM repo_releases
       WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1`
    ).bind(`meta_${format}`).first<{ deck_state_json: string }>();

    if (!row) return null;
    try {
      return JSON.parse(row.deck_state_json) as MetaSnapshot;
    } catch {
      return null;
    }
  }

  /**
   * Compare two snapshots and generate feed events.
   */
  generateFeedEvents(
    oldSnapshot: MetaSnapshot | null,
    newSnapshot: MetaSnapshot,
    banListChanges?: { banned: string[]; unbanned: string[] }
  ): MetaFeedEvent[] {
    const events: MetaFeedEvent[] = [];
    const ts = now();

    // Ban list changes
    if (banListChanges) {
      for (const card of banListChanges.banned) {
        events.push({
          id: generateId(),
          type: 'ban',
          title: `${card} Banned`,
          description: `${card} has been banned in ${newSnapshot.format} format`,
          cardNames: [card],
          affectedFormats: [newSnapshot.format],
          createdAt: ts,
          severity: 'high',
        });
      }
      for (const card of banListChanges.unbanned) {
        events.push({
          id: generateId(),
          type: 'unban',
          title: `${card} Unbanned`,
          description: `${card} has been unbanned in ${newSnapshot.format} format`,
          cardNames: [card],
          affectedFormats: [newSnapshot.format],
          createdAt: ts,
          severity: 'high',
        });
      }
    }

    // Compare staple usage
    if (oldSnapshot) {
      const oldStapleMap = new Map(oldSnapshot.topStaples.map(s => [s.name, s]));

      for (const staple of newSnapshot.topStaples) {
        const old = oldStapleMap.get(staple.name);

        if (!old && staple.usagePercent > 10) {
          // New staple emerged
          events.push({
            id: generateId(),
            type: 'new_staple',
            title: `${staple.name} Rising`,
            description: `${staple.name} now in ${staple.usagePercent.toFixed(1)}% of ${newSnapshot.format} decks`,
            cardNames: [staple.name],
            affectedFormats: [newSnapshot.format],
            createdAt: ts,
            severity: 'medium',
          });
        } else if (old) {
          // Check for significant price changes
          const priceChange = old.priceUsd > 0
            ? ((staple.priceUsd - old.priceUsd) / old.priceUsd) * 100
            : 0;

          if (priceChange < -30) {
            events.push({
              id: generateId(),
              type: 'price_drop',
              title: `${staple.name} Price Drop`,
              description: `${staple.name} dropped ${Math.abs(priceChange).toFixed(0)}% ($${old.priceUsd.toFixed(2)} → $${staple.priceUsd.toFixed(2)})`,
              cardNames: [staple.name],
              affectedFormats: [newSnapshot.format],
              createdAt: ts,
              severity: 'low',
            });
          } else if (priceChange > 50) {
            events.push({
              id: generateId(),
              type: 'price_spike',
              title: `${staple.name} Price Spike`,
              description: `${staple.name} spiked ${priceChange.toFixed(0)}% ($${old.priceUsd.toFixed(2)} → $${staple.priceUsd.toFixed(2)})`,
              cardNames: [staple.name],
              affectedFormats: [newSnapshot.format],
              createdAt: ts,
              severity: 'medium',
            });
          }

          // Check for usage drops
          const usageDrop = old.usagePercent - staple.usagePercent;
          if (usageDrop > 10) {
            events.push({
              id: generateId(),
              type: 'falling_staple',
              title: `${staple.name} Declining`,
              description: `${staple.name} dropped from ${old.usagePercent.toFixed(1)}% to ${staple.usagePercent.toFixed(1)}% usage`,
              cardNames: [staple.name],
              affectedFormats: [newSnapshot.format],
              createdAt: ts,
              severity: 'low',
            });
          }
        }
      }
    }

    return events;
  }

  /**
   * Check how meta changes affect a specific deck.
   */
  async getDeckImpact(
    repoId: string,
    deckCards: string[],
    events: MetaFeedEvent[]
  ): Promise<MetaDeckImpact> {
    const deckCardSet = new Set(deckCards.map(c => c.toLowerCase()));
    const affectingEvents: MetaFeedEvent[] = [];
    const suggestions: string[] = [];

    // Get deck name
    const repo = await this.db.prepare(
      'SELECT name FROM deck_repos WHERE id = ?'
    ).bind(repoId).first<{ name: string }>();

    for (const event of events) {
      const affects = event.cardNames.some(c => deckCardSet.has(c.toLowerCase()));
      if (affects) {
        affectingEvents.push(event);

        switch (event.type) {
          case 'ban':
            suggestions.push(`Remove ${event.cardNames.join(', ')} (banned)`);
            break;
          case 'price_spike':
            suggestions.push(`Consider budget alternatives for ${event.cardNames.join(', ')}`);
            break;
          case 'falling_staple':
            suggestions.push(`Evaluate if ${event.cardNames.join(', ')} still fits your strategy`);
            break;
        }
      }
    }

    return {
      repoId,
      deckName: repo?.name || 'Unknown',
      events: affectingEvents,
      suggestedActions: suggestions,
    };
  }

  /**
   * Get recent feed events across all formats.
   */
  async getRecentFeed(limit = 20): Promise<MetaFeedEvent[]> {
    // In a real implementation, feed events would be stored in their own table.
    // For now, return empty — events are generated on-demand via generateFeedEvents()
    return [];
  }
}
