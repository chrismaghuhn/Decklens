// ============================================================
// Bulk Edit — Multi-card paste, diff preview, and batch apply
// ============================================================
// Paste an Arena/MTGO decklist, see a diff of what will change,
// and apply changes in bulk. Also supports batch operations
// like "remove all cards tagged 'ramp'".
// ============================================================

import { h } from '../shared/dom.js';
import { showConfirmModal } from './confirm-modal.js';
import type { DeckBoard, DeckbuilderBoards, DeckbuilderCardEntry } from './types.js';

// ==================== Types ====================

export interface BulkDiffEntry {
  name: string;
  board: DeckBoard;
  action: 'add' | 'remove' | 'update';
  oldQty: number;
  newQty: number;
}

export interface BulkEditCallbacks {
  getBoards: () => DeckbuilderBoards;
  addCard: (board: DeckBoard, name: string, qty: number) => void;
  removeCard: (board: DeckBoard, name: string) => void;
  updateCardQty: (board: DeckBoard, name: string, qty: number) => void;
  saveAndRender: () => void;
}

// ==================== Clipboard Parser ====================

interface ParsedLine {
  qty: number;
  name: string;
  board: DeckBoard;
  set?: string;
  collectorNumber?: string;
}

/**
 * Parse a decklist string (Arena, MTGO, or raw format).
 */
export function parseDecklist(text: string): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let currentBoard: DeckBoard = 'mainboard';

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    // Board headers
    const headerLower = line.toLowerCase();
    if (headerLower === 'commander' || headerLower === 'commander:') {
      currentBoard = 'commander';
      continue;
    }
    if (headerLower === 'deck' || headerLower === 'mainboard' || headerLower === 'mainboard:' || headerLower === 'main deck') {
      currentBoard = 'mainboard';
      continue;
    }
    if (headerLower === 'sideboard' || headerLower === 'sideboard:') {
      currentBoard = 'sideboard';
      continue;
    }
    if (headerLower === 'maybeboard' || headerLower === 'maybeboard:' || headerLower === 'considering') {
      currentBoard = 'maybeboard';
      continue;
    }

    // Skip comment lines
    if (line.startsWith('//') || line.startsWith('#')) continue;

    // Arena format: "1 Lightning Bolt (MH3) 303"
    const arenaMatch = line.match(/^(\d+)\s+(.+?)(?:\s+\((\w+)\)\s+(\d+))?$/);
    if (arenaMatch) {
      lines.push({
        qty: parseInt(arenaMatch[1], 10),
        name: arenaMatch[2].trim(),
        board: currentBoard,
        set: arenaMatch[3] || undefined,
        collectorNumber: arenaMatch[4] || undefined,
      });
      continue;
    }

    // MTGO format: "1 Lightning Bolt" or just "Lightning Bolt"
    const mtgoMatch = line.match(/^(\d+)\s+(.+)$/);
    if (mtgoMatch) {
      lines.push({
        qty: parseInt(mtgoMatch[1], 10),
        name: mtgoMatch[2].trim(),
        board: currentBoard,
      });
      continue;
    }

    // Bare card name (assume qty 1)
    if (line.length > 1 && !line.match(/^\d+$/)) {
      lines.push({
        qty: 1,
        name: line,
        board: currentBoard,
      });
    }
  }

  return lines;
}

// ==================== Diff Computation ====================

/**
 * Compute the diff between current deck state and a parsed list.
 */
export function computeBulkDiff(
  currentBoards: DeckbuilderBoards,
  parsed: ParsedLine[]
): BulkDiffEntry[] {
  const diff: BulkDiffEntry[] = [];

  // Build map of current cards
  const currentMap = new Map<string, { board: DeckBoard; qty: number }>();
  for (const board of ['commander', 'mainboard', 'sideboard', 'maybeboard'] as DeckBoard[]) {
    for (const entry of currentBoards[board]) {
      currentMap.set(`${board}:${entry.name}`, { board, qty: entry.qty });
    }
  }

  // Build map of new cards
  const newMap = new Map<string, { board: DeckBoard; qty: number }>();
  for (const line of parsed) {
    const key = `${line.board}:${line.name}`;
    const existing = newMap.get(key);
    if (existing) {
      existing.qty += line.qty;
    } else {
      newMap.set(key, { board: line.board, qty: line.qty });
    }
  }

  // Find additions and updates
  for (const [key, newEntry] of newMap) {
    const current = currentMap.get(key);
    if (!current) {
      diff.push({
        name: key.split(':').slice(1).join(':'),
        board: newEntry.board,
        action: 'add',
        oldQty: 0,
        newQty: newEntry.qty,
      });
    } else if (current.qty !== newEntry.qty) {
      diff.push({
        name: key.split(':').slice(1).join(':'),
        board: newEntry.board,
        action: 'update',
        oldQty: current.qty,
        newQty: newEntry.qty,
      });
    }
  }

  // Find removals (in current but not in new)
  for (const [key, current] of currentMap) {
    if (!newMap.has(key)) {
      diff.push({
        name: key.split(':').slice(1).join(':'),
        board: current.board,
        action: 'remove',
        oldQty: current.qty,
        newQty: 0,
      });
    }
  }

  // Sort: removals first, then updates, then additions
  const order = { remove: 0, update: 1, add: 2 };
  diff.sort((a, b) => order[a.action] - order[b.action]);

  return diff;
}

