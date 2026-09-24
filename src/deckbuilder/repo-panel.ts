// ============================================================
// Repo Panel — Full Git UI integration for the Editor
// ============================================================
// Wires up repo-home, pr-list, pr-page, commit-history,
// conflict-resolver, repo-settings, lines-library,
// cut-assistant, live-validation into the "Repo" tab.
// ============================================================

import { h } from '../shared/dom.js';
import { repoApi, branchApi, commitApi, prApi } from './repo-api.js';
import type { Repo, Branch, Commit, PullRequest } from './repo-api.js';
import type { DeckbuilderDeck, DeckbuilderBoards } from './types.js';
import { getCurrentUser, isLoggedIn, loginWithGitHub, loginWithGoogle } from '../shared/auth.js';

// ==================== Types ====================

type RepoView =
  | 'landing'       // No repo yet — create or link
  | 'home'          // Repo overview with branches + recent commits
  | 'commits'       // Full commit history
  | 'pulls'         // PR list
  | 'pr-detail'     // Single PR
  | 'conflicts'     // Conflict resolver
  | 'settings'      // Repo settings
  | 'lines'         // Combo lines library
  | 'validation';   // Live validation

interface RepoPanelState {
  view: RepoView;
  repoId: string | null;
  repo: Repo | null;
  branches: Branch[];
  currentBranch: Branch | null;
  recentCommits: Commit[];
  openPRs: PullRequest[];
  selectedPR: number | null;
  loading: boolean;
  error: string | null;
}

// ==================== State ====================

let state: RepoPanelState = {
  view: 'landing',
  repoId: null,
  repo: null,
  branches: [],
  currentBranch: null,
  recentCommits: [],
  openPRs: [],
  selectedPR: null,
  loading: false,
  error: null,
};

let rootEl: HTMLElement | null = null;
let deckGetter: (() => DeckbuilderDeck | null) | null = null;

const REPO_STORAGE_KEY = 'DECKLENS_LINKED_REPO';

function getRepoStorageKey(): string {
  const deck = deckGetter?.();
  if (deck?.id) {
    return `dl_repo_${deck.id}`;
  }
  return REPO_STORAGE_KEY;
}

// ==================== Init ====================

/**
 * Initialize the repo panel. Called once from editor-main.
 * @param getDeck Function that returns the current deck state
 */
export function initRepoPanel(getDeck: () => DeckbuilderDeck | null): void {
  rootEl = document.getElementById('repoPanelRoot');
  deckGetter = getDeck;

  // Check if there's a linked repo (prefer deck-specific key)
  const key = getRepoStorageKey();
  const savedRepoId = localStorage.getItem(key);
  if (savedRepoId) {
    state.repoId = savedRepoId;
    loadRepo(savedRepoId);
  } else {
    state.view = 'landing';
    render();
  }
}

/**
 * Called when the Repo tab becomes active.
 */
export function onRepoTabActive(): void {
  if (state.repoId && state.view === 'landing') {
    loadRepo(state.repoId);
  } else {
    render();
  }
}

// ==================== Data Loading ====================

async function loadRepo(repoId: string): Promise<void> {
  state.loading = true;
  state.error = null;
  render();

  try {
    const [repo, branches] = await Promise.all([
      repoApi.get(repoId),
      branchApi.list(repoId),
    ]);

    const defaultBranch = branches.find(b => b.name === repo.default_branch) || branches[0] || null;

    let recentCommits: Commit[] = [];
    let openPRs: PullRequest[] = [];

    if (defaultBranch) {
      [recentCommits, openPRs] = await Promise.all([
        commitApi.list(repoId, defaultBranch.id, 10).catch(() => []),
        prApi.list(repoId, 'open').catch(() => []),
      ]);
    }

    state = {
      ...state,
      view: 'home',
      repoId,
      repo,
      branches,
      currentBranch: defaultBranch,
      recentCommits,
      openPRs,
      loading: false,
    };
  } catch (err) {
    state = { ...state, loading: false, error: (err as Error).message, view: 'landing' };
  }

  render();
}

// ==================== Render ====================

