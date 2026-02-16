import { h, replaceChildren } from '../shared/dom.js';
import type { CustomCategory, DeckBoard } from './types.js';

// ==================== Types ====================

export interface ContextMenuCallbacks {
  onMoveTo(cardName: string, fromBoard: DeckBoard, toBoard: DeckBoard): void;
  onQtyChange(cardName: string, board: DeckBoard, delta: number): void;
  onRemove(cardName: string, board: DeckBoard): void;
  onEditTags(cardName: string, board: DeckBoard): void;
  onToggleOwned?(cardName: string): boolean;
  isOwned?(cardName: string): boolean;
  onAssignCategory?(cardName: string, board: DeckBoard, categoryId: string | undefined): void;
  getCustomCategories?(): CustomCategory[];
  getCardCategoryId?(cardName: string, board: DeckBoard): string | undefined;
  /** Ping a card to all collab participants (only shown when collab is active) */
  onPingCard?(cardName: string, board: DeckBoard): void;
  /** Whether collab is currently active */
  isCollabActive?(): boolean;
  /** Open thread/discussion for a card (Phase 2) */
  onDiscussCard?(cardName: string, board: DeckBoard): void;
  /** Add a decision note for a card (Phase 2) */
  onAddDecision?(cardName: string, board: DeckBoard): void;
  /** Find similar cards */
  onFindSimilar?(cardName: string): void;
  /** Print proxy view */
  onPrintProxy?(cardName: string): void;
  getScryfallUrl(cardName: string): string;
  boardOrder: DeckBoard[];
  boardLabels: Record<DeckBoard, string>;
}

// ==================== State ====================

let menuEl: HTMLElement | null = null;
let callbacks: ContextMenuCallbacks | null = null;
let ctxHighlightIndex = -1;
let ctxKeydownHandler: ((e: KeyboardEvent) => void) | null = null;

// ==================== Init ====================

export function initContextMenu(cb: ContextMenuCallbacks): void {
  callbacks = cb;

  menuEl = document.createElement('div');
  menuEl.className = 'context-menu';
  document.body.appendChild(menuEl);

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      hideContextMenu();
    }
  });

  // Close on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });
}

// ==================== Show / Hide ====================