// ==================== Bulk Edit Modal ====================

/**
 * Open the bulk edit modal for paste + diff + apply.
 */
export function openBulkEditModal(callbacks: BulkEditCallbacks): void {
  let currentDiff: BulkDiffEntry[] = [];

  const textarea = document.createElement('textarea');
  textarea.className = 'bulk-edit__textarea';
  textarea.placeholder = 'Paste your decklist here...\n\nSupported formats:\n- MTG Arena (1 Lightning Bolt (MH3) 303)\n- MTGO (1 Lightning Bolt)\n- Raw (Lightning Bolt)\n\nUse headers like "Commander:", "Sideboard:" etc.';
  textarea.rows = 12;

  const diffContainer = h('div', { className: 'bulk-edit__diff' });
  const statsEl = h('div', { className: 'bulk-edit__stats' });

  textarea.addEventListener('input', () => {
    const parsed = parseDecklist(textarea.value);
    currentDiff = computeBulkDiff(callbacks.getBoards(), parsed);
    renderDiff(diffContainer, statsEl, currentDiff);
  });

  const backdrop = document.createElement('div');
  backdrop.className = 'confirm-modal-backdrop';

  const modal = h('div', {
    className: 'confirm-modal bulk-edit-modal',
    onClick: (e: Event) => e.stopPropagation(),
  },
    h('h3', { className: 'confirm-modal__title' }, 'Bulk Edit'),
    h('p', { className: 'confirm-modal__msg' }, 'Paste a decklist to see changes:'),
    textarea,
    statsEl,
    diffContainer,
    h('div', { className: 'confirm-modal__actions' },
      h('button', {
        className: 'btn',
        onClick: () => { backdrop.remove(); },
      }, 'Cancel'),
      h('button', {
        className: 'btn primary',
        onClick: () => {
          applyBulkDiff(currentDiff, callbacks);
          backdrop.remove();
        },
      }, 'Apply Changes'),
    ),
  );

  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
  textarea.focus();
}

function renderDiff(container: HTMLElement, statsEl: HTMLElement, diff: BulkDiffEntry[]): void {
  container.innerHTML = '';
  statsEl.innerHTML = '';

  if (diff.length === 0) {
    container.appendChild(h('div', { className: 'bulk-edit__empty' }, 'No changes detected'));
    return;
  }

  const adds = diff.filter(d => d.action === 'add').length;
  const updates = diff.filter(d => d.action === 'update').length;
  const removes = diff.filter(d => d.action === 'remove').length;

  statsEl.appendChild(h('span', { className: 'bulk-edit__stat-add' }, `+${adds}`));
  statsEl.appendChild(h('span', { className: 'bulk-edit__stat-update' }, `~${updates}`));
  statsEl.appendChild(h('span', { className: 'bulk-edit__stat-remove' }, `-${removes}`));

  for (const entry of diff.slice(0, 50)) { // Cap at 50 for performance
    const symbol = entry.action === 'add' ? '+' : entry.action === 'remove' ? '-' : '~';
    const className = `bulk-edit__diff-line bulk-edit__diff-line--${entry.action}`;
    const qty = entry.action === 'update'
      ? `${entry.oldQty} -> ${entry.newQty}`
      : `${entry.newQty}`;

    container.appendChild(h('div', { className },
      h('span', { className: 'bulk-edit__diff-symbol' }, symbol),
      h('span', { className: 'bulk-edit__diff-qty' }, qty),
      h('span', { className: 'bulk-edit__diff-name' }, entry.name),
      h('span', { className: 'bulk-edit__diff-board' }, entry.board),
    ));
  }

  if (diff.length > 50) {
    container.appendChild(h('div', { className: 'bulk-edit__more' }, `... and ${diff.length - 50} more`));
  }
}

function applyBulkDiff(diff: BulkDiffEntry[], callbacks: BulkEditCallbacks): void {
  for (const entry of diff) {
    switch (entry.action) {
      case 'add':
        callbacks.addCard(entry.board, entry.name, entry.newQty);
        break;
      case 'remove':
        callbacks.removeCard(entry.board, entry.name);
        break;
      case 'update':
        callbacks.updateCardQty(entry.board, entry.name, entry.newQty);
        break;
    }
  }
  callbacks.saveAndRender();
}
