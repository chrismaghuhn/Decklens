// ============================================================
// Conflict Resolver — Side-by-side merge conflict resolution
// ============================================================
// When a PR merge has conflicts, this UI shows each conflict
// with source/target/both options and a merge preview.
// ============================================================

import { h } from '../shared/dom.js';
import { prApi, commitApi } from './repo-api.js';
import type { DeckPatchOp, DeckState } from './repo-api.js';

// ==================== Types ====================

export interface ConflictEntry {
  board: string;
  cardName: string;
  sourceState: CardConflictState;
  targetState: CardConflictState;
}

export interface CardConflictState {
  qty: number;
  tags: string[];
  present: boolean;
}

export type Resolution = 'source' | 'target' | 'both';

export interface ResolvedConflict {
  board: string;
  cardName: string;
  resolution: Resolution;
}

export interface ConflictResolverCallbacks {
  onResolve: (resolutions: ResolvedConflict[], message: string) => void;
  onCancel: () => void;
}

interface ResolverState {
  conflicts: ConflictEntry[];
  resolutions: Map<string, Resolution>;  // key = "board:cardName"
  sourceState: DeckState | null;
  targetState: DeckState | null;
  loading: boolean;
  error: string | null;
}

// ==================== State ====================

let state: ResolverState = {
  conflicts: [],
  resolutions: new Map(),
  sourceState: null,
  targetState: null,
  loading: false,
  error: null,
};

let containerEl: HTMLElement | null = null;
let callbacks: ConflictResolverCallbacks | null = null;
let currentRepoId = '';
let currentPrNumber = 0;

// ==================== Init ====================

/**
 * Initialize conflict resolver for a PR with merge conflicts.
 */
export async function initConflictResolver(
  repoId: string,
  prNumber: number,
  conflicts: ConflictEntry[],
  container: HTMLElement,
  cbs: ConflictResolverCallbacks
): Promise<void> {
  currentRepoId = repoId;
  currentPrNumber = prNumber;
  containerEl = container;
  callbacks = cbs;

  state = {
    conflicts,
    resolutions: new Map(),
    sourceState: null,
    targetState: null,
    loading: false,
    error: null,
  };

  render();
}

/**
 * Initialize from a PR that needs conflict resolution.
 * Fetches conflict data automatically.
 */
export async function initFromPR(
  repoId: string,
  prNumber: number,
  container: HTMLElement,
  cbs: ConflictResolverCallbacks
): Promise<void> {
  currentRepoId = repoId;
  currentPrNumber = prNumber;
  containerEl = container;
  callbacks = cbs;

  state = { ...state, loading: true, error: null };
  render();

  try {
    // Try to merge and catch conflict info
    const mergeResult = await prApi.canMerge(repoId, prNumber);
    if (mergeResult.mergeable) {
      state = { ...state, loading: false, error: 'No conflicts detected — PR is mergeable' };
      render();
      return;
    }

    // Try to get diff to detect conflicts
    const diff = await prApi.getDiff(repoId, prNumber);
    const conflicts = detectConflictsFromDiff(diff);

    state = {
      conflicts,
      resolutions: new Map(),
      sourceState: null,
      targetState: null,
      loading: false,
      error: null,
    };
  } catch (err) {
    state = { ...state, loading: false, error: (err as Error).message };
  }

  render();
}

// ==================== Conflict Detection ====================

function detectConflictsFromDiff(diff: DeckPatchOp[]): ConflictEntry[] {
  // Group changes by card
  const cardChanges = new Map<string, DeckPatchOp[]>();
  for (const op of diff) {
    const key = `${op.board || 'unknown'}:${op.name || 'meta'}`;
    if (!cardChanges.has(key)) cardChanges.set(key, []);
    cardChanges.get(key)!.push(op);
  }

  // Cards with multiple conflicting operations are conflicts
  const conflicts: ConflictEntry[] = [];
  for (const [key, ops] of cardChanges) {
    if (ops.length > 1) {
      const [board, cardName] = key.split(':');
      conflicts.push({
        board,
        cardName,
        sourceState: extractState(ops, 'source'),
        targetState: extractState(ops, 'target'),
      });
    }
  }

  return conflicts;
}

function extractState(ops: DeckPatchOp[], _side: 'source' | 'target'): CardConflictState {
  const lastOp = ops[ops.length - 1];
  return {
    qty: (lastOp.qty as number) || 1,
    tags: [],
    present: lastOp.op !== 'remove_card',
  };
}

// ==================== Render ====================

