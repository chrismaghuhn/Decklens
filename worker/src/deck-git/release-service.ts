// ============================================================
// ReleaseService — Tagged releases for deck repos
// ============================================================
// Create versioned releases with frozen deck state,
// auto-generated release notes from merged PRs.
// ============================================================

import {
  type Release,
  type ReleaseChannel,
  type DeckState,
  generateId,
  now,
} from './types.js';
import { CommitService } from './commit-service.js';
import { WebhookService } from './webhook-service.js';

export class ReleaseService {
  constructor(
    private db: D1Database,
    private commitSvc: CommitService,
    private webhookSvc: WebhookService
  ) {}

  // ==================== CRUD ====================

  /**
   * Create a new release at a specific commit.
   */
  async createRelease(
    repoId: string,
    tagName: string,
    title: string,
    body: string,
    commitId: string,
    authorId: string,
    channel: ReleaseChannel = 'stable'
  ): Promise<Release> {
    // Validate tag name uniqueness
    const existing = await this.db
      .prepare('SELECT id FROM repo_releases WHERE repo_id = ? AND tag_name = ?')
      .bind(repoId, tagName)
      .first();

    if (existing) throw new Error(`Release tag "${tagName}" already exists`);

    // Get frozen deck state at commit
    const state = await this.commitSvc.getStateAtCommit(commitId);

    const releaseId = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO repo_releases (id, repo_id, tag_name, title, body, commit_id, author_id, boards_snapshot, channel, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        releaseId, repoId, tagName, title, body,
        commitId, authorId, JSON.stringify(state), channel, createdAt
      )
      .run();

    // Webhook
    await this.webhookSvc.dispatch(repoId, 'release.create', {
      tagName,
      title,
      body,
      commitId,
      channel
    }, authorId);

    return {
      id: releaseId,
      repoId,
      tagName,
      title,
      body,
      commitId,
      authorId,
      boardsSnapshot: JSON.stringify(state),
      channel,
      verified: false,
      verifiedBy: null,
      createdAt,
    };
  }

  // ==================== Release Notes Generation ====================

  /**
   * Auto-generate release notes from merged PRs since the last release.
   */
  async generateReleaseNotes(repoId: string, sinceTag?: string): Promise<string> {
    // Find the commit of the previous release
    let sinceCommitId: string | null = null;

    if (sinceTag) {
      const prevRelease = await this.db
        .prepare('SELECT commit_id FROM repo_releases WHERE repo_id = ? AND tag_name = ?')
        .bind(repoId, sinceTag)
        .first<{ commit_id: string }>();

      sinceCommitId = prevRelease?.commit_id ?? null;
    } else {
      // Get the most recent release
      const prevRelease = await this.db
        .prepare('SELECT commit_id FROM repo_releases WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1')
        .bind(repoId)
        .first<{ commit_id: string }>();

      sinceCommitId = prevRelease?.commit_id ?? null;
    }

    // Get merged PRs since the last release
    let query = `
      SELECT number, title, author_name, merged_at
      FROM deck_pull_requests
      WHERE repo_id = ? AND status = 'merged'
    `;
    const binds: unknown[] = [repoId];

    if (sinceCommitId) {
      // Get the timestamp of the since commit
      const sinceCommit = await this.db
        .prepare('SELECT created_at FROM deck_commits WHERE id = ?')
        .bind(sinceCommitId)
        .first<{ created_at: string }>();

      if (sinceCommit) {
        query += ' AND merged_at > ?';
        binds.push(sinceCommit.created_at);
      }
    }

    query += ' ORDER BY merged_at ASC';

    const prs = await this.db
      .prepare(query)
      .bind(...binds)
      .all<{
        number: number;
        title: string;
        author_name: string;
        merged_at: string;
      }>();

    if (!prs.results || prs.results.length === 0) {
      return 'No changes since the last release.';
    }

    // Build markdown notes
    const lines: string[] = ['## Changes\n'];

    for (const pr of prs.results) {
      lines.push(`- ${pr.title} (#${pr.number}) — @${pr.author_name}`);
    }

    lines.push('');
    lines.push(`**${prs.results.length} pull request(s) merged**`);

    return lines.join('\n');
  }

  // ==================== Queries ====================

  /**
   * Get all releases for a repo (newest first), optionally filtered by channel.
   */
  async getReleases(repoId: string, channel?: ReleaseChannel): Promise<Release[]> {
    let query = 'SELECT * FROM repo_releases WHERE repo_id = ?';
    const binds: unknown[] = [repoId];
    if (channel) {
      query += ' AND channel = ?';
      binds.push(channel);
    }
    query += ' ORDER BY created_at DESC';

    const rows = await this.db
      .prepare(query)
      .bind(...binds)
      .all<{
        id: string;
        repo_id: string;
        tag_name: string;
        title: string;
        body: string;
        commit_id: string;
        author_id: string;
        boards_snapshot: string;
        channel: string;
        created_at: string;
      }>();

    return (rows.results || []).map(row => ({
      id: row.id,
      repoId: row.repo_id,
      tagName: row.tag_name,
      title: row.title,
      body: row.body,
      commitId: row.commit_id,
      authorId: row.author_id,
      boardsSnapshot: row.boards_snapshot,
      channel: (row.channel as ReleaseChannel) || 'stable',
      verified: !!(row as any).verified,
      verifiedBy: ((row as any).verified_by as string) || null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Get a release by tag name.
   */
  async getRelease(repoId: string, tagName: string): Promise<Release | null> {
    const row = await this.db
      .prepare('SELECT * FROM repo_releases WHERE repo_id = ? AND tag_name = ?')
      .bind(repoId, tagName)
      .first<{
        id: string;
        repo_id: string;
        tag_name: string;
        title: string;
        body: string;
        commit_id: string;
        author_id: string;
        boards_snapshot: string;
        channel: string;
        created_at: string;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      repoId: row.repo_id,
      tagName: row.tag_name,
      title: row.title,
      body: row.body,
      commitId: row.commit_id,
      authorId: row.author_id,
      boardsSnapshot: row.boards_snapshot,
      channel: (row.channel as ReleaseChannel) || 'stable',
      verified: !!(row as any).verified,
      verifiedBy: ((row as any).verified_by as string) || null,
      createdAt: row.created_at,
    };
  }

  /**
   * Get the frozen deck state from a release.
   */
  async getReleaseState(repoId: string, tagName: string): Promise<DeckState | null> {
    const release = await this.getRelease(repoId, tagName);
    if (!release) return null;

    try {
      return JSON.parse(release.boardsSnapshot) as DeckState;
    } catch {
      return null;
    }
  }
}
