import type { DeckBoard, DeckbuilderCardView } from './types.js';

// ==================== Types ====================

export interface DragDropCallbacks {
  onDropToBoard(cardNames: string[], fromBoard: DeckBoard, toBoard: DeckBoard): void;
  onDropFromSearch(card: DeckbuilderCardView, toBoard: DeckBoard): void;
  getSelectedCards(): Set<string>;
  getActiveBoard(): DeckBoard;
}

interface DragPayloadDeckCards {
  type: 'deck-cards';
  board: DeckBoard;
  names: string[];
}

interface DragPayloadSearchCard {
  type: 'search-card';
  card: DeckbuilderCardView;
}

type DragPayload = DragPayloadDeckCards | DragPayloadSearchCard;

const MIME = 'application/json';

// ==================== State ====================

let callbacks: DragDropCallbacks | null = null;
let activeDragCount = 0;

// ==================== Init ====================

export function initDragDrop(cb: DragDropCallbacks): void {
  callbacks = cb;
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragend', onDragEnd);
}

export function destroyDragDrop(): void {
  document.removeEventListener('dragstart', onDragStart);
  document.removeEventListener('dragend', onDragEnd);
  callbacks = null;
}

// ==================== Make Elements Draggable ====================

/**
 * Board nav buttons and the board content area are already wired via
 * the delegated dragover/drop on document. Card elements need
 * draggable="true" set in view-modes.ts (already done).
 */

// ==================== Drop Zones ====================

export function makeDropZone(el: HTMLElement, board: DeckBoard): void {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    el.classList.add('drop-target');
  });

  el.addEventListener('dragleave', (e) => {
    // Only remove if leaving the element itself (not a child)
    if (e.relatedTarget && el.contains(e.relatedTarget as Node)) return;
    el.classList.remove('drop-target');
  });

  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drop-target');
    if (!callbacks) return;

    const raw = e.dataTransfer?.getData(MIME);
    if (!raw) return;

    let payload: DragPayload;
    try {
      payload = JSON.parse(raw) as DragPayload;
    } catch {
      return;
    }

    if (payload.type === 'deck-cards') {
      callbacks.onDropToBoard(payload.names, payload.board, board);
    } else if (payload.type === 'search-card') {
      callbacks.onDropFromSearch(payload.card, board);
    }
  });
}

export function makeSearchResultDraggable(el: HTMLElement, card: DeckbuilderCardView): void {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    if (!e.dataTransfer) return;
    const payload: DragPayloadSearchCard = { type: 'search-card', card };
    e.dataTransfer.setData(MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';

    // Custom drag image with card art
    if (card.image_uris?.small) {
      const ghost = document.createElement('img');
      ghost.src = card.image_uris.small;
      ghost.style.width = '80px';
      ghost.style.borderRadius = '6px';
      ghost.style.position = 'absolute';
      ghost.style.top = '-9999px';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 40, 55);
      requestAnimationFrame(() => ghost.remove());
    }
  });
}

// ==================== Drag Handlers ====================

function onDragStart(e: DragEvent): void {
  if (!callbacks || !e.dataTransfer) return;

  const cardEl = (e.target as HTMLElement).closest<HTMLElement>('[data-card-name][data-board]');
  if (!cardEl) return;

  const cardName = cardEl.dataset.cardName || '';
  const board = cardEl.dataset.board as DeckBoard;
  if (!cardName || !board) return;

  const selected = callbacks.getSelectedCards();
  const key = cardName.trim().toLowerCase().replace(/\s+/g, ' ');

  // If dragged card is selected, drag all selected. Otherwise drag just this card.
  let names: string[];
  if (selected.has(key) && selected.size > 1) {
    names = [...selected];
    activeDragCount = selected.size;
  } else {
    names = [key];
    activeDragCount = 1;
  }

  const payload: DragPayloadDeckCards = { type: 'deck-cards', board, names };
  e.dataTransfer.setData(MIME, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'move';

  // Visual: add .dragging to all dragged cards
  for (const name of names) {
    document.querySelectorAll<HTMLElement>(`[data-card-name]`).forEach((el) => {
      const elKey = (el.dataset.cardName || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (names.includes(elKey)) el.classList.add('dragging');
    });
  }

  // Custom drag image
  if (activeDragCount > 1) {
    const badge = document.createElement('div');
    badge.textContent = `${activeDragCount} cards`;
    badge.style.cssText = 'background:#53c58b;color:#0f1218;padding:6px 12px;border-radius:8px;font-weight:600;font-size:14px;position:absolute;top:-9999px;';
    document.body.appendChild(badge);
    e.dataTransfer.setDragImage(badge, 40, 16);
    requestAnimationFrame(() => badge.remove());
  } else {
    // Use the card element itself as drag image (default behavior is fine)
    const cardImg = cardEl.querySelector('img');
    if (cardImg) {
      const ghost = cardImg.cloneNode(true) as HTMLImageElement;
      ghost.style.width = '80px';
      ghost.style.borderRadius = '6px';
      ghost.style.position = 'absolute';
      ghost.style.top = '-9999px';
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 40, 55);
      requestAnimationFrame(() => ghost.remove());
    }
  }
}

function onDragEnd(_e: DragEvent): void {
  // Remove all .dragging classes
  document.querySelectorAll<HTMLElement>('.dragging').forEach((el) => {
    el.classList.remove('dragging');
  });
  // Remove all .drop-target classes
  document.querySelectorAll<HTMLElement>('.drop-target').forEach((el) => {
    el.classList.remove('drop-target');
  });
  activeDragCount = 0;
}
