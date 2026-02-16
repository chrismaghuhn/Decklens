// ============================================================
// BlameService — Card/Board-level blame for deck repos
// ============================================================
// Traverses the commit chain to determine who introduced or
// last modified a card. Provides per-card and per-board blame.
// ============================================================

import type { DeckBoard, DeckPatchOp, Commit } from './types.js';

export interface BlameEntry {
  cardName: string;
  board: DeckBoard;
  introduced: {
    commitId: string;
    authorId: string;
    authorName: string;
    message: string;
    time: string;
  } | null;
  lastChanged: {
    commitId: string;
    authorId: string;
    authorName: string;
    message: string;
    time: string;
  } | null;
  changeCount: number;
}

export class BlameService {
  constructor(private db: D1Database) {}

  /**
   * Get blame info for a specific card on a specific branch.
   * Traverses the commit chain backwards from branch HEAD.
   */
  async getCardBlame(repoId: string, branchId: string, cardName: string): Promise<BlameEntry | null> {
    const commits = await this.walkBranchHistory(branchId, 200);
    if (commits.length === 0) return null;

    let introduced: BlameEntry['introduced'] = null;
    let lastChanged: BlameEntry['lastChanged'] = null;
    let changeCount = 0;
    let board: DeckBoard = 'mainboard';

    // Walk oldest-to-newest to find introduction point
    for (const c of commits) {
      const patch: DeckPatchOp[] = JSON.parse(c.patch_json);
      for (const op of patch) {
        const opName = (op as { name?: string }).name;
        if (!opName || opName.toLowerCase() !== cardName.toLowerCase()) continue;

        changeCount++;
        const info = {
          commitId: c.id,
          authorId: c.author_id,
          authorName: c.author_name,
          message: c.message,
          time: c.created_at,
        };

        if (op.op === 'add_card') {
          if (!introduced) {
            introduced = info;
            board = op.board;
          }
          lastChanged = info;
          board = op.board;
        } else if (op.op === 'remove_card') {
          lastChanged = info;
          board = op.board;
        } else if (op.op === 'update_qty') {
          lastChanged = info;
          board = op.board;
        } else if (op.op === 'move_card') {
          lastChanged = info;
          board = (op as { toBoard: DeckBoard }).toBoard;
        } else if (op.op === 'set_tag') {
          lastChanged = info;
          board = op.board;
        }
      }
    }

    if (!introduced && !lastChanged) return null;

    return { cardName, board, introduced, lastChanged, changeCount };
  }

  /**
   * Get blame for all cards on a specific board.
   */
  async getBoardBlame(repoId: string, branchId: string, board: DeckBoard): Promise<BlameEntry[]> {
    const commits = await this.walkBranchHistory(branchId, 200);
    if (commits.length === 0) return [];

    // Track blame info per card
    const blameMap = new Map<string, {
      introduced: BlameEntry['introduced'];
      lastChanged: BlameEntry['lastChanged'];
      changeCount: number;
      board: DeckBoard;
    }>();

    for (const c of commits) {
      const patch: DeckPatchOp[] = JSON.parse(c.patch_json);
      for (const op of patch) {
        const opBoard = (op as { board?: DeckBoard }).board;
        const toBoard = (op as { toBoard?: DeckBoard }).toBoard;
        const affectsBoard = opBoard === board || toBoard === board;
        if (!affectsBoard) continue;

        const opName = (op as { name?: string }).name;
        if (!opName) continue;

        const key = opName.toLowerCase();
        if (!blameMap.has(key)) {
          blameMap.set(key, { introduced: null, lastChanged: null, changeCount: 0, board });
        }
        const entry = blameMap.get(key)!;
        entry.changeCount++;

        const info = {
          commitId: c.id,
          authorId: c.author_id,
          authorName: c.author_name,
          message: c.message,
          time: c.created_at,
        };

        if (op.op === 'add_card' && opBoard === board && !entry.introduced) {
          entry.introduced = info;
        }
        entry.lastChanged = info;
      }
    }

    return Array.from(blameMap.entries()).map(([name, data]) => ({
      cardName: name,
      board: data.board,
      introduced: data.introduced,
      lastChanged: data.lastChanged,
      changeCount: data.changeCount,
    }));
  }

  /**
   * Walk the commit chain from branch HEAD backwards.
   * Returns commits in chronological order (oldest first).
   */
  private async walkBranchHistory(
    branchId: string,
    maxCommits: number
  ): Promise<Array<{
    id: string;
    parent_id: string | null;
    author_id: string;
    author_name: string;
    message: string;
    patch_json: string;
    created_at: string;
  }>> {
    const branch = await this.db
      .prepare('SELECT head_commit_id FROM repo_branches WHERE id = ?')
      .bind(branchId)
      .first<{ head_commit_id: string | null }>();

    if (!branch?.head_commit_id) return [];

    const chain: Array<{
      id: string;
      parent_id: string | null;
      author_id: string;
      author_name: string;
      message: string;
      patch_json: string;
      created_at: string;
    }> = [];

    let currentId: string | null = branch.head_commit_id;
    while (currentId && chain.length < maxCommits) {
      const row = await this.db
        .prepare('SELECT id, parent_id, author_id, author_name, message, patch_json, created_at FROM deck_commits WHERE id = ?')
        .bind(currentId)
        .first<{
          id: string;
          parent_id: string | null;
          author_id: string;
          author_name: string;
          message: string;
          patch_json: string;
          created_at: string;
        }>();

      if (!row) break;
      chain.unshift(row); // prepend for chronological order
      currentId = row.parent_id;
    }

    return chain;
  }
}
