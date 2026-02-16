// ============================================================
// ForkService — Deck repo forking system
// ============================================================
// Fork a repo, sync from upstream, and track fork relationships.
// ============================================================

import {
  type Repo,
  type RepoSettings,
  generateId,
  now,
} from './types.js';
import { CommitService } from './commit-service.js';
import { BranchService } from './branch-service.js';
import { MergeService } from './merge-service.js';

export class ForkService {
  constructor(
    private db: D1Database,
    private commitSvc: CommitService,
    private branchSvc: BranchService,
    private mergeSvc: MergeService
  ) {}

  // ==================== Fork ====================

  /**
   * Fork a repo: create a new repo with the same branches and commits.
   */
  async forkRepo(
    sourceRepoId: string,
    newOwnerId: string,
    newOwnerName: string,
    newName?: string
  ): Promise<Repo> {
    // Get source repo
    const sourceRepo = await this.db
      .prepare('SELECT * FROM deck_repos WHERE id = ?')
      .bind(sourceRepoId)
      .first<{
        id: string;
        name: string;
        description: string;
        format: string;
        default_branch: string;
        settings_json: string;
      }>();

    if (!sourceRepo) throw new Error('Source repo not found');

    const forkId = generateId();
    const forkName = newName || `${sourceRepo.name} (fork)`;
    const createdAt = now();

    // Create fork repo
    await this.db
      .prepare(`
        INSERT INTO deck_repos
        (id, name, description, owner_id, visibility, format, default_branch,
         upstream_repo_id, fork_count, star_count, settings_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'private', ?, ?, ?, 0, 0, ?, ?, ?)
      `)
      .bind(
        forkId,
        forkName,
        `Fork of ${sourceRepo.name}`,
        newOwnerId,
        sourceRepo.format,
        sourceRepo.default_branch,
        sourceRepoId,
        sourceRepo.settings_json || '{}',
        createdAt,
        createdAt
      )
      .run();

    // Increment fork count on source
    await this.db
      .prepare('UPDATE deck_repos SET fork_count = fork_count + 1 WHERE id = ?')
      .bind(sourceRepoId)
      .run();

    // Copy branches and their HEAD commits
    const sourceBranches = await this.branchSvc.getBranches(sourceRepoId);

    for (const branch of sourceBranches) {
      const newBranchId = generateId();
      await this.db
        .prepare(`
          INSERT INTO repo_branches (id, repo_id, name, head_commit_id, base_branch_id, is_protected, created_by, created_at)
          VALUES (?, ?, ?, ?, NULL, 0, ?, ?)
        `)
        .bind(newBranchId, forkId, branch.name, branch.headCommitId, newOwnerId, createdAt)
        .run();

      // Copy commits for this branch
      if (branch.headCommitId) {
        await this.copyCommitChain(branch.headCommitId, forkId);
      }
    }

    // Add owner as collaborator
    await this.db
      .prepare(`
        INSERT INTO repo_collaborators (repo_id, user_id, role, invited_by, created_at)
        VALUES (?, ?, 'OWNER', NULL, ?)
      `)
      .bind(forkId, newOwnerId, createdAt)
      .run();

    const settings: RepoSettings = JSON.parse(sourceRepo.settings_json || '{}');

    return {
      id: forkId,
      name: forkName,
      description: `Fork of ${sourceRepo.name}`,
      ownerId: newOwnerId,
      visibility: 'private',
      format: sourceRepo.format,
      defaultBranch: sourceRepo.default_branch,
      upstreamRepoId: sourceRepoId,
      forkCount: 0,
      starCount: 0,
      settingsJson: settings,
      createdAt,
      updatedAt: createdAt,
    };
  }

  // ==================== Sync from Upstream ====================

