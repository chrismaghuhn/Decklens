// ============================================================
// Quick Replace — Swap one card for another with suggestions
// ============================================================
// "Swap Sol Ring -> Mana Crypt" style replacement with
// Scryfall-powered search and same-slot suggestions.
// ============================================================

import { h } from '../shared/dom.js';
import type { DeckBoard, DeckbuilderCardEntry } from './types.js';

// ==================== Types ====================

export interface ReplaceSuggestion {
  name: string;
  reason: string;
  imageUrl?: string;
}

export interface QuickReplaceCallbacks {
  getCardEntry: (board: DeckBoard, name: string) => DeckbuilderCardEntry | null;
  removeCard: (board: DeckBoard, name: string) => void;
  addCard: (board: DeckBoard, name: string, qty: number) => void;
  saveAndRender: () => void;
  searchScryfall: (query: string) => Promise<Array<{ name: string; type_line?: string; mana_cost?: string; image_uris?: { small?: string } }>>;
}

// ==================== Quick Replace Modal ====================

/**
 * Open the quick replace modal for a specific card.
 */
export function openQuickReplaceModal(
  board: DeckBoard,
  cardName: string,
  callbacks: QuickReplaceCallbacks
): void {
  const entry = callbacks.getCardEntry(board, cardName);
  if (!entry) return;

  let selectedReplacement: string | null = null;
  let searchResults: Array<{ name: string; type_line?: string; mana_cost?: string; image_uris?: { small?: string } }> = [];

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.className = 'quick-replace__search';
  searchInput.placeholder = 'Search for replacement card...';

  const resultsContainer = h('div', { className: 'quick-replace__results' });
  const previewContainer = h('div', { className: 'quick-replace__preview' });

  let searchTimeout: ReturnType<typeof setTimeout>;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
      const query = searchInput.value.trim();
      if (query.length < 2) {
        resultsContainer.innerHTML = '';
        return;
      }

      try {
        searchResults = await callbacks.searchScryfall(query);
        renderSearchResults(resultsContainer, searchResults, (name) => {
          selectedReplacement = name;
          updatePreview(previewContainer, cardName, name, entry.qty);
        });
      } catch (e) {
        resultsContainer.innerHTML = '';
        resultsContainer.appendChild(h('div', { className: 'quick-replace__error' }, 'Search failed'));
      }
    }, 300);
  });

  const backdrop = document.createElement('div');
  backdrop.className = 'confirm-modal-backdrop';

  const modal = h('div', {
    className: 'confirm-modal quick-replace-modal',
    onClick: (e: Event) => e.stopPropagation(),
  },
    h('h3', { className: 'confirm-modal__title' }, 'Quick Replace'),
    h('div', { className: 'quick-replace__current' },
      h('span', { className: 'quick-replace__label' }, 'Replace:'),
      h('span', { className: 'quick-replace__card-name' }, `${entry.qty}x ${cardName}`),
      h('span', { className: 'quick-replace__board' }, `(${board})`),
    ),
    h('div', { className: 'quick-replace__arrow' }, '\u2192'),
    searchInput,
    resultsContainer,
    previewContainer,
    h('div', { className: 'confirm-modal__actions' },
      h('button', {
        className: 'btn',
        onClick: () => { backdrop.remove(); },
      }, 'Cancel'),
      h('button', {
        className: 'btn primary',
        onClick: () => {
          if (selectedReplacement) {
            callbacks.removeCard(board, cardName);
            callbacks.addCard(board, selectedReplacement, entry.qty);
            callbacks.saveAndRender();
          }
          backdrop.remove();
        },
      }, 'Replace'),
    ),
  );

  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
  searchInput.focus();
}

function renderSearchResults(
  container: HTMLElement,
  results: Array<{ name: string; type_line?: string; mana_cost?: string; image_uris?: { small?: string } }>,
  onSelect: (name: string) => void
): void {
  container.innerHTML = '';

  if (results.length === 0) {
    container.appendChild(h('div', { className: 'quick-replace__empty' }, 'No results'));
    return;
  }

  for (const card of results.slice(0, 10)) {
    const item = h('div', {
      className: 'quick-replace__result-item',
      onClick: () => {
        // Deselect all
        container.querySelectorAll('.quick-replace__result-item').forEach(el =>
          el.classList.remove('quick-replace__result-item--selected')
        );
        item.classList.add('quick-replace__result-item--selected');
        onSelect(card.name);
      },
    },
      card.image_uris?.small
        ? h('img', { src: card.image_uris.small, alt: card.name, className: 'quick-replace__thumb' })
        : null,
      h('div', { className: 'quick-replace__result-info' },
        h('span', { className: 'quick-replace__result-name' }, card.name),
        card.type_line
          ? h('span', { className: 'quick-replace__result-type' }, card.type_line)
          : null,
        card.mana_cost
          ? h('span', { className: 'quick-replace__result-mana' }, card.mana_cost)
          : null,
      ),
    );
    container.appendChild(item);
  }
}

function updatePreview(container: HTMLElement, oldName: string, newName: string, qty: number): void {
  container.innerHTML = '';
  container.appendChild(h('div', { className: 'quick-replace__preview-content' },
    h('span', { className: 'quick-replace__preview-old' }, `${qty}x ${oldName}`),
    h('span', { className: 'quick-replace__preview-arrow' }, '\u2192'),
    h('span', { className: 'quick-replace__preview-new' }, `${qty}x ${newName}`),
  ));
}

// ==================== Batch Replace ====================

/**
 * Replace all instances of a card across all boards.
 */
export function batchReplace(
  oldName: string,
  newName: string,
  boards: { board: DeckBoard; entries: DeckbuilderCardEntry[] }[],
  callbacks: Pick<QuickReplaceCallbacks, 'removeCard' | 'addCard' | 'saveAndRender'>
): number {
  let count = 0;
  for (const { board, entries } of boards) {
    const entry = entries.find(e => e.name === oldName);
    if (entry) {
      callbacks.removeCard(board, oldName);
      callbacks.addCard(board, newName, entry.qty);
      count++;
    }
  }
  if (count > 0) callbacks.saveAndRender();
  return count;
}
