// ============================================================
// PR Page — Pull Request detail view
// ============================================================
// Full PR detail with conversation, changes (diff), checks,
// review bar, merge button with strategy dropdown.
// ============================================================

import { h } from '../shared/dom.js';
import {
  prApi, reviewApi, commentApi, checksApi,
} from './repo-api.js';
import type {
  PullRequest, Review, PRComment, CheckRun,
  DeckPatchOp, MergeResult,
} from './repo-api.js';

// ==================== Types ====================

export type PRTab = 'conversation' | 'changes' | 'checks';

export interface PRPageCallbacks {
  onMerge: (result: MergeResult) => void;
  onClose: () => void;
  onResolveConflicts: (prNumber: number) => void;
  onBack: () => void;
}

interface PRPageState {
  pr: PullRequest | null;
  reviews: Review[];
  comments: PRComment[];
  checks: CheckRun[];
  diff: DeckPatchOp[];
  mergeability: { mergeable: boolean; reasons: string[] } | null;
  activeTab: PRTab;
  loading: boolean;
  error: string | null;
}

// ==================== State ====================

let state: PRPageState = {
  pr: null,
  reviews: [],
  comments: [],
  checks: [],
  diff: [],
  mergeability: null,
  activeTab: 'conversation',
  loading: false,
  error: null,
};

let repoId = '';
let containerEl: HTMLElement | null = null;
let callbacks: PRPageCallbacks | null = null;

// ==================== Init ====================

/**
 * Load and render a PR detail page.
 */
export async function initPRPage(
  _repoId: string,
  prNumber: number,
  container: HTMLElement,
  cbs: PRPageCallbacks
): Promise<void> {
  repoId = _repoId;
  containerEl = container;
  callbacks = cbs;
  state = { ...state, loading: true, error: null };
  render();

  try {
    const [pr, reviews, comments, checks, diff, mergeability] = await Promise.all([
      prApi.get(repoId, prNumber),
      reviewApi.list(repoId, prNumber),
      commentApi.list(repoId, prNumber),
      checksApi.list(repoId, prNumber),
      prApi.getDiff(repoId, prNumber).catch(() => [] as DeckPatchOp[]),
      prApi.canMerge(repoId, prNumber).catch(() => ({ mergeable: false, reasons: ['Unable to check'] })),
    ]);

    state = {
      pr,
      reviews,
      comments,
      checks,
      diff,
      mergeability,
      activeTab: 'conversation',
      loading: false,
      error: null,
    };
  } catch (err) {
    state = { ...state, loading: false, error: (err as Error).message };
  }

  render();
}

// ==================== Render ====================

function render(): void {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  if (state.loading) {
    containerEl.appendChild(h('div', { className: 'pr-page__loading' }, 'Loading PR...'));
    return;
  }

  if (state.error || !state.pr) {
    containerEl.appendChild(h('div', { className: 'pr-page__error' }, state.error || 'PR not found'));
    return;
  }

  const pr = state.pr;

  // Back button + header
  const header = h('div', { className: 'pr-page__header' },
    h('button', {
      className: 'pr-page__back-btn',
      onClick: () => callbacks?.onBack(),
    }, '← Back'),
    h('div', { className: 'pr-page__title-row' },
      h('span', { className: `pr-page__status pr-page__status--${pr.status}` },
        pr.status === 'merged' ? '🟣 Merged' : pr.status === 'open' ? '🟢 Open' : '🔴 Closed'),
      h('h2', { className: 'pr-page__title' }, `#${pr.number} ${pr.title}`),
    ),
    h('p', { className: 'pr-page__desc' }, pr.description || 'No description'),
    h('div', { className: 'pr-page__meta' },
      h('span', {}, `by ${pr.authorName}`),
      h('span', {}, `created ${formatTimeAgo(pr.createdAt)}`),
      pr.mergedAt ? h('span', {}, `merged ${formatTimeAgo(pr.mergedAt)}`) : null,
    ),
    pr.labels.length > 0
      ? h('div', { className: 'pr-page__labels' },
          ...pr.labels.map(l => h('span', { className: 'pr-page__label' }, l)))
      : null,
  );

  // Tabs
  const tabs = h('div', { className: 'pr-page__tabs' },
    makeTab('Conversation', 'conversation', state.comments.length),
    makeTab('Changes', 'changes', state.diff.length),
    makeTab('Checks', 'checks', state.checks.length),
  );

  // Tab content
  let content: HTMLElement;
  switch (state.activeTab) {
    case 'conversation': content = renderConversation(); break;
    case 'changes': content = renderChanges(); break;
    case 'checks': content = renderChecks(); break;
  }

  // Merge bar (only for open PRs)
  const mergeBar = pr.status === 'open' ? renderMergeBar() : null;

  containerEl.append(header, tabs, content);
  if (mergeBar) containerEl.appendChild(mergeBar);
}

