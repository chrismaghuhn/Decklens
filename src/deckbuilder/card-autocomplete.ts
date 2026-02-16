/**
 * Card Autocomplete Component
 *
 * Reusable Scryfall-powered autocomplete dropdown for card name inputs.
 * Supports <input> and <textarea> (multi-line, comma-separated modes).
 * Uses existing fetchDeckbuilderAutocomplete() and card-preview hover.
 */

import { h } from '../shared/dom.js';
import { fetchDeckbuilderAutocomplete } from '../shared/api.js';
import { showHoverPreviewByName, hideHoverPreview } from './card-preview.js';

// ───── Types ─────

export interface CardAutocompleteOptions {
  /** The input or textarea element to attach to */
  input: HTMLInputElement | HTMLTextAreaElement;
  /** Optional: restrict/prioritize suggestions to these card names */
  deckCards?: string[];
  /** Debounce delay in ms (default: 200) */
  debounceMs?: number;
  /** Max suggestions to show (default: 8) */
  maxSuggestions?: number;
  /** Callback when a card is selected */
  onSelect?: (cardName: string) => void;
  /** For textarea: autocomplete current line only */
  multiLine?: boolean;
  /** For comma-separated inputs (e.g. opening hand) */
  commaSeparated?: boolean;
}

export interface CardAutocompleteController {
  /** Remove all event listeners and DOM elements */
  destroy(): void;
  /** Update the deck card filter list */
  updateDeckCards(cards: string[]): void;
}

// ───── Component ─────

