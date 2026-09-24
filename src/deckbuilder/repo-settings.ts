// ============================================================
// Repo Settings — Branch protection, collaborators, rules
// ============================================================
// Settings page for a deck repo: branch protection, required
// approvals, required checks, collaborator management,
// slot locking (Feature F), playgroup rules (Feature 7).
// ============================================================

import { h } from '../shared/dom.js';
import {
  repoApi, settingsApi, collaboratorApi, branchApi,
} from './repo-api.js';
import type { Repo, Branch, Collaborator } from './repo-api.js';

// ==================== Types ====================

export interface RepoSettingsData {
  protectedBranches: string[];
  requiredApprovals: number;
  requiredChecks: string[];
  defaultMergeStrategy: 'squash' | 'merge' | 'rebase';
  lockedSlots: LockedSlot[];
  playgroupRules: PlaygroupRule[];
  maxBudget: number | null;
  sideboardSize: number;
  tagQuotas: Record<string, number>;
}

export interface LockedSlot {
  board: string;
  cardName: string;
  lockedBy: string;
  reason: string;
}

export interface PlaygroupRule {
  type: 'ban' | 'limit' | 'require';
  cardName: string;
  limit?: number;
  message?: string;
}

export interface RepoSettingsCallbacks {
  onSave: (settings: RepoSettingsData) => void;
  onDeleteRepo: () => void;
  onTransferOwnership: (newOwnerId: string) => void;
  onBack: () => void;
}

// ==================== State ====================

interface SettingsState {
  repo: Repo | null;
  branches: Branch[];
  collaborators: Collaborator[];
  settings: RepoSettingsData;
  loading: boolean;
  error: string | null;
  dirty: boolean;
  activeSection: 'general' | 'branches' | 'collaborators' | 'rules' | 'danger';
}

let state: SettingsState = {
  repo: null,
  branches: [],
  collaborators: [],
  settings: getDefaultSettings(),
  loading: false,
  error: null,
  dirty: false,
  activeSection: 'general',
};

let containerEl: HTMLElement | null = null;
let callbacks: RepoSettingsCallbacks | null = null;
let currentRepoId = '';

function getDefaultSettings(): RepoSettingsData {
  return {
    protectedBranches: ['main'],
    requiredApprovals: 1,
    requiredChecks: ['format_validation'],
    defaultMergeStrategy: 'squash',
    lockedSlots: [],
    playgroupRules: [],
    maxBudget: null,
    sideboardSize: 15,
    tagQuotas: { ramp: 10, draw: 10, removal: 5, land: 33 },
  };
}

// ==================== Init ====================

/**
 * Initialize repo settings page.
 */