function renderConversation(): HTMLElement {
  const container = h('div', { className: 'pr-page__conversation' });

  // Reviews
  for (const review of state.reviews) {
    const stateIcon = review.state === 'APPROVED' ? '✅' :
      review.state === 'CHANGES_REQUESTED' ? '🔄' : '💬';

    container.appendChild(h('div', { className: `pr-page__review pr-page__review--${review.state.toLowerCase()}` },
      h('div', { className: 'pr-page__review-header' },
        h('span', {}, stateIcon),
        h('strong', {}, review.reviewerName),
        h('span', {}, review.state.replace('_', ' ').toLowerCase()),
        h('span', { className: 'pr-page__time' }, formatTimeAgo(review.createdAt)),
      ),
      review.body ? h('div', { className: 'pr-page__review-body' }, review.body) : null,
    ));
  }

  // Comments
  for (const comment of state.comments) {
    container.appendChild(h('div', { className: 'pr-page__comment' },
      h('div', { className: 'pr-page__comment-header' },
        h('strong', {}, comment.authorName),
        h('span', { className: 'pr-page__time' }, formatTimeAgo(comment.createdAt)),
        comment.path
          ? h('span', { className: 'pr-page__comment-path' }, `on ${comment.path}`)
          : null,
      ),
      h('div', { className: 'pr-page__comment-body' }, comment.body),
    ));
  }

  if (state.reviews.length === 0 && state.comments.length === 0) {
    container.appendChild(h('div', { className: 'pr-page__empty' }, 'No conversation yet'));
  }

  // Add comment form
  const textarea = document.createElement('textarea');
  textarea.className = 'pr-page__comment-input';
  textarea.placeholder = 'Leave a comment...';
  textarea.rows = 3;

  const submitBtn = h('button', {
    className: 'pr-page__comment-submit',
    onClick: async () => {
      const body = textarea.value.trim();
      if (!body || !state.pr) return;
      try {
        await commentApi.add(repoId, state.pr.number, body);
        textarea.value = '';
        // Refresh comments
        state.comments = await commentApi.list(repoId, state.pr.number);
        render();
      } catch (err) {
        console.error('[pr-page] Comment failed:', err);
      }
    },
  }, 'Comment');

  // Review buttons
  const reviewBar = state.pr?.status === 'open' ? h('div', { className: 'pr-page__review-bar' },
    h('button', {
      className: 'pr-page__review-btn pr-page__review-btn--approve',
      onClick: () => submitReview('APPROVED'),
    }, '✅ Approve'),
    h('button', {
      className: 'pr-page__review-btn pr-page__review-btn--request-changes',
      onClick: () => submitReview('CHANGES_REQUESTED'),
    }, '🔄 Request Changes'),
  ) : null;

  container.append(
    h('div', { className: 'pr-page__comment-form' }, textarea, submitBtn),
  );
  if (reviewBar) container.appendChild(reviewBar);

  return container;
}