function render(): void {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  if (state.loading) {
    containerEl.appendChild(h('div', { className: 'conflict-resolver__loading' }, 'Detecting conflicts...'));
    return;
  }

  if (state.error) {
    containerEl.appendChild(h('div', { className: 'conflict-resolver__error' }, state.error));
    return;
  }

  // Header
  const header = h('div', { className: 'conflict-resolver__header' },
    h('h3', {}, `Resolve ${state.conflicts.length} Conflict(s)`),
    h('p', { className: 'conflict-resolver__help' },
      'Choose how to resolve each conflict: keep source changes, target changes, or both.'),
  );

  // Progress
  const resolved = state.resolutions.size;
  const total = state.conflicts.length;
  const progress = h('div', { className: 'conflict-resolver__progress' },
    h('div', { className: 'conflict-resolver__progress-bar' },
      h('div', {
        className: 'conflict-resolver__progress-fill',
        style: `width: ${total > 0 ? (resolved / total) * 100 : 0}%`,
      }),
    ),
    h('span', {}, `${resolved}/${total} resolved`),
  );

  // Conflict list
  const list = h('div', { className: 'conflict-resolver__list' });
  for (const conflict of state.conflicts) {
    list.appendChild(renderConflict(conflict));
  }

  // Actions
  const actions = h('div', { className: 'conflict-resolver__actions' },
    h('button', {
      className: 'conflict-resolver__resolve-all-source',
      onClick: () => resolveAll('source'),
    }, 'All → Source'),
    h('button', {
      className: 'conflict-resolver__resolve-all-target',
      onClick: () => resolveAll('target'),
    }, 'All → Target'),
    h('button', {
      className: `conflict-resolver__submit ${resolved === total ? '' : 'conflict-resolver__submit--disabled'}`,
      disabled: resolved !== total,
      onClick: submitResolutions,
 }, resolved === total ? ' Apply Resolution' : `${total - resolved} remaining`),
    h('button', {
      className: 'conflict-resolver__cancel',
      onClick: () => callbacks?.onCancel(),
    }, 'Cancel'),
  );

  containerEl.append(header, progress, list, actions);
}

function renderConflict(conflict: ConflictEntry): HTMLElement {
  const key = `${conflict.board}:${conflict.cardName}`;
  const currentResolution = state.resolutions.get(key);

  return h('div', {
    className: `conflict-resolver__conflict ${currentResolution ? 'conflict-resolver__conflict--resolved' : ''}`,
  },
    h('div', { className: 'conflict-resolver__conflict-header' },
      h('span', { className: 'conflict-resolver__card-name' }, conflict.cardName),
      h('span', { className: 'conflict-resolver__board' }, conflict.board),
      currentResolution
 ? h('span', { className: 'conflict-resolver__resolved-badge' }, ` ${currentResolution}`)
        : null,
    ),
    h('div', { className: 'conflict-resolver__sides' },
      // Source side
      h('div', {
        className: `conflict-resolver__side conflict-resolver__side--source ${currentResolution === 'source' ? 'conflict-resolver__side--selected' : ''}`,
        onClick: () => setResolution(key, 'source'),
      },
        h('h4', {}, '← Source (Incoming)'),
        conflict.sourceState.present
          ? h('div', {},
              h('span', {}, `Qty: ${conflict.sourceState.qty}`),
              conflict.sourceState.tags.length > 0
                ? h('span', {}, `Tags: ${conflict.sourceState.tags.join(', ')}`)
                : null,
            )
          : h('span', { className: 'conflict-resolver__removed' }, 'Card removed'),
      ),
      // Target side
      h('div', {
        className: `conflict-resolver__side conflict-resolver__side--target ${currentResolution === 'target' ? 'conflict-resolver__side--selected' : ''}`,
        onClick: () => setResolution(key, 'target'),
      },
        h('h4', {}, 'Target (Current) →'),
        conflict.targetState.present
          ? h('div', {},
              h('span', {}, `Qty: ${conflict.targetState.qty}`),
              conflict.targetState.tags.length > 0
                ? h('span', {}, `Tags: ${conflict.targetState.tags.join(', ')}`)
                : null,
            )
          : h('span', { className: 'conflict-resolver__removed' }, 'Card removed'),
      ),
      // Both option
      conflict.sourceState.present && conflict.targetState.present
        ? h('div', {
            className: `conflict-resolver__side conflict-resolver__side--both ${currentResolution === 'both' ? 'conflict-resolver__side--selected' : ''}`,
            onClick: () => setResolution(key, 'both'),
          },
            h('h4', {}, 'Keep Both'),
            h('span', {}, `Qty: ${conflict.sourceState.qty + conflict.targetState.qty}`),
          )
        : null,
    ),
  );
}

// ==================== Actions ====================

function setResolution(key: string, resolution: Resolution): void {
  state.resolutions.set(key, resolution);
  render();
}

function resolveAll(resolution: Resolution): void {
  for (const conflict of state.conflicts) {
    const key = `${conflict.board}:${conflict.cardName}`;
    state.resolutions.set(key, resolution);
  }
  render();
}

async function submitResolutions(): Promise<void> {
  if (state.resolutions.size !== state.conflicts.length) return;

  const resolutions: ResolvedConflict[] = state.conflicts.map(conflict => {
    const key = `${conflict.board}:${conflict.cardName}`;
    return {
      board: conflict.board,
      cardName: conflict.cardName,
      resolution: state.resolutions.get(key) || 'target',
    };
  });

  const message = `Resolve ${resolutions.length} merge conflict(s)`;

  try {
    await prApi.resolve(currentRepoId, currentPrNumber, resolutions, message);
    callbacks?.onResolve(resolutions, message);
  } catch (err) {
    console.error('[conflict-resolver] Failed:', err);
    state.error = (err as Error).message;
    render();
  }
}

// ==================== Exports ====================

export function getResolverState(): ResolverState {
  return { ...state, resolutions: new Map(state.resolutions) };
}
