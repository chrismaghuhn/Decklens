/**
 * CollabTools — Card Pinging + Card Voting for collaborative editing.
 *
 * Card Pinging: Highlights a card with a glowing pulse animation
 * and shows a toast notification to all participants.
 *
 * Card Voting: Allows participants to 👍/👎 cards with tallies
 * shown in the card list (view-modes integration).
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';
import { showToast } from './collab-ui.js';
import type { DeckBoard, CardVoteTally } from './types.js';

// ───── Card Pinging ─────

/** Initialize card ping event listeners */
export function initCollabPing(): void {
  const mgr = getCollabManager();
  mgr.on('remote-card-ping', onRemoteCardPing);
}

/** Send a card ping to all participants */
export function sendCardPing(board: DeckBoard, cardName: string): void {
  getCollabManager().sendCardPing(board, cardName);
}

function onRemoteCardPing(event: CollabEvent): void {
  const data = event.data as {
    board: DeckBoard;
    cardName: string;
    participantId: string;
    participantName: string;
    color: string;
  };

  // Show toast
  showToast(`${data.participantName} pinged ${data.cardName}`, 'info');

  // Find the card element and apply ping animation
  highlightPingedCard(data.board, data.cardName, data.color);
}

function highlightPingedCard(board: DeckBoard, cardName: string, color: string): void {
  // Try to find card by data attributes
  const selectors = [
    `[data-card-name="${CSS.escape(cardName)}"][data-board="${board}"]`,
    `[data-card-name="${CSS.escape(cardName)}"]`,
  ];

  let el: HTMLElement | null = null;
  for (const sel of selectors) {
    el = document.querySelector<HTMLElement>(sel);
    if (el) break;
  }

  if (!el) return;

  // Scroll into view
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Apply ping animation
  el.style.setProperty('--ping-color', color);
  el.classList.add('collab-card-pinged');

  // Remove after animation completes (3s)
  setTimeout(() => {
    el!.classList.remove('collab-card-pinged');
    el!.style.removeProperty('--ping-color');
  }, 3000);
}

// ───── Card Voting ─────

/** Vote state: votes[board][cardName][participantId] = 1 | -1 */
let voteState: Record<string, Record<string, Record<string, 1 | -1>>> = {};
let localParticipantId: string | null = null;
let voteRenderCallback: (() => void) | null = null;

/** Initialize vote event listeners */
export function initCollabVoting(): void {
  const mgr = getCollabManager();
  mgr.on('remote-vote-update', onRemoteVoteUpdate);
  mgr.on('vote-sync', onVoteSync);
  mgr.on('sync', onSync);
  mgr.on('disconnected', onDisconnected);
}

/** Register a callback to re-render vote widgets when votes change */
export function setVoteRenderCallback(cb: () => void): void {
  voteRenderCallback = cb;
}

/** Get vote tally for a specific card */
export function getVoteTally(board: DeckBoard, cardName: string): CardVoteTally {
  const cardVotes = voteState[board]?.[cardName] || {};
  let up = 0;
  let down = 0;
  let myVote: 0 | 1 | -1 = 0;

  for (const [pid, vote] of Object.entries(cardVotes)) {
    if (vote === 1) up++;
    else if (vote === -1) down++;
    if (pid === localParticipantId) myVote = vote as 1 | -1;
  }

  return { up, down, net: up - down, myVote };
}

/** Cast or remove a vote for a card */
export function castVote(board: DeckBoard, cardName: string, vote: 1 | -1 | 0): void {
  getCollabManager().sendVoteUpdate(board, cardName, vote);
}

/** Create a vote widget element for a card */
export function createVoteWidget(board: DeckBoard, cardName: string): HTMLElement {
  const tally = getVoteTally(board, cardName);

  const upBtn = h('button', {
    className: `collab-vote-btn collab-vote-up${tally.myVote === 1 ? ' collab-vote-active-up' : ''}`,
    title: 'Upvote',
    onClick: (e: Event) => {
      e.stopPropagation();
      castVote(board, cardName, tally.myVote === 1 ? 0 : 1);
    },
  }, '▲');

  const downBtn = h('button', {
    className: `collab-vote-btn collab-vote-down${tally.myVote === -1 ? ' collab-vote-active-down' : ''}`,
    title: 'Downvote',
    onClick: (e: Event) => {
      e.stopPropagation();
      castVote(board, cardName, tally.myVote === -1 ? 0 : -1);
    },
  }, '▼');

  const tallyClass = tally.net > 0 ? 'collab-vote-positive' : tally.net < 0 ? 'collab-vote-negative' : '';
  const tallyEl = h('span', { className: `collab-vote-tally ${tallyClass}` },
    `+${tally.up}/−${tally.down}`,
  );

  return h('div', { className: 'collab-vote-widget' }, upBtn, tallyEl, downBtn);
}

// ───── Event Handlers ─────

function onRemoteVoteUpdate(event: CollabEvent): void {
  const data = event.data as {
    board: DeckBoard;
    cardName: string;
    participantId: string;
    vote: 1 | -1 | 0;
  };

  if (!voteState[data.board]) voteState[data.board] = {};
  if (!voteState[data.board][data.cardName]) voteState[data.board][data.cardName] = {};

  if (data.vote === 0) {
    delete voteState[data.board][data.cardName][data.participantId];
  } else {
    voteState[data.board][data.cardName][data.participantId] = data.vote;
  }

  voteRenderCallback?.();
}

function onVoteSync(event: CollabEvent): void {
  const data = event.data as { votes: Record<string, Record<string, Record<string, 1 | -1>>> };
  voteState = data.votes || {};
  voteRenderCallback?.();
}

function onSync(event: CollabEvent): void {
  // Extract our participant ID from the sync response
  const data = event.data as { participants?: Array<{ id: string }> };
  // Our ID is the last participant in the list (we just joined)
  if (data.participants && data.participants.length > 0) {
    localParticipantId = data.participants[data.participants.length - 1].id;
  }
}

function onDisconnected(): void {
  voteState = {};
  localParticipantId = null;
}

/** Check if any votes exist (used for conditional rendering) */
export function hasAnyVotes(): boolean {
  return Object.keys(voteState).length > 0;
}
