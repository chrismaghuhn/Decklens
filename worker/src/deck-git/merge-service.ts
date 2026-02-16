// ============================================================
// MergeService — 3-Way Merge for deck branches
// ============================================================
// Detects conflicts when two branches modify the same cards,
// provides resolution options, and creates merge commits.
// ============================================================

import {
  type DeckState,
  type DeckBoard,
  type DeckPatchOp,
  type DeckCardEntry,
  type MergeResult,
  type ConflictEntry,
  type ConflictResolution,
  type Commit,
  type MergeStrategy,
} from './types.js';
import { CommitService } from './commit-service.js';
import { BranchService } from './branch-service.js';

const BOARDS: DeckBoard[] = ['commander', 'mainboard', 'sideboard', 'maybeboard'];

/**
 * Represent a card's state for comparison: board + qty + tags
 */
interface CardFingerprint {
  board: DeckBoard;
  name: string;
  qty: number;
  tags: string[];
}

function buildFingerprints(state: DeckState): Map<string, CardFingerprint> {
  const map = new Map<string, CardFingerprint>();
  for (const board of BOARDS) {
    for (const entry of state.boards[board]) {
      map.set(entry.name, { board, name: entry.name, qty: entry.qty, tags: [...entry.tags] });
    }
  }
  return map;
}

export class MergeService {
  constructor(
    private db: D1Database,
    private commitSvc: CommitService,
    private branchSvc: BranchService
  ) {}

  // ==================== 3-Way Merge ====================

  /**
   * Perform a 3-way merge between source and target branches.
   *
   * 1. Find the merge base (common ancestor)
   * 2. Compute diff: base→source and base→target
   * 3. Detect conflicts: same card changed differently
   * 4. If no conflicts: auto-merge and return merged state
   * 5. If conflicts: return conflict list for resolution
   */
  async merge(
    sourceBranchId: string,
    targetBranchId: string,
    strategy: MergeStrategy = 'squash'
  ): Promise<MergeResult> {
    const sourceBranch = await this.branchSvc.getBranch(sourceBranchId);
    const targetBranch = await this.branchSvc.getBranch(targetBranchId);

    if (!sourceBranch?.headCommitId || !targetBranch?.headCommitId) {
      return { success: false, conflicts: [] };
    }

    // Get states
    const sourceState = await this.commitSvc.getStateAtCommit(sourceBranch.headCommitId);
    const targetState = await this.commitSvc.getStateAtCommit(targetBranch.headCommitId);

    // Find merge base
    const mergeBaseId = await this.branchSvc.findMergeBase(sourceBranchId, targetBranchId);

    if (!mergeBaseId) {
      // No common ancestor — treat target as base (effectively overwrite)
      return {
        success: true,
        mergedState: sourceState,
      };
    }

    const baseState = await this.commitSvc.getStateAtCommit(mergeBaseId);

    // Detect conflicts
    const conflicts = this.detectConflicts(baseState, sourceState, targetState);

    if (conflicts.length > 0) {
      return { success: false, conflicts };
    }

    // No conflicts — auto-merge
    const mergedState = this.autoMerge(baseState, sourceState, targetState);
    return { success: true, mergedState };
  }

  // ==================== Conflict Detection ====================