export async function initRepoSettings(
  repoId: string,
  container: HTMLElement,
  cbs: RepoSettingsCallbacks
): Promise<void> {
  currentRepoId = repoId;
  containerEl = container;
  callbacks = cbs;
  state = { ...state, loading: true, error: null };
  render();

  try {
    const [repo, branches, collaborators, rawSettings] = await Promise.all([
      repoApi.get(repoId),
      branchApi.list(repoId),
      collaboratorApi.list(repoId).catch(() => []),
      settingsApi.get(repoId).catch(() => ({})),
    ]);

    state = {
      repo,
      branches,
      collaborators,
      settings: { ...getDefaultSettings(), ...rawSettings as Partial<RepoSettingsData> },
      loading: false,
      error: null,
      dirty: false,
      activeSection: 'general',
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
    containerEl.appendChild(h('div', { className: 'repo-settings__loading' }, 'Loading settings...'));
    return;
  }

  if (state.error) {
    containerEl.appendChild(h('div', { className: 'repo-settings__error' }, state.error));
    return;
  }

  // Header
  const header = h('div', { className: 'repo-settings__header' },
    h('button', { className: 'repo-settings__back', onClick: () => callbacks?.onBack() }, '← Back'),
    h('h3', {}, 'Repository Settings'),
    state.dirty
      ? h('button', { className: 'repo-settings__save-btn', onClick: saveSettings }, 'Save Changes')
      : null,
  );

  // Section nav
  const nav = h('nav', { className: 'repo-settings__nav' },
    makeSection('General', 'general'),
    makeSection('Branch Protection', 'branches'),
    makeSection('Collaborators', 'collaborators'),
    makeSection('Playgroup Rules', 'rules'),
    makeSection('Danger Zone', 'danger'),
  );

  // Section content
  let content: HTMLElement;
  switch (state.activeSection) {
    case 'general': content = renderGeneral(); break;
    case 'branches': content = renderBranchProtection(); break;
    case 'collaborators': content = renderCollaborators(); break;
    case 'rules': content = renderPlaygroupRules(); break;
    case 'danger': content = renderDangerZone(); break;
  }

  containerEl.append(header, h('div', { className: 'repo-settings__layout' }, nav, content));
}

function renderGeneral(): HTMLElement {
  const s = state.settings;

  return h('div', { className: 'repo-settings__section' },
    h('h4', {}, 'General Settings'),

    makeField('Default Merge Strategy', () => {
      const select = document.createElement('select');
      for (const [val, label] of [['squash', 'Squash & Merge'], ['merge', 'Merge Commit'], ['rebase', 'Rebase']]) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        opt.selected = val === s.defaultMergeStrategy;
        select.appendChild(opt);
      }
      select.addEventListener('change', () => {
        s.defaultMergeStrategy = select.value as 'squash' | 'merge' | 'rebase';
        state.dirty = true;
        render();
      });
      return select;
    }),

    makeField('Required Approvals', () => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '5';
      input.value = String(s.requiredApprovals);
      input.addEventListener('change', () => {
        s.requiredApprovals = parseInt(input.value) || 0;
        state.dirty = true;
      });
      return input;
    }),

    makeField('Max Budget ($)', () => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.placeholder = 'No limit';
      input.value = s.maxBudget !== null ? String(s.maxBudget) : '';
      input.addEventListener('change', () => {
        s.maxBudget = input.value ? parseFloat(input.value) : null;
        state.dirty = true;
      });
      return input;
    }),

    makeField('Sideboard Size', () => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.max = '30';
      input.value = String(s.sideboardSize);
      input.addEventListener('change', () => {
        s.sideboardSize = parseInt(input.value) || 15;
        state.dirty = true;
      });
      return input;
    }),

    h('h4', { style: 'margin-top: 1rem' }, 'Tag Quotas'),
    h('p', { className: 'repo-settings__help' }, 'Minimum required cards per tag category for check validation'),
    ...Object.entries(s.tagQuotas).map(([tag, min]) =>
      makeField(tag, () => {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.value = String(min);
        input.addEventListener('change', () => {
          s.tagQuotas[tag] = parseInt(input.value) || 0;
          state.dirty = true;
        });
        return input;
      })
    ),
  );
}

function renderBranchProtection(): HTMLElement {
  const s = state.settings;

  return h('div', { className: 'repo-settings__section' },
    h('h4', {}, 'Branch Protection'),
    h('p', { className: 'repo-settings__help' }, 'Protected branches require PRs to merge. Direct pushes are blocked for non-maintainers.'),

    ...state.branches.map(branch => {
      const isProtected = s.protectedBranches.includes(branch.name);
      return h('div', { className: 'repo-settings__branch-row' },
        h('label', {},
          h('input', {
            type: 'checkbox',
            checked: isProtected,
            onChange: () => {
              if (isProtected) {
                s.protectedBranches = s.protectedBranches.filter(n => n !== branch.name);
              } else {
                s.protectedBranches.push(branch.name);
              }
              state.dirty = true;
              render();
            },
          }),
          h('span', {}, `${branch.name} ${isProtected ? '' : ''}`),
        ),
      );
    }),

    h('h4', { style: 'margin-top: 1rem' }, 'Required Checks'),
    h('p', { className: 'repo-settings__help' }, 'These checks must pass before a PR can be merged.'),

    ...['format_validation', 'regression_test', 'tag_quotas', 'budget_check', 'sideboard_check', 'playgroup_rules'].map(check => {
      const enabled = s.requiredChecks.includes(check);
      return h('div', { className: 'repo-settings__check-row' },
        h('label', {},
          h('input', {
            type: 'checkbox',
            checked: enabled,
            onChange: () => {
              if (enabled) {
                s.requiredChecks = s.requiredChecks.filter(c => c !== check);
              } else {
                s.requiredChecks.push(check);
              }
              state.dirty = true;
              render();
            },
          }),
          h('span', {}, formatCheckName(check)),
        ),
      );
    }),

    h('h4', { style: 'margin-top: 1rem' }, 'Locked Slots (Feature F)'),
    h('p', { className: 'repo-settings__help' }, 'Lock specific cards so they cannot be removed without maintainer approval.'),

    ...s.lockedSlots.map((slot, i) =>
      h('div', { className: 'repo-settings__locked-slot' },
        h('span', {}, `${slot.cardName} (${slot.board})`),
        h('span', { className: 'repo-settings__locked-reason' }, slot.reason),
        h('button', {
          className: 'repo-settings__remove-btn',
          onClick: () => {
            s.lockedSlots.splice(i, 1);
            state.dirty = true;
            render();
          },
 }, '✕'),
      )
    ),
    h('button', {
      className: 'repo-settings__add-lock-btn',
      onClick: () => {
        const cardName = prompt('Card name to lock:');
        const reason = prompt('Reason:') || 'Locked by maintainer';
        if (cardName) {
          s.lockedSlots.push({ board: 'mainboard', cardName, lockedBy: 'owner', reason });
          state.dirty = true;
          render();
        }
      },
    }, '+ Add Locked Slot'),
  );
}