function render(): void {
  if (!rootEl) return;
  rootEl.innerHTML = '';

  if (state.loading) {
    rootEl.appendChild(h('div', { className: 'repo-panel__loading' },
      h('div', { className: 'repo-panel__spinner' }),
      'Loading repository...',
    ));
    return;
  }

  if (state.error) {
    rootEl.appendChild(h('div', { className: 'repo-panel__error' },
      h('span', {}, `Error: ${state.error}`),
      h('button', {
        className: 'repo-panel__retry-btn',
        onClick: () => { state.error = null; state.repoId ? loadRepo(state.repoId) : render(); },
      }, 'Retry'),
    ));
  }

  switch (state.view) {
    case 'landing': renderLanding(); break;
    case 'home': renderHome(); break;
    case 'commits': renderCommits(); break;
    case 'pulls': renderPRList(); break;
    case 'pr-detail': renderPRDetail(); break;
    case 'settings': renderSettings(); break;
    case 'validation': renderValidation(); break;
    default: renderHome();
  }
}

// ==================== Landing (No Repo) ====================

function renderLanding(): void {
  if (!rootEl) return;

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'repo-panel__input';
  nameInput.placeholder = 'Deck name (repo name)';
  nameInput.value = deckGetter?.()?.name || '';

  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.className = 'repo-panel__input';
  descInput.placeholder = 'Description (optional)';

  const linkInput = document.createElement('input');
  linkInput.type = 'text';
  linkInput.className = 'repo-panel__input';
  linkInput.placeholder = 'Existing Repo ID';

  rootEl.appendChild(h('div', { className: 'repo-panel__landing' },
    h('div', { className: 'repo-panel__landing-icon' }, '◆'),
    h('h3', { className: 'repo-panel__landing-title' }, 'GitHub for Decks'),
    h('p', { className: 'repo-panel__landing-desc' },
      'Track changes, create branches, open pull requests, and collaborate with version control for your deck.'),

    // Create new repo
    h('div', { className: 'repo-panel__create-section' },
      h('h4', {}, 'Create New Repository'),
      nameInput,
      descInput,
      h('button', {
        className: 'repo-panel__create-btn',
        onClick: () => createNewRepo(nameInput.value, descInput.value),
      }, '+ Create Repository'),
    ),

    // Or link existing
    h('div', { className: 'repo-panel__link-section' },
      h('div', { className: 'repo-panel__divider' },
        h('span', {}, 'or'),
      ),
      h('h4', {}, 'Link Existing Repository'),
      linkInput,
      h('button', {
        className: 'repo-panel__link-btn',
        onClick: () => {
          const id = linkInput.value.trim();
          if (id) {
            localStorage.setItem(getRepoStorageKey(), id);
            state.repoId = id;
            loadRepo(id);
          }
        },
      }, 'Link Repository'),
    ),
  ));

  // Optional sign-in hint (appended separately to avoid null child issues)
  if (!isLoggedIn()) {
    rootEl.appendChild(h('div', {
      className: 'repo-panel__auth-hint',
      style: 'margin-top: 12px; padding: 10px; border-radius: 8px; background: rgba(201,168,76,0.08); border: 1px solid rgba(201,168,76,0.15); font-size: 12px; color: var(--text-dim);',
    },
      'Works without login. ',
      h('span', {
        style: 'color: var(--cobalt); cursor: pointer; text-decoration: underline;',
        onClick: () => loginWithGoogle(),
      }, 'Sign in with Google'),
      ' to sync across devices.',
    ));
  }
}

// ==================== Home (Repo Overview) ====================

