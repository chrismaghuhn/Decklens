/**
 * CollabBranches — Branch management UI for collaborative deck editing.
 *
 * Provides branch creation, switching, and a branch selector dropdown.
 * Branches are stored in D1 via the worker API.
 */

import { h } from '../shared/dom.js';
import { getUser } from '../shared/auth.js';

// ───── Types ─────

export interface DeckBranch {
  id: string;
  deckId: string;
  name: string;
  description: string;
  createdBy?: string;
  createdAt: string;
  parentBranchId?: string;
  isDefault: boolean;
}

// ───── State ─────

let branches: DeckBranch[] = [];
let currentBranchId: string | null = null;
let selectorEl: HTMLElement | null = null;
let deckId: string | null = null;
let onBranchSwitchCallback: ((branchId: string, boards: unknown) => void) | null = null;

// ───── Public API ─────

export function initBranches(currentDeckId: string, onSwitch?: (branchId: string, boards: unknown) => void): void {
  deckId = currentDeckId;
  onBranchSwitchCallback = onSwitch || null;
  loadBranches();
}

export function getCurrentBranchId(): string | null {
  return currentBranchId;
}

export function getBranches(): DeckBranch[] {
  return [...branches];
}

export function createBranchSelector(): HTMLElement {
  selectorEl = h('div', { className: 'branch-selector' },
    h('button', {
      className: 'branch-selector-btn',
      onClick: () => toggleBranchDropdown(),
      title: 'Switch branch',
    }, 'main'),
  );
  return selectorEl;
}

// ───── API Calls ─────

function getApiOrigin(): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}
async function loadBranches(): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/branches`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { branches: DeckBranch[] } };
    if (data.ok && data.data?.branches) {
      branches = data.data.branches;
      if (!currentBranchId) {
        const def = branches.find((b) => b.isDefault);
        currentBranchId = def?.id || branches[0]?.id || null;
      }
      updateSelectorLabel();
    }
  } catch { /* API not available */ }
}

export async function createNewBranch(name: string, description: string): Promise<DeckBranch | null> {
  if (!deckId) return null;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/branches`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, parentBranchId: currentBranchId }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { ok: boolean; data: { branch: DeckBranch } };
    if (data.ok && data.data?.branch) {
      branches.push(data.data.branch);
      updateSelectorLabel();
      return data.data.branch;
    }
  } catch { /* ignore */ }
  return null;
}

export async function switchBranch(branchId: string): Promise<void> {
  if (!deckId || branchId === currentBranchId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/branches/${branchId}/snapshot`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { branch: DeckBranch; boards: unknown } };
    if (data.ok) {
      currentBranchId = branchId;
      updateSelectorLabel();
      if (onBranchSwitchCallback && data.data.boards) {
        onBranchSwitchCallback(branchId, data.data.boards);
      }
    }
  } catch { /* ignore */ }
}

export async function deleteBranch(branchId: string): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/branches/${branchId}`, {
      method: 'DELETE', credentials: 'include',
    });
    if (resp.ok) {
      branches = branches.filter((b) => b.id !== branchId);
      if (currentBranchId === branchId) {
        const def = branches.find((b) => b.isDefault);
        currentBranchId = def?.id || null;
      }
      updateSelectorLabel();
    }
  } catch { /* ignore */ }
}
// ───── UI ─────

function updateSelectorLabel(): void {
  if (!selectorEl) return;
  const btn = selectorEl.querySelector('.branch-selector-btn');
  if (!btn) return;
  const current = branches.find((b) => b.id === currentBranchId);
  btn.textContent = `${current?.name || 'main'}`;
}

function toggleBranchDropdown(): void {
  if (!selectorEl) return;
  let dd = selectorEl.querySelector('.branch-dropdown') as HTMLElement | null;
  if (dd) { dd.remove(); return; }

  dd = h('div', { className: 'branch-dropdown' });

  for (const branch of branches) {
    const isCurrent = branch.id === currentBranchId;
    const row = h('button', {
      className: `branch-dropdown-item${isCurrent ? ' active' : ''}`,
      onClick: () => { switchBranch(branch.id); dd?.remove(); },
    },
      h('span', { className: 'branch-item-name' }, `${isCurrent ? '\u25CF ' : ''}${branch.name}`),
      branch.isDefault ? h('span', { className: 'branch-badge' }, 'default') : '',
    );
    // Add delete button for non-default branches
    if (!branch.isDefault) {
      const delBtn = h('span', {
        className: 'branch-delete-btn',
        title: 'Delete branch',
        onClick: (e: MouseEvent) => { e.stopPropagation(); dd?.remove(); promptDeleteBranch(branch.id, branch.name); },
 }, '✕');
      row.appendChild(delBtn);
    }
    dd.appendChild(row);
  }

  dd.appendChild(h('div', { className: 'branch-dropdown-divider' }));
  dd.appendChild(h('button', {
    className: 'branch-dropdown-item branch-create-item',
    onClick: () => { dd?.remove(); promptCreateBranch(); },
  }, '+ New Branch'));

  selectorEl.appendChild(dd);

  const close = (e: MouseEvent) => {
    if (!selectorEl?.contains(e.target as Node)) { dd?.remove(); document.removeEventListener('click', close); }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

function promptCreateBranch(): void {
  const overlay = h('div', { className: 'branch-modal-overlay' },
    h('div', { className: 'branch-modal' },
      h('h3', {}, 'Create Branch'),
      h('label', {}, 'Name'),
      h('input', { type: 'text', className: 'branch-input', placeholder: 'e.g. Budget Version', id: '_branchName' }),
      h('label', {}, 'Description (optional)'),
      h('input', { type: 'text', className: 'branch-input', placeholder: 'e.g. Under $100 variant', id: '_branchDesc' }),
      h('div', { className: 'branch-modal-actions' },
        h('button', { className: 'branch-modal-cancel', onClick: () => overlay.remove() }, 'Cancel'),
        h('button', { className: 'branch-modal-confirm', onClick: async () => {
          const n = (document.getElementById('_branchName') as HTMLInputElement)?.value?.trim();
          if (!n) return;
          const d = (document.getElementById('_branchDesc') as HTMLInputElement)?.value?.trim() || '';
          await createNewBranch(n, d);
          overlay.remove();
        }}, 'Create'),
      ),
    ),
  );
  document.body.appendChild(overlay);
  setTimeout(() => (document.getElementById('_branchName') as HTMLInputElement)?.focus(), 50);
}

function promptDeleteBranch(branchId: string, branchName: string): void {
  const overlay = h('div', { className: 'branch-modal-overlay' },
    h('div', { className: 'branch-modal' },
 h('h3', { style: 'color:#ef4444;' }, ' Delete Branch'),
      h('p', { style: 'margin:8px 0; color:rgba(255,255,255,0.7);' },
        'Are you sure you want to delete branch:'),
      h('p', { style: 'margin:4px 0 12px; font-weight:600; color:#e8e2d6; font-size:1.1rem;' }, branchName),
      h('p', { style: 'margin:0 0 12px; color:#ef4444; font-size:0.82rem;' },
        'This action cannot be undone. All branch-specific data will be lost.'),
      h('div', { className: 'branch-modal-actions' },
        h('button', { className: 'branch-modal-cancel', onClick: () => overlay.remove() }, 'Cancel'),
        h('button', {
          className: 'branch-modal-confirm',
          style: 'background:rgba(239,68,68,0.15); border-color:rgba(239,68,68,0.3); color:#ef4444;',
          onClick: async () => { await deleteBranch(branchId); overlay.remove(); },
        }, 'Delete'),
      ),
    ),
  );
  document.body.appendChild(overlay);
}