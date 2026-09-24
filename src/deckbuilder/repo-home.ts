// ============================================================
// Repo Home — Branch selector, PR badges, recent commits
// ============================================================
// Main repo overview UI. Shows branch selector in header,
// recent commits, open PR count, and collaborator avatars.
// ============================================================

import { h } from '../shared/dom.js';
import { repoApi, branchApi, commitApi, prApi, collaboratorApi } from './repo-api.js';
import type { Repo, Branch, Commit, PullRequest, Collaborator } from './repo-api.js';

// ==================== Types ====================

export interface RepoHomeState {
  repo: Repo | null;
  branches: Branch[];
  currentBranch: Branch | null;
  recentCommits: Commit[];
  openPRs: PullRequest[];
  collaborators: Collaborator[];
  loading: boolean;
  error: string | null;
}

export interface RepoHomeCallbacks {
  onBranchSwitch: (branch: Branch) => void;
  onCreateBranch: (name: string, fromBranchId: string) => void;
  onNavigate: (tab: 'commits' | 'pulls' | 'issues' | 'releases' | 'settings') => void;
  onCommitRestore: (commitId: string) => void;
}

// ==================== State ====================

let state: RepoHomeState = {
  repo: null,
  branches: [],
  currentBranch: null,
  recentCommits: [],
  openPRs: [],
  collaborators: [],
  loading: false,
  error: null,
};

let callbacks: RepoHomeCallbacks | null = null;
let containerEl: HTMLElement | null = null;

// ==================== Init ====================

/**
 * Initialize repo home with a repo ID.
 */
export async function initRepoHome(
  repoId: string,
  container: HTMLElement,
  cbs: RepoHomeCallbacks
): Promise<void> {
  callbacks = cbs;
  containerEl = container;
  state = { ...state, loading: true, error: null };
  render();

  try {
    const [repo, branches, openPRs, collaborators] = await Promise.all([
      repoApi.get(repoId),
      branchApi.list(repoId),
      prApi.list(repoId, 'open'),
      collaboratorApi.list(repoId).catch(() => [] as Collaborator[]),
    ]);

    const defaultBranch = branches.find(b => b.name === repo.default_branch) || branches[0] || null;
    let recentCommits: Commit[] = [];
    if (defaultBranch?.id) {
      recentCommits = await commitApi.list(repoId, defaultBranch.id, 10);
    }

    state = {
      repo,
      branches,
      currentBranch: defaultBranch,
      recentCommits,
      openPRs,
      collaborators,
      loading: false,
      error: null,
    };
  } catch (err) {
    state = { ...state, loading: false, error: (err as Error).message };
  }

  render();
}

/**
 * Switch to a different branch.
 */
export async function switchBranch(branchId: string): Promise<void> {
  if (!state.repo) return;

  const branch = state.branches.find(b => b.id === branchId);
  if (!branch) return;

  state.currentBranch = branch;

  try {
    state.recentCommits = await commitApi.list(state.repo.id, branchId, 10);
  } catch {
    state.recentCommits = [];
  }

  callbacks?.onBranchSwitch(branch);
  render();
}

// ==================== Render ====================

function render(): void {
  if (!containerEl) return;
  containerEl.innerHTML = '';

  if (state.loading) {
    containerEl.appendChild(h('div', { className: 'repo-home__loading' }, 'Loading repository...'));
    return;
  }

  if (state.error) {
    containerEl.appendChild(h('div', { className: 'repo-home__error' }, `Error: ${state.error}`));
    return;
  }

  if (!state.repo) return;

  // Header
  const header = h('div', { className: 'repo-home__header' },
    h('h2', { className: 'repo-home__title' }, state.repo.name),
    state.repo.description
      ? h('p', { className: 'repo-home__desc' }, state.repo.description)
      : null,
    h('div', { className: 'repo-home__meta' },
      h('span', { className: 'repo-home__format' }, state.repo.format),
      h('span', { className: 'repo-home__visibility' }, state.repo.visibility),
      state.repo.upstream_repo_id
 ? h('span', { className: 'repo-home__fork-badge' }, 'Fork')
        : null,
    ),
  );

  // Branch selector
  const branchSelector = renderBranchSelector();

  // Navigation tabs
  const nav = h('nav', { className: 'repo-home__nav' },
    makeNavTab('Commits', 'commits', `${state.recentCommits.length}`),
    makeNavTab('Pull Requests', 'pulls', `${state.openPRs.length}`),
    makeNavTab('Issues', 'issues'),
    makeNavTab('Releases', 'releases'),
    makeNavTab('Settings', 'settings'),
  );

  // Recent commits
  const commitsSection = renderRecentCommits();

  // Collaborators
  const collabSection = renderCollaborators();

  // Open PRs summary
  const prSection = renderOpenPRs();

  containerEl.append(header, branchSelector, nav, commitsSection, prSection, collabSection);
}

