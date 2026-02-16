// ============================================================
// Commit History — Chronological commit log with diff viewer
// ============================================================
// Displays git-like commit history, click-to-diff, revert,
// and time-travel to any point in deck history.
// ============================================================

import { h } from '../shared/dom.js';
import { commitApi, type Commit, type DeckPatchOp, type DeckState } from './repo-api.js';

// ==================== Types ====================

export interface CommitHistoryOptions {
  repoId: string;
  branchId: string;
  container: HTMLElement;
  onRestore?: (state: DeckState) => void;
  onDiffView?: (patch: DeckPatchOp[]) => void;
}

// ==================== Render ====================

/**
 * Render the commit history panel.
 */
export async function renderCommitHistory(options: CommitHistoryOptions): Promise<void> {
  const { repoId, branchId, container, onRestore, onDiffView } = options;

  container.innerHTML = '';
  container.appendChild(h('div', { className: 'commit-history__loading' }, 'Loading history...'));

  try {
    const commits = await commitApi.list(repoId, branchId, 50, 0);

    container.innerHTML = '';

    if (commits.length === 0) {
      container.appendChild(h('div', { className: 'commit-history__empty' }, 'No commits yet'));
      return;
    }

    const header = h('div', { className: 'commit-history__header' },
      h('h3', {}, `Commit History (${commits.length})`),
    );
    container.appendChild(header);

    const list = h('div', { className: 'commit-history__list' });

    for (const commit of commits) {
      const item = renderCommitItem(commit, repoId, branchId, onRestore, onDiffView);
      list.appendChild(item);
    }

    container.appendChild(list);
  } catch (e) {
    container.innerHTML = '';
    container.appendChild(h('div', { className: 'commit-history__error' },
      `Failed to load history: ${e instanceof Error ? e.message : 'Unknown error'}`
    ));
  }
}

function renderCommitItem(
  commit: Commit,
  repoId: string,
  branchId: string,
  onRestore?: (state: DeckState) => void,
  onDiffView?: (patch: DeckPatchOp[]) => void
): HTMLElement {
  const date = new Date(commit.createdAt);
  const timeAgo = formatTimeAgo(date);
  const isMerge = !!commit.parentId && commit.message.startsWith('Merge');

  const patchSummary = summarizePatch(commit.patch);

  return h('div', { className: `commit-history__item ${isMerge ? 'commit-history__item--merge' : ''}` },
    h('div', { className: 'commit-history__dot' }),
    h('div', { className: 'commit-history__content' },
      h('div', { className: 'commit-history__message' }, commit.message),
      h('div', { className: 'commit-history__meta' },
        h('span', { className: 'commit-history__author' }, commit.authorName),
        h('span', { className: 'commit-history__time' }, timeAgo),
        h('span', { className: 'commit-history__id' }, commit.id.slice(0, 8)),
      ),
      patchSummary.length > 0
        ? h('div', { className: 'commit-history__summary' }, patchSummary)
        : null,
      h('div', { className: 'commit-history__actions' },
        h('button', {
          className: 'btn btn--small',
          onClick: async () => {
            if (onDiffView) onDiffView(commit.patch);
          },
        }, 'View Diff'),
        onRestore
          ? h('button', {
              className: 'btn btn--small',
              onClick: async () => {
                try {
                  const state = await commitApi.getState(repoId, commit.id);
                  onRestore(state);
                } catch (e) {
                  console.error('Failed to restore state:', e);
                }
              },
            }, 'Restore')
          : null,
        h('button', {
          className: 'btn btn--small btn--danger',
          onClick: async () => {
            try {
              await commitApi.revert(repoId, commit.id, branchId);
              // Refresh the history
              const container = document.querySelector('.commit-history__list');
              if (container?.parentElement) {
                await renderCommitHistory({
                  repoId, branchId,
                  container: container.parentElement as HTMLElement,
                  onRestore, onDiffView,
                });
              }
            } catch (e) {
              console.error('Failed to revert:', e);
            }
          },
        }, 'Revert'),
      ),
    ),
  );
}

// ==================== Helpers ====================

function summarizePatch(patch: DeckPatchOp[]): string {
  const adds = patch.filter(p => p.op === 'add_card').length;
  const removes = patch.filter(p => p.op === 'remove_card').length;
  const updates = patch.filter(p => p.op === 'update_qty').length;
  const moves = patch.filter(p => p.op === 'move_card').length;
  const meta = patch.filter(p => p.op === 'set_meta').length;

  const parts: string[] = [];
  if (adds) parts.push(`+${adds} added`);
  if (removes) parts.push(`-${removes} removed`);
  if (updates) parts.push(`~${updates} updated`);
  if (moves) parts.push(`${moves} moved`);
  if (meta) parts.push(`${meta} meta change(s)`);

  return parts.join(', ');
}

function formatTimeAgo(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) return date.toLocaleDateString();
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}
