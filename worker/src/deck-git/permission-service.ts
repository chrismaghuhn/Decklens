// ============================================================
// PermissionService — Roles, AuthZ & Audit for deck repos
// ============================================================
// Manages persistent collaborator roles (OWNER through VIEWER),
// authorization checks, and append-only audit logging.
// ============================================================

import {
  type RepoRole,
  type Collaborator,
  type AuditAction,
  type AuditEntry,
  ROLE_PERMISSIONS,
  generateId,
  now,
} from './types.js';

export class PermissionService {
  constructor(private db: D1Database) {}

  // ==================== Role Management ====================

  /**
   * Get a user's role in a repo. Returns null if not a collaborator.
   * Also checks if the user is the repo owner (always OWNER role).
   */
  async getRole(repoId: string, userId: string | null): Promise<RepoRole | null> {
    // Fetch repo basic info
    const repo = await this.db
      .prepare('SELECT owner_id, visibility FROM deck_repos WHERE id = ?')
      .bind(repoId)
      .first<{ owner_id: string; visibility: string }>();

    if (!repo) return null;

    // Public or Unlisted repos grant VIEWER access to everyone (even if not logged in)
    if (repo.visibility === 'public' || repo.visibility === 'unlisted') {
      // But if they are logged in and actually have a higher role, we should find it
      const baseRole: RepoRole = 'VIEWER';
      if (!userId) return baseRole;

      if (repo.owner_id === userId) return 'OWNER';

      const collab = await this.db
        .prepare('SELECT role FROM repo_collaborators WHERE repo_id = ? AND user_id = ?')
        .bind(repoId, userId)
        .first<{ role: string }>();

      return (collab?.role as RepoRole) || baseRole;
    }

    // Private repo requires being logged in
    if (!userId) return null;

    if (repo.owner_id === userId) return 'OWNER';

    // Check collaborator table
    const collab = await this.db
      .prepare('SELECT role FROM repo_collaborators WHERE repo_id = ? AND user_id = ?')
      .bind(repoId, userId)
      .first<{ role: string }>();

    if (collab) return collab.role as RepoRole;

    return null;
  }

