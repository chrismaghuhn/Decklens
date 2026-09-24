// ============================================================
// Command Palette — Ctrl+K / Ctrl+Shift+P overlay
// ============================================================
// Fuzzy-searchable command palette for the deckbuilder.
// Register commands from any module, search + execute.
// ============================================================

import { h } from '../shared/dom.js';

// ==================== Types ====================

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;           // e.g. "Ctrl+S", "Ctrl+Z"
  category?: string;           // "File", "Edit", "View", "Navigation", "Tools"
  icon?: string;               // emoji or unicode char
  action: () => void | Promise<void>;
  /** If true, command is hidden from palette but shortcut still works */
  hidden?: boolean;
}

// ==================== Registry ====================

const commands: Map<string, PaletteCommand> = new Map();

/**
 * Register a command. Overwrites if ID already exists.
 */
export function registerCommand(cmd: PaletteCommand): void {
  commands.set(cmd.id, cmd);
}

/**
 * Register multiple commands at once.
 */
export function registerCommands(cmds: PaletteCommand[]): void {
  for (const cmd of cmds) commands.set(cmd.id, cmd);
}

/**
 * Unregister a command by ID.
 */
export function unregisterCommand(id: string): void {
  commands.delete(id);
}

/**
 * Get all registered commands.
 */
export function getCommands(): PaletteCommand[] {
  return [...commands.values()].filter(c => !c.hidden);
}

// ==================== Fuzzy Search ====================

/**
 * Simple fuzzy match: check if all chars of query appear in str in order.
 * Returns score (lower is better match), or -1 for no match.
 */
function fuzzyMatch(query: string, str: string): number {
  const q = query.toLowerCase();
  const s = str.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;

  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      // Bonus for consecutive matches
      if (lastMatchIdx === si - 1) {
        score -= 5;
      }
      // Bonus for word boundary matches
      if (si === 0 || s[si - 1] === ' ' || s[si - 1] === '/' || s[si - 1] === '-') {
        score -= 10;
      }
      lastMatchIdx = si;
      qi++;
      score += si; // Earlier matches score better
    }
  }

  return qi === q.length ? score : -1;
}

/**
 * Search commands by fuzzy matching on label + description.
 */
function searchCommands(query: string): PaletteCommand[] {
  if (!query.trim()) return getCommands();

  const results: Array<{ cmd: PaletteCommand; score: number }> = [];

  for (const cmd of commands.values()) {
    if (cmd.hidden) continue;
    const labelScore = fuzzyMatch(query, cmd.label);
    const descScore = cmd.description ? fuzzyMatch(query, cmd.description) : -1;
    const catScore = cmd.category ? fuzzyMatch(query, cmd.category) : -1;

    const bestScore = Math.min(
      labelScore >= 0 ? labelScore : Infinity,
      descScore >= 0 ? descScore + 50 : Infinity,
      catScore >= 0 ? catScore + 100 : Infinity
    );

    if (bestScore < Infinity) {
      results.push({ cmd, score: bestScore });
    }
  }

  results.sort((a, b) => a.score - b.score);
  return results.map(r => r.cmd);
}

// ==================== UI ====================

let paletteEl: HTMLElement | null = null;
let backdropEl: HTMLElement | null = null;
let selectedIndex = 0;
let currentResults: PaletteCommand[] = [];

function highlight(text: string, query: string): HTMLElement {
  const span = document.createElement('span');
  if (!query) {
    span.textContent = text;
    return span;
  }

  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;

  for (let i = 0; i < text.length; i++) {
    if (qi < q.length && t[i] === q[qi]) {
      const mark = document.createElement('mark');
      mark.textContent = text[i];
      mark.className = 'cmd-palette__highlight';
      span.appendChild(mark);
      qi++;
    } else {
      span.appendChild(document.createTextNode(text[i]));
    }
  }

  return span;
}

function renderResults(query: string): void {
  const list = document.querySelector('.cmd-palette__list');
  if (!list) return;

  currentResults = searchCommands(query);
  selectedIndex = 0;

  list.innerHTML = '';

  if (currentResults.length === 0) {
    const empty = h('div', { className: 'cmd-palette__empty' }, 'No commands found');
    list.appendChild(empty);
    return;
  }

  let lastCategory = '';

  for (let i = 0; i < currentResults.length; i++) {
    const cmd = currentResults[i];

    // Category header
    if (cmd.category && cmd.category !== lastCategory) {
      lastCategory = cmd.category;
      const header = h('div', { className: 'cmd-palette__category' }, cmd.category);
      list.appendChild(header);
    }

    const item = h('div', {
      className: `cmd-palette__item ${i === 0 ? 'cmd-palette__item--selected' : ''}`,
      'data-index': String(i),
      onClick: () => executeAndClose(cmd),
    },
      cmd.icon ? h('span', { className: 'cmd-palette__icon' }, cmd.icon) : null,
      h('div', { className: 'cmd-palette__item-content' },
        highlight(cmd.label, query),
        cmd.description
          ? h('span', { className: 'cmd-palette__desc' }, cmd.description)
          : null,
      ),
      cmd.shortcut
        ? h('kbd', { className: 'cmd-palette__kbd' }, cmd.shortcut)
        : null,
    );

    list.appendChild(item);
  }
}

