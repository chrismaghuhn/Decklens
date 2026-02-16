/**
 * CollabThreads — Card Debate Threads for collaborative deck editing.
 *
 * Per-card discussion threads with replies and reactions.
 * Data persisted via REST API (D1), real-time notifications via WebSocket.
 */

import { h } from '../shared/dom.js';
import { attachCardAutocomplete, cardNameWithPreview } from './card-autocomplete.js';

// ───── Types ─────

export interface ThreadComment {
  id: string;
  deck_id: string;
  board: string;
  card_name: string;
  participant_name: string;
  text: string;
  parent_id: string | null;
  reactions_json: string;
  created_at: string;
}

// ───── State ─────

let threads: ThreadComment[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let deckId: string | null = null;
let currentBoard: string | null = null;
let currentCard: string | null = null;

// ───── Public API ─────

export function initThreads(currentDeckId: string): void {
  deckId = currentDeckId;
}

export function toggleThreadPanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isThreadPanelOpen(): boolean {
  return panelVisible;
}

/** Open thread panel focused on a specific card */
export function openThreadForCard(board: string, cardName: string): void {
  currentBoard = board;
  currentCard = cardName;
  panelVisible = true;
  showPanel();
  loadThreadsForCard(board, cardName);
}

export function refreshThreads(): void {
  if (currentBoard && currentCard) {
    loadThreadsForCard(currentBoard, currentCard);
  }
}

// ───── API ─────

function getApiOrigin(): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}

async function loadThreadsForCard(board: string, cardName: string): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(
      `${getApiOrigin()}/api/decks/${deckId}/threads?board=${encodeURIComponent(board)}&card=${encodeURIComponent(cardName)}`,
      { credentials: 'include' },
    );
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { threads: ThreadComment[] } };
    if (data.ok && data.data?.threads) {
      threads = data.data.threads;
      renderThreadList();
    }
  } catch { /* ignore */ }
}

async function loadAllThreads(): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/threads`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { threads: ThreadComment[] } };
    if (data.ok && data.data?.threads) {
      threads = data.data.threads;
      renderThreadList();
    }
  } catch { /* ignore */ }
}

export async function postComment(board: string, cardName: string, text: string, parentId?: string): Promise<ThreadComment | null> {
  if (!deckId) return null;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/threads`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board, cardName, text, parentId }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { ok: boolean; data: { thread: ThreadComment } };
    if (data.ok && data.data?.thread) {
      threads.push(data.data.thread);
      renderThreadList();
      return data.data.thread;
    }
  } catch { /* ignore */ }
  return null;
}

