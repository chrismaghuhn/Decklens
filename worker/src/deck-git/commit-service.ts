// ============================================================
// CommitService — Delta-based commit system for deck repos
// ============================================================
// Computes patches between deck states, stores commits as a DAG,
// and reconstructs state at any point in history.
// ============================================================

import {
  type DeckState,
  type DeckBoards,
  type DeckCardEntry,
  type DeckBoard,
  type DeckPatchOp,
  type Commit,
  generateId,
  now,
} from './types.js';

const BOARDS: DeckBoard[] = ['commander', 'mainboard', 'sideboard', 'maybeboard'];

/**
 * Build a lookup map: "boardName:cardName" → entry
 */
function buildCardMap(boards: DeckBoards): Map<string, { board: DeckBoard; entry: DeckCardEntry }> {
  const map = new Map<string, { board: DeckBoard; entry: DeckCardEntry }>();
  for (const board of BOARDS) {
    for (const entry of boards[board]) {
      map.set(`${board}:${entry.name}`, { board, entry });
    }
  }
  return map;
}

export class CommitService {
  constructor(private db: D1Database) {}

  // ==================== Patch Computation ====================

  /**
   * Compute a deterministic patch between two deck states.
   * The patch, when applied to oldState, produces newState.
   */
  computePatch(oldState: DeckState, newState: DeckState): DeckPatchOp[] {
    const ops: DeckPatchOp[] = [];

    // 1. Meta changes
    if (oldState.meta.name !== newState.meta.name) {
      ops.push({ op: 'set_meta', key: 'name', value: newState.meta.name });
    }
    if (oldState.meta.description !== newState.meta.description) {
      ops.push({ op: 'set_meta', key: 'description', value: newState.meta.description });
    }
    if (oldState.meta.format !== newState.meta.format) {
      ops.push({ op: 'set_meta', key: 'format', value: newState.meta.format });
    }

    // 2. Board changes
    const oldMap = buildCardMap(oldState.boards);
    const newMap = buildCardMap(newState.boards);

    // Check for removed or modified cards
    for (const [key, { board, entry }] of oldMap) {
      const newEntry = newMap.get(key);
      if (!newEntry) {
        // Card was removed from this board
        // Check if it was moved to another board
        const movedTo = this.findCardInBoards(entry.name, newState.boards, board);
        if (movedTo) {
          ops.push({
            op: 'move_card',
            fromBoard: board,
            toBoard: movedTo.board,
            name: entry.name,
            qty: movedTo.entry.qty,
          });
        } else {
          ops.push({ op: 'remove_card', board, name: entry.name, qty: entry.qty });
        }
      } else if (newEntry.entry.qty !== entry.qty) {
        ops.push({
          op: 'update_qty',
          board,
          name: entry.name,
          oldQty: entry.qty,
          newQty: newEntry.entry.qty,
        });
      }

      // Check for tag changes
      if (newEntry) {
        const oldTags = new Set(entry.tags);
        const newTags = new Set(newEntry.entry.tags);
        for (const tag of newTags) {
          if (!oldTags.has(tag)) {
            ops.push({ op: 'set_tag', board, name: entry.name, tag, value: true });
          }
        }
        for (const tag of oldTags) {
          if (!newTags.has(tag)) {
            ops.push({ op: 'set_tag', board, name: entry.name, tag, value: false });
          }
        }

        // Section changes
        if (entry.customCategoryId !== newEntry.entry.customCategoryId) {
          ops.push({
            op: 'set_section',
            board,
            name: entry.name,
            sectionId: newEntry.entry.customCategoryId || '',
          });
        }
      }
    }

    // Check for new cards (not already handled by move detection)
    const movedCards = new Set<string>();
    for (const op of ops) {
      if (op.op === 'move_card') {
        movedCards.add(`${op.toBoard}:${op.name}`);
      }
    }

    for (const [key, { board, entry }] of newMap) {
      if (!oldMap.has(key) && !movedCards.has(key)) {
        ops.push({ op: 'add_card', board, name: entry.name, qty: entry.qty });
      }
    }

    return ops;
  }