function renderHome(): void {
  if (!rootEl || !state.repo) return;

  // Repo header
  const header = h('div', { className: 'repo-panel__header' },
    h('div', { className: 'repo-panel__header-top' },
      h('h3', { className: 'repo-panel__repo-name' }, state.repo.name),
      h('span', { className: `repo-panel__visibility repo-panel__visibility--${state.repo.visibility}` },
        state.repo.visibility),
    ),
    state.repo.description
      ? h('p', { className: 'repo-panel__repo-desc' }, state.repo.description)
      : null,
  );

  // Branch selector
  const branchSelect = document.createElement('select');
  branchSelect.className = 'repo-panel__branch-select';
  for (const branch of state.branches) {
    const opt = document.createElement('option');
    opt.value = branch.id;
    opt.textContent = `${branch.isProtected ? '' : ''}${branch.name}`;
    opt.selected = branch.id === state.currentBranch?.id;
    branchSelect.appendChild(opt);
  }
  branchSelect.addEventListener('change', async () => {
    const branch = state.branches.find(b => b.id === branchSelect.value);
    if (branch && state.repoId) {
      state.currentBranch = branch;
      state.recentCommits = await commitApi.list(state.repoId, branch.id, 10).catch(() => []);
      render();
    }
  });

  const branchBar = h('div', { className: 'repo-panel__branch-bar' },
    h('span', { className: 'repo-panel__branch-icon' }, '⑂'),
    branchSelect,
    h('button', {
      className: 'repo-panel__new-branch-btn',
      onClick: () => createBranch(),
    }, '+ Branch'),
  );

  // Quick actions
  const actions = h('div', { className: 'repo-panel__actions' },
    h('button', {
      className: 'repo-panel__action-btn repo-panel__action-btn--commit',
      onClick: () => commitCurrentState(),
    }, 'Commit'),
    h('button', {
      className: 'repo-panel__action-btn',
      onClick: () => openNewPR(),
    }, 'New PR'),
    h('button', {
      className: 'repo-panel__action-btn',
      onClick: () => { state.view = 'validation'; render(); },
 }, ' Validate'),
    h('button', {
      className: 'repo-panel__action-btn repo-panel__action-btn--deckhub',
      onClick: () => openDeckHub(),
    }, 'DeckHub'),
  );

  // Navigation
  const nav = h('div', { className: 'repo-panel__nav' },
    makeNavBtn('Commits', 'commits', `${state.recentCommits.length}`),
    makeNavBtn('Pull Requests', 'pulls', `${state.openPRs.length}`),
    makeNavBtn('Settings', 'settings'),
  );

  // Recent commits
  const commitsList = h('div', { className: 'repo-panel__recent' },
    h('h4', { className: 'repo-panel__section-title' }, 'Recent Commits'),
  );

  if (state.recentCommits.length === 0) {
    commitsList.appendChild(h('p', { className: 'repo-panel__empty' },
      'No commits yet. Click "Commit" to save the current deck state.'));
  } else {
    for (const commit of state.recentCommits.slice(0, 5)) {
      commitsList.appendChild(h('div', { className: 'repo-panel__commit' },
        h('div', { className: 'repo-panel__commit-msg' }, commit.message),
        h('div', { className: 'repo-panel__commit-meta' },
          h('span', {}, commit.authorName),
          h('span', {}, timeAgo(commit.createdAt)),
          h('span', { className: 'repo-panel__hash' }, commit.id.slice(0, 7)),
        ),
      ));
    }
    if (state.recentCommits.length > 5) {
      commitsList.appendChild(h('button', {
        className: 'repo-panel__see-all',
        onClick: () => { state.view = 'commits'; render(); },
      }, `View all ${state.recentCommits.length} commits →`));
    }
  }

  // Open PRs
  const prSection = h('div', { className: 'repo-panel__recent' },
    h('h4', { className: 'repo-panel__section-title' },
      `Open Pull Requests (${state.openPRs.length})`),
  );

  if (state.openPRs.length === 0) {
    prSection.appendChild(h('p', { className: 'repo-panel__empty' }, 'No open pull requests'));
  } else {
    for (const pr of state.openPRs.slice(0, 3)) {
      prSection.appendChild(h('div', {
        className: 'repo-panel__pr-item',
        onClick: () => { state.selectedPR = pr.number; state.view = 'pr-detail'; render(); },
      },
        h('span', { className: 'repo-panel__pr-status' }, '●'),
        h('span', { className: 'repo-panel__pr-number' }, `#${pr.number}`),
        h('span', { className: 'repo-panel__pr-title' }, pr.title),
        h('span', { className: 'repo-panel__pr-author' }, pr.authorName),
      ));
    }
  }

  // Unlink button
  const footer = h('div', { className: 'repo-panel__footer' },
    h('button', {
      className: 'repo-panel__unlink-btn',
      onClick: () => {
        if (confirm('Unlink this repository? (The repo will not be deleted)')) {
          localStorage.removeItem(getRepoStorageKey());
          state = { ...state, view: 'landing', repoId: null, repo: null, branches: [], currentBranch: null, recentCommits: [], openPRs: [] };
          render();
        }
      },
    }, 'Unlink Repo'),
  );

  rootEl.append(header, branchBar, actions, nav, commitsList, prSection, footer);
}

// ==================== Commits View ====================

