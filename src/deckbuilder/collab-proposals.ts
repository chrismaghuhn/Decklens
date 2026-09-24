/**
 * CollabProposals — Change Proposals (Merge Requests for Decks).
 *
 * Create, vote on, and resolve deck change proposals.
 * Data persisted via REST API (D1), real-time notifications via WebSocket.
 */

import { h } from '../shared/dom.js';
import { attachCardAutocomplete } from './card-autocomplete.js';

// ───── Types ─────

export interface Proposal {
  id: string;
  deck_id: string;
  proposed_by_name: string;
  title: string;
  description: string;
  changes_json: string;
  status: string;
  created_at: string;
  resolved_at?: string;
}

export interface ProposalVote {
  id: string;
  proposal_id: string;
  participant_name: string;
  vote: string;
  created_at: string;
}

// ───── State ─────

let proposals: Proposal[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let deckId: string | null = null;
let onProposalAccepted: ((changes: unknown) => void) | null = null;

// ───── Public API ─────

export function initProposals(currentDeckId: string, onAccepted?: (changes: unknown) => void): void {
  deckId = currentDeckId;
  onProposalAccepted = onAccepted || null;
  loadProposals();
}

export function toggleProposalPanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isProposalPanelOpen(): boolean {
  return panelVisible;
}

export function refreshProposals(): void {
  loadProposals();
}

// ───── API ─────

function getApiOrigin(): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}

async function loadProposals(): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/proposals?status=open`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { proposals: Proposal[] } };
    if (data.ok && data.data?.proposals) {
      proposals = data.data.proposals;
      if (panelVisible) renderList();
    }
  } catch { /* ignore */ }
}

export async function createProposal(title: string, description: string, changes: unknown): Promise<Proposal | null> {
  if (!deckId) return null;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/proposals`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description, changes }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { ok: boolean; data: { proposal: Proposal } };
    if (data.ok && data.data?.proposal) {
      proposals.unshift(data.data.proposal);
      if (panelVisible) renderList();
      return data.data.proposal;
    }
  } catch { /* ignore */ }
  return null;
}

async function voteOnProposal(proposalId: string, vote: 'accept' | 'reject'): Promise<void> {
  if (!deckId) return;
  try {
    await fetch(`${getApiOrigin()}/api/decks/${deckId}/proposals/${proposalId}/vote`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vote }),
    });
    if (panelVisible) await loadAndShowProposal(proposalId);
  } catch { /* ignore */ }
}

async function resolveProposal(proposalId: string, decision: 'accepted' | 'rejected'): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/proposals/${proposalId}/resolve`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    if (resp.ok) {
      if (decision === 'accepted') {
        const proposal = proposals.find((p) => p.id === proposalId);
        if (proposal && onProposalAccepted) {
          try { onProposalAccepted(JSON.parse(proposal.changes_json)); } catch { /* ignore */ }
        }
      }
      proposals = proposals.filter((p) => p.id !== proposalId);
      if (panelVisible) renderList();
    }
  } catch { /* ignore */ }
}

async function loadAndShowProposal(proposalId: string): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/proposals/${proposalId}`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { proposal: Proposal; votes: ProposalVote[] } };
    if (data.ok) {
      renderProposalDetail(data.data.proposal, data.data.votes);
    }
  } catch { /* ignore */ }
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; loadProposals(); return; }

  panelEl = h('div', { className: 'proposal-panel' },
    h('div', { className: 'proposal-panel-header' },
 h('span', { className: 'proposal-panel-title' }, '▥ Proposals'),
      h('div', { className: 'proposal-panel-actions-header' },
        h('button', { className: 'proposal-create-btn', onClick: () => promptCreateProposal(), title: 'New proposal' }, '+ New'),
 h('button', { className: 'proposal-panel-close', onClick: () => toggleProposalPanel(), title: 'Close' }, '✕'),
      ),
    ),
    h('div', { className: 'proposal-list', id: '_proposalList' }),
  );
  document.body.appendChild(panelEl);
  renderList();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderList(): void {
  const container = document.getElementById('_proposalList');
  if (!container) return;

  if (proposals.length === 0) {
    container.replaceChildren(h('div', { className: 'proposal-empty' }, 'No open proposals. Click "+ New" to create one.'));
    return;
  }

  const items = proposals.map((prop) => {
    let changes: { added?: unknown[]; removed?: unknown[]; changed?: unknown[] } = {};
    try { changes = JSON.parse(prop.changes_json); } catch { /* ignore */ }
    const addCount = Array.isArray(changes.added) ? changes.added.length : 0;
    const removeCount = Array.isArray(changes.removed) ? changes.removed.length : 0;

    return h('div', { className: 'proposal-card', onClick: () => loadAndShowProposal(prop.id) },
      h('div', { className: 'proposal-card-header' },
        h('span', { className: 'proposal-card-title' }, prop.title),
        h('span', { className: 'proposal-card-status' }, prop.status),
      ),
      h('div', { className: 'proposal-card-meta' },
        h('span', {}, `by ${prop.proposed_by_name}`),
        h('span', {}, formatDate(prop.created_at)),
      ),
      (addCount > 0 || removeCount > 0)
        ? h('div', { className: 'proposal-card-changes' },
            addCount > 0 ? h('span', { className: 'proposal-change-add' }, `+${addCount}`) : '',
            removeCount > 0 ? h('span', { className: 'proposal-change-remove' }, `-${removeCount}`) : '',
          )
        : '',
    );
  });

  container.replaceChildren(...items);
}