function updateSelection(): void {
  const items = document.querySelectorAll('.cmd-palette__item');
  items.forEach((item, i) => {
    item.classList.toggle('cmd-palette__item--selected', i === selectedIndex);
  });
  // Scroll selected into view
  items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
}

function executeAndClose(cmd: PaletteCommand): void {
  closePalette();
  try {
    const result = cmd.action();
    if (result instanceof Promise) {
      result.catch(console.error);
    }
  } catch (e) {
    console.error('[cmd-palette] Command failed:', cmd.id, e);
  }
}

// ==================== Open / Close ====================

/**
 * Open the command palette.
 */
export function openPalette(): void {
  if (paletteEl) return; // Already open

  backdropEl = h('div', {
    className: 'cmd-palette-backdrop',
    onClick: (e: Event) => {
      if (e.target === backdropEl) closePalette();
    },
  });

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cmd-palette__input';
  input.placeholder = 'Type a command...';
  input.addEventListener('input', () => {
    renderResults(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
      updateSelection();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
      updateSelection();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (currentResults[selectedIndex]) {
        executeAndClose(currentResults[selectedIndex]);
      }
    } else if (e.key === 'Escape') {
      closePalette();
    }
  });

  paletteEl = h('div', { className: 'cmd-palette' },
    h('div', { className: 'cmd-palette__header' },
      h('span', { className: 'cmd-palette__icon-search' }, '◇'),
      input,
    ),
    h('div', { className: 'cmd-palette__list' }),
    h('div', { className: 'cmd-palette__footer' },
      h('span', {}, '\u2191\u2193 Navigate'),
      h('span', {}, '\u21B5 Select'),
      h('span', {}, 'Esc Close'),
    ),
  );

  backdropEl.appendChild(paletteEl);
  document.body.appendChild(backdropEl);
  input.focus();
  renderResults('');
}

/**
 * Close the command palette.
 */
export function closePalette(): void {
  if (backdropEl) {
    backdropEl.classList.add('cmd-palette--exit');
    backdropEl.addEventListener('animationend', () => {
      backdropEl?.remove();
      backdropEl = null;
      paletteEl = null;
    }, { once: true });
    // Fallback
    setTimeout(() => {
      backdropEl?.remove();
      backdropEl = null;
      paletteEl = null;
    }, 300);
  }
}

/**
 * Toggle the command palette.
 */
export function togglePalette(): void {
  if (paletteEl) closePalette();
  else openPalette();
}

// ==================== Global Keyboard Shortcut ====================

/**
 * Initialize the command palette keyboard listener.
 * Call this once during app startup.
 */
export function initCommandPalette(): void {
  document.addEventListener('keydown', (e) => {
    // Ctrl+K or Ctrl+Shift+P to open palette
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      togglePalette();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      togglePalette();
    }

    // Execute registered keyboard shortcuts (when palette is NOT open)
    if (!paletteEl) {
      for (const cmd of commands.values()) {
        if (cmd.shortcut && matchesShortcut(e, cmd.shortcut)) {
          e.preventDefault();
          try {
            const result = cmd.action();
            if (result instanceof Promise) result.catch(console.error);
          } catch (err) {
            console.error('[cmd-palette] Shortcut failed:', cmd.id, err);
          }
          break;
        }
      }
    }
  });
}

/**
 * Check if a keyboard event matches a shortcut string like "Ctrl+S".
 */
function matchesShortcut(e: KeyboardEvent, shortcut: string): boolean {
  const parts = shortcut.toLowerCase().split('+');
  const key = parts.pop() || '';

  const needsCtrl = parts.includes('ctrl') || parts.includes('cmd');
  const needsShift = parts.includes('shift');
  const needsAlt = parts.includes('alt');

  if (needsCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (needsShift !== e.shiftKey) return false;
  if (needsAlt !== e.altKey) return false;

  return e.key.toLowerCase() === key;
}