  /**
   * Find a card by name in boards, excluding a specific board.
   */
  private findCardInBoards(
    name: string,
    boards: DeckBoards,
    excludeBoard: DeckBoard
  ): { board: DeckBoard; entry: DeckCardEntry } | null {
    for (const board of BOARDS) {
      if (board === excludeBoard) continue;
      const entry = boards[board].find(e => e.name === name);
      if (entry) return { board, entry };
    }
    return null;
  }

  // ==================== Patch Application ====================

  /**
   * Apply a patch to a deck state, producing a new state.
   * Pure function — does not mutate the input state.
   */
  applyPatch(state: DeckState, patch: DeckPatchOp[]): DeckState {
    // Deep clone the state
    const result: DeckState = {
      meta: { ...state.meta },
      boards: {
        commander: state.boards.commander.map(e => ({ ...e, tags: [...e.tags] })),
        mainboard: state.boards.mainboard.map(e => ({ ...e, tags: [...e.tags] })),
        sideboard: state.boards.sideboard.map(e => ({ ...e, tags: [...e.tags] })),
        maybeboard: state.boards.maybeboard.map(e => ({ ...e, tags: [...e.tags] })),
      },
    };

    for (const op of patch) {
      switch (op.op) {
        case 'add_card':
          result.boards[op.board].push({ name: op.name, qty: op.qty, tags: [] });
          break;

        case 'remove_card': {
          const idx = result.boards[op.board].findIndex(e => e.name === op.name);
          if (idx !== -1) result.boards[op.board].splice(idx, 1);
          break;
        }

        case 'update_qty': {
          const card = result.boards[op.board].find(e => e.name === op.name);
          if (card) card.qty = op.newQty;
          break;
        }

        case 'move_card': {
          const fromIdx = result.boards[op.fromBoard].findIndex(e => e.name === op.name);
          if (fromIdx !== -1) {
            const [moved] = result.boards[op.fromBoard].splice(fromIdx, 1);
            moved.qty = op.qty;
            result.boards[op.toBoard].push(moved);
          }
          break;
        }

        case 'set_tag': {
          const tagCard = result.boards[op.board].find(e => e.name === op.name);
          if (tagCard) {
            if (op.value) {
              if (!tagCard.tags.includes(op.tag)) tagCard.tags.push(op.tag);
            } else {
              tagCard.tags = tagCard.tags.filter(t => t !== op.tag);
            }
          }
          break;
        }

        case 'set_meta':
          if (op.key === 'name') result.meta.name = op.value;
          else if (op.key === 'description') result.meta.description = op.value;
          else if (op.key === 'format') result.meta.format = op.value;
          break;

        case 'set_section': {
          const secCard = result.boards[op.board].find(e => e.name === op.name);
          if (secCard) secCard.customCategoryId = op.sectionId || undefined;
          break;
        }
      }
    }

    return result;
  }

  // ==================== Commit CRUD ====================