  /**
   * Sync a fork's branch with the upstream branch.
   * Performs a merge from upstream HEAD into fork's branch.
   */
  async syncFromUpstream(
    forkRepoId: string,
    branchName: string,
    userId: string,
    userName: string
  ): Promise<{ success: boolean; message: string }> {
    // Get fork repo to find upstream
    const forkRepo = await this.db
      .prepare('SELECT upstream_repo_id FROM deck_repos WHERE id = ?')
      .bind(forkRepoId)
      .first<{ upstream_repo_id: string | null }>();

    if (!forkRepo?.upstream_repo_id) {
      throw new Error('This repo is not a fork');
    }

    // Get upstream branch
    const upstreamBranch = await this.branchSvc.getBranchByName(forkRepo.upstream_repo_id, branchName);
    if (!upstreamBranch?.headCommitId) {
      throw new Error(`Upstream branch "${branchName}" not found or empty`);
    }

    // Get fork branch
    const forkBranch = await this.branchSvc.getBranchByName(forkRepoId, branchName);
    if (!forkBranch?.headCommitId) {
      throw new Error(`Fork branch "${branchName}" not found or empty`);
    }

    // Check if already up to date
    if (forkBranch.headCommitId === upstreamBranch.headCommitId) {
      return { success: true, message: 'Already up to date' };
    }

    // Get states
    const upstreamState = await this.commitSvc.getStateAtCommit(upstreamBranch.headCommitId);
    const forkState = await this.commitSvc.getStateAtCommit(forkBranch.headCommitId);

    // Compute patch from fork to upstream
    const patch = this.commitSvc.computePatch(forkState, upstreamState);

    if (patch.length === 0) {
      return { success: true, message: 'Already up to date (no changes)' };
    }

    // Copy upstream commits that the fork doesn't have
    await this.copyCommitChain(upstreamBranch.headCommitId, forkRepoId);

    // Create a merge commit on the fork branch
    await this.commitSvc.createMergeCommit(
      forkRepoId,
      forkBranch.id,
      forkBranch.headCommitId,
      upstreamBranch.headCommitId,
      userId,
      userName,
      `Sync from upstream: ${branchName}`,
      upstreamState,
      patch
    );

    return { success: true, message: `Synced ${patch.length} change(s) from upstream` };
  }

  // ==================== Queries ====================

  /**
   * List all forks of a repo.
   */
  async listForks(repoId: string): Promise<Repo[]> {
    const rows = await this.db
      .prepare('SELECT * FROM deck_repos WHERE upstream_repo_id = ? ORDER BY created_at DESC')
      .bind(repoId)
      .all();

    return (rows.results || []).map(this.rowToRepo);
  }

  /**
   * Check if a repo is a fork.
   */
  async isFork(repoId: string): Promise<boolean> {
    const repo = await this.db
      .prepare('SELECT upstream_repo_id FROM deck_repos WHERE id = ?')
      .bind(repoId)
      .first<{ upstream_repo_id: string | null }>();

    return !!repo?.upstream_repo_id;
  }

  // ==================== Helpers ====================

  /**
   * Copy a commit chain to a new repo (for forking).
   * Only copies commits that don't already exist (by ID).
   */
  private async copyCommitChain(headCommitId: string, targetRepoId: string): Promise<void> {
    const visited = new Set<string>();
    const queue = [headCommitId];

    while (queue.length > 0) {
      const commitId = queue.shift()!;
      if (visited.has(commitId)) continue;
      visited.add(commitId);

      // Check if commit already exists in target repo
      const existing = await this.db
        .prepare('SELECT id FROM deck_commits WHERE id = ? AND repo_id = ?')
        .bind(commitId, targetRepoId)
        .first();

      if (existing) continue;

      // Get the commit from source
      const commit = await this.db
        .prepare('SELECT * FROM deck_commits WHERE id = ?')
        .bind(commitId)
        .first<{
          id: string;
          parent_id: string | null;
          parent2_id: string | null;
          author_id: string;
          author_name: string;
          message: string;
          patch_json: string;
          boards_snapshot: string | null;
          created_at: string;
        }>();

      if (!commit) continue;

      // Insert copy with new repo_id
      await this.db
        .prepare(`
          INSERT OR IGNORE INTO deck_commits
          (id, repo_id, parent_id, parent2_id, author_id, author_name, message, patch_json, boards_snapshot, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          commit.id, targetRepoId,
          commit.parent_id, commit.parent2_id,
          commit.author_id, commit.author_name,
          commit.message, commit.patch_json,
          commit.boards_snapshot, commit.created_at
        )
        .run();

      // Queue parents
      if (commit.parent_id) queue.push(commit.parent_id);
      if (commit.parent2_id) queue.push(commit.parent2_id);
    }
  }

  private rowToRepo(row: Record<string, unknown>): Repo {
    return {
      id: row.id as string,
      name: row.name as string,
      description: (row.description as string) || '',
      ownerId: row.owner_id as string,
      visibility: (row.visibility as Repo['visibility']) || 'private',
      format: (row.format as string) || 'commander',
      defaultBranch: (row.default_branch as string) || 'main',
      upstreamRepoId: (row.upstream_repo_id as string) || null,
      forkCount: (row.fork_count as number) || 0,
      starCount: (row.star_count as number) || 0,
      settingsJson: JSON.parse((row.settings_json as string) || '{}'),
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