function renderCollaborators(): HTMLElement {
  return h('div', { className: 'repo-settings__section' },
    h('h4', {}, 'Collaborators'),

    state.collaborators.length === 0
      ? h('p', { className: 'repo-settings__empty' }, 'No collaborators yet')
      : h('div', { className: 'repo-settings__collab-list' },
          ...state.collaborators.map(collab =>
            h('div', { className: 'repo-settings__collab-row' },
              h('span', { className: 'repo-settings__collab-name' }, collab.userId),
              h('span', { className: `repo-settings__collab-role repo-settings__role--${collab.role.toLowerCase()}` }, collab.role),
              h('div', { className: 'repo-settings__collab-actions' },
                makeRoleSelect(collab),
                h('button', {
                  className: 'repo-settings__remove-collab',
                  onClick: async () => {
                    if (confirm(`Remove ${collab.userId}?`)) {
                      try {
                        await collaboratorApi.remove(currentRepoId, collab.userId);
                        state.collaborators = state.collaborators.filter(c => c.userId !== collab.userId);
                        render();
                      } catch (err) {
                        console.error('[repo-settings] Remove collaborator failed:', err);
                      }
                    }
                  },
 }, '✕'),
              ),
            )
          )
        ),

    h('button', {
      className: 'repo-settings__invite-btn',
      onClick: async () => {
        const userId = prompt('User ID to invite:');
        if (!userId) return;
        try {
          await collaboratorApi.add(currentRepoId, userId, 'CONTRIBUTOR');
          state.collaborators = await collaboratorApi.list(currentRepoId);
          render();
        } catch (err) {
          console.error('[repo-settings] Invite failed:', err);
        }
      },
    }, '+ Invite Collaborator'),
  );
}

function renderPlaygroupRules(): HTMLElement {
  const s = state.settings;

  return h('div', { className: 'repo-settings__section' },
    h('h4', {}, 'Playgroup Rules (Feature 7)'),
    h('p', { className: 'repo-settings__help' },
      'Define custom format rules for your playgroup. These are enforced by the ChecksService.'),

    s.playgroupRules.length === 0
      ? h('p', { className: 'repo-settings__empty' }, 'No playgroup rules defined')
      : h('div', { className: 'repo-settings__rules-list' },
          ...s.playgroupRules.map((rule, i) =>
            h('div', { className: `repo-settings__rule repo-settings__rule--${rule.type}` },
              h('span', { className: 'repo-settings__rule-type' },
 rule.type === 'ban' ? '⊘' : rule.type === 'limit' ? '▤' : ''),
              h('span', {}, `${rule.type.toUpperCase()}: ${rule.cardName}`),
              rule.limit !== undefined ? h('span', {}, `(max ${rule.limit})`) : null,
              rule.message ? h('span', { className: 'repo-settings__rule-msg' }, rule.message) : null,
              h('button', {
                className: 'repo-settings__remove-btn',
                onClick: () => {
                  s.playgroupRules.splice(i, 1);
                  state.dirty = true;
                  render();
                },
 }, '✕'),
            )
          )
        ),

    h('div', { className: 'repo-settings__add-rule' },
      h('button', {
        onClick: () => addRule('ban'),
      }, '+ Ban Card'),
      h('button', {
        onClick: () => addRule('limit'),
      }, '+ Limit Card'),
      h('button', {
        onClick: () => addRule('require'),
      }, '+ Require Card'),
    ),
  );
}

