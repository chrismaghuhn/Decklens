// ============================================================
// PRService — Pull Request management for deck repos
// ============================================================
// Open, review, merge, and close pull requests. Integrates
// with MergeService for conflict detection and ChecksService
// for CI-like validation before merge.
// ============================================================

import {
  type PullRequest,
  type PRStatus,
  type MergeStrategy,
  type MergeResult,
  type Review,
  type ReviewState,
  type PRComment,
  generateId,
  now,
} from './types.js';
import { MergeService } from './merge-service.js';
import { PermissionService } from './permission-service.js';
import { ChecksService } from './checks-service.js';
import { CommitService } from './commit-service.js';
import { BranchService } from './branch-service.js';
import { WebhookService } from './webhook-service.js';

export class PRService {
  constructor(
    private db: D1Database,
    private mergeSvc: MergeService,
    private permSvc: PermissionService,
    private checksSvc: ChecksService,
    private commitSvc: CommitService,
    private branchSvc: BranchService,
    private webhookSvc: WebhookService
  ) {}

  // ==================== PR CRUD ====================

  /**
   * Open a new pull request.
   */
  async openPR(
    repoId: string,
    title: string,
    description: string,
    sourceBranchId: string,
    targetBranchId: string,
    authorId: string,
    authorName: string,
    sourceRepoId?: string
  ): Promise<PullRequest> {
    // Get next PR number for this repo
    const maxRow = await this.db
      .prepare('SELECT MAX(number) as max_num FROM deck_pull_requests WHERE repo_id = ?')
      .bind(repoId)
      .first<{ max_num: number | null }>();

    const number = (maxRow?.max_num ?? 0) + 1;
    const prId = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO deck_pull_requests
        (id, repo_id, number, title, description, source_branch_id, target_branch_id, source_repo_id,
         author_id, author_name, status, merge_commit_id, merge_strategy, labels_json, assignees_json,
         required_approvals, parent_pr_id, created_at, updated_at, merged_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, '[]', '[]', 1, NULL, ?, ?, NULL, NULL)
      `)
      .bind(
        prId, repoId, number, title, description,
        sourceBranchId, targetBranchId, sourceRepoId ?? null,
        authorId, authorName, createdAt, createdAt
      )
      .run();

    // Audit
    await this.permSvc.audit(repoId, authorId, authorName, 'pr.open', {
      prNumber: number,
      title,
      sourceBranch: sourceBranchId,
      targetBranch: targetBranchId,
    });

    // Webhook
    await this.webhookSvc.dispatch(repoId, 'pr.open', {
      prNumber: number,
      title,
      description,
      sourceBranchId,
      targetBranchId,
      authorId,
      authorName
    }, authorName);

    return {
      id: prId,
      repoId,
      number,
      title,
      description,
      sourceBranchId,
      targetBranchId,
      sourceRepoId: sourceRepoId ?? null,
      authorId,
      authorName,
      status: 'open',
      mergeCommitId: null,
      mergeStrategy: null,
      labels: [],
      assignees: [],
      requiredApprovals: 1,
      autoMerge: false,
      parentPrId: null,
      locked: false,
      verified: false,
      verifiedBy: null,
      isDraft: false,
      draftReady: false,
      mergeScheduledAt: null,
      mergeSchedule: null,
      createdAt,
      updatedAt: createdAt,
      mergedAt: null,
      closedAt: null,
    };
  }

  /**
   * Update PR metadata (title, description, labels, assignees).
   */
  async updatePR(
    prId: string,
    updates: Partial<Pick<PullRequest, 'title' | 'description' | 'labels' | 'assignees' | 'requiredApprovals'>>
  ): Promise<void> {
    const parts: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) { parts.push('title = ?'); values.push(updates.title); }
    if (updates.description !== undefined) { parts.push('description = ?'); values.push(updates.description); }
    if (updates.labels !== undefined) { parts.push('labels_json = ?'); values.push(JSON.stringify(updates.labels)); }
    if (updates.assignees !== undefined) { parts.push('assignees_json = ?'); values.push(JSON.stringify(updates.assignees)); }
    if (updates.requiredApprovals !== undefined) { parts.push('required_approvals = ?'); values.push(updates.requiredApprovals); }

    if (parts.length === 0) return;

    parts.push('updated_at = ?');
    values.push(now());
    values.push(prId);

    await this.db
      .prepare(`UPDATE deck_pull_requests SET ${parts.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  /**
   * Close a PR without merging.
   */
  async closePR(prId: string, actorId: string, actorName: string): Promise<void> {
    const pr = await this.getPRById(prId);
    if (!pr) throw new Error('PR not found');
    if (pr.status !== 'open') throw new Error('PR is not open');

    const closedAt = now();
    await this.db
      .prepare('UPDATE deck_pull_requests SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?')
      .bind('closed', closedAt, closedAt, prId)
      .run();

    await this.permSvc.audit(pr.repoId, actorId, actorName, 'pr.close', {
      prNumber: pr.number,
    });
  }

  // ==================== Draft PRs ====================

  /**
   * Mark a PR as draft (WIP).
   */
  async setDraft(prId: string, actorId: string, actorName: string, isDraft: boolean): Promise<void> {
    const pr = await this.getPRById(prId);
    if (!pr) throw new Error('PR not found');
    if (pr.status !== 'open') throw new Error('Can only modify open PRs');

    const updatedAt = now();
    await this.db
      .prepare('UPDATE deck_pull_requests SET is_draft = ?, updated_at = ? WHERE id = ?')
      .bind(isDraft ? 1 : 0, updatedAt, prId)
      .run();

    await this.permSvc.audit(pr.repoId, actorId, actorName, isDraft ? 'pr.draft' : 'pr.ready', {
      prNumber: pr.number,
      isDraft,
    });
  }

  /**
   * Mark a draft PR as ready for review.
   */
  async markReady(prId: string, actorId: string, actorName: string): Promise<void> {
    const pr = await this.getPRById(prId);
    if (!pr) throw new Error('PR not found');
    if (!pr.isDraft) throw new Error('PR is not a draft');
    if (pr.status !== 'open') throw new Error('Can only modify open PRs');

    const updatedAt = now();
    await this.db
      .prepare('UPDATE deck_pull_requests SET is_draft = 0, draft_ready = 1, updated_at = ? WHERE id = ?')
      .bind(updatedAt, prId)
      .run();

    await this.permSvc.audit(pr.repoId, actorId, actorName, 'pr.ready', {
      prNumber: pr.number,
    });
  }

  // ==================== Merge Scheduling ====================

  /**
   * Schedule a PR for automatic merge at a specific time.
   */
  async scheduleMerge(
    prId: string,
    actorId: string,
    actorName: string,
    schedule: string
  ): Promise<void> {
    const pr = await this.getPRById(prId);
    if (!pr) throw new Error('PR not found');
    if (pr.status !== 'open') throw new Error('Can only schedule open PRs');

    const [scheduleType, scheduleValue] = schedule.split(':');
    let scheduledFor: string;

    if (scheduleType === 'daily') {
      const [hours, minutes] = scheduleValue.split(',').map(Number);
      const date = new Date();
      date.setHours(hours, minutes, 0, 0);
      if (date <= new Date()) date.setDate(date.getDate() + 1);
      scheduledFor = date.toISOString();
    } else if (scheduleType === 'weekly') {
      const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const targetDay = dayNames.indexOf(scheduleValue.toLowerCase());
      const date = new Date();
      const currentDay = date.getDay();
      let daysToAdd = targetDay - currentDay;
      if (daysToAdd <= 0) daysToAdd += 7;
      date.setDate(date.getDate() + daysToAdd);
      date.setHours(9, 0, 0, 0);
      scheduledFor = date.toISOString();
    } else {
      throw new Error('Invalid schedule format. Use "daily:HH,MM" or "weekly:day"');
    }

    const updatedAt = now();
    await this.db
      .prepare('UPDATE deck_pull_requests SET merge_schedule = ?, merge_scheduled_at = ?, auto_merge = 1, updated_at = ? WHERE id = ?')
      .bind(schedule, scheduledFor, updatedAt, prId)
      .run();

    await this.permSvc.audit(pr.repoId, actorId, actorName, 'pr.schedule', {
      prNumber: pr.number,
      schedule,
      scheduledFor,
    });
  }

  /**
   * Cancel a scheduled merge.
   */
  async cancelScheduledMerge(prId: string, actorId: string, actorName: string): Promise<void> {
    const pr = await this.getPRById(prId);
    if (!pr) throw new Error('PR not found');

    const updatedAt = now();
    await this.db
      .prepare('UPDATE deck_pull_requests SET merge_schedule = NULL, merge_scheduled_at = NULL, auto_merge = 0, updated_at = ? WHERE id = ?')
      .bind(updatedAt, prId)
      .run();
  }

  /**
   * Get PRs ready for scheduled merge.
   */
  async getScheduledForMerge(): Promise<PullRequest[]> {
    const now = new Date().toISOString();
    const rows = await this.db
      .prepare(`
        SELECT * FROM deck_pull_requests 
        WHERE status = 'open' 
        AND auto_merge = 1 
        AND merge_scheduled_at IS NOT NULL 
        AND merge_scheduled_at <= ?
      `)
      .bind(now)
      .all();

    return (rows.results || []).map(row => this.rowToPR(row));
  }

  // ==================== Merge ====================

  /**
   * Merge a PR: check permissions, verify checks, detect conflicts, merge.
   */
  async mergePR(
    prId: string,
    strategy: MergeStrategy,
    userId: string,
    userName: string
  ): Promise<MergeResult> {
    const pr = await this.getPRById(prId);
    if (!pr) throw new Error('PR not found');
    if (pr.status !== 'open') throw new Error('PR is not open');

    // Check permissions
    const canMerge = await this.permSvc.canMergePR(pr.repoId, userId);
    if (!canMerge) throw new Error('Insufficient permissions to merge');

    // Check merge eligibility
    const eligibility = await this.canMerge(prId);
    if (!eligibility.mergeable) {
      return { success: false, conflicts: [] };
    }

    // Perform merge
    const result = await this.mergeSvc.merge(pr.sourceBranchId, pr.targetBranchId, strategy);

    if (!result.success) {
      return result;
    }

    // Create merge commit if auto-merge succeeded
    if (result.mergedState) {
      const sourceBranch = await this.branchSvc.getBranch(pr.sourceBranchId);
      const targetBranch = await this.branchSvc.getBranch(pr.targetBranchId);

      if (sourceBranch?.headCommitId && targetBranch?.headCommitId) {
        const targetState = await this.commitSvc.getStateAtCommit(targetBranch.headCommitId);
        const mergedPatch = this.commitSvc.computePatch(targetState, result.mergedState);

        const mergeCommit = await this.commitSvc.createMergeCommit(
          pr.repoId,
          pr.targetBranchId,
          targetBranch.headCommitId,
          sourceBranch.headCommitId,
          userId,
          userName,
          `Merge PR #${pr.number}: ${pr.title}`,
          result.mergedState,
          mergedPatch
        );

        result.mergeCommit = mergeCommit;

        // Update PR status
        const mergedAt = now();
        await this.db
          .prepare(`
            UPDATE deck_pull_requests
            SET status = 'merged', merge_commit_id = ?, merge_strategy = ?, merged_at = ?, updated_at = ?
            WHERE id = ?
          `)
          .bind(mergeCommit.id, strategy, mergedAt, mergedAt, prId)
          .run();

        // Auto-close linked issues
        await this.autoCloseLinkedIssues(pr);

        // Audit
        await this.permSvc.audit(pr.repoId, userId, userName, 'pr.merge', {
          prNumber: pr.number,
          strategy,
          commitId: mergeCommit.id,
        });

        // Webhook
        await this.webhookSvc.dispatch(pr.repoId, 'pr.merge', {
          prNumber: pr.number,
          strategy,
          commitId: mergeCommit.id,
          mergedBy: userId
        }, userName);
      }
    }

    return result;
  }

  /**
   * Check if a PR can be merged: approvals, checks, no conflicts.
   */
  async canMerge(prId: string): Promise<{ mergeable: boolean; reasons: string[] }> {
    const pr = await this.getPRById(prId);
    if (!pr) return { mergeable: false, reasons: ['PR not found'] };

    const reasons: string[] = [];

    // Check approvals
    const reviews = await this.getReviews(prId);
    const approvals = reviews.filter(r => r.state === 'APPROVED').length;
    const changesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');

    if (approvals < pr.requiredApprovals) {
      reasons.push(`Needs ${pr.requiredApprovals - approvals} more approval(s)`);
    }
    if (changesRequested) {
      reasons.push('Changes have been requested');
    }

    // Check if PR is a draft
    if (pr.isDraft && !pr.draftReady) {
      reasons.push('PR is still a draft');
    }

    // Check CI checks
    const allPassed = await this.checksSvc.allChecksPassed(prId);
    if (!allPassed) {
      reasons.push('Not all checks have passed');
    }

    // Check guarded sections
    try {
      const repo = await this.db.prepare('SELECT settings_json FROM deck_repos WHERE id = ?')
        .bind(pr.repoId).first<{ settings_json: string }>();
      const settings = JSON.parse(repo?.settings_json || '{}');
      if (settings.guardedSections && Array.isArray(settings.guardedSections)) {
        const diff = await this.getDiff(prId);
        const affectedBoards = new Set<string>();
        for (const op of diff) {
          if ('board' in op && op.board) affectedBoards.add(op.board);
          if ('fromBoard' in op) affectedBoards.add((op as { fromBoard: string }).fromBoard);
          if ('toBoard' in op) affectedBoards.add((op as { toBoard: string }).toBoard);
        }
        for (const guard of settings.guardedSections as Array<{ section: string; requiredApprovals: number }>) {
          if (affectedBoards.has(guard.section) && approvals < guard.requiredApprovals) {
            reasons.push(`Guarded "${guard.section}" needs ${guard.requiredApprovals} approval(s)`);
          }
        }
      }
    } catch { /* guarded check is best-effort */ }

    // Check parent PR in stack is merged first
    if (pr.parentPrId) {
      const parentPr = await this.getPRById(pr.parentPrId);
      if (parentPr && parentPr.status !== 'merged') {
        reasons.push(`Parent PR #${parentPr.number} must be merged first`);
      }
    }

    // Check for conflicts
    const mergeResult = await this.mergeSvc.merge(pr.sourceBranchId, pr.targetBranchId);
    if (!mergeResult.success && mergeResult.conflicts && mergeResult.conflicts.length > 0) {
      reasons.push(`${mergeResult.conflicts.length} conflict(s) detected`);
    }

    return { mergeable: reasons.length === 0, reasons };
  }

  // ==================== Reviews ====================

  /**
   * Add a review to a PR.
   */
  async addReview(
    prId: string,
    reviewerId: string,
    reviewerName: string,
    state: ReviewState,
    body: string
  ): Promise<Review> {
    const pr = await this.getPRById(prId);
    if (!pr) throw new Error('PR not found');

    // Check permissions
    const canReview = await this.permSvc.canReview(pr.repoId, reviewerId);
    if (!canReview) throw new Error('Insufficient permissions to review');

    const reviewId = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO pr_reviews (id, pr_id, reviewer_id, reviewer_name, state, body, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(reviewId, prId, reviewerId, reviewerName, state, body, createdAt)
      .run();

    await this.permSvc.audit(pr.repoId, reviewerId, reviewerName, 'review.add', {
      prNumber: pr.number,
      state,
    });

    return {
      id: reviewId,
      prId,
      reviewerId,
      reviewerName,
      state,
      body,
      createdAt,
    };
  }

  /**
   * Get all reviews for a PR.
   */
  async getReviews(prId: string): Promise<Review[]> {
    const rows = await this.db
      .prepare('SELECT * FROM pr_reviews WHERE pr_id = ? ORDER BY created_at ASC')
      .bind(prId)
      .all<{
        id: string;
        pr_id: string;
        reviewer_id: string;
        reviewer_name: string;
        state: string;
        body: string;
        created_at: string;
      }>();

    return (rows.results || []).map(row => ({
      id: row.id,
      prId: row.pr_id,
      reviewerId: row.reviewer_id,
      reviewerName: row.reviewer_name,
      state: row.state as ReviewState,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  // ==================== Comments ====================

  /**
   * Add a comment to a PR (general or inline).
   */
  async addComment(
    prId: string,
    authorId: string,
    authorName: string,
    body: string,
    inline?: { commitId: string; path: string; lineContext?: string },
    parentCommentId?: string
  ): Promise<PRComment> {
    const commentId = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO pr_comments
        (id, pr_id, author_id, author_name, body, commit_id, path, line_context, parent_comment_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `)
      .bind(
        commentId, prId, authorId, authorName, body,
        inline?.commitId ?? null,
        inline?.path ?? null,
        inline?.lineContext ?? null,
        parentCommentId ?? null,
        createdAt
      )
      .run();

    return {
      id: commentId,
      prId,
      authorId,
      authorName,
      body,
      commitId: inline?.commitId ?? null,
      path: inline?.path ?? null,
      lineContext: inline?.lineContext ?? null,
      parentCommentId: parentCommentId ?? null,
      createdAt,
      updatedAt: null,
    };
  }

  /**
   * Get all comments for a PR.
   */
  async getComments(prId: string): Promise<PRComment[]> {
    const rows = await this.db
      .prepare('SELECT * FROM pr_comments WHERE pr_id = ? ORDER BY created_at ASC')
      .bind(prId)
      .all<{
        id: string;
        pr_id: string;
        author_id: string;
        author_name: string;
        body: string;
        commit_id: string | null;
        path: string | null;
        line_context: string | null;
        parent_comment_id: string | null;
        created_at: string;
        updated_at: string | null;
      }>();

    return (rows.results || []).map(row => ({
      id: row.id,
      prId: row.pr_id,
      authorId: row.author_id,
      authorName: row.author_name,
      body: row.body,
      commitId: row.commit_id,
      path: row.path,
      lineContext: row.line_context,
      parentCommentId: row.parent_comment_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  // ==================== Diff ====================

  /**
   * Get the diff (patch) between source and target branch of a PR.
   */
  async getDiff(prId: string): Promise<import('./types.js').DeckPatchOp[]> {
    const pr = await this.getPRById(prId);
    if (!pr) throw new Error('PR not found');

    const sourceBranch = await this.branchSvc.getBranch(pr.sourceBranchId);
    const targetBranch = await this.branchSvc.getBranch(pr.targetBranchId);

    if (!sourceBranch?.headCommitId || !targetBranch?.headCommitId) return [];

    const sourceState = await this.commitSvc.getStateAtCommit(sourceBranch.headCommitId);
    const targetState = await this.commitSvc.getStateAtCommit(targetBranch.headCommitId);

    return this.commitSvc.computePatch(targetState, sourceState);
  }

  // ==================== Queries ====================

  /**
   * Get a PR by its internal ID.
   */
  async getPRById(prId: string): Promise<PullRequest | null> {
    const row = await this.db
      .prepare('SELECT * FROM deck_pull_requests WHERE id = ?')
      .bind(prId)
      .first();

    return row ? this.rowToPR(row) : null;
  }

  /**
   * Get a PR by repo ID and number.
   */
  async getPR(repoId: string, number: number): Promise<PullRequest | null> {
    const row = await this.db
      .prepare('SELECT * FROM deck_pull_requests WHERE repo_id = ? AND number = ?')
      .bind(repoId, number)
      .first();

    return row ? this.rowToPR(row) : null;
  }

  /**
   * List PRs for a repo with optional status filter.
   */
  async listPRs(repoId: string, status?: PRStatus): Promise<PullRequest[]> {
    let query = 'SELECT * FROM deck_pull_requests WHERE repo_id = ?';
    const binds: unknown[] = [repoId];

    if (status) {
      query += ' AND status = ?';
      binds.push(status);
    }

    query += ' ORDER BY number DESC';

    const rows = await this.db
      .prepare(query)
      .bind(...binds)
      .all();

    return (rows.results || []).map(this.rowToPR);
  }

  // ==================== Helpers ====================

  /**
   * Auto-close issues linked via "closes #N" in PR description.
   */
  private async autoCloseLinkedIssues(pr: PullRequest): Promise<void> {
    const closesPattern = /(?:closes?|fixes?|resolves?)\s+#(\d+)/gi;
    const text = `${pr.title} ${pr.description}`;
    let match: RegExpExecArray | null;

    while ((match = closesPattern.exec(text)) !== null) {
      const issueNumber = parseInt(match[1], 10);
      await this.db
        .prepare(`
          UPDATE repo_issues SET status = 'closed', closed_at = ?, updated_at = ?
          WHERE repo_id = ? AND number = ? AND status = 'open'
        `)
        .bind(now(), now(), pr.repoId, issueNumber)
        .run();
    }
  }

  private rowToPR(row: Record<string, unknown>): PullRequest {
    return {
      id: row.id as string,
      repoId: row.repo_id as string,
      number: row.number as number,
      title: row.title as string,
      description: (row.description as string) || '',
      sourceBranchId: row.source_branch_id as string,
      targetBranchId: row.target_branch_id as string,
      sourceRepoId: (row.source_repo_id as string) || null,
      authorId: row.author_id as string,
      authorName: row.author_name as string,
      status: row.status as PRStatus,
      mergeCommitId: (row.merge_commit_id as string) || null,
      mergeStrategy: (row.merge_strategy as MergeStrategy) || null,
      labels: JSON.parse((row.labels_json as string) || '[]'),
      assignees: JSON.parse((row.assignees_json as string) || '[]'),
      requiredApprovals: (row.required_approvals as number) || 1,
      autoMerge: !!(row.auto_merge),
      parentPrId: (row.parent_pr_id as string) || null,
      locked: !!(row.locked),
      verified: !!(row.verified),
      verifiedBy: (row.verified_by as string) || null,
      isDraft: !!(row.is_draft),
      draftReady: !!(row.draft_ready),
      mergeScheduledAt: (row.merge_scheduled_at as string) || null,
      mergeSchedule: (row.merge_schedule as string) || null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      mergedAt: (row.merged_at as string) || null,
      closedAt: (row.closed_at as string) || null,
    };
  }
}
