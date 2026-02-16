import { trackAnalyticsEvent } from '../shared/analytics.js';
import { showConfirmModal } from './confirm-modal.js';
import {
  createDeck,
  deleteDeck,
  duplicateDeck,
  listDecks,
  setLastOpenedDeckId,
  summarizeDeckCardCounts,
} from './storage.js';

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function openDeck(deckId: string): void {
  setLastOpenedDeckId(deckId);
  window.location.href = `/decks/id/${encodeURIComponent(deckId)}`;
}

function renderDeckList(): void {
  const container = byId<HTMLDivElement>('decksList');
  const decks = listDecks();
  container.textContent = '';

  if (decks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No local decks yet. Create your first Commander deck to get started.';
    container.append(empty);
    return;
  }

  for (const deck of decks) {
    const counts = summarizeDeckCardCounts(deck);

    const row = document.createElement('div');
    row.className = 'deck-row';

    const titleBlock = document.createElement('div');
    titleBlock.className = 'deck-row-title';

    const title = document.createElement('strong');
    title.textContent = deck.name;

    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.textContent = `${deck.visibility.toUpperCase()} - ${counts.total} cards (${counts.mainboard} main + ${counts.commander} commander) - updated ${new Date(deck.updatedAt).toLocaleString()}`;

    titleBlock.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'deck-row-actions';

    const openButton = document.createElement('button');
    openButton.className = 'btn primary';
    openButton.textContent = 'Open';
    openButton.addEventListener('click', () => openDeck(deck.id));

    const cloneButton = document.createElement('button');
    cloneButton.className = 'btn';
    cloneButton.textContent = 'Duplicate';
    cloneButton.addEventListener('click', () => {
      const clone = duplicateDeck(deck.id);
      if (!clone) return;
      trackAnalyticsEvent('feature_used', {
        feature: 'deckbuilder_duplicate_deck',
      });
      renderDeckList();
    });

    const deleteButton = document.createElement('button');
    deleteButton.className = 'btn danger';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', async () => {
      const confirmed = await showConfirmModal({
        title: 'Delete Deck',
        message: `Delete deck "${deck.name}"? This removes it from this device only.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!confirmed) return;
      deleteDeck(deck.id);
      trackAnalyticsEvent('feature_used', {
        feature: 'deckbuilder_delete_deck',
      });
      renderDeckList();
    });

    actions.append(openButton, cloneButton, deleteButton);
    row.append(titleBlock, actions);
    container.append(row);
  }
}

function createDeckFromInput(): void {
  const input = byId<HTMLInputElement>('newDeckName');
  const name = input.value.trim() || 'Untitled Deck';
  const created = createDeck(name);
  trackAnalyticsEvent('feature_used', {
    feature: 'deckbuilder_create_deck',
  });
  openDeck(created.id);
}

function init(): void {
  byId<HTMLButtonElement>('btnCreateDeck').addEventListener('click', createDeckFromInput);
  byId<HTMLInputElement>('newDeckName').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createDeckFromInput();
    }
  });

  byId<HTMLButtonElement>('btnBrowsePublic').addEventListener('click', () => {
    window.location.href = '/decks/public';
  });

  renderDeckList();
}

document.addEventListener('DOMContentLoaded', init);