async function reactToComment(threadId: string, emoji: string): Promise<void> {
  if (!deckId) return;
  try {
    await fetch(`${getApiOrigin()}/api/decks/${deckId}/threads/${threadId}/react`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    });
    // Reload to see updated reactions
    if (currentBoard && currentCard) {
      await loadThreadsForCard(currentBoard, currentCard);
    }
  } catch { /* ignore */ }
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) {
    panelEl.style.display = 'flex';
    if (currentBoard && currentCard) {
      loadThreadsForCard(currentBoard, currentCard);
    } else {
      loadAllThreads();
    }
    return;
  }

  panelEl = h('div', { className: 'thread-panel' },
    h('div', { className: 'thread-panel-header' },
      h('span', { className: 'thread-panel-title', id: '_threadTitle' }, '\uD83D\uDCAC Discussions'),
      h('div', { style: 'display:flex;gap:4px;align-items:center;' },
        !currentCard ? h('button', {
          className: 'thread-panel-all-btn',
          onClick: () => { currentBoard = null; currentCard = null; loadAllThreads(); },
          title: 'Show all threads',
        }, 'All') : '',
        h('button', { className: 'thread-panel-close', onClick: () => toggleThreadPanel(), title: 'Close' }, '\u2715'),
      ),
    ),
    h('div', { className: 'thread-list', id: '_threadList' }),
    // Card selector row (visible when no card is selected)
    h('div', { className: 'thread-card-selector', id: '_threadCardSelector' },
      h('input', { type: 'text', className: 'thread-card-input', id: '_threadCardInput',
        placeholder: 'Card name to discuss...', }),
      h('select', { className: 'thread-board-select', id: '_threadBoardSelect' },
        h('option', { value: 'mainboard' }, 'Mainboard'),
        h('option', { value: 'sideboard' }, 'Sideboard'),
        h('option', { value: 'commander' }, 'Commander'),
        h('option', { value: 'maybeboard' }, 'Maybeboard'),
      ),
    ),
    h('div', { className: 'thread-input-area' },
      h('input', { type: 'text', className: 'thread-input', placeholder: 'Add a comment...', id: '_threadInput',
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') submitComment(); },
      }),
      h('button', { className: 'thread-send-btn', onClick: () => submitComment() }, '\u27A4'),
    ),
  );
  document.body.appendChild(panelEl);

  // Attach autocomplete to card name input
  const cardInput = document.getElementById('_threadCardInput') as HTMLInputElement;
  if (cardInput) {
    attachCardAutocomplete({ input: cardInput });
  }

  if (currentBoard && currentCard) {
    loadThreadsForCard(currentBoard, currentCard);
  } else {
    loadAllThreads();
  }
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderThreadList(): void {
  const container = document.getElementById('_threadList');
  if (!container) return;

  updateCardSelectorVisibility();

  // Update title
  const titleEl = document.getElementById('_threadTitle');
  if (titleEl) {
    titleEl.textContent = currentCard
      ? `\uD83D\uDCAC ${currentCard}`
      : '\uD83D\uDCAC All Discussions';
  }

  if (threads.length === 0) {
    container.replaceChildren(h('div', { className: 'thread-empty' },
      currentCard ? `No comments on ${currentCard} yet.` : 'No discussions yet.',
    ));
    return;
  }

  // Separate top-level and replies
  const topLevel = threads.filter((t) => !t.parent_id);
  const replies = threads.filter((t) => t.parent_id);

  const items = topLevel.map((comment) => {
    const commentReplies = replies.filter((r) => r.parent_id === comment.id);
    let reactions: Record<string, number> = {};
    try { reactions = JSON.parse(comment.reactions_json || '{}'); } catch { /* ignore */ }

    return h('div', { className: 'thread-comment' },
      h('div', { className: 'thread-comment-header' },
        h('span', { className: 'thread-comment-user' }, comment.participant_name),
        h('span', { className: 'thread-comment-time' }, formatTime(comment.created_at)),
      ),
      !currentCard ? h('div', { className: 'thread-comment-card-tag' },
        h('button', { className: 'thread-card-link', onClick: () => openThreadForCard(comment.board, comment.card_name) },
          `${comment.board}/`, cardNameWithPreview(comment.card_name)),
      ) : '',
      h('div', { className: 'thread-comment-text' }, comment.text),

      // Reactions
      h('div', { className: 'thread-reactions' },
        ...Object.entries(reactions).map(([emoji, count]) =>
          h('button', { className: 'thread-reaction-btn', onClick: () => reactToComment(comment.id, emoji) },
            `${emoji} ${count}`),
        ),
        h('button', { className: 'thread-reaction-add', onClick: () => showReactionPicker(comment.id) }, '+'),
      ),

      // Replies
      ...commentReplies.map((reply) =>
        h('div', { className: 'thread-reply' },
          h('div', { className: 'thread-comment-header' },
            h('span', { className: 'thread-comment-user' }, reply.participant_name),
            h('span', { className: 'thread-comment-time' }, formatTime(reply.created_at)),
          ),
          h('div', { className: 'thread-comment-text' }, reply.text),
        ),
      ),
    );
  });

  container.replaceChildren(...items);
}

function submitComment(): void {
  const input = document.getElementById('_threadInput') as HTMLInputElement;
  if (!input || !input.value.trim()) return;

  let board = currentBoard;
  let card = currentCard;

  // If no card selected, use the card selector inputs
  if (!board || !card) {
    const cardInput = document.getElementById('_threadCardInput') as HTMLInputElement;
    const boardSelect = document.getElementById('_threadBoardSelect') as HTMLSelectElement;
    card = cardInput?.value?.trim() || null;
    board = boardSelect?.value || 'mainboard';
    if (!card) return; // Need a card name
    // Set as current so follow-up comments go to same card
    currentCard = card;
    currentBoard = board;
    if (cardInput) cardInput.value = '';
    updateCardSelectorVisibility();
  }

  const text = input.value.trim();
  input.value = '';
  postComment(board!, card!, text);
}

function updateCardSelectorVisibility(): void {
  const selector = document.getElementById('_threadCardSelector');
  if (selector) {
    selector.style.display = (currentBoard && currentCard) ? 'none' : 'flex';
  }
}

function showReactionPicker(threadId: string): void {
  const emojis = ['\uD83D\uDC4D', '\u2764\uFE0F', '\uD83E\uDD14', '\uD83D\uDE02', '\uD83D\uDE4F', '\uD83D\uDD25'];
  const picker = h('div', { className: 'thread-reaction-picker' },
    ...emojis.map((emoji) =>
      h('button', { className: 'thread-reaction-pick', onClick: () => { reactToComment(threadId, emoji); picker.remove(); } }, emoji),
    ),
  );
  // Add near the reaction add button
  const panel = document.getElementById('_threadList');
  if (panel) panel.appendChild(picker);
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!picker.contains(e.target as Node)) { picker.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

// ───── Utilities ─────

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  } catch { return iso; }
}
