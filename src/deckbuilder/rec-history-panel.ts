/**
 * Recommendation History Panel — "Previously worked for you"
 *
 * Renders a section in the Strategy tab showing per-deck recommendation
 * history. Each entry shows a card that was previously applied via a
 * recommendation, with an "Apply Again" action.
 *
 * Uses getDeckRecommendationHistory() from recommendation-history.ts
 * which stores data in localStorage keyed by deckName + commanders.
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import {
  getDeckRecommendationHistory,
  type RecommendationHistoryEntry,
} from '../mtg/recommendation-history.js';
import { isOwned } from './collection.js';
import { trackRecInteraction } from './activation-funnel.js';
import type { RecommendationLogicTag } from '../mtg/recommendation-impact.js';

// ───── Public Interface ─────

export interface RecHistoryCallbacks {
  onReapply(cardName: string, mode: 'add' | 'swap', cutName: string | null): void;
}

// ───── Constants ─────

const MAX_DISPLAY_ENTRIES = 5;

const LOGIC_TAG_LABELS: Record<RecommendationLogicTag, string> = {
  synergy: 'Synergy',
  'curve-fix': 'Curve Fix',
  'mana-fix': 'Mana Fix',
  'meta-answer': 'Meta Answer',
  'card-advantage': 'Card Advantage',
  protection: 'Protection',
  'board-control': 'Board Control',
};

const LOGIC_TAG_CHIP_CLASS: Record<string, string> = {
  synergy: 'rec-chip-synergy',
  'curve-fix': 'rec-chip-curve_fix',
  'mana-fix': 'rec-chip-mana_fix',
  'meta-answer': 'rec-chip-consistency',
  'card-advantage': 'rec-chip-consistency',
  protection: 'rec-chip-synergy',
  'board-control': 'rec-chip-curve_fix',
};

// ───── Helpers ─────

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function relativeTime(timestamp: number): string {
  const now = Date.now();
  const delta = now - timestamp;
  const seconds = Math.floor(delta / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) return `${Math.floor(days / 30)}mo ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

/**
 * Score entries by recency-weighted apply count.
 * More recent entries score higher, frequent entries score higher.
 */
function scoreEntry(entry: RecommendationHistoryEntry): number {
  const daysSince = (Date.now() - entry.lastAppliedAt) / (1000 * 60 * 60 * 24);
  const recencyWeight = Math.max(0.1, 1 - daysSince / 60); // Decays over 60 days
  return entry.applyCount * recencyWeight;
}

// ───── Render ─────

export function renderRecHistoryPanel(
  container: HTMLElement,
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  callbacks: RecHistoryCallbacks,
): void {
  container.textContent = '';

  // Get history for this specific deck
  const commanderNames = deck.boards.commander.map((e) => e.name);
  const history = getDeckRecommendationHistory(deck.name, commanderNames);

  if (!history || history.entries.length === 0) {
    // Don't render anything if no history — section stays hidden
    return;
  }

  // Build set of card names currently in the deck for filtering
  const currentCards = new Set<string>();
  for (const board of [deck.boards.mainboard, deck.boards.sideboard, deck.boards.commander]) {
    for (const entry of board) {
      currentCards.add(normalizeKey(entry.name));
    }
  }

  // Filter out cards already in the deck, then sort by score
  const candidates = history.entries
    .filter((entry) => !currentCards.has(normalizeKey(entry.cardName)))
    .sort((a, b) => scoreEntry(b) - scoreEntry(a))
    .slice(0, MAX_DISPLAY_ENTRIES);

  if (candidates.length === 0) {
    // All previously applied cards are already in the deck — nothing to show
    return;
  }

  // Section wrapper
  const section = document.createElement('div');
  section.className = 'rec-history-section';

  // Title
  const title = document.createElement('h4');
  title.className = 'rec-history-title';
  title.textContent = 'Previously worked for you';
  section.appendChild(title);

  // List
  const list = document.createElement('div');
  list.className = 'rec-history-list';

  for (const entry of candidates) {
    const item = createHistoryItem(entry, cardByName, callbacks);
    list.appendChild(item);

    // Track view interaction
    trackRecInteraction('view', entry.lastRecommendationId, 'strategy_tab', {
      cardName: entry.cardName,
      source: 'history_panel',
    });
  }

  section.appendChild(list);
  container.appendChild(section);
}

function createHistoryItem(
  entry: RecommendationHistoryEntry,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  callbacks: RecHistoryCallbacks,
): HTMLElement {
  const item = document.createElement('div');
  item.className = 'rec-history-item';

  // Top row: card name + owned indicator
  const nameRow = document.createElement('div');
  nameRow.className = 'rec-history-name-row';

  const cardName = document.createElement('span');
  cardName.className = 'rec-history-card-name';
  cardName.textContent = entry.cardName;
  nameRow.appendChild(cardName);

  // Owned indicator
  if (isOwned(entry.cardName)) {
    const ownedDot = document.createElement('span');
    ownedDot.className = 'rec-history-owned';
    ownedDot.title = 'You own this card';
    nameRow.appendChild(ownedDot);
  }

  item.appendChild(nameRow);

  // Meta row: apply count + relative time
  const meta = document.createElement('div');
  meta.className = 'rec-history-meta';
  const countText = entry.applyCount === 1 ? 'Applied 1\u00D7' : `Applied ${entry.applyCount}\u00D7`;
  meta.textContent = `${countText} \u00B7 ${relativeTime(entry.lastAppliedAt)}`;
  item.appendChild(meta);

  // Logic tags as chips (reuse rec-chip styles)
  if (entry.logicTags.length > 0) {
    const tagsRow = document.createElement('div');
    tagsRow.className = 'rec-history-tags';
    for (const tag of entry.logicTags) {
      const chip = document.createElement('span');
      chip.className = `rec-chip ${LOGIC_TAG_CHIP_CLASS[tag] || 'rec-chip-synergy'}`;
      chip.textContent = LOGIC_TAG_LABELS[tag] || tag;
      tagsRow.appendChild(chip);
    }
    item.appendChild(tagsRow);
  }

  // Reason (truncated)
  if (entry.lastReason) {
    const reason = document.createElement('div');
    reason.className = 'rec-history-reason';
    reason.textContent = entry.lastReason.length > 80
      ? entry.lastReason.slice(0, 77) + '...'
      : entry.lastReason;
    item.appendChild(reason);
  }

  // Apply Again button
  const applyBtn = document.createElement('button');
  applyBtn.className = 'btn-ghost rec-history-apply';
  applyBtn.textContent = 'Apply Again';
  applyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    callbacks.onReapply(entry.cardName, entry.lastMode, entry.lastCutName);
    trackRecInteraction('apply', entry.lastRecommendationId, 'strategy_tab', {
      cardName: entry.cardName,
      source: 'history_panel',
      reapply: true,
    });
    // Disable button after click to prevent double-apply
    applyBtn.disabled = true;
 applyBtn.textContent = 'Applied ';
  });
  item.appendChild(applyBtn);

  return item;
}
