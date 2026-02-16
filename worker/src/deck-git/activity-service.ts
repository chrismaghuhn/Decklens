// ============================================================
// ActivityService — Activity feed for deck repos
// ============================================================
// Logs and queries activity events for repositories.
// ============================================================

import {
  type ActivityEntry,
  type ActivityActionType,
  generateId,
  now,
} from './types.js';

export class ActivityService {
  constructor(private db: D1Database) {}

  /**
   * Log an activity event.
   */
  async log(
    repoId: string,
    actorId: string,
    actionType: ActivityActionType,
    targetType?: string,
    targetId?: string,
    metadata?: Record<string, unknown>
  ): Promise<ActivityEntry> {
    const id = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO activity_feed (id, repo_id, actor_id, action_type, target_type, target_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        repoId,
        actorId,
        actionType,
        targetType ?? null,
        targetId ?? null,
        metadata ? JSON.stringify(metadata) : null,
        createdAt
      )
      .run();

    return {
      id,
      repoId,
      actorId,
      actionType,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      metadata: metadata ?? null,
      createdAt,
    };
  }

  /**
   * Get activity feed for a repository.
   */
  async getFeed(repoId: string, limit = 50, offset = 0): Promise<ActivityEntry[]> {
    const rows = await this.db
      .prepare(`
        SELECT * FROM activity_feed 
        WHERE repo_id = ? 
        ORDER BY created_at DESC 
        LIMIT ? OFFSET ?
      `)
      .bind(repoId, limit, offset)
      .all<{
        id: string;
        repo_id: string;
        actor_id: string;
        action_type: string;
        target_type: string | null;
        target_id: string | null;
        metadata_json: string | null;
        created_at: string;
      }>();

    return (rows.results || []).map(row => ({
      id: row.id,
      repoId: row.repo_id,
      actorId: row.actor_id,
      actionType: row.action_type,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get activity feed for a user.
   */
  async getUserActivity(userId: string, limit = 50): Promise<ActivityEntry[]> {
    const rows = await this.db
      .prepare(`
        SELECT * FROM activity_feed 
        WHERE actor_id = ? 
        ORDER BY created_at DESC 
        LIMIT ?
      `)
      .bind(userId, limit)
      .all<{
        id: string;
        repo_id: string;
        actor_id: string;
        action_type: string;
        target_type: string | null;
        target_id: string | null;
        metadata_json: string | null;
        created_at: string;
      }>();

    return (rows.results || []).map(row => ({
      id: row.id,
      repoId: row.repo_id,
      actorId: row.actor_id,
      actionType: row.action_type,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get activity stats for a repository.
   */
  async getStats(repoId: string): Promise<{
    totalEvents: number;
    eventsByType: Record<string, number>;
    eventsByDay: Record<string, number>;
  }> {
    const rows = await this.db
      .prepare(`
        SELECT action_type, DATE(created_at) as day, COUNT(*) as count
        FROM activity_feed
        WHERE repo_id = ?
        GROUP BY action_type, DATE(created_at)
        ORDER BY day DESC
      `)
      .bind(repoId)
      .all<{
        action_type: string;
        day: string;
        count: number;
      }>();

    const eventsByType: Record<string, number> = {};
    const eventsByDay: Record<string, number> = {};
    let totalEvents = 0;

    for (const row of rows.results || []) {
      eventsByType[row.action_type] = (eventsByType[row.action_type] || 0) + row.count;
      eventsByDay[row.day] = (eventsByDay[row.day] || 0) + row.count;
      totalEvents += row.count;
    }

    return { totalEvents, eventsByType, eventsByDay };
  }
}