function renderCommits(): void {
  if (!rootEl || !state.repoId) return;

  const backBtn = h('button', {
    className: 'repo-panel__back',
    onClick: () => { state.view = 'home'; render(); },
  }, '← Back');

  const list = h('div', { className: 'repo-panel__commit-list' });

  for (const commit of state.recentCommits) {
    const patchSummary = summarizePatch(commit.patch || []);

    list.appendChild(h('div', { className: 'repo-panel__commit repo-panel__commit--full' },
      h('div', { className: 'repo-panel__commit-msg' }, commit.message),
      h('div', { className: 'repo-panel__commit-meta' },
        h('span', {}, commit.authorName),
        h('span', {}, timeAgo(commit.createdAt)),
        h('span', { className: 'repo-panel__hash' }, commit.id.slice(0, 7)),
      ),
      patchSummary ? h('div', { className: 'repo-panel__commit-patch' }, patchSummary) : null,
      h('div', { className: 'repo-panel__commit-actions' },
        h('button', {
          className: 'repo-panel__small-btn',
          onClick: () => viewCommitState(commit.id),
        }, 'View State'),
        h('button', {
          className: 'repo-panel__small-btn repo-panel__small-btn--danger',
          onClick: () => revertCommit(commit.id),
        }, 'Revert'),
      ),
    ));
  }

  rootEl.append(
    backBtn,
    h('h3', { className: 'repo-panel__view-title' }, 'Commit History'),
    list,
  );
}

// ==================== PR List ====================

function renderPRList(): void {
  if (!rootEl || !state.repoId) return;

  const backBtn = h('button', {
    className: 'repo-panel__back',
    onClick: () => { state.view = 'home'; render(); },
  }, '← Back');

  const createBtn = h('button', {
    className: 'repo-panel__create-btn',
    onClick: () => openNewPR(),
  }, '+ New PR');

  const header = h('div', { className: 'repo-panel__pr-header' },
    h('h3', { className: 'repo-panel__view-title' }, 'Pull Requests'),
    createBtn,
  );

  const list = h('div', { className: 'repo-panel__pr-list' });

  if (state.openPRs.length === 0) {
    list.appendChild(h('p', { className: 'repo-panel__empty' }, 'No pull requests'));
  } else {
    for (const pr of state.openPRs) {
      list.appendChild(h('div', {
        className: 'repo-panel__pr-card',
        onClick: () => { state.selectedPR = pr.number; state.view = 'pr-detail'; render(); },
      },
        h('div', { className: 'repo-panel__pr-card-header' },
          h('span', { className: 'repo-panel__pr-status' },
            pr.status === 'merged' ? '●' : pr.status === 'open' ? '●' : '●'),
          h('span', { className: 'repo-panel__pr-number' }, `#${pr.number}`),
          h('span', { className: 'repo-panel__pr-title' }, pr.title),
        ),
        h('div', { className: 'repo-panel__pr-card-meta' },
          h('span', {}, `by ${pr.authorName}`),
          h('span', {}, timeAgo(pr.createdAt)),
        ),
      ));
    }
  }

  rootEl.append(backBtn, header, list);
}

// ==================== PR Detail ====================

