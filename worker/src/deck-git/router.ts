// ============================================================
// DeckGit API Router — All /api/repos/* endpoints
// ============================================================
// Self-contained router for the "GitHub for Decks" API.
// Returns null if the path doesn't match, allowing the main
// worker to fall through to other routes.
// ============================================================

import { CommitService } from './commit-service.js';
import { BranchService } from './branch-service.js';
import { MergeService } from './merge-service.js';
import { PermissionService } from './permission-service.js';
import { PRService } from './pr-service.js';
import { ChecksService } from './checks-service.js';
import { IssueService } from './issue-service.js';
import { ReleaseService } from './release-service.js';
import { ForkService } from './fork-service.js';
import { AutoLabelService } from './auto-label-service.js';
import { BlameService } from './blame-service.js';
import { parseSlashCommand, formatCommandResult } from './slash-command-service.js';
import { ReviewerSuggestionService } from './reviewer-suggestion-service.js';
import { ActivityService } from './activity-service.js';
import { HealthService } from './health-service.js';
import { WebhookService } from './webhook-service.js';
import { WatchService } from './watch-service.js';
import { BisectService } from './bisect-service.js';
import {
  type DeckState,
  type DeckPatchOp,
  type RepoSettings,
  type MergeStrategy,
  type ReviewState,
  type PRStatus,
  type IssueStatus,
  type KanbanColumn,
  type ConflictResolution,
  type ReleaseChannel,
  generateId,
  now,
} from './types.js';

interface DeckGitEnv {
  COMMUNITY_DB?: D1Database;
}

interface AuthInfo {
  userId: string;
  userName: string;
}

/**
 * Handle all /api/repos/* routes.
 * Returns a Response if matched, or null to pass through.
 */