  /**
   * Detect conflicts between source and target changes relative to base.
   * A conflict occurs when both branches modify the same card differently.
   */
  detectConflicts(
    base: DeckState,
    source: DeckState,
    target: DeckState
  ): ConflictEntry[] {
    const conflicts: ConflictEntry[] = [];

    const baseFP = buildFingerprints(base);
    const sourceFP = buildFingerprints(source);
    const targetFP = buildFingerprints(target);

    // Collect all card names across all states
    const allCardNames = new Set<string>();
    for (const fp of [baseFP, sourceFP, targetFP]) {
      for (const name of fp.keys()) allCardNames.add(name);
    }

    for (const cardName of allCardNames) {
      const baseCard = baseFP.get(cardName);
      const sourceCard = sourceFP.get(cardName);
      const targetCard = targetFP.get(cardName);

      // Determine if source and target both changed this card (relative to base)
      const sourceChanged = !this.fingerprintsEqual(baseCard, sourceCard);
      const targetChanged = !this.fingerprintsEqual(baseCard, targetCard);

      if (sourceChanged && targetChanged) {
        // Both branches modified this card — check if they made the SAME change
        if (!this.fingerprintsEqual(sourceCard, targetCard)) {
          // Different changes → CONFLICT
          const board = baseCard?.board ?? sourceCard?.board ?? targetCard?.board ?? 'mainboard';
          conflicts.push({
            board,
            cardName,
            sourceChange: this.describeChange(baseCard, sourceCard),
            targetChange: this.describeChange(baseCard, targetCard),
          });
        }
        // If both made the same change, no conflict — pick either (they're identical)
      }
    }

    return conflicts;
  }

  // ==================== Auto-Merge ====================

  /**
   * Auto-merge: apply non-conflicting changes from both branches.
   * Assumes no conflicts (call detectConflicts first).
   */
  private autoMerge(base: DeckState, source: DeckState, target: DeckState): DeckState {
    const baseFP = buildFingerprints(base);
    const sourceFP = buildFingerprints(source);
    const targetFP = buildFingerprints(target);

    // Start from base state
    const merged: DeckState = {
      meta: { ...base.meta },
      boards: {
        commander: [],
        mainboard: [],
        sideboard: [],
        maybeboard: [],
      },
    };

    // Merge meta: prefer source if changed, otherwise target
    merged.meta.name = source.meta.name !== base.meta.name ? source.meta.name : target.meta.name;
    merged.meta.description = source.meta.description !== base.meta.description
      ? source.meta.description : target.meta.description;
    merged.meta.format = source.meta.format !== base.meta.format
      ? source.meta.format : target.meta.format;

    // Collect all card names
    const allCardNames = new Set<string>();
    for (const fp of [baseFP, sourceFP, targetFP]) {
      for (const name of fp.keys()) allCardNames.add(name);
    }

    for (const cardName of allCardNames) {
      const baseCard = baseFP.get(cardName);
      const sourceCard = sourceFP.get(cardName);
      const targetCard = targetFP.get(cardName);

      const sourceChanged = !this.fingerprintsEqual(baseCard, sourceCard);
      const targetChanged = !this.fingerprintsEqual(baseCard, targetCard);

      let resultCard: CardFingerprint | undefined;

      if (sourceChanged && !targetChanged) {
        // Only source changed → take source
        resultCard = sourceCard;
      } else if (!sourceChanged && targetChanged) {
        // Only target changed → take target
        resultCard = targetCard;
      } else if (sourceChanged && targetChanged) {
        // Both changed identically (conflicts already filtered out)
        resultCard = sourceCard;
      } else {
        // Neither changed → keep base
        resultCard = baseCard;
      }

      if (resultCard) {
        const entry: DeckCardEntry = {
          name: resultCard.name,
          qty: resultCard.qty,
          tags: resultCard.tags,
        };
        merged.boards[resultCard.board].push(entry);
      }
    }

    return merged;
  }

  // ==================== Conflict Resolution ====================