export function attachCardAutocomplete(options: CardAutocompleteOptions): CardAutocompleteController {
  const {
    input,
    debounceMs = 200,
    maxSuggestions = 8,
    onSelect,
    multiLine = false,
    commaSeparated = false,
  } = options;

  let deckCards: string[] = options.deckCards || [];
  let suggestions: string[] = [];
  let highlightIndex = -1;
  let dropdownEl: HTMLElement | null = null;
  let debounceTimer = 0;
  let abortCtrl: AbortController | null = null;
  let isOpen = false;

  // ── Query extraction ──

  function extractQuery(): string {
    const raw = input.value;

    if (commaSeparated) {
      const lastComma = raw.lastIndexOf(',');
      return (lastComma >= 0 ? raw.slice(lastComma + 1) : raw).trim();
    }

    if (multiLine && input instanceof HTMLTextAreaElement) {
      const pos = input.selectionStart ?? raw.length;
      const before = raw.slice(0, pos);
      const lineStart = before.lastIndexOf('\n') + 1;
      return before.slice(lineStart).trim();
    }

    return raw.trim();
  }

  // ── Replace query in input ──

  function replaceQuery(cardName: string): void {
    if (commaSeparated) {
      const raw = input.value;
      const lastComma = raw.lastIndexOf(',');
      const prefix = lastComma >= 0 ? raw.slice(0, lastComma + 1) + ' ' : '';
      input.value = prefix + cardName + ', ';
      return;
    }

    if (multiLine && input instanceof HTMLTextAreaElement) {
      const pos = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, pos);
      const after = input.value.slice(pos);
      const lineStart = before.lastIndexOf('\n') + 1;
      const afterLine = after.indexOf('\n');
      const lineEnd = afterLine >= 0 ? pos + afterLine : input.value.length;
      input.value = input.value.slice(0, lineStart) + cardName + input.value.slice(lineEnd);
      const newPos = lineStart + cardName.length;
      input.setSelectionRange(newPos, newPos);
      return;
    }

    input.value = cardName;
  }

  // ── Dropdown rendering ──

  function createDropdown(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'card-autocomplete-dropdown';
    document.body.appendChild(el);
    return el;
  }

  function positionDropdown(): void {
    if (!dropdownEl) return;
    const rect = input.getBoundingClientRect();
    const dropW = Math.max(rect.width, 220);
    let left = rect.left + window.scrollX;

    // Check if there's enough space below; if not, open above
    const dropH = dropdownEl.offsetHeight || 200;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const openAbove = spaceBelow < dropH && spaceAbove > spaceBelow;

    let top: number;
    if (openAbove) {
      top = rect.top + window.scrollY - dropH - 2;
    } else {
      top = rect.bottom + window.scrollY + 2;
    }

    // Keep within viewport horizontally
    if (left + dropW > window.innerWidth) left = window.innerWidth - dropW - 8;
    if (left < 4) left = 4;

    dropdownEl.style.left = `${left}px`;
    dropdownEl.style.top = `${top}px`;
    dropdownEl.style.width = `${dropW}px`;
  }

  function renderSuggestions(): void {
    if (!dropdownEl) dropdownEl = createDropdown();
    dropdownEl.innerHTML = '';

    for (let i = 0; i < suggestions.length; i++) {
      const name = suggestions[i];
      const isDeckCard = deckCards.some((d) => d.toLowerCase() === name.toLowerCase());
      const item = h('div', {
        className: `ac-item${i === highlightIndex ? ' ac-highlighted' : ''}${isDeckCard ? ' ac-item-deck' : ''}`,
        onMouseEnter: (e: Event) => {
          highlightIndex = i;
          renderSuggestions();
          showHoverPreviewByName(name, e as MouseEvent);
        },
        onMouseLeave: () => {
          hideHoverPreview();
        },
        onMouseDown: (e: Event) => {
          e.preventDefault(); // prevent input blur
          selectSuggestion(i);
        },
      }, name);
      dropdownEl.appendChild(item);
    }

    positionDropdown();
    isOpen = suggestions.length > 0;
    dropdownEl.style.display = isOpen ? '' : 'none';
  }

  function closeDropdown(): void {
    if (dropdownEl) {
      dropdownEl.style.display = 'none';
    }
    suggestions = [];
    highlightIndex = -1;
    isOpen = false;
    hideHoverPreview();
  }

  // ── Selection ──

  function selectSuggestion(index: number): void {
    const name = suggestions[index];
    if (!name) return;

    replaceQuery(name);
    closeDropdown();

    if (onSelect) onSelect(name);

    // Re-focus and trigger input event for any listeners
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // ── Fetch suggestions ──

  async function fetchSuggestions(query: string): Promise<void> {
    if (query.length < 2) {
      closeDropdown();
      return;
    }

    // Cancel previous request
    if (abortCtrl) abortCtrl.abort();
    abortCtrl = new AbortController();

    // Local deck card matches first
    const lowerQ = query.toLowerCase();
    const localMatches = deckCards
      .filter((c) => c.toLowerCase().includes(lowerQ))
      .slice(0, 4);

    try {
      const remote = await fetchDeckbuilderAutocomplete(query, { signal: abortCtrl.signal });

      // Merge: local matches first (deduplicated), then remote
      const seen = new Set(localMatches.map((n) => n.toLowerCase()));
      const merged = [...localMatches];
      for (const name of remote) {
        if (!seen.has(name.toLowerCase())) {
          merged.push(name);
          seen.add(name.toLowerCase());
        }
        if (merged.length >= maxSuggestions) break;
      }

      suggestions = merged.slice(0, maxSuggestions);
      highlightIndex = suggestions.length > 0 ? 0 : -1;
      renderSuggestions();
    } catch {
      // AbortError or network error — ignore silently
    }
  }

  // ── Event handlers ──

  function onInput(): void {
    clearTimeout(debounceTimer);
    const query = extractQuery();
    debounceTimer = window.setTimeout(() => fetchSuggestions(query), debounceMs);
  }

  function onKeyDown(e: Event): void {
    const ke = e as KeyboardEvent;
    if (!isOpen) return;

    if (ke.key === 'ArrowDown') {
      ke.preventDefault();
      highlightIndex = (highlightIndex + 1) % suggestions.length;
      renderSuggestions();
    } else if (ke.key === 'ArrowUp') {
      ke.preventDefault();
      highlightIndex = (highlightIndex - 1 + suggestions.length) % suggestions.length;
      renderSuggestions();
    } else if (ke.key === 'Enter' && highlightIndex >= 0) {
      ke.preventDefault();
      ke.stopPropagation();
      selectSuggestion(highlightIndex);
    } else if (ke.key === 'Tab' && highlightIndex >= 0) {
      ke.preventDefault();
      selectSuggestion(highlightIndex);
    } else if (ke.key === 'Escape') {
      ke.preventDefault();
      ke.stopPropagation();
      closeDropdown();
    }
  }

  function onBlur(): void {
    // Delay so mousedown on suggestion fires first
    setTimeout(closeDropdown, 150);
  }

  function onDocumentClick(e: Event): void {
    if (dropdownEl && !dropdownEl.contains(e.target as Node) && e.target !== input) {
      closeDropdown();
    }
  }

  // ── Setup ──

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKeyDown);
  input.addEventListener('blur', onBlur);
  document.addEventListener('click', onDocumentClick, true);

  // Set autocomplete off to prevent browser dropdown conflict
  input.setAttribute('autocomplete', 'off');

  // ── Controller ──

  return {
    destroy() {
      clearTimeout(debounceTimer);
      if (abortCtrl) abortCtrl.abort();
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeyDown);
      input.removeEventListener('blur', onBlur);
      document.removeEventListener('click', onDocumentClick, true);
      if (dropdownEl) {
        dropdownEl.remove();
        dropdownEl = null;
      }
    },
    updateDeckCards(cards: string[]) {
      deckCards = cards;
    },
  };
}

// ───── Card Name with Hover Preview helper ─────

/**
 * Create a span element that shows a Scryfall card image on hover.
 * Use this in place of plain text card name spans for hover previews.
 */
export function cardNameWithPreview(name: string, className?: string): HTMLElement {
  return h('span', {
    className: className ? `card-name-preview ${className}` : 'card-name-preview',
    onMouseEnter: (e: Event) => showHoverPreviewByName(name, e as MouseEvent),
    onMouseLeave: () => hideHoverPreview(),
  }, name);
}