async function renderPRDetail(): Promise<void> {
  if (!rootEl || !state.repoId || !state.selectedPR) return;

  rootEl.innerHTML = '';
  rootEl.appendChild(h('div', { className: 'repo-panel__loading' }, 'Loading PR...'));

  try {
    const pr = await prApi.get(state.repoId, state.selectedPR);
    const diff = await prApi.getDiff(state.repoId, state.selectedPR).catch(() => []);
    const mergeability = await prApi.canMerge(state.repoId, state.selectedPR).catch(() => ({ mergeable: false, reasons: [] }));

    rootEl.innerHTML = '';

    const backBtn = h('button', {
      className: 'repo-panel__back',
      onClick: () => { state.view = 'pulls'; render(); },
    }, '← Back to PRs');

    const statusIcon = pr.status === 'merged' ? '● Merged' : pr.status === 'open' ? '● Open' : '● Closed';

    const header = h('div', { className: 'repo-panel__pr-detail-header' },
      h('span', { className: `repo-panel__status repo-panel__status--${pr.status}` }, statusIcon),
      h('h3', {}, `#${pr.number} ${pr.title}`),
      pr.description ? h('p', { className: 'repo-panel__pr-desc' }, pr.description) : null,
      h('div', { className: 'repo-panel__pr-meta' },
        h('span', {}, `by ${pr.authorName}`),
        h('span', {}, timeAgo(pr.createdAt)),
      ),
    );

    // Diff
    const diffSection = h('div', { className: 'repo-panel__diff-section' },
      h('h4', {}, `Changes (${diff.length})`),
    );

    if (diff.length === 0) {
      diffSection.appendChild(h('p', { className: 'repo-panel__empty' }, 'No changes'));
    } else {
      for (const patch of diff) {
        const { icon, text, cls } = formatPatch(patch);
        diffSection.appendChild(h('div', { className: `repo-panel__diff-line ${cls}` },
          h('span', { className: 'repo-panel__diff-icon' }, icon),
          h('span', {}, text),
        ));
      }
    }

    // Merge bar
    const mergeBar = pr.status === 'open' ? h('div', {
      className: `repo-panel__merge-bar ${mergeability.mergeable ? 'repo-panel__merge-bar--ready' : 'repo-panel__merge-bar--blocked'}`,
    },
 h('span', {}, mergeability.mergeable ? ' Ready to merge' : `⊘ ${mergeability.reasons?.join(', ') || 'Cannot merge'}`),
      mergeability.mergeable
        ? h('button', {
            className: 'repo-panel__merge-btn',
            onClick: async () => {
              try {
                await prApi.merge(state.repoId!, state.selectedPR!, 'squash');
                alert('PR merged!');
                state.view = 'home';
                if (state.repoId) loadRepo(state.repoId);
              } catch (err) {
                alert(`Merge failed: ${(err as Error).message}`);
              }
            },
          }, 'Squash & Merge')
        : null,
    ) : null;

    rootEl.append(backBtn, header, diffSection);
    if (mergeBar) rootEl.appendChild(mergeBar);
  } catch (err) {
    rootEl.innerHTML = '';
    rootEl.appendChild(h('div', { className: 'repo-panel__error' }, `Failed to load PR: ${(err as Error).message}`));
    rootEl.appendChild(h('button', {
      className: 'repo-panel__back',
      onClick: () => { state.view = 'pulls'; render(); },
    }, '← Back'));
  }
}

// ==================== Settings ====================

function renderSettings(): void {
  if (!rootEl || !state.repo) return;

  const backBtn = h('button', {
    className: 'repo-panel__back',
    onClick: () => { state.view = 'home'; render(); },
  }, '← Back');

  // Visibility selector
  const visSelect = document.createElement('select');
  visSelect.className = 'repo-panel__input';
  for (const v of ['private', 'unlisted', 'public']) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    opt.selected = v === state.repo.visibility;
    visSelect.appendChild(opt);
  }

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'repo-panel__input';
  nameInput.value = state.repo.name;

  const descInput = document.createElement('input');
  descInput.type = 'text';
  descInput.className = 'repo-panel__input';
  descInput.value = state.repo.description || '';

  rootEl.append(
    backBtn,
    h('h3', { className: 'repo-panel__view-title' }, 'Settings'),

    h('div', { className: 'repo-panel__settings-form' },
      h('label', {}, 'Name'),
      nameInput,
      h('label', {}, 'Description'),
      descInput,
      h('label', {}, 'Visibility'),
      visSelect,
      h('button', {
        className: 'repo-panel__save-btn',
        onClick: async () => {
          try {
            await repoApi.update(state.repoId!, {
              name: nameInput.value,
              description: descInput.value,
              visibility: visSelect.value,
            });
            alert('Settings saved!');
            if (state.repoId) loadRepo(state.repoId);
          } catch (err) {
            alert(`Save failed: ${(err as Error).message}`);
          }
        },
      }, 'Save'),
    ),

    h('div', { className: 'repo-panel__danger-zone' },
      h('h4', {}, '! Danger Zone'),
      h('button', {
        className: 'repo-panel__delete-btn',
        onClick: async () => {
          if (confirm('Delete this repository? This cannot be undone!') &&
              confirm('Really delete? All commits, branches, and PRs will be lost.')) {
            try {
              await repoApi.delete(state.repoId!);
              localStorage.removeItem(getRepoStorageKey());
              state = { ...state, view: 'landing', repoId: null, repo: null, branches: [], currentBranch: null, recentCommits: [], openPRs: [] };
              render();
            } catch (err) {
              alert(`Delete failed: ${(err as Error).message}`);
            }
          }
        },
      }, 'Delete Repository'),
    ),
  );
}

