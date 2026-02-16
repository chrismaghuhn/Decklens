/**
 * Themed Confirm & Prompt Modals
 * Replaces native confirm() and prompt() with Aether-themed modals.
 */

import { h } from '../shared/dom.js';

// ==================== Types ====================

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

// ==================== Helpers ====================

function trapFocus(backdrop: HTMLElement): void {
  backdrop.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusable = backdrop.querySelectorAll<HTMLElement>('button, input, [tabindex]');
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
}

function createBackdrop(onClose: () => void): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'confirm-modal-backdrop';
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) onClose();
  });
  return backdrop;
}

function animateOut(backdrop: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    backdrop.classList.add('confirm-modal--exit');
    backdrop.addEventListener('animationend', () => {
      backdrop.remove();
      resolve();
    }, { once: true });
    // Fallback: remove after 300ms if animationend doesn't fire
    setTimeout(() => { backdrop.remove(); resolve(); }, 300);
  });
}

// ==================== Confirm Modal ====================

export function showConfirmModal(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const {
      title,
      message,
      confirmLabel = 'Confirm',
      cancelLabel = 'Cancel',
      danger = false,
    } = options;

    let resolved = false;
    const close = (result: boolean): void => {
      if (resolved) return;
      resolved = true;
      void animateOut(backdrop);
      document.removeEventListener('keydown', escHandler);
      resolve(result);
    };

    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(false);
    };

    const backdrop = createBackdrop(() => close(false));

    const modal = h('div', {
      className: 'confirm-modal',
      onClick: (e: Event) => e.stopPropagation(),
    },
      h('h3', { className: 'confirm-modal__title' }, title),
      h('p', { className: 'confirm-modal__msg' }, message),
      h('div', { className: 'confirm-modal__actions' },
        h('button', {
          className: 'btn',
          onClick: () => close(false),
        }, cancelLabel),
        h('button', {
          className: danger ? 'btn danger' : 'btn primary',
          onClick: () => close(true),
        }, confirmLabel),
      ),
    );

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    trapFocus(backdrop);
    document.addEventListener('keydown', escHandler);

    // Auto-focus the action button
    const actionBtn = modal.querySelector('.btn.primary, .btn.danger') as HTMLButtonElement | null;
    if (actionBtn) actionBtn.focus();
  });
}

// ==================== Prompt Modal ====================

export function showPromptModal(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const {
      title,
      message,
      placeholder = '',
      defaultValue = '',
      confirmLabel = 'OK',
      cancelLabel = 'Cancel',
    } = options;

    let resolved = false;
    const close = (result: string | null): void => {
      if (resolved) return;
      resolved = true;
      void animateOut(backdrop);
      document.removeEventListener('keydown', escHandler);
      resolve(result);
    };

    const escHandler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close(null);
    };

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'confirm-modal__input';
    input.placeholder = placeholder;
    input.value = defaultValue;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value);
    });

    const backdrop = createBackdrop(() => close(null));

    const modal = h('div', {
      className: 'confirm-modal',
      onClick: (e: Event) => e.stopPropagation(),
    },
      h('h3', { className: 'confirm-modal__title' }, title),
      h('p', { className: 'confirm-modal__msg' }, message),
      input,
      h('div', { className: 'confirm-modal__actions' },
        h('button', {
          className: 'btn',
          onClick: () => close(null),
        }, cancelLabel),
        h('button', {
          className: 'btn primary',
          onClick: () => close(input.value),
        }, confirmLabel),
      ),
    );

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    trapFocus(backdrop);
    document.addEventListener('keydown', escHandler);

    // Focus and select input
    input.focus();
    input.select();
  });
}
