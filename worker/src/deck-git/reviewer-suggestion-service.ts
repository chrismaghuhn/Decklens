// ============================================================
// ReviewerSuggestionService — Suggest reviewers based on history
// ============================================================
// Analyzes recent commit history to suggest reviewers who have
// the most experience with the affected areas of a PR's diff.
// ============================================================

import type { DeckPatchOp, DeckBoard } from './types.js';
import { analyzeScopes } from './auto-label-service.js';

export interface SuggestedReviewer {
  userId: string;
  authorName: string;
  reason: string;
  score: number;
}

export class ReviewerSuggestionService {
  constructor(private db: D1Database) {}

  /**
   * Suggest reviewers based on the PR's diff.
   * Looks at recent commits touching the same scopes and suggests top contributors.
   */
  async suggestReviewers(
    repoId: string,
    branchId: string,
    patch: DeckPatchOp[],
    excludeUserId?: string
  ): Promise<SuggestedReviewer[]> {
    // Determine affected scopes from the patch
    const scopes = analyzeScopes(patch);
    const affectedBoards = new Set<string>();
    for (const op of patch) {
      if ('board' in op && (op as { board?: string }).board) affectedBoards.add((op as { board: string }).board);
      if ('fromBoard' in op) affectedBoards.add((op as { fromBoard: string }).fromBoard);
      if ('toBoard' in op) affectedBoards.add((op as { toBoard: string }).toBoard);
    }

    // Get branch HEAD
    const branch = await this.db
      .prepare('SELECT head_commit_id FROM repo_branches WHERE id = ?')
      .bind(branchId)
      .first<{ head_commit_id: string | null }>();

    if (!branch?.head_commit_id) return [];

    // Walk last 30 commits on this branch
    const commits: Array<{
      author_id: string;
      author_name: string;
      patch_json: string;
    }> = [];

    let currentId: string | null = branch.head_commit_id;
    let count = 0;
    while (currentId && count < 30) {
      const row = await this.db
        .prepare('SELECT author_id, author_name, patch_json, parent_id FROM deck_commits WHERE id = ?')
        .bind(currentId)
        .first<{
          author_id: string;
          author_name: string;
          patch_json: string;
          parent_id: string | null;
        }>();

      if (!row) break;
      commits.push({ author_id: row.author_id, author_name: row.author_name, patch_json: row.patch_json });
      currentId = row.parent_id;
      count++;
    }

    // Score authors by how many of their commits touch the same boards/scopes
    const authorScores = new Map<string, { name: string; score: number; boards: Set<string> }>();

    for (const c of commits) {
      if (c.author_id === excludeUserId) continue;

      let commitPatch: DeckPatchOp[];
      try {
        commitPatch = JSON.parse(c.patch_json);
      } catch { continue; }

      const commitBoards = new Set<string>();
      for (const op of commitPatch) {
        if ('board' in op && (op as { board?: string }).board) commitBoards.add((op as { board: string }).board);
      }

      // Check overlap with affected boards
      let overlap = 0;
      for (const b of affectedBoards) {
        if (commitBoards.has(b)) overlap++;
      }

      if (overlap > 0) {
        if (!authorScores.has(c.author_id)) {
          authorScores.set(c.author_id, { name: c.author_name, score: 0, boards: new Set() });
        }
        const entry = authorScores.get(c.author_id)!;
        entry.score += overlap;
        for (const b of commitBoards) {
          if (affectedBoards.has(b)) entry.boards.add(b);
        }
      }
    }

    // Sort by score and return top 3
    return Array.from(authorScores.entries())
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 3)
      .map(([userId, data]) => ({
        userId,
        authorName: data.name,
        reason: `Worked on ${[...data.boards].join(', ')} (${data.score} related commits)`,
        score: data.score,
      }));
  }
}