function renderBranchSelector(): HTMLElement {
  const select = document.createElement('select');
  select.className = 'repo-home__branch-select';

  for (const branch of state.branches) {
    const opt = document.createElement('option');
    opt.value = branch.id;
    opt.textContent = `${branch.isProtected ? '' : ''}${branch.name}`;
    opt.selected = branch.id === state.currentBranch?.id;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    switchBranch(select.value);
  });

  const createBtn = h('button', {
    className: 'repo-home__new-branch-btn',
    onClick: () => {
      const name = prompt('Branch name:');
      if (name && state.currentBranch) {
        callbacks?.onCreateBranch(name, state.currentBranch.id);
      }
    },
  }, '+ New Branch');

  return h('div', { className: 'repo-home__branch-bar' },
    h('span', { className: 'repo-home__branch-icon' }, '⑂'),
    select,
    createBtn,
  );
}

function renderRecentCommits(): HTMLElement {
  const items = state.recentCommits.slice(0, 5).map(commit => {
    const timeAgo = formatTimeAgo(commit.createdAt);
    return h('div', { className: 'repo-home__commit-item' },
      h('div', { className: 'repo-home__commit-msg' }, commit.message),
      h('div', { className: 'repo-home__commit-meta' },
        h('span', {}, commit.authorName),
        h('span', {}, timeAgo),
        h('span', { className: 'repo-home__commit-hash' }, commit.id.slice(0, 7)),
      ),
    );
  });

  return h('div', { className: 'repo-home__section' },
    h('h3', { className: 'repo-home__section-title' }, 'Recent Commits'),
    items.length > 0
      ? h('div', { className: 'repo-home__commit-list' }, ...items)
      : h('div', { className: 'repo-home__empty' }, 'No commits yet'),
  );
}

function renderOpenPRs(): HTMLElement {
  if (state.openPRs.length === 0) {
    return h('div', { className: 'repo-home__section' },
      h('h3', { className: 'repo-home__section-title' }, 'Pull Requests'),
      h('div', { className: 'repo-home__empty' }, 'No open pull requests'),
    );
  }

  const items = state.openPRs.slice(0, 5).map(pr =>
    h('div', {
      className: 'repo-home__pr-item',
      onClick: () => callbacks?.onNavigate('pulls'),
    },
      h('span', { className: 'repo-home__pr-number' }, `#${pr.number}`),
      h('span', { className: 'repo-home__pr-title' }, pr.title),
      h('span', { className: 'repo-home__pr-author' }, pr.authorName),
    )
  );

  return h('div', { className: 'repo-home__section' },
    h('h3', { className: 'repo-home__section-title' },
      `Pull Requests (${state.openPRs.length} open)`),
    h('div', { className: 'repo-home__pr-list' }, ...items),
  );
}

function renderCollaborators(): HTMLElement {
  if (state.collaborators.length === 0) return document.createElement('div');

  const avatars = state.collaborators.map(c =>
    h('div', {
      className: 'repo-home__avatar',
      title: `${c.userId} (${c.role})`,
    }, c.userId.slice(0, 2).toUpperCase())
  );

  return h('div', { className: 'repo-home__section' },
    h('h3', { className: 'repo-home__section-title' }, 'Collaborators'),
    h('div', { className: 'repo-home__avatar-row' }, ...avatars),
  );
}

function makeNavTab(
  label: string,
  tab: 'commits' | 'pulls' | 'issues' | 'releases' | 'settings',
  badge?: string
): HTMLElement {
  return h('button', {
    className: 'repo-home__nav-tab',
    onClick: () => callbacks?.onNavigate(tab),
  },
    label,
    badge ? h('span', { className: 'repo-home__nav-badge' }, badge) : null,
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

export function getRepoHomeState(): RepoHomeState {
  return { ...state };
}

export function getCurrentBranch(): Branch | null {
  return state.currentBranch;
}

export function getRepo(): Repo | null {
  return state.repo;
}