function renderDangerZone(): HTMLElement {
  return h('div', { className: 'repo-settings__section repo-settings__danger' },
    h('h4', {}, '! Danger Zone'),

    h('div', { className: 'repo-settings__danger-item' },
      h('div', {},
        h('strong', {}, 'Transfer Ownership'),
        h('p', {}, 'Transfer this repository to another user.'),
      ),
      h('button', {
        className: 'repo-settings__danger-btn',
        onClick: () => {
          const newOwnerId = prompt('Enter new owner user ID:');
          if (newOwnerId && confirm(`Transfer to ${newOwnerId}? This cannot be undone.`)) {
            callbacks?.onTransferOwnership(newOwnerId);
          }
        },
      }, 'Transfer'),
    ),

    h('div', { className: 'repo-settings__danger-item' },
      h('div', {},
        h('strong', {}, 'Delete Repository'),
        h('p', {}, 'Permanently delete this repository and all its data.'),
      ),
      h('button', {
        className: 'repo-settings__danger-btn repo-settings__danger-btn--delete',
        onClick: () => {
          if (confirm('Are you sure? This cannot be undone!') &&
              confirm('Really delete? All branches, commits, and PRs will be lost.')) {
            callbacks?.onDeleteRepo();
          }
        },
      }, 'Delete Repository'),
    ),
  );
}

// ==================== Helpers ====================

function makeSection(label: string, section: SettingsState['activeSection']): HTMLElement {
  return h('button', {
    className: `repo-settings__nav-item ${state.activeSection === section ? 'repo-settings__nav-item--active' : ''}`,
    onClick: () => { state.activeSection = section; render(); },
  }, label);
}

function makeField(label: string, inputFactory: () => HTMLElement): HTMLElement {
  return h('div', { className: 'repo-settings__field' },
    h('label', { className: 'repo-settings__field-label' }, label),
    inputFactory(),
  );
}

function makeRoleSelect(collab: Collaborator): HTMLElement {
  const select = document.createElement('select');
  select.className = 'repo-settings__role-select';
  for (const role of ['VIEWER', 'CONTRIBUTOR', 'REVIEWER', 'MAINTAINER']) {
    const opt = document.createElement('option');
    opt.value = role;
    opt.textContent = role;
    opt.selected = role === collab.role;
    select.appendChild(opt);
  }
  select.addEventListener('change', async () => {
    try {
      await collaboratorApi.add(currentRepoId, collab.userId, select.value);
      collab.role = select.value;
      render();
    } catch (err) {
      console.error('[repo-settings] Role change failed:', err);
    }
  });
  return select;
}

function addRule(type: 'ban' | 'limit' | 'require'): void {
  const cardName = prompt(`Card name to ${type}:`);
  if (!cardName) return;

  const rule: PlaygroupRule = { type, cardName };
  if (type === 'limit') {
    const limit = prompt('Maximum copies allowed:');
    rule.limit = parseInt(limit || '1') || 1;
  }
  rule.message = prompt('Reason (optional):') || undefined;

  state.settings.playgroupRules.push(rule);
  state.dirty = true;
  render();
}

function formatCheckName(check: string): string {
  return check.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function saveSettings(): Promise<void> {
  try {
    await settingsApi.update(currentRepoId, state.settings as unknown as Record<string, unknown>);
    state.dirty = false;
    callbacks?.onSave(state.settings);
    render();
  } catch (err) {
    state.error = (err as Error).message;
    render();
  }
}
