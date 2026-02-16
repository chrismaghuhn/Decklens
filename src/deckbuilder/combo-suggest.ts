/**
 * Combo Suggest -- Modal UI for submitting community combo suggestions.
 * Renders a modal overlay with card inputs, description, and submit.
 * All DOM created programmatically (no innerHTML for XSS safety).
 */

import { h } from '../shared/dom.js';

// ==================== Types ====================

export interface ComboSuggestion {
  name: string;
  cards: string[];
  description: string;
  produces: string[];
}

// ==================== State ====================

const MIN_CARDS = 2;
const MAX_CARDS = 6;

let activeOverlay: HTMLElement | null = null;

// ==================== Modal ====================

/**
 * Show the combo suggestion modal.
 * Creates a fullscreen overlay with a form for submitting a new combo.
 *
 * @param onSubmit - Callback invoked with the validated suggestion when the user submits
 */
export function showSuggestComboModal(
  onSubmit: (suggestion: ComboSuggestion) => void,
): void {
  // Prevent stacking -- close any existing modal first
  if (activeOverlay) {
    closeSuggestComboModal();
  }

  // Track card input elements for dynamic add/remove
  const cardInputs: HTMLInputElement[] = [];
  let cardContainer: HTMLElement;

  // ---------- Field: Name ----------
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'combo-suggest-input';
  nameInput.placeholder = 'e.g. Infinite Squirrels';
  nameInput.maxLength = 120;
  nameInput.required = true;

  const nameField = h('div', { className: 'combo-suggest-field' },
    h('label', { className: 'combo-suggest-label' }, 'Combo Name *'),
    nameInput,
  );

  // ---------- Field: Card Inputs ----------
  function createCardInput(index: number): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'combo-suggest-input';
    input.placeholder = `Card ${index + 1}`;
    input.maxLength = 200;
    return input;
  }

  function renderCardInputs(): void {
    cardContainer.textContent = '';
    for (const input of cardInputs) {
      cardContainer.appendChild(input);
    }

    // Update Add Card button visibility
    if (addCardBtn) {
      addCardBtn.style.display = cardInputs.length >= MAX_CARDS ? 'none' : '';
    }
  }

  // Start with 2 card inputs
  cardInputs.push(createCardInput(0));
  cardInputs.push(createCardInput(1));

  cardContainer = h('div', { className: 'combo-suggest-card-list' });

  const addCardBtn = h('button', {
    className: 'combo-suggest-add-card',
    type: 'button',
    onClick: () => {
      if (cardInputs.length < MAX_CARDS) {
        cardInputs.push(createCardInput(cardInputs.length));
        renderCardInputs();
        // Focus the new input
        cardInputs[cardInputs.length - 1].focus();
      }
    },
  }, '+ Add Card');

  const cardsField = h('div', { className: 'combo-suggest-field' },
    h('label', { className: 'combo-suggest-label' }, 'Cards * (2-6 cards)'),
    cardContainer,
    addCardBtn,
  );

  // Render initial card inputs
  renderCardInputs();

  // ---------- Field: Description ----------
  const descTextarea = document.createElement('textarea');
  descTextarea.className = 'combo-suggest-textarea';
  descTextarea.placeholder = 'Describe how the combo works, step by step...';
  descTextarea.rows = 4;
  descTextarea.maxLength = 2000;
  descTextarea.required = true;

  const descField = h('div', { className: 'combo-suggest-field' },
    h('label', { className: 'combo-suggest-label' }, 'Description *'),
    descTextarea,
  );

  // ---------- Field: Produces ----------
  const producesInput = document.createElement('input');
  producesInput.type = 'text';
  producesInput.className = 'combo-suggest-input';
  producesInput.placeholder = 'e.g. Infinite mana, Win the game';
  producesInput.maxLength = 500;

  const producesField = h('div', { className: 'combo-suggest-field' },
    h('label', { className: 'combo-suggest-label' }, 'Produces (comma-separated, optional)'),
    producesInput,
  );

  // ---------- Error display ----------
  const errorEl = document.createElement('div');
  errorEl.className = 'combo-suggest-error';
  errorEl.style.display = 'none';

  function showError(msg: string): void {
    errorEl.textContent = msg;
    errorEl.style.display = '';
  }

  function hideError(): void {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }

  // ---------- Validation & Submit ----------
  function handleSubmit(): void {
    hideError();

    const name = nameInput.value.trim();
    if (!name) {
      showError('Combo name is required.');
      nameInput.focus();
      return;
    }

    const cards = cardInputs
      .map((input) => input.value.trim())
      .filter(Boolean);

    if (cards.length < MIN_CARDS) {
      showError(`At least ${MIN_CARDS} cards are required.`);
      // Focus first empty card input
      const emptyInput = cardInputs.find((input) => !input.value.trim());
      if (emptyInput) emptyInput.focus();
      return;
    }

    const description = descTextarea.value.trim();
    if (!description) {
      showError('Description is required.');
      descTextarea.focus();
      return;
    }

    const producesRaw = producesInput.value.trim();
    const produces = producesRaw
      ? producesRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : [];

    const suggestion: ComboSuggestion = { name, cards, description, produces };
    onSubmit(suggestion);
    closeSuggestComboModal();
  }

  // ---------- Action Buttons ----------
  const submitBtn = h('button', {
    className: 'combo-suggest-submit',
    type: 'button',
    onClick: handleSubmit,
  }, 'Submit Combo');

  const cancelBtn = h('button', {
    className: 'combo-suggest-cancel',
    type: 'button',
    onClick: () => closeSuggestComboModal(),
  }, 'Cancel');

  const actions = h('div', { className: 'combo-suggest-actions' },
    cancelBtn,
    submitBtn,
  );

  // ---------- Modal Assembly ----------
  const modal = h('div', {
    className: 'combo-suggest-modal',
    onClick: (e: Event) => e.stopPropagation(),
  },
    h('h3', { className: 'combo-suggest-title' }, 'Suggest a Combo'),
    nameField,
    cardsField,
    descField,
    producesField,
    errorEl,
    actions,
  );

  // ---------- Overlay ----------
  const overlay = document.createElement('div');
  overlay.className = 'combo-suggest-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeSuggestComboModal();
    }
  });
  overlay.appendChild(modal);

  // ---------- Keyboard Handling ----------
  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      closeSuggestComboModal();
    }
  }

  document.addEventListener('keydown', onKeyDown);

  // Store cleanup ref on the overlay so we can remove the listener on close
  (overlay as HTMLElement & { _cleanup?: () => void })._cleanup = () => {
    document.removeEventListener('keydown', onKeyDown);
  };

  // ---------- Focus Trap ----------
  overlay.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = overlay.querySelectorAll<HTMLElement>(
      'input, textarea, button, [tabindex]',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // ---------- Mount ----------
  activeOverlay = overlay;
  document.body.appendChild(overlay);
  nameInput.focus();
}

/**
 * Close and remove the combo suggestion modal from the DOM.
 */
export function closeSuggestComboModal(): void {
  if (!activeOverlay) return;

  // Run cleanup (remove keydown listener)
  const cleanup = (activeOverlay as HTMLElement & { _cleanup?: () => void })._cleanup;
  if (typeof cleanup === 'function') {
    cleanup();
  }

  activeOverlay.remove();
  activeOverlay = null;
}