function renderChanges(): HTMLElement {
  const container = h('div', { className: 'pr-page__changes' });

  if (state.diff.length === 0) {
    container.appendChild(h('div', { className: 'pr-page__empty' }, 'No changes'));
    return container;
  }

  // Group patches by type
  const adds = state.diff.filter(p => p.op === 'add_card');
  const removes = state.diff.filter(p => p.op === 'remove_card');
  const updates = state.diff.filter(p => p.op === 'update_qty');
  const moves = state.diff.filter(p => p.op === 'move_card');
  const tagChanges = state.diff.filter(p => p.op === 'set_tag');
  const metaChanges = state.diff.filter(p => p.op === 'set_meta');

  // Summary
  container.appendChild(h('div', { className: 'pr-page__diff-summary' },
    h('span', { className: 'pr-page__diff-add' }, `+${adds.length} added`),
    h('span', { className: 'pr-page__diff-remove' }, `-${removes.length} removed`),
    updates.length > 0 ? h('span', { className: 'pr-page__diff-update' }, `~${updates.length} updated`) : null,
    moves.length > 0 ? h('span', {}, `${moves.length} moved`) : null,
  ));

  // Detailed diff
  for (const patch of state.diff) {
    container.appendChild(renderPatchLine(patch));
  }

  return container;
}

function renderPatchLine(patch: DeckPatchOp): HTMLElement {
  let icon: string;
  let text: string;
  let cls: string;

  switch (patch.op) {
    case 'add_card':
      icon = '+'; cls = 'pr-page__diff-line--add';
      text = `${patch.qty || 1}x ${patch.name} → ${patch.board}`;
      break;
    case 'remove_card':
      icon = '-'; cls = 'pr-page__diff-line--remove';
      text = `${patch.qty || 1}x ${patch.name} from ${patch.board}`;
      break;
    case 'update_qty':
      icon = '~'; cls = 'pr-page__diff-line--update';
      text = `${patch.name}: qty ${(patch as unknown as { oldQty: number }).oldQty} → ${(patch as unknown as { newQty: number }).newQty}`;
      break;
    case 'move_card':
      icon = '→'; cls = 'pr-page__diff-line--move';
      text = `${patch.name}: ${(patch as unknown as { fromBoard: string }).fromBoard} → ${(patch as unknown as { toBoard: string }).toBoard}`;
      break;
    case 'set_tag':
      icon = '#'; cls = 'pr-page__diff-line--tag';
      text = `${patch.name}: tag ${(patch as unknown as { tag: string }).tag} = ${(patch as unknown as { value: boolean }).value}`;
      break;
    case 'set_meta':
      icon = 'ⓘ'; cls = 'pr-page__diff-line--meta';
      text = `meta.${(patch as unknown as { key: string }).key} = ${(patch as unknown as { value: string }).value}`;
      break;
    default:
      icon = '?'; cls = ''; text = JSON.stringify(patch);
  }

  return h('div', { className: `pr-page__diff-line ${cls}` },
    h('span', { className: 'pr-page__diff-icon' }, icon),
    h('span', { className: 'pr-page__diff-text' }, text),
  );
}

function renderChecks(): HTMLElement {
  const container = h('div', { className: 'pr-page__checks' });

  if (state.checks.length === 0) {
    container.appendChild(h('div', { className: 'pr-page__empty' }, 'No checks configured'));

    if (state.pr?.status === 'open') {
      container.appendChild(h('button', {
        className: 'pr-page__run-checks-btn',
        onClick: async () => {
          if (!state.pr) return;
          try {
            state.checks = await checksApi.run(repoId, state.pr.number);
            render();
          } catch (err) {
            console.error('[pr-page] Run checks failed:', err);
          }
        },
      }, '▶ Run Checks'));
    }
    return container;
  }

  for (const check of state.checks) {
    const statusIcon = check.status === 'pass' ? '✅' :
      check.status === 'fail' ? '❌' :
      check.status === 'running' ? '⏳' :
      check.status === 'error' ? '⚠️' : '⏸️';

    const checkEl = h('div', { className: `pr-page__check pr-page__check--${check.status}` },
      h('div', { className: 'pr-page__check-header' },
        h('span', {}, statusIcon),
        h('strong', {}, check.checkName),
        h('span', { className: `pr-page__check-status` }, check.status),
      ),
    );

    if (check.report) {
      checkEl.appendChild(h('div', { className: 'pr-page__check-summary' }, check.report.summary));
      if (check.report.details.length > 0) {
        const details = h('ul', { className: 'pr-page__check-details' });
        for (const d of check.report.details) {
          details.appendChild(h('li', {
            className: `pr-page__check-detail--${d.severity}`,
          }, d.message));
        }
        checkEl.appendChild(details);
      }
    }

    container.appendChild(checkEl);
  }

  return container;
}