export function showContextMenu(cardName: string, board: DeckBoard, event: MouseEvent): void {
  if (!menuEl || !callbacks) return;
  event.preventDefault();

  const otherBoards = callbacks.boardOrder.filter((b) => b !== board);

  replaceChildren(menuEl,
    // Move to submenu
    h('div', {},
      h('div', { className: 'ctx-label' }, 'Move to'),
      ...otherBoards.map((b) =>
        h('button', { className: 'ctx-item', onClick: () => {
          callbacks!.onMoveTo(cardName, board, b);
          hideContextMenu();
        }}, callbacks!.boardLabels[b]),
      ),
    ),
    h('div', { className: 'ctx-divider' }),

    // Quantity
    h('button', { className: 'ctx-item', onClick: () => {
      callbacks!.onQtyChange(cardName, board, 1);
      hideContextMenu();
    }}, '+1 Quantity'),
    h('button', { className: 'ctx-item', onClick: () => {
      callbacks!.onQtyChange(cardName, board, -1);
      hideContextMenu();
    }}, '-1 Quantity'),
    h('div', { className: 'ctx-divider' }),

    // Remove
    h('button', { className: 'ctx-item ctx-danger', onClick: () => {
      callbacks!.onRemove(cardName, board);
      hideContextMenu();
    }}, 'Remove from Deck'),
    h('div', { className: 'ctx-divider' }),

    // Tags
    h('button', { className: 'ctx-item', onClick: () => {
      callbacks!.onEditTags(cardName, board);
      hideContextMenu();
    }}, 'Add / Edit Tags'),

    // Custom Category assignment
    ...(callbacks.onAssignCategory && callbacks.getCustomCategories ? (() => {
      const cats = callbacks.getCustomCategories!();
      if (cats.length === 0) return [];
      const currentCatId = callbacks.getCardCategoryId?.(cardName, board);
      return [
        h('div', { className: 'ctx-divider' }),
        h('div', {},
          h('div', { className: 'ctx-label' }, 'Category'),
          ...cats.map((cat) =>
            h('button', {
              className: `ctx-item${currentCatId === cat.id ? ' ctx-active' : ''}`,
              onClick: () => {
                callbacks!.onAssignCategory!(cardName, board, currentCatId === cat.id ? undefined : cat.id);
                hideContextMenu();
              },
            },
              h('span', {
                className: 'ctx-color-dot',
                style: `background: ${cat.color}`,
              }),
              currentCatId === cat.id ? `${cat.name} ✓` : cat.name,
            ),
          ),
          h('button', {
            className: `ctx-item${!currentCatId ? ' ctx-active' : ''}`,
            onClick: () => {
              callbacks!.onAssignCategory!(cardName, board, undefined);
              hideContextMenu();
            },
          }, 'Auto (default)'),
        ),
      ];
    })() : []),

    // Toggle Owned (collection)
    ...(callbacks.onToggleOwned ? [
      h('button', { className: 'ctx-item', onClick: () => {
        callbacks!.onToggleOwned!(cardName);
        hideContextMenu();
      }}, callbacks.isOwned?.(cardName) ? 'Mark as Not Owned' : 'Mark as Owned'),
    ] : []),

    // Ping Card (collab only)
    ...(callbacks.onPingCard && callbacks.isCollabActive?.() ? [
      h('div', { className: 'ctx-divider' }),
      h('button', { className: 'ctx-item ctx-ping', onClick: () => {
        callbacks!.onPingCard!(cardName, board);
        hideContextMenu();
      }}, '\uD83D\uDCE1 Ping Card'),
    ] : []),

    // Discuss Card (collab only, Phase 2)
    ...(callbacks.onDiscussCard && callbacks.isCollabActive?.() ? [
      h('button', { className: 'ctx-item ctx-discuss', onClick: () => {
        callbacks!.onDiscussCard!(cardName, board);
        hideContextMenu();
      }}, '\uD83D\uDCAC Discuss Card'),
    ] : []),

    // Add Decision Note (collab only, Phase 2)
    ...(callbacks.onAddDecision && callbacks.isCollabActive?.() ? [
      h('button', { className: 'ctx-item ctx-decision', onClick: () => {
        callbacks!.onAddDecision!(cardName, board);
        hideContextMenu();
      }}, '\uD83D\uDCD6 Add Decision Note'),
    ] : []),
    h('div', { className: 'ctx-divider' }),

    // View on Scryfall
    h('a', {
      href: callbacks.getScryfallUrl(cardName),
      target: '_blank',
      className: 'ctx-item',
    }, 'View on Scryfall'),

    // Find Similar
    ...(callbacks.onFindSimilar ? [
      h('button', { className: 'ctx-item', onClick: () => {
        callbacks!.onFindSimilar!(cardName);
        hideContextMenu();
      }}, 'Find Similar...'),
    ] : []),

    // Print Proxy
    ...(callbacks.onPrintProxy ? [
      h('button', { className: 'ctx-item', onClick: () => {
        callbacks!.onPrintProxy!(cardName);
        hideContextMenu();
      }}, 'Print Proxy...'),
    ] : []),
  );

  // Position at cursor, clamped to viewport
  const menuW = 200;
  menuEl.style.left = '0px';
  menuEl.style.top = '0px';
  menuEl.classList.add('visible');

  // Get actual height after rendering
  const menuH = menuEl.offsetHeight;
  let left = event.clientX;
  let top = event.clientY;
  if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 8;
  if (top + menuH > window.innerHeight) top = window.innerHeight - menuH - 8;
  if (left < 0) left = 8;
  if (top < 0) top = 8;

  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;

  // Keyboard navigation
  ctxHighlightIndex = -1;
  if (ctxKeydownHandler) document.removeEventListener('keydown', ctxKeydownHandler);
  ctxKeydownHandler = (e: KeyboardEvent) => {
    if (!menuEl) return;
    const items = menuEl.querySelectorAll<HTMLElement>('.ctx-item');
    if (items.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      ctxHighlightIndex = (ctxHighlightIndex + 1) % items.length;
      updateCtxHighlight(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      ctxHighlightIndex = (ctxHighlightIndex - 1 + items.length) % items.length;
      updateCtxHighlight(items);
    } else if (e.key === 'Enter' && ctxHighlightIndex >= 0) {
      e.preventDefault();
      items[ctxHighlightIndex].click();
    }
  };
  document.addEventListener('keydown', ctxKeydownHandler);
}

export function hideContextMenu(): void {
  if (menuEl) menuEl.classList.remove('visible');
  ctxHighlightIndex = -1;
  if (ctxKeydownHandler) {
    document.removeEventListener('keydown', ctxKeydownHandler);
    ctxKeydownHandler = null;
  }
}

function updateCtxHighlight(items: NodeListOf<HTMLElement>): void {
  items.forEach((el, i) => {
    el.classList.toggle('ctx-menu-highlighted', i === ctxHighlightIndex);
  });
  if (ctxHighlightIndex >= 0) items[ctxHighlightIndex]?.scrollIntoView({ block: 'nearest' });
}