  /**
   * Apply user-provided conflict resolutions and create a merge commit.
   */
  async resolveAndMerge(
    repoId: string,
    targetBranchId: string,
    sourceBranchId: string,
    resolutions: ConflictResolution[],
    authorId: string,
    authorName: string,
    commitMessage: string
  ): Promise<Commit> {
    const sourceBranch = await this.branchSvc.getBranch(sourceBranchId);
    const targetBranch = await this.branchSvc.getBranch(targetBranchId);

    if (!sourceBranch?.headCommitId || !targetBranch?.headCommitId) {
      throw new Error('Branches must have commits to merge');
    }

    const mergeBaseId = await this.branchSvc.findMergeBase(sourceBranchId, targetBranchId);
    const baseState = mergeBaseId
      ? await this.commitSvc.getStateAtCommit(mergeBaseId)
      : this.commitSvc.emptyState();
    const sourceState = await this.commitSvc.getStateAtCommit(sourceBranch.headCommitId);
    const targetState = await this.commitSvc.getStateAtCommit(targetBranch.headCommitId);

    // Start with auto-merged base
    const merged = this.autoMerge(baseState, sourceState, targetState);

    // Apply conflict resolutions
    for (const resolution of resolutions) {
      const sourceFP = buildFingerprints(sourceState).get(resolution.cardName);
      const targetFP = buildFingerprints(targetState).get(resolution.cardName);

      // Remove existing entry from merged (if any)
      for (const board of BOARDS) {
        const idx = merged.boards[board].findIndex(e => e.name === resolution.cardName);
        if (idx !== -1) merged.boards[board].splice(idx, 1);
      }

      switch (resolution.choice) {
        case 'source':
          if (sourceFP) {
            merged.boards[sourceFP.board].push({
              name: sourceFP.name,
              qty: resolution.customQty ?? sourceFP.qty,
              tags: sourceFP.tags,
            });
          }
          break;
        case 'target':
          if (targetFP) {
            merged.boards[targetFP.board].push({
              name: targetFP.name,
              qty: resolution.customQty ?? targetFP.qty,
              tags: targetFP.tags,
            });
          }
          break;
        case 'both':
          // Keep both versions (source in its board, target in its board)
          if (sourceFP) {
            merged.boards[sourceFP.board].push({
              name: sourceFP.name,
              qty: sourceFP.qty,
              tags: sourceFP.tags,
            });
          }
          // If target is on a different board or has different qty
          if (targetFP && (!sourceFP || targetFP.board !== sourceFP.board)) {
            merged.boards[targetFP.board].push({
              name: targetFP.name,
              qty: targetFP.qty,
              tags: targetFP.tags,
            });
          }
          break;
      }
    }

    // Compute the full patch from target state to merged state
    const mergedPatch = this.commitSvc.computePatch(targetState, merged);

    // Create merge commit
    return this.commitSvc.createMergeCommit(
      repoId,
      targetBranchId,
      targetBranch.headCommitId,
      sourceBranch.headCommitId,
      authorId,
      authorName,
      commitMessage,
      merged,
      mergedPatch
    );
  }

  // ==================== Helpers ====================

  private fingerprintsEqual(
    a: CardFingerprint | undefined,
    b: CardFingerprint | undefined
  ): boolean {
    if (!a && !b) return true;
    if (!a || !b) return false;
    if (a.board !== b.board) return false;
    if (a.qty !== b.qty) return false;
    if (a.tags.length !== b.tags.length) return false;
    const sortedA = [...a.tags].sort();
    const sortedB = [...b.tags].sort();
    return sortedA.every((t, i) => t === sortedB[i]);
  }

  private describeChange(
    base: CardFingerprint | undefined,
    changed: CardFingerprint | undefined
  ): DeckPatchOp {
    if (!base && changed) {
      return { op: 'add_card', board: changed.board, name: changed.name, qty: changed.qty };
    }
    if (base && !changed) {
      return { op: 'remove_card', board: base.board, name: base.name, qty: base.qty };
    }
    if (base && changed) {
      if (base.board !== changed.board) {
        return { op: 'move_card', fromBoard: base.board, toBoard: changed.board, name: base.name, qty: changed.qty };
      }
      return { op: 'update_qty', board: base.board, name: base.name, oldQty: base.qty, newQty: changed.qty };
    }
    // Shouldn't reach here
    return { op: 'set_meta', key: 'unknown', value: '' };
  }
}