function renderProposalDetail(proposal: Proposal, votes: ProposalVote[]): void {
  const container = document.getElementById('_proposalList');
  if (!container) return;

  const acceptVotes = votes.filter((v) => v.vote === 'accept').length;
  const rejectVotes = votes.filter((v) => v.vote === 'reject').length;
  const total = votes.length || 1;

  let changes: { added?: Array<{ name: string; qty: number }>; removed?: Array<{ name: string; qty: number }> } = {};
  try { changes = JSON.parse(proposal.changes_json); } catch { /* ignore */ }

  container.replaceChildren(
    h('button', { className: 'proposal-back-btn', onClick: () => renderList() }, '\u2190 Back'),
    h('div', { className: 'proposal-detail' },
      h('h3', { className: 'proposal-detail-title' }, proposal.title),
      proposal.description ? h('p', { className: 'proposal-detail-desc' }, proposal.description) : '',
      h('div', { className: 'proposal-detail-meta' },
        h('span', {}, `by ${proposal.proposed_by_name}`),
        h('span', {}, formatDate(proposal.created_at)),
      ),

      // Changes preview
      (changes.added && changes.added.length > 0) || (changes.removed && changes.removed.length > 0)
        ? h('div', { className: 'proposal-diff-preview' },
            ...(changes.added || []).map((c) => h('div', { className: 'proposal-diff-add' }, `+ ${c.qty || 1}x ${c.name}`)),
            ...(changes.removed || []).map((c) => h('div', { className: 'proposal-diff-remove' }, `- ${c.qty || 1}x ${c.name}`)),
          )
        : '',

      // Vote bar
      h('div', { className: 'proposal-vote-section' },
        h('div', { className: 'proposal-vote-bar' },
          h('div', { className: 'proposal-vote-accept-fill', style: `width:${(acceptVotes / total) * 100}%` }),
          h('div', { className: 'proposal-vote-reject-fill', style: `width:${(rejectVotes / total) * 100}%` }),
        ),
        h('div', { className: 'proposal-vote-counts' },
 h('span', { className: 'proposal-vote-accept-count' }, `✓ ${acceptVotes}`),
 h('span', { className: 'proposal-vote-reject-count' }, `✕ ${rejectVotes}`),
        ),
      ),

      // Vote + resolve buttons
      proposal.status === 'open'
        ? h('div', { className: 'proposal-actions' },
 h('button', { className: 'proposal-vote-btn proposal-vote-accept', onClick: () => voteOnProposal(proposal.id, 'accept') }, '✓ Accept'),
 h('button', { className: 'proposal-vote-btn proposal-vote-reject', onClick: () => voteOnProposal(proposal.id, 'reject') }, '✕ Reject'),
            h('div', { className: 'proposal-resolve-section' },
              h('button', { className: 'proposal-resolve-btn proposal-resolve-accept', onClick: () => resolveProposal(proposal.id, 'accepted') }, 'Merge'),
              h('button', { className: 'proposal-resolve-btn proposal-resolve-reject', onClick: () => resolveProposal(proposal.id, 'rejected') }, 'Close'),
            ),
          )
        : h('div', { className: 'proposal-resolved-tag' }, `Resolved: ${proposal.status}`),
    ),
  );
}

