// ============================================================
// BranchService — Branch management for deck repos
// ============================================================
// CRUD operations for branches, HEAD pointer management,
// and merge-base finding for 3-way merge.
// ============================================================

import { type Branch, generateId, now } from './types.js';

export class BranchService {
  constructor(private db: D1Database) {}

  // ==================== CRUD ====================

  /**
   * Create a new branch, optionally from an existing branch's HEAD.
   */
  async createBranch(
    repoId: string,
    name: string,
    fromBranchId: string | null,
    createdBy: string
  ): Promise<Branch> {
    // Validate branch name
    if (!this.isValidBranchName(name)) {
      throw new Error(`Invalid branch name: "${name}". Use alphanumeric, hyphens, underscores, and slashes.`);
    }

    // Check for duplicate
    const existing = await this.db
      .prepare('SELECT id FROM repo_branches WHERE repo_id = ? AND name = ?')
      .bind(repoId, name)
      .first();

    if (existing) {
      throw new Error(`Branch "${name}" already exists in this repo`);
    }

    // Get HEAD from source branch if specified
    let headCommitId: string | null = null;
    if (fromBranchId) {
      const sourceBranch = await this.db
        .prepare('SELECT head_commit_id FROM repo_branches WHERE id = ? AND repo_id = ?')
        .bind(fromBranchId, repoId)
        .first<{ head_commit_id: string | null }>();

      if (!sourceBranch) throw new Error(`Source branch ${fromBranchId} not found`);
      headCommitId = sourceBranch.head_commit_id;
    }

    const branchId = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO repo_branches (id, repo_id, name, head_commit_id, base_branch_id, is_protected, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `)
      .bind(branchId, repoId, name, headCommitId, fromBranchId, createdBy, createdAt)
      .run();

    return {
      id: branchId,
      repoId,
      name,
      headCommitId,
      baseBranchId: fromBranchId,
      isProtected: false,
      createdBy,
      createdAt,
    };
  }

  /**
   * Delete a branch (cannot delete protected branches).
   */
  async deleteBranch(repoId: string, branchId: string): Promise<void> {
    const branch = await this.getBranch(branchId);
    if (!branch) throw new Error(`Branch ${branchId} not found`);
    if (branch.repoId !== repoId) throw new Error('Branch does not belong to this repo');
    if (branch.isProtected) throw new Error('Cannot delete a protected branch');

    // Check if this is the default branch
    const repo = await this.db
      .prepare('SELECT default_branch FROM deck_repos WHERE id = ?')
      .bind(repoId)
      .first<{ default_branch: string }>();

    if (repo && repo.default_branch === branch.name) {
      throw new Error('Cannot delete the default branch');
    }

    await this.db
      .prepare('DELETE FROM repo_branches WHERE id = ? AND repo_id = ?')
      .bind(branchId, repoId)
      .run();
  }

  /**
   * Rename a branch.
   */
  async renameBranch(repoId: string, branchId: string, newName: string): Promise<void> {
    if (!this.isValidBranchName(newName)) {
      throw new Error(`Invalid branch name: "${newName}"`);
    }

    // Check for duplicate
    const existing = await this.db
      .prepare('SELECT id FROM repo_branches WHERE repo_id = ? AND name = ? AND id != ?')
      .bind(repoId, newName, branchId)
      .first();

    if (existing) throw new Error(`Branch "${newName}" already exists`);

    await this.db
      .prepare('UPDATE repo_branches SET name = ? WHERE id = ? AND repo_id = ?')
      .bind(newName, branchId, repoId)
      .run();

    // Update default_branch if this was the default
    await this.db
      .prepare(`
        UPDATE deck_repos SET default_branch = ?
        WHERE id = ? AND default_branch = (SELECT name FROM repo_branches WHERE id = ?)
      `)
      .bind(newName, repoId, branchId)
      .run();
  }

  /**
   * Set branch protection status.
   */
  async setProtected(branchId: string, isProtected: boolean): Promise<void> {
    await this.db
      .prepare('UPDATE repo_branches SET is_protected = ? WHERE id = ?')
      .bind(isProtected ? 1 : 0, branchId)
      .run();
  }

  /**
   * Update the HEAD commit pointer of a branch.
   */
  async setHead(branchId: string, commitId: string): Promise<void> {
    await this.db
      .prepare('UPDATE repo_branches SET head_commit_id = ? WHERE id = ?')
      .bind(commitId, branchId)
      .run();
  }

  // ==================== Queries ====================

  /**
   * Get all branches for a repo.
   */
  async getBranches(repoId: string): Promise<Branch[]> {
    const rows = await this.db
      .prepare('SELECT * FROM repo_branches WHERE repo_id = ? ORDER BY created_at ASC')
      .bind(repoId)
      .all<{
        id: string;
        repo_id: string;
        name: string;
        head_commit_id: string | null;
        base_branch_id: string | null;
        is_protected: number;
        created_by: string;
        created_at: string;
      }>();

    return (rows.results || []).map(this.rowToBranch);
  }

  /**
   * Get a single branch by ID.
   */
  async getBranch(branchId: string): Promise<Branch | null> {
    const row = await this.db
      .prepare('SELECT * FROM repo_branches WHERE id = ?')
      .bind(branchId)
      .first<{
        id: string;
        repo_id: string;
        name: string;
        head_commit_id: string | null;
        base_branch_id: string | null;
        is_protected: number;
        created_by: string;
        created_at: string;
      }>();

    return row ? this.rowToBranch(row) : null;
  }

  /**
   * Get a branch by name within a repo.
   */
  async getBranchByName(repoId: string, name: string): Promise<Branch | null> {
    const row = await this.db
      .prepare('SELECT * FROM repo_branches WHERE repo_id = ? AND name = ?')
      .bind(repoId, name)
      .first<{
        id: string;
        repo_id: string;
        name: string;
        head_commit_id: string | null;
        base_branch_id: string | null;
        is_protected: number;
        created_by: string;
        created_at: string;
      }>();

    return row ? this.rowToBranch(row) : null;
  }

  // ==================== Merge Base ====================

  /**
   * Find the common ancestor (merge base) of two branches.
   * Uses a simple two-pointer approach walking up parent chains.
   */
  async findMergeBase(branchAId: string, branchBId: string): Promise<string | null> {
    const branchA = await this.getBranch(branchAId);
    const branchB = await this.getBranch(branchBId);

    if (!branchA?.headCommitId || !branchB?.headCommitId) return null;

    // Collect all ancestors of branch A
    const ancestorsA = new Set<string>();
    let currentA: string | null = branchA.headCommitId;

    while (currentA) {
      ancestorsA.add(currentA);
      const commit = await this.db
        .prepare('SELECT parent_id FROM deck_commits WHERE id = ?')
        .bind(currentA)
        .first<{ parent_id: string | null }>();
      currentA = commit?.parent_id ?? null;
    }

    // Walk branch B's ancestors until we find one in A's set
    let currentB: string | null = branchB.headCommitId;

    while (currentB) {
      if (ancestorsA.has(currentB)) return currentB;
      const commit = await this.db
        .prepare('SELECT parent_id FROM deck_commits WHERE id = ?')
        .bind(currentB)
        .first<{ parent_id: string | null }>();
      currentB = commit?.parent_id ?? null;
    }

    return null;
  }

  // ==================== Helpers ====================

  private isValidBranchName(name: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9_\-/]*$/.test(name) && name.length <= 100;
  }

  private rowToBranch(row: {
    id: string;
    repo_id: string;
    name: string;
    head_commit_id: string | null;
    base_branch_id: string | null;
    is_protected: number;
    created_by: string;
    created_at: string;
  }): Branch {
    return {
      id: row.id,
      repoId: row.repo_id,
      name: row.name,
      headCommitId: row.head_commit_id,
      baseBranchId: row.base_branch_id,
      isProtected: row.is_protected === 1,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }
}