  /**
   * Create a commit on a branch.
   * Computes the patch from the current branch HEAD state to the new state.
   * Updates the branch HEAD to point to the new commit.
   */
  async createCommit(
    repoId: string,
    branchId: string,
    authorId: string,
    authorName: string,
    message: string,
    newState: DeckState
  ): Promise<Commit> {
    // Get current HEAD
    const branch = await this.db
      .prepare('SELECT head_commit_id FROM repo_branches WHERE id = ?')
      .bind(branchId)
      .first<{ head_commit_id: string | null }>();

    if (!branch) throw new Error(`Branch ${branchId} not found`);

    // Get current state at HEAD (or empty state for initial commit)
    const currentState = branch.head_commit_id
      ? await this.getStateAtCommit(branch.head_commit_id)
      : this.emptyState();

    // Compute patch
    const patch = this.computePatch(currentState, newState);

    // Don't create empty commits
    if (patch.length === 0) {
      throw new Error('No changes to commit');
    }

    const commitId = generateId();
    const createdAt = now();

    // Store commit
    await this.db
      .prepare(`
        INSERT INTO deck_commits (id, repo_id, parent_id, parent2_id, author_id, author_name, message, patch_json, boards_snapshot, created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        commitId,
        repoId,
        branch.head_commit_id,
        authorId,
        authorName,
        message,
        JSON.stringify(patch),
        JSON.stringify(newState), // cache full state
        createdAt
      )
      .run();

    // Update branch HEAD
    await this.db
      .prepare('UPDATE repo_branches SET head_commit_id = ? WHERE id = ?')
      .bind(commitId, branchId)
      .run();

    return {
      id: commitId,
      repoId,
      parentId: branch.head_commit_id,
      parent2Id: null,
      authorId,
      authorName,
      message,
      patch,
      boardsSnapshot: JSON.stringify(newState),
      createdAt,
    };
  }

  /**
   * Create a merge commit with two parents.
   */
  async createMergeCommit(
    repoId: string,
    branchId: string,
    parentId: string,
    parent2Id: string,
    authorId: string,
    authorName: string,
    message: string,
    mergedState: DeckState,
    mergedPatch: DeckPatchOp[]
  ): Promise<Commit> {
    const commitId = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO deck_commits (id, repo_id, parent_id, parent2_id, author_id, author_name, message, patch_json, boards_snapshot, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        commitId,
        repoId,
        parentId,
        parent2Id,
        authorId,
        authorName,
        message,
        JSON.stringify(mergedPatch),
        JSON.stringify(mergedState),
        createdAt
      )
      .run();

    // Update branch HEAD
    await this.db
      .prepare('UPDATE repo_branches SET head_commit_id = ? WHERE id = ?')
      .bind(commitId, branchId)
      .run();

    return {
      id: commitId,
      repoId,
      parentId,
      parent2Id,
      authorId,
      authorName,
      message,
      patch: mergedPatch,
      boardsSnapshot: JSON.stringify(mergedState),
      createdAt,
    };
  }

  // ==================== State Reconstruction ====================

  /**
   * Reconstruct the full deck state at a specific commit.
   * Uses cached snapshot if available, otherwise replays patches from genesis.
   */
  async getStateAtCommit(commitId: string): Promise<DeckState> {
    const commit = await this.db
      .prepare('SELECT * FROM deck_commits WHERE id = ?')
      .bind(commitId)
      .first<{
        id: string;
        repo_id: string;
        parent_id: string | null;
        patch_json: string;
        boards_snapshot: string | null;
      }>();

    if (!commit) throw new Error(`Commit ${commitId} not found`);

    // Use cached snapshot if available
    if (commit.boards_snapshot) {
      try {
        return JSON.parse(commit.boards_snapshot) as DeckState;
      } catch {
        // Fall through to reconstruction
      }
    }

    // Reconstruct by replaying patches from genesis
    const chain = await this.getCommitChain(commitId);
    let state = this.emptyState();

    for (const c of chain) {
      const patch: DeckPatchOp[] = JSON.parse(c.patch_json);
      state = this.applyPatch(state, patch);
    }

    // Cache the reconstructed state for future use
    await this.db
      .prepare('UPDATE deck_commits SET boards_snapshot = ? WHERE id = ?')
      .bind(JSON.stringify(state), commitId)
      .run();

    return state;
  }

  /**
   * Get the commit chain from genesis to the given commit (inclusive).
   * Returns commits in chronological order (oldest first).
   */
  private async getCommitChain(
    commitId: string
  ): Promise<Array<{ id: string; parent_id: string | null; patch_json: string }>> {
    const chain: Array<{ id: string; parent_id: string | null; patch_json: string }> = [];
    let currentId: string | null = commitId;

    while (currentId) {
      const commit = await this.db
        .prepare('SELECT id, parent_id, patch_json FROM deck_commits WHERE id = ?')
        .bind(currentId)
        .first<{ id: string; parent_id: string | null; patch_json: string }>();

      if (!commit) break;
      chain.unshift(commit); // prepend to maintain chronological order
      currentId = commit.parent_id;
    }

    return chain;
  }

  // ==================== History ====================

  /**
   * Get commit history for a branch (newest first).
   */
  async getHistory(branchId: string, limit = 50, offset = 0): Promise<Commit[]> {
    // Get branch HEAD
    const branch = await this.db
      .prepare('SELECT head_commit_id FROM repo_branches WHERE id = ?')
      .bind(branchId)
      .first<{ head_commit_id: string | null }>();

    if (!branch?.head_commit_id) return [];

    // Walk the parent chain
    const commits: Commit[] = [];
    let currentId: string | null = branch.head_commit_id;
    let skipped = 0;

    while (currentId && commits.length < limit) {
      const row = await this.db
        .prepare('SELECT * FROM deck_commits WHERE id = ?')
        .bind(currentId)
        .first<{
          id: string;
          repo_id: string;
          parent_id: string | null;
          parent2_id: string | null;
          author_id: string;
          author_name: string;
          message: string;
          patch_json: string;
          boards_snapshot: string | null;
          created_at: string;
        }>();

      if (!row) break;

      if (skipped >= offset) {
        commits.push({
          id: row.id,
          repoId: row.repo_id,
          parentId: row.parent_id,
          parent2Id: row.parent2_id,
          authorId: row.author_id,
          authorName: row.author_name,
          message: row.message,
          patch: JSON.parse(row.patch_json),
          boardsSnapshot: row.boards_snapshot,
          createdAt: row.created_at,
        });
      } else {
        skipped++;
      }

      currentId = row.parent_id;
    }

    return commits;
  }

  /**
   * Get a single commit by ID.
   */
  async getCommit(commitId: string): Promise<Commit | null> {
    const row = await this.db
      .prepare('SELECT * FROM deck_commits WHERE id = ?')
      .bind(commitId)
      .first<{
        id: string;
        repo_id: string;
        parent_id: string | null;
        parent2_id: string | null;
        author_id: string;
        author_name: string;
        message: string;
        patch_json: string;
        boards_snapshot: string | null;
        created_at: string;
      }>();

    if (!row) return null;

    return {
      id: row.id,
      repoId: row.repo_id,
      parentId: row.parent_id,
      parent2Id: row.parent2_id,
      authorId: row.author_id,
      authorName: row.author_name,
      message: row.message,
      patch: JSON.parse(row.patch_json),
      boardsSnapshot: row.boards_snapshot,
      createdAt: row.created_at,
    };
  }

  // ==================== Revert ====================

  /**
   * Create a revert commit that undoes the changes of a specific commit.
   * Generates an inverse patch and commits it to the branch.
   */
  async revertCommit(
    commitId: string,
    branchId: string,
    authorId: string,
    authorName: string
  ): Promise<Commit> {
    const commit = await this.getCommit(commitId);
    if (!commit) throw new Error(`Commit ${commitId} not found`);

    const inversePatch = this.invertPatch(commit.patch);
    const branch = await this.db
      .prepare('SELECT head_commit_id, repo_id FROM repo_branches WHERE id = ?')
      .bind(branchId)
      .first<{ head_commit_id: string | null; repo_id: string }>();

    if (!branch?.head_commit_id) throw new Error(`Branch ${branchId} not found or empty`);

    // Get current state and apply inverse
    const currentState = await this.getStateAtCommit(branch.head_commit_id);
    const revertedState = this.applyPatch(currentState, inversePatch);

    const revertId = generateId();
    const createdAt = now();

    await this.db
      .prepare(`
        INSERT INTO deck_commits (id, repo_id, parent_id, parent2_id, author_id, author_name, message, patch_json, boards_snapshot, created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        revertId,
        branch.repo_id,
        branch.head_commit_id,
        authorId,
        authorName,
        `Revert "${commit.message}"`,
        JSON.stringify(inversePatch),
        JSON.stringify(revertedState),
        createdAt
      )
      .run();

    await this.db
      .prepare('UPDATE repo_branches SET head_commit_id = ? WHERE id = ?')
      .bind(revertId, branchId)
      .run();

    return {
      id: revertId,
      repoId: branch.repo_id,
      parentId: branch.head_commit_id,
      parent2Id: null,
      authorId,
      authorName,
      message: `Revert "${commit.message}"`,
      patch: inversePatch,
      boardsSnapshot: JSON.stringify(revertedState),
      createdAt,
    };
  }

  /**
   * Generate an inverse patch that undoes the given operations.
   */
  invertPatch(patch: DeckPatchOp[]): DeckPatchOp[] {
    const inverse: DeckPatchOp[] = [];

    // Process in reverse order
    for (let i = patch.length - 1; i >= 0; i--) {
      const op = patch[i];
      switch (op.op) {
        case 'add_card':
          inverse.push({ op: 'remove_card', board: op.board, name: op.name, qty: op.qty });
          break;
        case 'remove_card':
          inverse.push({ op: 'add_card', board: op.board, name: op.name, qty: op.qty });
          break;
        case 'update_qty':
          inverse.push({
            op: 'update_qty',
            board: op.board,
            name: op.name,
            oldQty: op.newQty,
            newQty: op.oldQty,
          });
          break;
        case 'move_card':
          inverse.push({
            op: 'move_card',
            fromBoard: op.toBoard,
            toBoard: op.fromBoard,
            name: op.name,
            qty: op.qty,
          });
          break;
        case 'set_tag':
          inverse.push({
            op: 'set_tag',
            board: op.board,
            name: op.name,
            tag: op.tag,
            value: !op.value,
          });
          break;
        case 'set_meta':
          // For meta, we'd need the old value. Store as empty string revert.
          // In practice, the revert applies the full inverse state.
          inverse.push({ op: 'set_meta', key: op.key, value: '' });
          break;
        case 'set_section':
          inverse.push({
            op: 'set_section',
            board: op.board,
            name: op.name,
            sectionId: '',
          });
          break;
      }
    }

    return inverse;
  }

  // ==================== Branch Comparison ====================

  /**
   * Compare two branches and return the diff between them.
   */
  async compareBranches(
    branchAId: string,
    branchBId: string
  ): Promise<{
    addedCards: Array<{ board: string; card: string; qty: number }>;
    removedCards: Array<{ board: string; card: string; qty: number }>;
    modifiedCards: Array<{ board: string; card: string; oldQty: number; newQty: number }>;
    totalChanges: number;
    fromCommitId: string | null;
    toCommitId: string | null;
  }> {
    // Get branch info
    const branchA = await this.db
      .prepare('SELECT head_commit_id, name FROM repo_branches WHERE id = ?')
      .bind(branchAId)
      .first<{ head_commit_id: string | null; name: string }>();
    const branchB = await this.db
      .prepare('SELECT head_commit_id, name FROM repo_branches WHERE id = ?')
      .bind(branchBId)
      .first<{ head_commit_id: string | null; name: string }>();

    if (!branchA || !branchB) {
      throw new Error('Branch not found');
    }

    // Get states
    const stateA = branchA.head_commit_id
      ? await this.getStateAtCommit(branchA.head_commit_id)
      : this.emptyState();
    const stateB = branchB.head_commit_id
      ? await this.getStateAtCommit(branchB.head_commit_id)
      : this.emptyState();

    // Compute patch from A to B
    const patch = this.computePatch(stateA, stateB);

    const addedCards: Array<{ board: string; card: string; qty: number }> = [];
    const removedCards: Array<{ board: string; card: string; qty: number }> = [];
    const modifiedCards: Array<{ board: string; card: string; oldQty: number; newQty: number }> = [];

    for (const op of patch) {
      if (op.op === 'add_card') {
        addedCards.push({ board: op.board, card: op.name, qty: op.qty });
      } else if (op.op === 'remove_card') {
        removedCards.push({ board: op.board, card: op.name, qty: op.qty });
      } else if (op.op === 'update_qty') {
        modifiedCards.push({ board: op.board, card: op.name, oldQty: op.oldQty, newQty: op.newQty });
      }
    }

    return {
      addedCards,
      removedCards,
      modifiedCards,
      totalChanges: patch.length,
      fromCommitId: branchA.head_commit_id,
      toCommitId: branchB.head_commit_id,
    };
  }

  /**
   * Get side-by-side state comparison for two branches.
   */
  async getComparisonState(
    branchAId: string,
    branchBId: string
  ): Promise<{
    branchA: DeckState;
    branchB: DeckState;
    addedCards: Array<{ board: string; card: string; qty: number }>;
    removedCards: Array<{ board: string; card: string; qty: number }>;
    commonCards: number;
  }> {
    const branchA = await this.db
      .prepare('SELECT head_commit_id FROM repo_branches WHERE id = ?')
      .bind(branchAId)
      .first<{ head_commit_id: string | null }>();
    const branchB = await this.db
      .prepare('SELECT head_commit_id FROM repo_branches WHERE id = ?')
      .bind(branchBId)
      .first<{ head_commit_id: string | null }>();

    const stateA = branchA?.head_commit_id
      ? await this.getStateAtCommit(branchA.head_commit_id)
      : this.emptyState();
    const stateB = branchB?.head_commit_id
      ? await this.getStateAtCommit(branchB.head_commit_id)
      : this.emptyState();

    const mapA = buildCardMap(stateA.boards);
    const mapB = buildCardMap(stateB.boards);

    const addedCards: Array<{ board: string; card: string; qty: number }> = [];
    const removedCards: Array<{ board: string; card: string; qty: number }> = [];
    let commonCards = 0;

    // Find added cards (in B but not in A)
    for (const [key, { board, entry }] of mapB) {
      if (!mapA.has(key)) {
        addedCards.push({ board, card: entry.name, qty: entry.qty });
      } else {
        commonCards++;
      }
    }

    // Find removed cards (in A but not in B)
    for (const [key, { board, entry }] of mapA) {
      if (!mapB.has(key)) {
        removedCards.push({ board, card: entry.name, qty: entry.qty });
      }
    }

    return {
      branchA: stateA,
      branchB: stateB,
      addedCards,
      removedCards,
      commonCards,
    };
  }

  // ==================== Helpers ====================

  /**
   * Generate a smart commit message based on the patch operations.
   */
  generateSmartCommitMessage(
    patch: DeckPatchOp[],
    meta?: { name?: string; format?: string }
  ): { shortMessage: string; longMessage: string; suggestedTitle: string; tags: string[] } {
    const added: string[] = [];
    const removed: string[] = [];
    const modified: string[] = [];
    const tags = new Set<string>();

    for (const op of patch) {
      switch (op.op) {
        case 'add_card':
          added.push(op.name);
          tags.add('add');
          break;
        case 'remove_card':
          removed.push(op.name);
          tags.add('remove');
          break;
        case 'update_qty':
          modified.push(`${op.name} (${op.oldQty}→${op.newQty})`);
          tags.add('update');
          break;
        case 'move_card':
          tags.add('restructure');
          break;
        case 'set_tag':
          tags.add('tag');
          break;
        case 'set_meta':
          if (op.key === 'format') tags.add('format');
          if (op.key === 'name') tags.add('meta');
          break;
      }
    }

    // Build short message
    let shortMessage = '';
    if (added.length > 0) {
      const count = added.length;
      const cards = added.slice(0, 3).join(', ');
      shortMessage += `+${count} card${count > 1 ? 's' : ''}: ${cards}`;
      if (added.length > 3) shortMessage += `, +${added.length - 3} more`;
    }
    if (removed.length > 0) {
      if (shortMessage) shortMessage += '; ';
      const count = removed.length;
      const cards = removed.slice(0, 3).join(', ');
      shortMessage += `-${count} card${count > 1 ? 's' : ''}: ${cards}`;
      if (removed.length > 3) shortMessage += `, -${removed.length - 3} more`;
    }
    if (modified.length > 0) {
      if (shortMessage) shortMessage += '; ';
      shortMessage += `~${modified.length} modified`;
    }
    if (patch.length === 0) {
      shortMessage = 'No changes';
    }

    // Build long message
    let longMessage = shortMessage;
    if (added.length > 0) {
      longMessage += '\n\n### Added\n' + added.map(c => `- ${c}`).join('\n');
    }
    if (removed.length > 0) {
      longMessage += '\n\n### Removed\n' + removed.map(c => `- ${c}`).join('\n');
    }
    if (modified.length > 0) {
      longMessage += '\n\n### Modified\n' + modified.map(c => `- ${c}`).join('\n');
    }

    // Generate suggested title
    let suggestedTitle = shortMessage.split(';')[0];
    if (added.length > 0 && removed.length === 0) {
      suggestedTitle = `Add ${added.slice(0, 2).join(', ')}${added.length > 2 ? ` and ${added.length - 2} more` : ''}`;
    } else if (removed.length > 0 && added.length === 0) {
      suggestedTitle = `Remove ${removed.slice(0, 2).join(', ')}${removed.length > 2 ? ` and ${removed.length - 2} more` : ''}`;
    } else if (added.length > 0 && removed.length > 0) {
      suggestedTitle = `Update deck: +${added.length} -${removed.length}`;
    }

    return {
      shortMessage,
      longMessage,
      suggestedTitle: suggestedTitle.slice(0, 100),
      tags: Array.from(tags),
    };
  }

  /**
   * Empty deck state for initial commits.
   */
  emptyState(): DeckState {
    return {
      boards: {
        commander: [],
        mainboard: [],
        sideboard: [],
        maybeboard: [],
      },
      meta: {
        name: '',
        description: '',
        format: 'commander',
      },
    };
  }
}