function promptCreateProposal(): void {
  const addEntries: Array<{ name: string; qty: number }> = [];
  const removeEntries: Array<{ name: string; qty: number }> = [];

  function renderChangePreview(): void {
    const previewEl = document.getElementById('_propChangePreview');
    if (!previewEl) return;
    const items: HTMLElement[] = [];
    for (const a of addEntries) items.push(h('div', { className: 'proposal-preview-add' }, `+ ${a.qty}x ${a.name}`));
    for (const r of removeEntries) items.push(h('div', { className: 'proposal-preview-remove' }, `- ${r.qty}x ${r.name}`));
    previewEl.replaceChildren(
      items.length > 0 ? h('div', {}, ...items) : h('div', { className: 'muted' }, 'No changes yet'),
    );
  }

  function addCard(listName: 'add' | 'remove'): void {
    const inputId = listName === 'add' ? '_propAddCard' : '_propRemoveCard';
    const qtyId = listName === 'add' ? '_propAddQty' : '_propRemoveQty';
    const nameInput = document.getElementById(inputId) as HTMLInputElement;
    const qtyInput = document.getElementById(qtyId) as HTMLInputElement;
    const name = nameInput?.value?.trim();
    const qty = parseInt(qtyInput?.value || '1');
    if (!name) return;
    (listName === 'add' ? addEntries : removeEntries).push({ name, qty });
    nameInput.value = '';
    qtyInput.value = '1';
    renderChangePreview();
    nameInput.focus();
  }

  const overlay = h('div', { className: 'proposal-modal-overlay' },
    h('div', { className: 'proposal-modal proposal-modal-structured' },
      h('h3', {}, 'New Proposal'),
      h('label', {}, 'Title'),
      h('input', { type: 'text', className: 'proposal-input', placeholder: 'e.g. Add more removal', id: '_propTitle' }),
      h('label', {}, 'Description (optional)'),
      h('textarea', { className: 'proposal-textarea', placeholder: 'Why this change?', id: '_propDesc', rows: '2' }),

      // Add cards section
      h('div', { className: 'proposal-change-section' },
        h('label', {}, 'Add Cards'),
        h('div', { className: 'proposal-add-row' },
          h('input', { type: 'text', className: 'proposal-card-input', id: '_propAddCard', placeholder: 'Card name...',
            onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); addCard('add'); } },
          }),
          h('input', { type: 'number', className: 'proposal-qty-input', id: '_propAddQty', value: '1', min: '1', max: '20' }),
          h('button', { className: 'proposal-inline-btn proposal-inline-add', onClick: () => addCard('add') }, '+'),
        ),
      ),

      // Remove cards section
      h('div', { className: 'proposal-change-section' },
        h('label', {}, 'Remove Cards'),
        h('div', { className: 'proposal-add-row' },
          h('input', { type: 'text', className: 'proposal-card-input', id: '_propRemoveCard', placeholder: 'Card name...',
            onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); addCard('remove'); } },
          }),
          h('input', { type: 'number', className: 'proposal-qty-input', id: '_propRemoveQty', value: '1', min: '1', max: '20' }),
          h('button', { className: 'proposal-inline-btn proposal-inline-remove', onClick: () => addCard('remove') }, '-'),
        ),
      ),

      // Preview
      h('div', { className: 'proposal-change-preview', id: '_propChangePreview' },
        h('div', { className: 'muted' }, 'No changes yet'),
      ),

      h('div', { className: 'proposal-modal-actions' },
        h('button', { className: 'proposal-modal-cancel', onClick: () => overlay.remove() }, 'Cancel'),
        h('button', { className: 'proposal-modal-confirm', onClick: async () => {
          const title = (document.getElementById('_propTitle') as HTMLInputElement)?.value?.trim();
          if (!title) return;
          const desc = (document.getElementById('_propDesc') as HTMLTextAreaElement)?.value?.trim() || '';
          const changes = { added: addEntries, removed: removeEntries };
          await createProposal(title, desc, changes);
          overlay.remove();
        }}, 'Create Proposal'),
      ),
    ),
  );

  document.body.appendChild(overlay);

  // Attach autocomplete to both card inputs
  const addInput = document.getElementById('_propAddCard') as HTMLInputElement;
  const removeInput = document.getElementById('_propRemoveCard') as HTMLInputElement;
  if (addInput) attachCardAutocomplete({ input: addInput });
  if (removeInput) attachCardAutocomplete({ input: removeInput });

  setTimeout(() => (document.getElementById('_propTitle') as HTMLInputElement)?.focus(), 50);
}

// ───── Utilities ─────

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString();
  } catch { return iso; }
}
