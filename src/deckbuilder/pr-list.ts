// ============================================================
// PR List — Pull Request listing with filters
// ============================================================
// Shows open/closed/merged PRs with status badges,
// labels, quick-merge button for eligible PRs.
// ============================================================

import { h } from '../shared/dom.js';
import { prApi, checksApi } from './repo-api.js';
import type { PullRequest, CheckRun } from './repo-api.js';

// ==================== Types ====================

export type PRFilter = 'open' | 'closed' | 'merged' | 'all';

export interface PRListCallbacks {
  onSelectPR: (pr: PullRequest) => void;
  onCreatePR: () => void;
  onQuickMerge: (pr: PullRequest) => void;
}

interface PRListState {
  prs: PullRequest[];
  filter: PRFilter;
  loading: boolean;
  error: string | null;
  checkStatus: Map<number, 'pass' | 'fail' | 'pending' | 'unknown'>;
}

// ==================== State ====================

let state: PRListState = {
  prs: [],
  filter: 'open',
  loading: false,
  error: null,
  checkStatus: new Map(),
};

let repoId: string = '';
let containerEl: HTMLElement | null = null;
let callbacks: PRListCallbacks | null = null;

// ==================== Init ====================

/**
 * Initialize the PR list for a repo.
 */
export async function initPRList(
  _repoId: string,
  container: HTMLElement,
  cbs: PRListCallbacks
): Promise<void> {
  repoId = _repoId;
  containerEl = container;
  callbacks = cbs;
  await loadPRs('open');
}

/**
 * Load PRs with a specific filter.
 */
export async function loadPRs(filter: PRFilter): Promise<void> {
  state = { ...state, filter, loading: true, error: null };
  render();

  try {
    const status = filter === 'all' ? undefined : filter === 'merged' ? 'merged' : filter;
    const prs = await prApi.list(repoId, status);

    // Filter merged PRs locally if needed (API may not support merged filter)
    let filtered = prs;
    if (filter === 'merged') {
      filtered = prs.filter(pr => pr.status === 'merged');
    }

    state = { ...state, prs: filtered, loading: false };

    // Load check status for open PRs in background
    if (filter === 'open') {
      loadCheckStatuses(filtered);
    }
  } catch (err) {
    state = { ...state, loading: false, error: (err as Error).message };
  }

  render();
}

async function loadCheckStatuses(prs: PullRequest[]): Promise<void> {
  for (const pr of prs) {
    try {
      const checks = await checksApi.list(repoId, pr.number);
      const allPass = checks.length > 0 && checks.every((c: CheckRun) => c.status === 'pass');
      const anyFail = checks.some((c: CheckRun) => c.status === 'fail' || c.status === 'error');
      const status = checks.length === 0 ? 'unknown' : anyFail ? 'fail' : allPass ? 'pass' : 'pending';
      state.checkStatus.set(pr.number, status);
    } catch {
      state.checkStatus.set(pr.number, 'unknown');
    }
  }
  render();
}

// ==================== Render ====================

function render(): void {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  // Header
  const header = h('div', { className: 'pr-list__header' },
    h('h3', { className: 'pr-list__title' }, 'Pull Requests'),
    h('button', {
      className: 'pr-list__create-btn',
      onClick: () => callbacks?.onCreatePR(),
    }, '+ New PR'),
  );

  // Filter tabs
  const filterBar = h('div', { className: 'pr-list__filters' },
    makeFilterTab('Open', 'open'),
    makeFilterTab('Closed', 'closed'),
    makeFilterTab('Merged', 'merged'),
    makeFilterTab('All', 'all'),
  );

  containerEl.append(header, filterBar);

  if (state.loading) {
    containerEl.appendChild(h('div', { className: 'pr-list__loading' }, 'Loading...'));
    return;
  }

  if (state.error) {
    containerEl.appendChild(h('div', { className: 'pr-list__error' }, state.error));
    return;
  }

  if (state.prs.length === 0) {
    containerEl.appendChild(
      h('div', { className: 'pr-list__empty' },
        `No ${state.filter === 'all' ? '' : state.filter + ' '}pull requests`)
    );
    return;
  }

  // PR items
  const list = h('div', { className: 'pr-list__items' });
  for (const pr of state.prs) {
    list.appendChild(renderPRItem(pr));
  }
  containerEl.appendChild(list);
}

function renderPRItem(pr: PullRequest): HTMLElement {
  const statusIcon = pr.status === 'merged' ? '●' : pr.status === 'open' ? '●' : '●';
  const checkStatus = state.checkStatus.get(pr.number) || 'unknown';
 const checkIcon = checkStatus === 'pass' ? '✓' : checkStatus === 'fail' ? '✕' : checkStatus === 'pending' ? '…' : '';
  const timeAgo = formatTimeAgo(pr.updatedAt || pr.createdAt);

  const item = h('div', {
    className: `pr-list__item pr-list__item--${pr.status}`,
    onClick: () => callbacks?.onSelectPR(pr),
  },
    h('div', { className: 'pr-list__item-header' },
      h('span', { className: 'pr-list__status-icon' }, statusIcon),
      h('span', { className: 'pr-list__pr-title' }, pr.title),
      checkIcon ? h('span', { className: 'pr-list__check-icon' }, checkIcon) : null,
    ),
    h('div', { className: 'pr-list__item-meta' },
      h('span', { className: 'pr-list__pr-number' }, `#${pr.number}`),
      h('span', {}, `by ${pr.authorName}`),
      h('span', {}, timeAgo),
    ),
    pr.labels.length > 0
      ? h('div', { className: 'pr-list__labels' },
          ...pr.labels.map(l => h('span', { className: 'pr-list__label' }, l))
        )
      : null,
    pr.status === 'open' && checkStatus === 'pass'
      ? h('button', {
          className: 'pr-list__quick-merge',
          onClick: (e: Event) => {
            e.stopPropagation();
            callbacks?.onQuickMerge(pr);
          },
        }, 'Merge')
      : null,
  );

  return item;
}

function makeFilterTab(label: string, filter: PRFilter): HTMLElement {
  return h('button', {
    className: `pr-list__filter-tab ${state.filter === filter ? 'pr-list__filter-tab--active' : ''}`,
    onClick: () => loadPRs(filter),
  }, label);
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

export function getPRListState(): PRListState {
  return { ...state };
}

export function refreshPRList(): Promise<void> {
  return loadPRs(state.filter);
}