// ==================== Live Validation ====================

function renderValidation(): void {
  if (!rootEl) return;

  const backBtn = h('button', {
    className: 'repo-panel__back',
    onClick: () => { state.view = 'home'; render(); },
  }, '← Back');

  const deck = deckGetter?.();
  if (!deck) {
    rootEl.append(backBtn, h('p', { className: 'repo-panel__empty' }, 'No deck loaded'));
    return;
  }

  // Import and run validation dynamically
  import('./live-validation.js').then(({ validateDeck, getIssueSeverityIcon }) => {
    const result = validateDeck(deck.boards, deck.format || 'commander');

    const header = h('div', { className: 'repo-panel__validation-header' },
 h('h3', {}, ' Deck Validation'),
      h('span', { className: result.valid ? 'repo-panel__valid' : 'repo-panel__invalid' },
 result.valid ? ' Valid' : ` ${result.issues.filter(i => i.severity === 'error').length} errors`),
      h('span', { className: 'repo-panel__deck-size' },
        `${result.deckSize}/${result.targetSize} cards`),
    );

    const issuesList = h('div', { className: 'repo-panel__issues' });
    for (const issue of result.issues) {
      issuesList.appendChild(h('div', { className: `repo-panel__issue repo-panel__issue--${issue.severity}` },
        h('span', { className: 'repo-panel__issue-icon' }, getIssueSeverityIcon(issue.severity)),
        h('div', {},
          h('span', { className: 'repo-panel__issue-msg' }, issue.message),
          issue.fix ? h('span', { className: 'repo-panel__issue-fix' }, `Fix: ${issue.fix}`) : null,
        ),
      ));
    }

    if (result.issues.length === 0) {
      issuesList.appendChild(h('p', { className: 'repo-panel__empty' }, 'No issues found! Deck looks great.'));
    }

    rootEl!.append(backBtn, header, issuesList);
  }).catch(() => {
    rootEl!.append(backBtn, h('p', { className: 'repo-panel__error' }, 'Failed to load validation module'));
  });
}

// ==================== Actions ====================

async function createNewRepo(name: string, description: string): Promise<void> {
  if (!name.trim()) {
    alert('Please enter a repo name');
    return;
  }

  state.loading = true;
  render();

  try {
    const deck = deckGetter?.();
    const result = await repoApi.create({
      name: name.trim(),
      description: description.trim(),
      format: deck?.format || 'commander',
      visibility: 'private',
    });

    localStorage.setItem(getRepoStorageKey(), result.id);
    state.repoId = result.id;

    // Auto-commit the current deck state
    if (deck) {
      const deckState = {
        boards: deck.boards,
        meta: {
          name: deck.name,
          description: deck.description || '',
          format: deck.format || 'commander',
        },
      };

      await commitApi.create(result.id, result.defaultBranchId, 'Initial commit', deckState);
    }

    await loadRepo(result.id);
  } catch (err) {
    state = { ...state, loading: false, error: (err as Error).message };
    render();
  }
}

async function createBranch(): Promise<void> {
  const name = prompt('Branch name:');
  if (!name || !state.repoId || !state.currentBranch) return;

  try {
    const branch = await branchApi.create(state.repoId, name, state.currentBranch.id);
    state.branches.push(branch);
    state.currentBranch = branch;
    render();
  } catch (err) {
    alert(`Branch creation failed: ${(err as Error).message}`);
  }
}

async function commitCurrentState(): Promise<void> {
  if (!state.repoId || !state.currentBranch) return;

  const deck = deckGetter?.();
  if (!deck) {
    alert('No deck loaded');
    return;
  }

  const message = prompt('Commit message:', `Update: ${deck.name}`);
  if (!message) return;

  try {
    const deckState = {
      boards: deck.boards,
      meta: {
        name: deck.name,
        description: deck.description || '',
        format: deck.format || 'commander',
      },
    };

    const commit = await commitApi.create(
      state.repoId, state.currentBranch.id, message, deckState
    );

    state.recentCommits.unshift(commit);
    render();
  } catch (err) {
    alert(`Commit failed: ${(err as Error).message}`);
  }
}