  /**
   * Set a collaborator's role. Creates or updates the entry.
   */
  async setRole(
    repoId: string,
    userId: string,
    role: RepoRole,
    invitedBy: string
  ): Promise<void> {
    if (role === 'OWNER') {
      throw new Error('Cannot assign OWNER role via setRole. Use repo transfer instead.');
    }

    const existing = await this.db
      .prepare('SELECT user_id FROM repo_collaborators WHERE repo_id = ? AND user_id = ?')
      .bind(repoId, userId)
      .first();

    if (existing) {
      await this.db
        .prepare('UPDATE repo_collaborators SET role = ? WHERE repo_id = ? AND user_id = ?')
        .bind(role, repoId, userId)
        .run();
    } else {
      await this.db
        .prepare(`
          INSERT INTO repo_collaborators (repo_id, user_id, role, invited_by, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind(repoId, userId, role, invitedBy, now())
        .run();
    }
  }

  /**
   * Remove a collaborator from a repo.
   */
  async removeCollaborator(repoId: string, userId: string): Promise<void> {
    // Don't allow removing the owner
    const repo = await this.db
      .prepare('SELECT owner_id FROM deck_repos WHERE id = ?')
      .bind(repoId)
      .first<{ owner_id: string }>();

    if (repo?.owner_id === userId) {
      throw new Error('Cannot remove the repo owner');
    }

    await this.db
      .prepare('DELETE FROM repo_collaborators WHERE repo_id = ? AND user_id = ?')
      .bind(repoId, userId)
      .run();
  }

  /**
   * Get all collaborators for a repo.
   */
  async getCollaborators(repoId: string): Promise<Collaborator[]> {
    const rows = await this.db
      .prepare('SELECT * FROM repo_collaborators WHERE repo_id = ? ORDER BY created_at ASC')
      .bind(repoId)
      .all<{
        repo_id: string;
        user_id: string;
        role: string;
        invited_by: string | null;
        created_at: string;
      }>();

    return (rows.results || []).map(row => ({
      repoId: row.repo_id,
      userId: row.user_id,
      role: row.role as RepoRole,
      invitedBy: row.invited_by,
      createdAt: row.created_at,
    }));
  }

  // ==================== Authorization Checks ====================

  /**
   * Check if a user can push (commit) to a branch.
   * Protected branches require MAINTAINER or higher.
   */
  async canPushToBranch(repoId: string, userId: string, branchId: string): Promise<boolean> {
    const role = await this.getRole(repoId, userId);
    if (!role) return false;

    const perms = ROLE_PERMISSIONS[role];
    if (!perms.canPush) return false;

    // Check if branch is protected
    const branch = await this.db
      .prepare('SELECT is_protected FROM repo_branches WHERE id = ?')
      .bind(branchId)
      .first<{ is_protected: number }>();

    if (branch?.is_protected) {
      // Protected branches require merge permission (MAINTAINER+)
      return perms.canMerge;
    }

    return true;
  }

  /**
   * Check if a user can merge PRs.
   */
  async canMergePR(repoId: string, userId: string): Promise<boolean> {
    const role = await this.getRole(repoId, userId);
    if (!role) return false;
    return ROLE_PERMISSIONS[role].canMerge;
  }

  /**
   * Check if a user can change repo settings.
   */
  async canChangeSettings(repoId: string, userId: string): Promise<boolean> {
    const role = await this.getRole(repoId, userId);
    if (!role) return false;
    return ROLE_PERMISSIONS[role].canManageSettings;
  }

  /**
   * Check if a user can manage collaborators.
   */
  async canManageCollaborators(repoId: string, userId: string): Promise<boolean> {
    const role = await this.getRole(repoId, userId);
    if (!role) return false;
    return ROLE_PERMISSIONS[role].canManageCollaborators;
  }

  /**
   * Check if a user can review PRs.
   */
  async canReview(repoId: string, userId: string): Promise<boolean> {
    const role = await this.getRole(repoId, userId);
    if (!role) return false;
    return ROLE_PERMISSIONS[role].canReview;
  }

  /**
   * Check if a user can comment.
   */
  async canComment(repoId: string, userId: string): Promise<boolean> {
    const role = await this.getRole(repoId, userId);
    if (!role) return false;
    return ROLE_PERMISSIONS[role].canComment;
  }

  /**
   * Check if a user can read (view) the repo.
   */
  async canRead(repoId: string, userId: string | null): Promise<boolean> {
    const role = await this.getRole(repoId, userId);
    if (!role) return false;
    return ROLE_PERMISSIONS[role].canRead;
  }

  /**
   * Check if a user can delete the repo.
   */
  async canDelete(repoId: string, userId: string): Promise<boolean> {
    const role = await this.getRole(repoId, userId);
    if (!role) return false;
    return ROLE_PERMISSIONS[role].canDelete;
  }

  /**
   * Require a specific permission, throw if not authorized.
   */
  async requirePermission(
    repoId: string,
    userId: string | null,
    permission: keyof typeof ROLE_PERMISSIONS['OWNER']
  ): Promise<void> {
    const role = await this.getRole(repoId, userId);
    if (!role) throw new Error('Access denied: not authorized to access this repository');
    if (!ROLE_PERMISSIONS[role][permission]) {
      throw new Error(`Access denied: ${role} role does not have ${permission} permission`);
    }
  }

  // ==================== Audit Log ====================

  /**
   * Record an audit event. Every mutation should call this.
   */
  async audit(
    repoId: string,
    actorId: string,
    actorName: string,
    action: AuditAction,
    details: Record<string, unknown> = {}
  ): Promise<void> {
    await this.db
      .prepare(`
        INSERT INTO repo_audit_log (id, repo_id, actor_id, actor_name, action, details_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(generateId(), repoId, actorId, actorName, action, JSON.stringify(details), now())
      .run();
  }

  /**
   * Get audit log entries for a repo, newest first.
   */
  async getAuditLog(repoId: string, limit = 50, offset = 0): Promise<AuditEntry[]> {
    const rows = await this.db
      .prepare(`
        SELECT * FROM repo_audit_log
        WHERE repo_id = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
      `)
      .bind(repoId, limit, offset)
      .all<{
        id: string;
        repo_id: string;
        actor_id: string;
        actor_name: string;
        action: string;
        details_json: string;
        created_at: string;
      }>();

    return (rows.results || []).map(row => ({
      id: row.id,
      repoId: row.repo_id,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action as AuditAction,
      details: JSON.parse(row.details_json || '{}'),
      createdAt: row.created_at,
    }));
  }
}
