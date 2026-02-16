import { h } from '../shared/dom.js';

export type ToastType = 'success' | 'info' | 'warning' | 'error';

export interface ToastOptions {
  message: string;
  type?: ToastType;
  duration?: number;
  undoAction?: () => void;
  action?: { label: string; onClick: () => void };
}

const MAX_VISIBLE = 3;
let container: HTMLElement | null = null;
const active: { el: HTMLElement; timer: number }[] = [];

function dismiss(el: HTMLElement): void {
  const idx = active.findIndex((t) => t.el === el);
  if (idx >= 0) {
    clearTimeout(active[idx].timer);
    active.splice(idx, 1);
  }
  el.classList.add('toast--exit');
  el.addEventListener('animationend', () => el.remove(), { once: true });
}

export function initToastContainer(): void {
  if (container) return;
  container = document.createElement('div');
  container.className = 'toast-container';
  document.body.appendChild(container);
}

export function showToast(options: ToastOptions): void {
  if (!container) initToastContainer();

  const { message, type = 'info', duration = 4000, undoAction, action } = options;

  // Evict oldest if at capacity
  while (active.length >= MAX_VISIBLE) {
    const oldest = active[0];
    if (oldest) dismiss(oldest.el);
  }

  const toast = h('div', {
    className: `toast toast--${type}`,
    role: 'status',
    'aria-live': 'polite',
  },
    h('span', { className: 'toast__msg' }, message),
    undoAction
      ? h('button', {
          className: 'toast__undo',
          onClick: (e: Event) => {
            e.stopPropagation();
            undoAction();
            dismiss(toast);
          },
        }, 'Undo')
      : null,
    action
      ? h('button', {
          className: 'toast__action',
          onClick: (e: Event) => {
            e.stopPropagation();
            action.onClick();
            dismiss(toast);
          },
        }, action.label)
      : null,
    h('button', {
      className: 'toast__close',
      'aria-label': 'Dismiss',
      onClick: () => dismiss(toast),
    }, '\u00d7'),
  );

  container!.appendChild(toast);

  const timer = window.setTimeout(() => dismiss(toast), duration);
  active.push({ el: toast, timer });
}

// ==================== Toast Batching ====================

interface BatchState {
  type: ToastType;
  messages: string[];
  timer: number;
}

let batchState: BatchState | null = null;
const BATCH_WINDOW_MS = 500;

function flushBatch(): void {
  if (!batchState) return;
  const { type, messages } = batchState;
  batchState = null;
  if (messages.length === 1) {
    showToast({ message: messages[0], type });
  } else {
    showToast({ message: `${messages.length} cards added`, type });
  }
}

/**
 * Toast that batches rapid successive calls within a 500ms window.
 * Use `batchKey` to group related messages (e.g. 'card-add').
 * Without `batchKey`, falls through to normal `showToast()`.
 */
export function showBatchableToast(options: ToastOptions & { batchKey?: string }): void {
  if (!options.batchKey) {
    showToast(options);
    return;
  }

  const { type = 'info' } = options;

  if (batchState && batchState.type === type) {
    // Accumulate into existing batch
    batchState.messages.push(options.message);
    clearTimeout(batchState.timer);
    batchState.timer = window.setTimeout(flushBatch, BATCH_WINDOW_MS);
  } else {
    // Flush any existing batch, start new one
    if (batchState) flushBatch();
    batchState = {
      type,
      messages: [options.message],
      timer: window.setTimeout(flushBatch, BATCH_WINDOW_MS),
    };
  }
}