function renderMergeBar(): HTMLElement {
  const canMerge = state.mergeability?.mergeable ?? false;
  const reasons = state.mergeability?.reasons ?? [];

  const approvals = state.reviews.filter(r => r.state === 'APPROVED').length;
  const changesRequested = state.reviews.some(r => r.state === 'CHANGES_REQUESTED');
  const allChecksPass = state.checks.length > 0 && state.checks.every(c => c.status === 'pass');

  // Merge strategy selector
  const strategySelect = document.createElement('select');
  strategySelect.className = 'pr-page__merge-strategy';
  for (const [value, label] of [['squash', 'Squash & Merge'], ['merge', 'Create Merge Commit'], ['rebase', 'Rebase & Merge']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    strategySelect.appendChild(opt);
  }

  return h('div', { className: `pr-page__merge-bar ${canMerge ? 'pr-page__merge-bar--ready' : 'pr-page__merge-bar--blocked'}` },
    h('div', { className: 'pr-page__merge-status' },
      h('div', { className: 'pr-page__merge-checks' },
        h('span', {}, `Reviews: ${approvals} approvals`),
        changesRequested ? h('span', { className: 'pr-page__merge-warning' }, '⚠ Changes requested') : null,
        h('span', {}, `Checks: ${allChecksPass ? '✅ All passed' : state.checks.length === 0 ? '— None' : '❌ Some failing'}`),
      ),
      !canMerge && reasons.length > 0
        ? h('div', { className: 'pr-page__merge-reasons' },
            ...reasons.map(r => h('span', { className: 'pr-page__merge-reason' }, r)))
        : null,
    ),
    h('div', { className: 'pr-page__merge-actions' },
      strategySelect,
      h('button', {
        className: `pr-page__merge-btn ${canMerge ? '' : 'pr-page__merge-btn--disabled'}`,
        disabled: !canMerge,
        onClick: async () => {
          if (!state.pr || !canMerge) return;
          try {
            const result = await prApi.merge(repoId, state.pr.number, strategySelect.value);
            callbacks?.onMerge(result);
          } catch (err) {
            console.error('[pr-page] Merge failed:', err);
            // Check if it's a conflict
            if ((err as Error).message.includes('conflict')) {
              callbacks?.onResolveConflicts(state.pr.number);
            }
          }
        },
      }, canMerge ? '🔀 Merge PR' : '🚫 Cannot Merge'),
      h('button', {
        className: 'pr-page__close-btn',
        onClick: async () => {
          if (!state.pr) return;
          try {
            await prApi.close(repoId, state.pr.number);
            callbacks?.onClose();
          } catch (err) {
            console.error('[pr-page] Close failed:', err);
          }
        },
      }, 'Close PR'),
    ),
  );
}

// ==================== Actions ====================

async function submitReview(reviewState: 'APPROVED' | 'CHANGES_REQUESTED'): Promise<void> {
  if (!state.pr) return;
  const body = prompt(`Review comment (${reviewState.replace('_', ' ').toLowerCase()}):`) || '';
  try {
    await reviewApi.add(repoId, state.pr.number, reviewState, body);
    state.reviews = await reviewApi.list(repoId, state.pr.number);
    state.mergeability = await prApi.canMerge(repoId, state.pr.number).catch(() => null);
    render();
  } catch (err) {
    console.error('[pr-page] Review failed:', err);
  }
}

function makeTab(label: string, tab: PRTab, count?: number): HTMLElement {
  return h('button', {
    className: `pr-page__tab ${state.activeTab === tab ? 'pr-page__tab--active' : ''}`,
    onClick: () => {
      state.activeTab = tab;
      render();
    },
  },
    label,
    count !== undefined ? h('span', { className: 'pr-page__tab-count' }, `${count}`) : null,
  );
}

// ==================== Helpers ====================

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ==================== Exports ====================

export function getPRPageState(): PRPageState {
  return { ...state };
}
