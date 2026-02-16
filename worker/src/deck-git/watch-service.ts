// ============================================================
// WatchService — User notification preferences
// ============================================================
// Manages per-user watch rules for repositories to filter
// which events trigger notifications.
// ============================================================

import { type WatchRule, generateId, now } from './types.js';

export class WatchService {
  constructor(private db: D1Database) {}

  /**
   * Set or update a watch rule for a user on a repo.
   */
  async setWatchRule(userId: string, repoId: string, events: string[]): Promise<WatchRule> {
    const existing = await this.db.prepare(
      'SELECT id FROM deck_watch_rules WHERE user_id = ? AND repo_id = ?'
    ).bind(userId, repoId).first<{ id: string }>();

    const createdAt = now();
    
    if (existing) {
      await this.db.prepare(
        'UPDATE deck_watch_rules SET events_json = ?, active = 1 WHERE id = ?'
      ).bind(JSON.stringify(events), existing.id).run();
      
      return {
        id: existing.id,
        userId,
        repoId,
        events,
        active: true,
        createdAt: '' // Not ideal, but we'd need to fetch it
      };
    } else {
      const id = generateId();
      await this.db.prepare(`
        INSERT INTO deck_watch_rules (id, user_id, repo_id, events_json, active, created_at)
        VALUES (?, ?, ?, ?, 1, ?)
      `).bind(id, userId, repoId, JSON.stringify(events), createdAt).run();

      return {
        id,
        userId,
        repoId,
        events,
        active: true,
        createdAt
      };
    }
  }

  /**
   * Get watch rule for a specific user and repo.
   */
  async getWatchRule(userId: string, repoId: string): Promise<WatchRule | null> {
    const row = await this.db.prepare(
      'SELECT * FROM deck_watch_rules WHERE user_id = ? AND repo_id = ?'
    ).bind(userId, repoId).first<any>();

    if (!row) return null;

    return {
      id: row.id,
      userId: row.user_id,
      repoId: row.repo_id,
      events: JSON.parse(row.events_json || '[]'),
      active: !!row.active,
      createdAt: row.created_at
    };
  }

  /**
   * List all repos a user is watching.
   */
  async listWatchedRepos(userId: string): Promise<WatchRule[]> {
    const { results } = await this.db.prepare(
      'SELECT * FROM deck_watch_rules WHERE user_id = ? AND active = 1'
    ).bind(userId).all<any>();

    return (results || []).map(row => ({
      id: row.id,
      userId: row.user_id,
      repoId: row.repo_id,
      events: JSON.parse(row.events_json || '[]'),
      active: !!row.active,
      createdAt: row.created_at
    }));
  }

  /**
   * Get all users watching a repo for a specific event.
   */
  async getWatchers(repoId: string, event: string): Promise<string[]> {
    const { results } = await this.db.prepare(
      'SELECT user_id, events_json FROM deck_watch_rules WHERE repo_id = ? AND active = 1'
    ).bind(repoId).all<any>();

    return (results || [])
      .filter(row => {
        const events = JSON.parse(row.events_json || '[]') as string[];
        return events.includes(event) || events.includes('*');
      })
      .map(row => row.user_id);
  }
}
