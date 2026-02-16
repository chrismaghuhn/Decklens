// ============================================================
// IssueService — Issue tracking for deck repos
// ============================================================
// CRUD for issues with labels, assignees, Kanban columns,
// and "closes #N" linking to PRs.
// ============================================================

import {
  type Issue,
  type IssueStatus,
  type IssueComment,
  type KanbanColumn,
  generateId,
  now,
} from './types.js';
import { WebhookService } from './webhook-service.js';

export class IssueService {
  constructor(private db: D1Database, private webhookSvc: WebhookService) {}

  // ==================== CRUD ====================

  /**
   * Create a new issue.
   */
  async createIssue(
    repoId: string,
    title: string,
    body: string,
    authorId: string,
    authorName: string,
    labels: string[] = [],
    assignees: string[] = []
  ): Promise<Issue> {
    // Get next issue number
    const maxRow = await this.db
      .prepare('SELECT MAX(number) as max_num FROM repo_issues WHERE repo_id = ?')
      .bind(repoId)
      .first<{ max_num: number | null }>();

    const number = (maxRow?.max_num ?? 0) + 1;
    const issueId = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO repo_issues
        (id, repo_id, number, title, body, author_id, author_name, status, labels_json, assignees_json,
         linked_pr_id, kanban_column, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, 'backlog', ?, ?, NULL)
      `)
      .bind(
        issueId, repoId, number, title, body,
        authorId, authorName,
        JSON.stringify(labels), JSON.stringify(assignees),
        createdAt, createdAt
      )
      .run();

    // Webhook
    await this.webhookSvc.dispatch(repoId, 'issue.create', {
      number,
      title,
      body,
      authorId,
      authorName
    }, authorName);

    return {
      id: issueId,
      repoId,
      number,
      title,
      body,
      authorId,
      authorName,
      status: 'open',
      labels,
      assignees,
      linkedPrId: null,
      kanbanColumn: 'backlog',
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
    };
  }

  /**
   * Update issue metadata.
   */
  async updateIssue(
    issueId: string,
    updates: Partial<Pick<Issue, 'title' | 'body' | 'labels' | 'assignees' | 'kanbanColumn'>>
  ): Promise<void> {
    const parts: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) { parts.push('title = ?'); values.push(updates.title); }
    if (updates.body !== undefined) { parts.push('body = ?'); values.push(updates.body); }
    if (updates.labels !== undefined) { parts.push('labels_json = ?'); values.push(JSON.stringify(updates.labels)); }
    if (updates.assignees !== undefined) { parts.push('assignees_json = ?'); values.push(JSON.stringify(updates.assignees)); }
    if (updates.kanbanColumn !== undefined) { parts.push('kanban_column = ?'); values.push(updates.kanbanColumn); }

    if (parts.length === 0) return;

    parts.push('updated_at = ?');
    values.push(now());
    values.push(issueId);

    await this.db
      .prepare(`UPDATE repo_issues SET ${parts.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  /**
   * Close an issue.
   */
  async closeIssue(issueId: string): Promise<void> {
    const closedAt = now();
    await this.db
      .prepare('UPDATE repo_issues SET status = ?, closed_at = ?, updated_at = ?, kanban_column = ? WHERE id = ?')
      .bind('closed', closedAt, closedAt, 'done', issueId)
      .run();
  }

  /**
   * Reopen a closed issue.
   */
  async reopenIssue(issueId: string): Promise<void> {
    await this.db
      .prepare('UPDATE repo_issues SET status = ?, closed_at = NULL, updated_at = ?, kanban_column = ? WHERE id = ?')
      .bind('open', now(), 'in_progress', issueId)
      .run();
  }

  // ==================== Comments ====================

  /**
   * Add a comment to an issue.
   */
  async addComment(
    issueId: string,
    authorId: string,
    authorName: string,
    body: string
  ): Promise<IssueComment> {
    const commentId = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO issue_comments (id, issue_id, author_id, author_name, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .bind(commentId, issueId, authorId, authorName, body, createdAt)
      .run();

    return {
      id: commentId,
      issueId,
      authorId,
      authorName,
      body,
      createdAt,
    };
  }

  /**
   * Get all comments for an issue.
   */
  async getComments(issueId: string): Promise<IssueComment[]> {
    const rows = await this.db
      .prepare('SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at ASC')
      .bind(issueId)
      .all<{
        id: string;
        issue_id: string;
        author_id: string;
        author_name: string;
        body: string;
        created_at: string;
      }>();

    return (rows.results || []).map(row => ({
      id: row.id,
      issueId: row.issue_id,
      authorId: row.author_id,
      authorName: row.author_name,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  // ==================== Linking ====================

  /**
   * Link an issue to a PR.
   */
  async linkToPR(issueId: string, prId: string): Promise<void> {
    await this.db
      .prepare('UPDATE repo_issues SET linked_pr_id = ?, updated_at = ? WHERE id = ?')
      .bind(prId, now(), issueId)
      .run();
  }

  // ==================== Queries ====================

  /**
   * Get an issue by ID.
   */
  async getIssue(issueId: string): Promise<Issue | null> {
    const row = await this.db
      .prepare('SELECT * FROM repo_issues WHERE id = ?')
      .bind(issueId)
      .first();

    return row ? this.rowToIssue(row) : null;
  }

  /**
   * Get an issue by repo and number.
   */
  async getIssueByNumber(repoId: string, number: number): Promise<Issue | null> {
    const row = await this.db
      .prepare('SELECT * FROM repo_issues WHERE repo_id = ? AND number = ?')
      .bind(repoId, number)
      .first();

    return row ? this.rowToIssue(row) : null;
  }

  /**
   * List issues for a repo with optional filters.
   */
  async getIssues(
    repoId: string,
    options?: {
      status?: IssueStatus;
      label?: string;
      kanbanColumn?: KanbanColumn;
      assignee?: string;
    }
  ): Promise<Issue[]> {
    let query = 'SELECT * FROM repo_issues WHERE repo_id = ?';
    const binds: unknown[] = [repoId];

    if (options?.status) {
      query += ' AND status = ?';
      binds.push(options.status);
    }

    if (options?.kanbanColumn) {
      query += ' AND kanban_column = ?';
      binds.push(options.kanbanColumn);
    }

    query += ' ORDER BY number DESC';

    const rows = await this.db
      .prepare(query)
      .bind(...binds)
      .all();

    let issues = (rows.results || []).map(this.rowToIssue);

    // Filter by label (JSON array in labels_json)
    if (options?.label) {
      issues = issues.filter(i => i.labels.includes(options.label!));
    }

    // Filter by assignee
    if (options?.assignee) {
      issues = issues.filter(i => i.assignees.includes(options.assignee!));
    }

    return issues;
  }

  // ==================== Helpers ====================

  private rowToIssue(row: Record<string, unknown>): Issue {
    return {
      id: row.id as string,
      repoId: row.repo_id as string,
      number: row.number as number,
      title: row.title as string,
      body: (row.body as string) || '',
      authorId: row.author_id as string,
      authorName: row.author_name as string,
      status: row.status as IssueStatus,
      labels: JSON.parse((row.labels_json as string) || '[]'),
      assignees: JSON.parse((row.assignees_json as string) || '[]'),
      linkedPrId: (row.linked_pr_id as string) || null,
      kanbanColumn: (row.kanban_column as KanbanColumn) || 'backlog',
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      closedAt: (row.closed_at as string) || null,
    };
  }
}