async function openNewPR(): Promise<void> {
  if (!state.repoId || state.branches.length < 2) {
    alert('Need at least 2 branches to create a PR');
    return;
  }

  const title = prompt('PR title:');
  if (!title) return;

  const defaultBranch = state.branches.find(b => b.name === 'main') || state.branches[0];
  const sourceBranch = state.currentBranch;

  if (!sourceBranch || sourceBranch.id === defaultBranch?.id) {
    alert('Switch to a feature branch before creating a PR');
    return;
  }

  try {
    const pr = await prApi.create(state.repoId, {
      title,
      description: '',
      sourceBranchId: sourceBranch.id,
      targetBranchId: defaultBranch!.id,
    });

    state.openPRs.unshift(pr);
    state.selectedPR = pr.number;
    state.view = 'pr-detail';
    render();
  } catch (err) {
    alert(`PR creation failed: ${(err as Error).message}`);
  }
}

/**
 * Open the full DeckHub repo page in a new tab
 */
function openDeckHub(): void {
  if (!state.repoId) {
    alert('No repo linked — create or link a repo first.');
    return;
  }
  window.open(`/deckhub?repo=${encodeURIComponent(state.repoId)}`, '_blank');
}

async function viewCommitState(commitId: string): Promise<void> {
  if (!state.repoId) return;
  try {
    const deckState = await commitApi.getState(state.repoId, commitId);
    alert(`Deck state at commit ${commitId.slice(0, 7)}:\n${JSON.stringify(deckState.boards, null, 2).slice(0, 500)}...`);
  } catch (err) {
    alert(`Failed to load state: ${(err as Error).message}`);
  }
}

async function revertCommit(commitId: string): Promise<void> {
  if (!state.repoId || !state.currentBranch) return;
  if (!confirm('Revert this commit? This creates a new commit that undoes these changes.')) return;

  try {
    await commitApi.revert(state.repoId, commitId, state.currentBranch.id);
    state.recentCommits = await commitApi.list(state.repoId, state.currentBranch.id, 10);
    render();
  } catch (err) {
    alert(`Revert failed: ${(err as Error).message}`);
  }
}

// ==================== Helpers ====================

function makeNavBtn(label: string, view: RepoView, badge?: string): HTMLElement {
  return h('button', {
    className: 'repo-panel__nav-btn',
    onClick: () => { state.view = view; render(); },
  },
    label,
    badge ? h('span', { className: 'repo-panel__badge' }, badge) : null,
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const d = Math.floor(hrs / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function summarizePatch(patch: unknown[]): string {
  if (!Array.isArray(patch) || patch.length === 0) return '';
  const adds = patch.filter((p: any) => p.op === 'add_card').length;
  const removes = patch.filter((p: any) => p.op === 'remove_card').length;
  const updates = patch.filter((p: any) => p.op === 'update_qty').length;
  const parts: string[] = [];
  if (adds > 0) parts.push(`+${adds}`);
  if (removes > 0) parts.push(`-${removes}`);
  if (updates > 0) parts.push(`~${updates}`);
  return parts.join(' ');
}

function formatPatch(patch: any): { icon: string; text: string; cls: string } {
  switch (patch.op) {
    case 'add_card': return { icon: '+', text: `${patch.qty || 1}x ${patch.name} → ${patch.board}`, cls: 'repo-panel__diff--add' };
    case 'remove_card': return { icon: '-', text: `${patch.qty || 1}x ${patch.name} from ${patch.board}`, cls: 'repo-panel__diff--remove' };
    case 'update_qty': return { icon: '~', text: `${patch.name}: ${patch.oldQty} → ${patch.newQty}`, cls: 'repo-panel__diff--update' };
    case 'move_card': return { icon: '→', text: `${patch.name}: ${patch.fromBoard} → ${patch.toBoard}`, cls: 'repo-panel__diff--move' };
    case 'set_tag': return { icon: '#', text: `${patch.name}: tag ${patch.tag} = ${patch.value}`, cls: 'repo-panel__diff--tag' };
    case 'set_meta': return { icon: 'ⓘ', text: `meta.${patch.key} = ${patch.value}`, cls: 'repo-panel__diff--meta' };
    default: return { icon: '?', text: JSON.stringify(patch), cls: '' };
  }
}