export async function handleDeckGitRoute(
  request: Request,
  path: string,
  env: DeckGitEnv,
  corsHeaders: Record<string, string>,
  auth: AuthInfo | null
): Promise<Response | null> {
  // Only handle /api/repos paths
  if (!path.startsWith('/api/repos') && !path.startsWith('/api/inventory') &&
      !path.startsWith('/api/templates') && !path.startsWith('/api/draft')) {
    return null;
  }

  const db = env.COMMUNITY_DB;
  if (!db) {
    return json({ error: 'Database not configured' }, 500, corsHeaders);
  }

  // Initialize services
  const commitSvc = new CommitService(db);
  const branchSvc = new BranchService(db);
  const mergeSvc = new MergeService(db, commitSvc, branchSvc);
  const webhookSvc = new WebhookService(db);
  const permSvc = new PermissionService(db);
  const checksSvc = new ChecksService(db, webhookSvc);
  const prSvc = new PRService(db, mergeSvc, permSvc, checksSvc, commitSvc, branchSvc, webhookSvc);
  const issueSvc = new IssueService(db, webhookSvc);
  const releaseSvc = new ReleaseService(db, commitSvc, webhookSvc);
  const forkSvc = new ForkService(db, commitSvc, branchSvc, mergeSvc);
  const autoLabelSvc = new AutoLabelService(db);
  const blameSvc = new BlameService(db);
  const reviewerSuggestSvc = new ReviewerSuggestionService(db);
  const activitySvc = new ActivityService(db);
  const healthSvc = new HealthService(db);
  const watchSvc = new WatchService(db);
  const bisectSvc = new BisectService(db, commitSvc, checksSvc);

  const method = request.method;

  try {
    // ==================== Repos ====================

    // POST /api/repos — Create repo
    if (path === '/api/repos' && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { name: string; description?: string; format?: string; visibility?: string };
      const repoId = generateId();
      const createdAt = now();

      await db.prepare(`
        INSERT INTO deck_repos (id, name, description, owner_id, visibility, format, default_branch, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'main', '{}', ?, ?)
      `).bind(
        repoId, body.name, body.description || '', auth!.userId,
        body.visibility || 'private', body.format || 'commander',
        createdAt, createdAt
      ).run();

      // Create default 'main' branch
      const mainBranch = await branchSvc.createBranch(repoId, 'main', null, auth!.userId);

      // Add owner as collaborator
      await permSvc.setRole(repoId, auth!.userId, 'MAINTAINER', auth!.userId);
      await permSvc.audit(repoId, auth!.userId, auth!.userName, 'repo.create', { name: body.name });

      return json({ id: repoId, defaultBranchId: mainBranch.id }, 201, corsHeaders);
    }

    // GET /api/repos/:id
    const repoMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)$/);
    if (repoMatch && method === 'GET') {
      const repoId = repoMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const repo = await db.prepare('SELECT * FROM deck_repos WHERE id = ?').bind(repoId).first();
      if (!repo) return json({ error: 'Repo not found' }, 404, corsHeaders);
      return json(repo, 200, corsHeaders);
    }

    // PATCH /api/repos/:id
    if (repoMatch && method === 'PATCH') {
      requireAuth(auth);
      await permSvc.requirePermission(repoMatch[1], auth!.userId, 'canManageSettings');
      const body = await request.json() as Record<string, unknown>;
      const parts: string[] = [];
      const values: unknown[] = [];

      if (body.name) { parts.push('name = ?'); values.push(body.name); }
      if (body.description !== undefined) { parts.push('description = ?'); values.push(body.description); }
      if (body.visibility) { parts.push('visibility = ?'); values.push(body.visibility); }
      if (body.format) { parts.push('format = ?'); values.push(body.format); }

      if (parts.length > 0) {
        parts.push('updated_at = ?'); values.push(now()); values.push(repoMatch[1]);
        await db.prepare(`UPDATE deck_repos SET ${parts.join(', ')} WHERE id = ?`).bind(...values).run();
      }
      return json({ ok: true }, 200, corsHeaders);
    }

    // DELETE /api/repos/:id
    if (repoMatch && method === 'DELETE') {
      requireAuth(auth);
      await permSvc.requirePermission(repoMatch[1], auth!.userId, 'canDelete');
      await db.prepare('DELETE FROM deck_repos WHERE id = ?').bind(repoMatch[1]).run();
      return json({ ok: true }, 200, corsHeaders);
    }

    // POST /api/repos/:id/fork
    const forkMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/fork$/);
    if (forkMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { name?: string } | undefined;
      const fork = await forkSvc.forkRepo(forkMatch[1], auth!.userId, auth!.userName, body?.name);
      await permSvc.audit(forkMatch[1], auth!.userId, auth!.userName, 'repo.fork', { forkId: fork.id });
      return json(fork, 201, corsHeaders);
    }

    // GET /api/repos/:id/forks
    const forksMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/forks$/);
    if (forksMatch && method === 'GET') {
      const repoId = forksMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const forks = await forkSvc.listForks(repoId);
      return json(forks, 200, corsHeaders);
    }

    // ==================== Branches ====================

    // GET /api/repos/:id/branches
    const branchesMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/branches$/);
    if (branchesMatch && method === 'GET') {
      const repoId = branchesMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const branches = await branchSvc.getBranches(repoId);
      return json(branches, 200, corsHeaders);
    }

    // POST /api/repos/:id/branches
    if (branchesMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { name: string; fromBranchId?: string };
      const branch = await branchSvc.createBranch(branchesMatch[1], body.name, body.fromBranchId || null, auth!.userId);
      await permSvc.audit(branchesMatch[1], auth!.userId, auth!.userName, 'branch.create', { branchName: body.name });
      return json(branch, 201, corsHeaders);
    }

    // DELETE /api/repos/:id/branches/:bid
    const branchMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/branches\/([a-z0-9-]+)$/);
    if (branchMatch && method === 'DELETE') {
      requireAuth(auth);
      await branchSvc.deleteBranch(branchMatch[1], branchMatch[2]);
      await permSvc.audit(branchMatch[1], auth!.userId, auth!.userName, 'branch.delete', { branchId: branchMatch[2] });
      return json({ ok: true }, 200, corsHeaders);
    }

    // PATCH /api/repos/:id/branches/:bid
    if (branchMatch && method === 'PATCH') {
      requireAuth(auth);
      const body = await request.json() as { name?: string; isProtected?: boolean };
      if (body.name) await branchSvc.renameBranch(branchMatch[1], branchMatch[2], body.name);
      if (body.isProtected !== undefined) await branchSvc.setProtected(branchMatch[2], body.isProtected);
      return json({ ok: true }, 200, corsHeaders);
    }

    // ==================== Commits ====================

    // GET /api/repos/:id/branches/:bid/commits
    const branchCommitsMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/branches\/([a-z0-9-]+)\/commits$/);
    if (branchCommitsMatch && method === 'GET') {
      const repoId = branchCommitsMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const commits = await commitSvc.getHistory(branchCommitsMatch[2], limit, offset);
      return json(commits, 200, corsHeaders);
    }

    // POST /api/repos/:id/branches/:bid/commits — Create commit
    if (branchCommitsMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { message: string; state: DeckState };
      const commit = await commitSvc.createCommit(
        branchCommitsMatch[1], branchCommitsMatch[2],
        auth!.userId, auth!.userName,
        body.message, body.state
      );
      await permSvc.audit(branchCommitsMatch[1], auth!.userId, auth!.userName, 'commit.create', {
        commitId: commit.id, message: body.message,
      });
      return json(commit, 201, corsHeaders);
    }

    // GET /api/repos/:id/commits/:cid
    const commitMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/commits\/([a-z0-9-]+)$/);
    if (commitMatch && method === 'GET') {
      const repoId = commitMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const commit = await commitSvc.getCommit(commitMatch[2]);
      if (!commit) return json({ error: 'Commit not found' }, 404, corsHeaders);
      return json(commit, 200, corsHeaders);
    }

    // GET /api/repos/:id/commits/:cid/state
    const commitStateMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/commits\/([a-z0-9-]+)\/state$/);
    if (commitStateMatch && method === 'GET') {
      const repoId = commitStateMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const state = await commitSvc.getStateAtCommit(commitStateMatch[2]);
      return json(state, 200, corsHeaders);
    }

    // POST /api/repos/:id/commits/:cid/revert
    const revertMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/commits\/([a-z0-9-]+)\/revert$/);
    if (revertMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { branchId: string };
      const revertCommit = await commitSvc.revertCommit(
        revertMatch[2], body.branchId, auth!.userId, auth!.userName
      );
      await permSvc.audit(revertMatch[1], auth!.userId, auth!.userName, 'commit.revert', {
        commitId: revertMatch[2], revertCommitId: revertCommit.id,
      });
      return json(revertCommit, 201, corsHeaders);
    }

    // ==================== Branch Comparison ====================

    // GET /api/repos/:id/compare?from=branch1&to=branch2
    const compareMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/compare$/);
    if (compareMatch && method === 'GET') {
      const repoId = compareMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const url = new URL(request.url);
      const fromBranch = url.searchParams.get('from');
      const toBranch = url.searchParams.get('to');

      if (!fromBranch || !toBranch) {
        return json({ error: 'Specify from and to branch parameters' }, 400, corsHeaders);
      }

      // Get branch IDs
      const branches = await branchSvc.getBranches(compareMatch[1]);
      const fromBranchObj = branches.find(b => b.name === fromBranch);
      const toBranchObj = branches.find(b => b.name === toBranch);

      if (!fromBranchObj || !toBranchObj) {
        return json({ error: 'Branch not found' }, 404, corsHeaders);
      }

      const comparison = await commitSvc.compareBranches(fromBranchObj.id, toBranchObj.id);
      return json(comparison, 200, corsHeaders);
    }

    // POST /api/repos/:id/commits/suggest-message — Generate smart commit message
    const suggestCommitMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/commits\/suggest-message$/);
    if (suggestCommitMatch && method === 'POST') {
      const body = await request.json() as { patch: DeckPatchOp[]; meta?: { name?: string; format?: string } };
      const suggestion = commitSvc.generateSmartCommitMessage(body.patch, body.meta);
      return json(suggestion, 200, corsHeaders);
    }

    // GET /api/repos/:id/branches/:bid/compare?with=otherBranchId
    const branchCompareMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/branches\/([a-z0-9-]+)\/compare$/);
    if (branchCompareMatch && method === 'GET') {
      const repoId = branchCompareMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const url = new URL(request.url);
      const withBranchId = url.searchParams.get('with');

      if (!withBranchId) {
        return json({ error: 'Specify ?with=branchId parameter' }, 400, corsHeaders);
      }

      const comparison = await commitSvc.compareBranches(branchCompareMatch[2], withBranchId);
      return json(comparison, 200, corsHeaders);
    }

    // GET /api/repos/:id/branches/:bid/state?compare=otherBranchId
    const branchStateMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/branches\/([a-z0-9-]+)\/state$/);
    if (branchStateMatch && method === 'GET') {
      const repoId = branchStateMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const url = new URL(request.url);
      const compareWith = url.searchParams.get('compare');

      if (!compareWith) {
        // Just return the state of this branch
        const branch = await branchSvc.getBranch(branchStateMatch[2]);
        if (!branch?.headCommitId) {
          return json(commitSvc.emptyState(), 200, corsHeaders);
        }
        const state = await commitSvc.getStateAtCommit(branch.headCommitId);
        return json(state, 200, corsHeaders);
      }

      // Return side-by-side comparison
      const comparison = await commitSvc.getComparisonState(branchStateMatch[2], compareWith);
      return json(comparison, 200, corsHeaders);
    }

    // ==================== Pull Requests ====================

    // GET /api/repos/:id/pulls
    const pullsMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls$/);
    if (pullsMatch && method === 'GET') {
      const repoId = pullsMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const url = new URL(request.url);
      const status = url.searchParams.get('status') as PRStatus | null;
      const prs = await prSvc.listPRs(repoId, status || undefined);
      return json(prs, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls
    if (pullsMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as {
        title: string; description?: string;
        sourceBranchId: string; targetBranchId: string;
        sourceRepoId?: string;
      };
      const pr = await prSvc.openPR(
        pullsMatch[1], body.title, body.description || '',
        body.sourceBranchId, body.targetBranchId,
        auth!.userId, auth!.userName, body.sourceRepoId
      );
      // Auto-label based on diff scope (non-blocking)
      try {
        const diff = await prSvc.getDiff(pr.id);
        if (diff.length > 0) {
          const labels = await autoLabelSvc.applyAutoLabels(pr.id, diff);
          pr.labels = labels;
        }
      } catch { /* auto-label is best-effort */ }
      return json(pr, 201, corsHeaders);
    }

    // GET /api/repos/:id/pulls/:num
    const prMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)$/);
    if (prMatch && method === 'GET') {
      const repoId = prMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const pr = await prSvc.getPR(repoId, parseInt(prMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      return json(pr, 200, corsHeaders);
    }

    // PATCH /api/repos/:id/pulls/:num
    if (prMatch && method === 'PATCH') {
      requireAuth(auth);
      const pr = await prSvc.getPR(prMatch[1], parseInt(prMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const body = await request.json() as Partial<{ title: string; description: string; labels: string[]; assignees: string[] }>;
      await prSvc.updatePR(pr.id, body);
      return json({ ok: true }, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/merge
    const mergeMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/merge$/);
    if (mergeMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(mergeMatch[1], parseInt(mergeMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const body = await request.json() as { strategy?: MergeStrategy };
      const result = await prSvc.mergePR(pr.id, body.strategy || 'squash', auth!.userId, auth!.userName);
      return json(result, result.success ? 200 : 409, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/close
    const closeMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/close$/);
    if (closeMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(closeMatch[1], parseInt(closeMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      await prSvc.closePR(pr.id, auth!.userId, auth!.userName);
      return json({ ok: true }, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/automerge — Toggle automerge
    const autoMergeMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/automerge$/);
    if (autoMergeMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(autoMergeMatch[1], parseInt(autoMergeMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      if (pr.status !== 'open') return json({ error: 'PR is not open' }, 400, corsHeaders);
      const body = await request.json() as { enabled: boolean };
      await db.prepare('UPDATE deck_pull_requests SET auto_merge = ? WHERE id = ?')
        .bind(body.enabled ? 1 : 0, pr.id).run();
      // If enabling, try to merge immediately if ready
      if (body.enabled) {
        try {
          const eligibility = await prSvc.canMerge(pr.id);
          if (eligibility.mergeable) {
            const result = await prSvc.mergePR(pr.id, 'squash', auth!.userId, auth!.userName);
            return json({ autoMerge: true, merged: result.success }, 200, corsHeaders);
          }
        } catch { /* auto-merge attempt best-effort */ }
      }
      return json({ autoMerge: body.enabled, merged: false }, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/draft — Mark PR as draft/WIP
    const draftMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/draft$/);
    if (draftMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(draftMatch[1], parseInt(draftMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const body = await request.json() as { isDraft: boolean };
      await prSvc.setDraft(pr.id, auth!.userId, auth!.userName, body.isDraft);
      return json({ ok: true, isDraft: body.isDraft }, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/ready — Mark draft PR as ready for review
    const readyMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/ready$/);
    if (readyMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(readyMatch[1], parseInt(readyMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      await prSvc.markReady(pr.id, auth!.userId, auth!.userName);
      return json({ ok: true, draftReady: true }, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/schedule — Schedule auto-merge
    const scheduleMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/schedule$/);
    if (scheduleMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(scheduleMatch[1], parseInt(scheduleMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const body = await request.json() as { schedule: string };
      await prSvc.scheduleMerge(pr.id, auth!.userId, auth!.userName, body.schedule);
      return json({ ok: true, schedule: body.schedule }, 200, corsHeaders);
    }

    // DELETE /api/repos/:id/pulls/:num/schedule — Cancel scheduled merge
    if (scheduleMatch && method === 'DELETE') {
      requireAuth(auth);
      const pr = await prSvc.getPR(scheduleMatch[1], parseInt(scheduleMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      await prSvc.cancelScheduledMerge(pr.id, auth!.userId, auth!.userName);
      return json({ ok: true, schedule: null }, 200, corsHeaders);
    }

    // GET /api/repos/:id/pulls/:num/diff
    const diffMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/diff$/);
    if (diffMatch && method === 'GET') {
      const repoId = diffMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const pr = await prSvc.getPR(repoId, parseInt(diffMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const diff = await prSvc.getDiff(pr.id);
      return json(diff, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/auto-label — Re-run auto-labeling
    const autoLabelMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/auto-label$/);
    if (autoLabelMatch && method === 'POST') {
      const pr = await prSvc.getPR(autoLabelMatch[1], parseInt(autoLabelMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const diff = await prSvc.getDiff(pr.id);
      const labels = await autoLabelSvc.applyAutoLabels(pr.id, diff);
      return json({ labels }, 200, corsHeaders);
    }

    // GET /api/repos/:id/pulls/:num/mergeable
    const mergeableMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/mergeable$/);
    if (mergeableMatch && method === 'GET') {
      const pr = await prSvc.getPR(mergeableMatch[1], parseInt(mergeableMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const result = await prSvc.canMerge(pr.id);
      return json(result, 200, corsHeaders);
    }

    // GET /api/repos/:id/pulls/:num/suggested-reviewers
    const suggestReviewersMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/suggested-reviewers$/);
    if (suggestReviewersMatch && method === 'GET') {
      const pr = await prSvc.getPR(suggestReviewersMatch[1], parseInt(suggestReviewersMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const diff = await prSvc.getDiff(pr.id);
      const suggestions = await reviewerSuggestSvc.suggestReviewers(
        pr.repoId, pr.targetBranchId, diff, pr.authorId
      );
      return json(suggestions, 200, corsHeaders);
    }

    // ==================== Reviews ====================

    // GET /api/repos/:id/pulls/:num/reviews
    const reviewsMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/reviews$/);
    if (reviewsMatch && method === 'GET') {
      const pr = await prSvc.getPR(reviewsMatch[1], parseInt(reviewsMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const reviews = await prSvc.getReviews(pr.id);
      return json(reviews, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/reviews
    if (reviewsMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(reviewsMatch[1], parseInt(reviewsMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const body = await request.json() as { state: ReviewState; body?: string };
      const review = await prSvc.addReview(pr.id, auth!.userId, auth!.userName, body.state, body.body || '');
      return json(review, 201, corsHeaders);
    }

    // ==================== PR Comments ====================

    // GET /api/repos/:id/pulls/:num/comments
    const prCommentsMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/comments$/);
    if (prCommentsMatch && method === 'GET') {
      const repoId = prCommentsMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const pr = await prSvc.getPR(repoId, parseInt(prCommentsMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const comments = await prSvc.getComments(pr.id);
      return json(comments, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/comments
    if (prCommentsMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(prCommentsMatch[1], parseInt(prCommentsMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);

      // Check if conversation is locked (only OWNER/MAINTAINER can comment)
      if (pr.locked) {
        try {
          await permSvc.requirePermission(pr.repoId, auth!.userId, 'canManageSettings');
        } catch {
          return json({ error: 'This conversation is locked. Only maintainers can comment.' }, 403, corsHeaders);
        }
      }

      const body = await request.json() as {
        body: string;
        inline?: { commitId: string; path: string; lineContext?: string };
        parentCommentId?: string;
      };
      const comment = await prSvc.addComment(
        pr.id, auth!.userId, auth!.userName,
        body.body, body.inline, body.parentCommentId
      );

      // Process slash commands (non-blocking)
      try {
        const slashCmd = parseSlashCommand(body.body);
        if (slashCmd) {
          let resultMsg = '';
          let success = true;
          switch (slashCmd.command) {
            case '/recheck': {
              const sourceBranch = await branchSvc.getBranch(pr.sourceBranchId);
              if (sourceBranch?.headCommitId) {
                const state = await commitSvc.getStateAtCommit(sourceBranch.headCommitId);
                const repo = await db.prepare('SELECT settings_json FROM deck_repos WHERE id = ?')
                  .bind(pr.repoId).first<{ settings_json: string }>();
                const settings: RepoSettings = JSON.parse(repo?.settings_json || '{}');
                await checksSvc.runChecks(pr.repoId, pr.id, sourceBranch.headCommitId, state, settings);
                resultMsg = 'Checks re-triggered';
              }
              break;
            }
            case '/label':
              if (slashCmd.args[0]) {
                const labels = [...new Set([...pr.labels, slashCmd.args[0]])];
                await prSvc.updatePR(pr.id, { labels });
                resultMsg = `Label "${slashCmd.args[0]}" added`;
              }
              break;
            case '/unlabel':
              if (slashCmd.args[0]) {
                const labels = pr.labels.filter(l => l !== slashCmd.args[0]);
                await prSvc.updatePR(pr.id, { labels });
                resultMsg = `Label "${slashCmd.args[0]}" removed`;
              }
              break;
            case '/close':
              await prSvc.closePR(pr.id, auth!.userId, auth!.userName);
              resultMsg = 'PR closed';
              break;
            case '/approve':
              await prSvc.addReview(pr.id, auth!.userId, auth!.userName, 'APPROVED', 'Approved via /approve command');
              resultMsg = 'PR approved';
              break;
            case '/merge':
              try {
                const mergeResult = await prSvc.mergePR(pr.id, 'squash', auth!.userId, auth!.userName);
                resultMsg = mergeResult.success ? 'PR merged' : 'Merge failed';
                success = mergeResult.success;
              } catch (e) { resultMsg = `Merge failed: ${(e as Error).message}`; success = false; }
              break;
            default:
              resultMsg = `Unknown command: ${slashCmd.command}`;
              success = false;
          }
          // Post system comment with result
          if (resultMsg) {
            await prSvc.addComment(pr.id, 'system', 'DeckHub Bot', formatCommandResult(slashCmd.raw, success, resultMsg));
          }
        }
      } catch { /* slash command execution is best-effort */ }

      return json(comment, 201, corsHeaders);
    }

    // ==================== Checks ====================

    // GET /api/repos/:id/pulls/:num/checks
    const checksMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/checks$/);
    if (checksMatch && method === 'GET') {
      const repoId = checksMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const pr = await prSvc.getPR(repoId, parseInt(checksMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const checks = await checksSvc.getCheckRuns(pr.id);
      return json(checks, 200, corsHeaders);
    }

    // POST /api/repos/:id/pulls/:num/checks/run
    const runChecksMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/checks\/run$/);
    if (runChecksMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(runChecksMatch[1], parseInt(runChecksMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);

      // Get source branch HEAD state
      const sourceBranch = await branchSvc.getBranch(pr.sourceBranchId);
      if (!sourceBranch?.headCommitId) return json({ error: 'Source branch empty' }, 400, corsHeaders);
      const state = await commitSvc.getStateAtCommit(sourceBranch.headCommitId);

      // Get repo settings
      const repo = await db.prepare('SELECT settings_json FROM deck_repos WHERE id = ?')
        .bind(runChecksMatch[1]).first<{ settings_json: string }>();
      const settings: RepoSettings = JSON.parse(repo?.settings_json || '{}');

      const checks = await checksSvc.runChecks(runChecksMatch[1], pr.id, sourceBranch.headCommitId, state, settings);
      await permSvc.audit(runChecksMatch[1], auth!.userId, auth!.userName, 'check.run', {
        prNumber: pr.number, checksCount: checks.length,
      });
      return json(checks, 200, corsHeaders);
    }

    // ==================== Issues ====================

    // GET /api/repos/:id/issues
    const issuesMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/issues$/);
    if (issuesMatch && method === 'GET') {
      const repoId = issuesMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const url = new URL(request.url);
      const status = url.searchParams.get('status') as IssueStatus | null;
      const label = url.searchParams.get('label') || undefined;
      const kanban = url.searchParams.get('kanban') as KanbanColumn | null;
      const issues = await issueSvc.getIssues(repoId, {
        status: status || undefined,
        label,
        kanbanColumn: kanban || undefined,
      });
      return json(issues, 200, corsHeaders);
    }

    // POST /api/repos/:id/issues
    if (issuesMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { title: string; body?: string; labels?: string[]; assignees?: string[] };
      const issue = await issueSvc.createIssue(
        issuesMatch[1], body.title, body.body || '',
        auth!.userId, auth!.userName,
        body.labels, body.assignees
      );
      await permSvc.audit(issuesMatch[1], auth!.userId, auth!.userName, 'issue.create', {
        issueNumber: issue.number, title: body.title,
      });
      return json(issue, 201, corsHeaders);
    }

    // GET /api/repos/:id/issues/:num
    const issueMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/issues\/(\d+)$/);
    if (issueMatch && method === 'GET') {
      const repoId = issueMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const issue = await issueSvc.getIssueByNumber(repoId, parseInt(issueMatch[2], 10));
      if (!issue) return json({ error: 'Issue not found' }, 404, corsHeaders);
      return json(issue, 200, corsHeaders);
    }

    // PATCH /api/repos/:id/issues/:num
    if (issueMatch && method === 'PATCH') {
      requireAuth(auth);
      const issue = await issueSvc.getIssueByNumber(issueMatch[1], parseInt(issueMatch[2], 10));
      if (!issue) return json({ error: 'Issue not found' }, 404, corsHeaders);
      const body = await request.json() as Partial<{ title: string; body: string; labels: string[]; assignees: string[]; kanbanColumn: KanbanColumn; status: IssueStatus }>;
      if (body.status === 'closed') {
        await issueSvc.closeIssue(issue.id);
      } else if (body.status === 'open') {
        await issueSvc.reopenIssue(issue.id);
      }
      const { status: _s, ...updates } = body;
      await issueSvc.updateIssue(issue.id, updates);
      return json({ ok: true }, 200, corsHeaders);
    }

    // POST /api/repos/:id/issues/:num/comments
    const issueCommentsMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/issues\/(\d+)\/comments$/);
    if (issueCommentsMatch && method === 'POST') {
      requireAuth(auth);
      const issue = await issueSvc.getIssueByNumber(issueCommentsMatch[1], parseInt(issueCommentsMatch[2], 10));
      if (!issue) return json({ error: 'Issue not found' }, 404, corsHeaders);
      const body = await request.json() as { body: string };
      const comment = await issueSvc.addComment(issue.id, auth!.userId, auth!.userName, body.body);
      return json(comment, 201, corsHeaders);
    }

    // ==================== Releases ====================

    // GET /api/repos/:id/releases
    const releasesMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/releases$/);
    if (releasesMatch && method === 'GET') {
      const repoId = releasesMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const url = new URL(request.url);
      const channel = url.searchParams.get('channel') as ReleaseChannel | null;
      const releases = await releaseSvc.getReleases(repoId, channel || undefined);
      return json(releases, 200, corsHeaders);
    }

    // POST /api/repos/:id/releases
    if (releasesMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { tagName: string; title: string; body?: string; commitId: string; autoNotes?: boolean; channel?: ReleaseChannel };
      let releaseBody = body.body || '';
      if (body.autoNotes) {
        releaseBody = await releaseSvc.generateReleaseNotes(releasesMatch[1]);
      }
      const release = await releaseSvc.createRelease(
        releasesMatch[1], body.tagName, body.title, releaseBody,
        body.commitId, auth!.userId, body.channel || 'stable'
      );
      await permSvc.audit(releasesMatch[1], auth!.userId, auth!.userName, 'release.create', {
        tagName: body.tagName, channel: release.channel,
      });
      return json(release, 201, corsHeaders);
    }

    // ==================== Settings ====================

    // GET /api/repos/:id/settings
    const settingsMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/settings$/);
    if (settingsMatch && method === 'GET') {
      const repoId = settingsMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const repo = await db.prepare('SELECT settings_json FROM deck_repos WHERE id = ?')
        .bind(repoId).first<{ settings_json: string }>();
      if (!repo) return json({ error: 'Repo not found' }, 404, corsHeaders);
      return json(JSON.parse(repo.settings_json || '{}'), 200, corsHeaders);
    }

    // PATCH /api/repos/:id/settings
    if (settingsMatch && method === 'PATCH') {
      requireAuth(auth);
      await permSvc.requirePermission(settingsMatch[1], auth!.userId, 'canManageSettings');
      const body = await request.json() as RepoSettings;
      await db.prepare('UPDATE deck_repos SET settings_json = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(body), now(), settingsMatch[1]).run();
      return json({ ok: true }, 200, corsHeaders);
    }

    // ==================== Webhooks (8B) ====================

    // GET /api/repos/:id/webhooks
    const webhooksMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/webhooks$/);
    if (webhooksMatch && method === 'GET') {
      requireAuth(auth);
      const repoId = webhooksMatch[1];
      await permSvc.requirePermission(repoId, auth!.userId, 'canRead');
      const hooks = await webhookSvc.listWebhooks(repoId);
      return json(hooks, 200, corsHeaders);
    }

    // POST /api/repos/:id/webhooks
    if (webhooksMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { url: string; events: string[]; secret?: string };
      const hook = await webhookSvc.createWebhook(webhooksMatch[1], body.url, body.events, body.secret);
      return json(hook, 201, corsHeaders);
    }

    // DELETE /api/repos/:id/webhooks/:hid
    const webhookDeleteMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/webhooks\/([a-z0-9-]+)$/);
    if (webhookDeleteMatch && method === 'DELETE') {
      requireAuth(auth);
      await webhookSvc.deleteWebhook(webhookDeleteMatch[2]);
      return json({ ok: true }, 200, corsHeaders);
    }

    // ==================== Watch Rules (8C) ====================

    // GET /api/repos/:id/watch
    const watchMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/watch$/);
    if (watchMatch && method === 'GET') {
      requireAuth(auth);
      const repoId = watchMatch[1];
      await permSvc.requirePermission(repoId, auth!.userId, 'canRead');
      const rule = await watchSvc.getWatchRule(auth!.userId, repoId);
      return json(rule || { events: [], active: false }, 200, corsHeaders);
    }

    // POST /api/repos/:id/watch
    if (watchMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { events: string[] };
      const rule = await watchSvc.setWatchRule(auth!.userId, watchMatch[1], body.events);
      return json(rule, 200, corsHeaders);
    }

    // ==================== Auto-Bisect (8A) ====================

    // POST /api/repos/:id/bisect/start
    const bisectStartMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/bisect\/start$/);
    if (bisectStartMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { goodCommitId: string; badCommitId: string };
      const session = await bisectSvc.startBisect(bisectStartMatch[1], body.goodCommitId, body.badCommitId);
      return json(session, 201, corsHeaders);
    }

    // POST /api/repos/:id/bisect/:sid/report
    const bisectReportMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/bisect\/([a-z0-9-]+)\/report$/);
    if (bisectReportMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { commitId: string; isGood: boolean };
      const session = await bisectSvc.reportResult(bisectReportMatch[2], body.commitId, body.isGood);
      return json(session, 200, corsHeaders);
    }

    // ==================== Collaborators ====================

    // GET /api/repos/:id/collaborators
    const collabsMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/collaborators$/);
    if (collabsMatch && method === 'GET') {
      const repoId = collabsMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const collabs = await permSvc.getCollaborators(repoId);
      return json(collabs, 200, corsHeaders);
    }

    // POST /api/repos/:id/collaborators
    if (collabsMatch && method === 'POST') {
      requireAuth(auth);
      await permSvc.requirePermission(collabsMatch[1], auth!.userId, 'canManageCollaborators');
      const body = await request.json() as { userId: string; role: string };
      await permSvc.setRole(collabsMatch[1], body.userId, body.role as any, auth!.userId);
      await permSvc.audit(collabsMatch[1], auth!.userId, auth!.userName, 'collaborator.add', {
        userId: body.userId, role: body.role,
      });
      return json({ ok: true }, 201, corsHeaders);
    }

    // DELETE /api/repos/:id/collaborators/:uid
    const collabMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/collaborators\/([a-z0-9-]+)$/);
    if (collabMatch && method === 'DELETE') {
      requireAuth(auth);
      await permSvc.requirePermission(collabMatch[1], auth!.userId, 'canManageCollaborators');
      await permSvc.removeCollaborator(collabMatch[1], collabMatch[2]);
      await permSvc.audit(collabMatch[1], auth!.userId, auth!.userName, 'collaborator.remove', {
        userId: collabMatch[2],
      });
      return json({ ok: true }, 200, corsHeaders);
    }

    // ==================== Audit Log ====================

    // GET /api/repos/:id/audit-log
    const auditMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/audit-log$/);
    if (auditMatch && method === 'GET') {
      const repoId = auditMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const entries = await permSvc.getAuditLog(repoId, limit, offset);
      return json(entries, 200, corsHeaders);
    }

    // ==================== Conflict Resolution ====================

    // POST /api/repos/:id/pulls/:num/resolve
    const resolveMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/resolve$/);
    if (resolveMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(resolveMatch[1], parseInt(resolveMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const body = await request.json() as { resolutions: ConflictResolution[]; message?: string };
      const commit = await mergeSvc.resolveAndMerge(
        pr.repoId, pr.targetBranchId, pr.sourceBranchId,
        body.resolutions, auth!.userId, auth!.userName,
        body.message || `Resolve conflicts for PR #${pr.number}`
      );
      return json(commit, 200, corsHeaders);
    }

    // ==================== Sync from Upstream ====================

    // POST /api/repos/:id/sync
    const syncMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/sync$/);
    if (syncMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { branchName: string };
      const result = await forkSvc.syncFromUpstream(syncMatch[1], body.branchName, auth!.userId, auth!.userName);
      return json(result, 200, corsHeaders);
    }

    // ==================== Blame ====================

    // GET /api/repos/:id/branches/:bid/blame?card=NAME
    // GET /api/repos/:id/branches/:bid/blame?board=mainboard
    const blameMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/branches\/([a-z0-9-]+)\/blame$/);
    if (blameMatch && method === 'GET') {
      const url = new URL(request.url);
      const card = url.searchParams.get('card');
      const board = url.searchParams.get('board');
      if (card) {
        const blame = await blameSvc.getCardBlame(blameMatch[1], blameMatch[2], card);
        if (!blame) return json({ error: 'No blame data found' }, 404, corsHeaders);
        return json(blame, 200, corsHeaders);
      } else if (board) {
        const blameEntries = await blameSvc.getBoardBlame(blameMatch[1], blameMatch[2], board as any);
        return json(blameEntries, 200, corsHeaders);
      }
      return json({ error: 'Specify ?card=NAME or ?board=BOARD' }, 400, corsHeaders);
    }

    // ==================== Revert PR ====================

    // POST /api/repos/:id/pulls/:num/revert — Create a revert PR for a merged PR
    const revertPRMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/revert$/);
    if (revertPRMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(revertPRMatch[1], parseInt(revertPRMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      if (pr.status !== 'merged') return json({ error: 'Can only revert merged PRs' }, 400, corsHeaders);

      // Get the diff and invert it
      const diff = await prSvc.getDiff(pr.id);
      const inversePatch = commitSvc.invertPatch(diff);

      // Create a new branch for the revert
      const revertBranchName = `revert-pr-${pr.number}`;
      const targetBranch = await branchSvc.getBranch(pr.targetBranchId);
      if (!targetBranch) return json({ error: 'Target branch not found' }, 404, corsHeaders);

      const revertBranch = await branchSvc.createBranch(pr.repoId, revertBranchName, pr.targetBranchId, auth!.userId);

      // Apply inverse patch on the revert branch
      if (targetBranch.headCommitId) {
        const currentState = await commitSvc.getStateAtCommit(targetBranch.headCommitId);
        const revertedState = commitSvc.applyPatch(currentState, inversePatch);
        await commitSvc.createCommit(
          pr.repoId, revertBranch.id, auth!.userId, auth!.userName,
          `Revert "PR #${pr.number}: ${pr.title}"`, revertedState
        );
      }

      // Open a new PR for the revert
      const revertPR = await prSvc.openPR(
        pr.repoId,
        `Revert "PR #${pr.number}: ${pr.title}"`,
        `This reverts the changes from PR #${pr.number}.\n\nOriginal PR: ${pr.title}`,
        revertBranch.id, pr.targetBranchId,
        auth!.userId, auth!.userName
      );

      return json({ pr: revertPR }, 201, corsHeaders);
    }

    // ==================== Cherry-pick ====================

    // POST /api/repos/:id/commits/:cid/cherry-pick
    const cherryPickMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/commits\/([a-z0-9-]+)\/cherry-pick$/);
    if (cherryPickMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { targetBranchId: string };
      const sourceCommit = await commitSvc.getCommit(cherryPickMatch[2]);
      if (!sourceCommit) return json({ error: 'Commit not found' }, 404, corsHeaders);

      const targetBranch = await branchSvc.getBranch(body.targetBranchId);
      if (!targetBranch?.headCommitId) return json({ error: 'Target branch not found or empty' }, 404, corsHeaders);

      // Get target state and apply source patch
      const targetState = await commitSvc.getStateAtCommit(targetBranch.headCommitId);
      const conflicts: Array<{ board: string; cardName: string; reason: string }> = [];

      // Validate patch applicability
      for (const op of sourceCommit.patch) {
        if (op.op === 'remove_card') {
          const exists = targetState.boards[op.board]?.some(c => c.name === op.name);
          if (!exists) {
            conflicts.push({ board: op.board, cardName: op.name, reason: 'Card not found in target' });
          }
        }
      }

      if (conflicts.length > 0) {
        return json({ commit: null, conflicts }, 409, corsHeaders);
      }

      const cherryState = commitSvc.applyPatch(targetState, sourceCommit.patch);
      const cherryCommit = await commitSvc.createCommit(
        cherryPickMatch[1], body.targetBranchId,
        auth!.userId, auth!.userName,
        `Cherry-pick: ${sourceCommit.message}`, cherryState
      );

      return json({ commit: cherryCommit, conflicts: [] }, 201, corsHeaders);
    }

    // ==================== Golden Deck State ====================

    // POST /api/repos/:id/settings/golden — Set golden commit
    const goldenSetMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/settings\/golden$/);
    if (goldenSetMatch && method === 'POST') {
      requireAuth(auth);
      await permSvc.requirePermission(goldenSetMatch[1], auth!.userId, 'canManageSettings');
      const body = await request.json() as { commitId: string | null };

      const repo = await db.prepare('SELECT settings_json FROM deck_repos WHERE id = ?')
        .bind(goldenSetMatch[1]).first<{ settings_json: string }>();
      const settings: RepoSettings & { goldenCommitId?: string | null } = JSON.parse(repo?.settings_json || '{}');
      settings.goldenCommitId = body.commitId;

      await db.prepare('UPDATE deck_repos SET settings_json = ?, updated_at = ? WHERE id = ?')
        .bind(JSON.stringify(settings), now(), goldenSetMatch[1]).run();

      return json({ ok: true, goldenCommitId: body.commitId }, 200, corsHeaders);
    }

    // GET /api/repos/:id/settings/golden — Get golden state + drift
    if (goldenSetMatch && method === 'GET') {
      const repo = await db.prepare('SELECT settings_json, default_branch FROM deck_repos WHERE id = ?')
        .bind(goldenSetMatch[1]).first<{ settings_json: string; default_branch: string }>();
      if (!repo) return json({ error: 'Repo not found' }, 404, corsHeaders);

      const settings: RepoSettings & { goldenCommitId?: string | null } = JSON.parse(repo.settings_json || '{}');
      if (!settings.goldenCommitId) return json({ goldenCommitId: null, drift: null }, 200, corsHeaders);

      // Compute drift from golden to current default branch HEAD
      const branches = await branchSvc.getBranches(goldenSetMatch[1]);
      const defaultBranch = branches.find(b => b.name === repo.default_branch);
      if (!defaultBranch?.headCommitId) {
        return json({ goldenCommitId: settings.goldenCommitId, drift: null }, 200, corsHeaders);
      }

      const goldenState = await commitSvc.getStateAtCommit(settings.goldenCommitId);
      const currentState = await commitSvc.getStateAtCommit(defaultBranch.headCommitId);
      const driftPatch = commitSvc.computePatch(goldenState, currentState);
      const added = driftPatch.filter(p => p.op === 'add_card').length;
      const removed = driftPatch.filter(p => p.op === 'remove_card').length;
      const totalGolden = Object.values(goldenState.boards).reduce((s, b) => s + b.length, 0);
      const driftPercent = totalGolden > 0 ? Math.round(((added + removed) / totalGolden) * 100) : 0;

      return json({
        goldenCommitId: settings.goldenCommitId,
        drift: { added, removed, totalChanges: driftPatch.length, driftPercent },
      }, 200, corsHeaders);
    }

    // ==================== Verified Merges ====================

    // POST /api/repos/:id/pulls/:num/verify — Verify a merged PR
    const verifyPRMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/verify$/);
    if (verifyPRMatch && method === 'POST') {
      requireAuth(auth);
      await permSvc.requirePermission(verifyPRMatch[1], auth!.userId, 'canManageSettings');
      const pr = await prSvc.getPR(verifyPRMatch[1], parseInt(verifyPRMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      if (pr.status !== 'merged') return json({ error: 'Only merged PRs can be verified' }, 400, corsHeaders);

      await db.prepare('UPDATE deck_pull_requests SET verified = 1, verified_by = ?, updated_at = ? WHERE id = ?')
        .bind(auth!.userName, now(), pr.id).run();
      await permSvc.audit(verifyPRMatch[1], auth!.userId, auth!.userName, 'pr.verify', { prNumber: pr.number });
      return json({ ok: true, verified: true, verifiedBy: auth!.userName }, 200, corsHeaders);
    }

    // POST /api/repos/:id/releases/:tag/verify — Verify a release
    const verifyReleaseMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/releases\/([^/]+)\/verify$/);
    if (verifyReleaseMatch && method === 'POST') {
      requireAuth(auth);
      await permSvc.requirePermission(verifyReleaseMatch[1], auth!.userId, 'canManageSettings');
      const release = await releaseSvc.getRelease(verifyReleaseMatch[1], decodeURIComponent(verifyReleaseMatch[2]));
      if (!release) return json({ error: 'Release not found' }, 404, corsHeaders);

      await db.prepare('UPDATE repo_releases SET verified = 1, verified_by = ? WHERE id = ?')
        .bind(auth!.userName, release.id).run();
      await permSvc.audit(verifyReleaseMatch[1], auth!.userId, auth!.userName, 'release.verify', { tagName: release.tagName });
      return json({ ok: true, verified: true, verifiedBy: auth!.userName }, 200, corsHeaders);
    }

    // ==================== Lock/Unlock Conversation ====================

    // POST /api/repos/:id/pulls/:num/lock — Lock PR conversation
    const lockPRMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/lock$/);
    if (lockPRMatch && method === 'POST') {
      requireAuth(auth);
      await permSvc.requirePermission(lockPRMatch[1], auth!.userId, 'canManageSettings');
      const pr = await prSvc.getPR(lockPRMatch[1], parseInt(lockPRMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const body = await request.json() as { locked: boolean };

      await db.prepare('UPDATE deck_pull_requests SET locked = ? WHERE id = ?')
        .bind(body.locked ? 1 : 0, pr.id).run();
      await permSvc.audit(lockPRMatch[1], auth!.userId, auth!.userName,
        body.locked ? 'pr.lock' : 'pr.unlock', { prNumber: pr.number });
      return json({ ok: true, locked: body.locked }, 200, corsHeaders);
    }

    // ==================== Report/Hide Comment ====================

    // POST /api/repos/:id/pulls/:num/comments/:cid/report — Report a comment
    const reportCommentMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/comments\/([a-z0-9-]+)\/report$/);
    if (reportCommentMatch && method === 'POST') {
      requireAuth(auth);

      // Increment report count; auto-hide after 3 reports
      const comment = await db.prepare('SELECT id, report_count, hidden FROM pr_comments WHERE id = ?')
        .bind(reportCommentMatch[3]).first<{ id: string; report_count: number; hidden: number }>();
      if (!comment) return json({ error: 'Comment not found' }, 404, corsHeaders);

      const newCount = (comment.report_count || 0) + 1;
      const shouldHide = newCount >= 3;

      await db.prepare('UPDATE pr_comments SET report_count = ?, hidden = ? WHERE id = ?')
        .bind(newCount, shouldHide ? 1 : 0, comment.id).run();

      if (shouldHide) {
        // Add system notice
        const pr = await prSvc.getPR(reportCommentMatch[1], parseInt(reportCommentMatch[2], 10));
        if (pr) {
          await prSvc.addComment(pr.id, 'system', 'DeckHub Bot',
            `\u{26A0}\u{FE0F} A comment was hidden due to multiple reports.`);
        }
      }

      return json({ ok: true, reportCount: newCount, hidden: shouldHide }, 200, corsHeaders);
    }

    // ==================== Contribution Guidelines ====================

    // GET /api/repos/:id/settings/guidelines
    const guidelinesMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/settings\/guidelines$/);
    if (guidelinesMatch && method === 'GET') {
      const repoId = guidelinesMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const repo = await db.prepare('SELECT settings_json FROM deck_repos WHERE id = ?')
        .bind(repoId).first<{ settings_json: string }>();
      if (!repo) return json({ error: 'Repo not found' }, 404, corsHeaders);
      const settings: RepoSettings = JSON.parse(repo.settings_json || '{}');
      return json({
        guidelines: settings.contributionGuidelines || '',
        prTemplate: settings.prTemplate || '',
      }, 200, corsHeaders);
    }

    // ==================== Meta Branch Generator ====================

    // POST /api/repos/:id/workflows/meta-branch
    const metaBranchMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/workflows\/meta-branch$/);
    if (metaBranchMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { name?: string; format?: string };
      const repoIdLocal = metaBranchMatch[1];
      const branchName = body.name || `meta-tune/${new Date().toISOString().slice(0, 10)}`;

      // Get default branch to fork from
      const repo = await db.prepare('SELECT default_branch FROM deck_repos WHERE id = ?')
        .bind(repoIdLocal).first<{ default_branch: string }>();
      const branches = await branchSvc.getBranches(repoIdLocal);
      const defaultBranch = branches.find(b => b.name === repo?.default_branch) || branches[0];
      if (!defaultBranch) return json({ error: 'No branches found' }, 400, corsHeaders);

      // Create meta branch
      const branch = await branchSvc.createBranch(repoIdLocal, branchName, defaultBranch.id, auth!.userId);

      // Create template issues based on format
      const format = body.format || 'edh';
      const issueTemplates = format === 'edh'
        ? ['Review manabase for consistency', 'Verify removal/interaction density', 'Sideboard plan review', 'Matchup testing results']
        : ['Sideboard plan for current meta', 'Manabase & curve review', 'Matchup testing results'];

      const issues = [];
      for (const title of issueTemplates) {
        const issue = await issueSvc.createIssue(
          repoIdLocal, title,
          `Auto-created for meta-tune branch \`${branchName}\``,
          auth!.userId, auth!.userName,
          ['meta-tune']
        );
        issues.push(issue);
      }

      await permSvc.audit(repoIdLocal, auth!.userId, auth!.userName, 'branch.create', {
        branchName, workflow: 'meta-branch', issues: issues.length,
      });

      return json({ branch, issues }, 201, corsHeaders);
    }

    // ==================== PR Stack ====================

    // POST /api/repos/:id/pulls/:num/stack — Set parent PR
    const setStackMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/pulls\/(\d+)\/stack$/);
    if (setStackMatch && method === 'POST') {
      requireAuth(auth);
      const pr = await prSvc.getPR(setStackMatch[1], parseInt(setStackMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);
      const body = await request.json() as { parentPrNumber: number | null };

      let parentPrId: string | null = null;
      if (body.parentPrNumber !== null) {
        const parentPr = await prSvc.getPR(setStackMatch[1], body.parentPrNumber);
        if (!parentPr) return json({ error: 'Parent PR not found' }, 404, corsHeaders);
        parentPrId = parentPr.id;
      }

      await db.prepare('UPDATE deck_pull_requests SET parent_pr_id = ?, updated_at = ? WHERE id = ?')
        .bind(parentPrId, now(), pr.id).run();

      return json({ ok: true, parentPrId }, 200, corsHeaders);
    }

    // GET /api/repos/:id/pulls/:num/stack — Get PR stack chain
    if (setStackMatch && method === 'GET') {
      const repoId = setStackMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const pr = await prSvc.getPR(repoId, parseInt(setStackMatch[2], 10));
      if (!pr) return json({ error: 'PR not found' }, 404, corsHeaders);

      // Walk up to find root
      const stack: Array<{ id: string; number: number; title: string; status: string; parentPrId: string | null }> = [];
      const allPRs = await prSvc.listPRs(setStackMatch[1]);
      const prMap = new Map(allPRs.map(p => [p.id, p]));

      // Walk up from current PR
      let current = pr;
      const ancestors: typeof stack = [];
      while (current.parentPrId) {
        const parent = prMap.get(current.parentPrId);
        if (!parent) break;
        ancestors.unshift({ id: parent.id, number: parent.number, title: parent.title, status: parent.status, parentPrId: parent.parentPrId });
        current = parent;
      }

      // Add current PR
      const currentEntry = { id: pr.id, number: pr.number, title: pr.title, status: pr.status, parentPrId: pr.parentPrId };

      // Find children
      const children: typeof stack = [];
      const findChildren = (parentId: string) => {
        for (const p of allPRs) {
          if (p.parentPrId === parentId) {
            children.push({ id: p.id, number: p.number, title: p.title, status: p.status, parentPrId: p.parentPrId });
            findChildren(p.id);
          }
        }
      };
      findChildren(pr.id);

      stack.push(...ancestors, currentEntry, ...children);

      return json({ stack, currentIndex: ancestors.length }, 200, corsHeaders);
    }

    // ==================== Activity Feed ====================

    // GET /api/repos/:id/activity — Get repo activity feed
    const activityMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/activity$/);
    if (activityMatch && method === 'GET') {
      const repoId = activityMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const feed = await activitySvc.getFeed(repoId, limit, offset);
      return json(feed, 200, corsHeaders);
    }

    // GET /api/repos/:id/activity/stats — Get activity stats
    const activityStatsMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/activity\/stats$/);
    if (activityStatsMatch && method === 'GET') {
      const repoId = activityStatsMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const stats = await activitySvc.getStats(repoId);
      return json(stats, 200, corsHeaders);
    }

    // ==================== Deck Health ====================

    // GET /api/repos/:id/branches/:bid/health — Get health for branch
    const healthMatch = path.match(/^\/api\/repos\/([a-z0-9-]+)\/branches\/([a-z0-9-]+)\/health$/);
    if (healthMatch && method === 'GET') {
      const repoId = healthMatch[1];
      await permSvc.requirePermission(repoId, auth?.userId || null, 'canRead');
      const snapshot = await healthSvc.getLatestSnapshot(healthMatch[2]);
      if (!snapshot) return json({ error: 'No health snapshot found' }, 404, corsHeaders);
      return json(snapshot.health, 200, corsHeaders);
    }

    // POST /api/repos/:id/branches/:bid/health — Analyze and save health snapshot
    if (healthMatch && method === 'POST') {
      requireAuth(auth);
      const body = await request.json() as { state: DeckState };
      const branch = await branchSvc.getBranch(healthMatch[2]);
      if (!branch?.headCommitId) return json({ error: 'Branch has no commits' }, 400, corsHeaders);
      const state = await commitSvc.getStateAtCommit(branch.headCommitId);
      const snapshot = await healthSvc.saveSnapshot(
        healthMatch[1], healthMatch[2], branch.headCommitId, body.state
      );
      return json(snapshot, 201, corsHeaders);
    }

    // Not a deck-git route
    return null;

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    const status = msg.includes('Access denied') ? 403
      : msg.includes('not found') ? 404
      : msg.includes('already exists') ? 409
      : 400;
    return json({ error: msg }, status, corsHeaders);
  }
}

// ==================== Helpers ====================

function json(data: unknown, status: number, corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function requireAuth(auth: AuthInfo | null): asserts auth is AuthInfo {
  if (!auth) throw new Error('Authentication required');
}
