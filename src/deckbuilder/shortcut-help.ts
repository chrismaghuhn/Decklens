/**
 * Keyboard Shortcut Help Overlay
 * Shows all available keyboard shortcuts in a modal overlay.
 * Toggle with '?' key or button click.
 * F4: Enhanced with custom shortcut mapping and conflict detection.
 */

import { h } from '../shared/dom.js';
import { storageGet, storageSet, STORAGE_KEYS } from '../shared/storage.js';

let overlayEl: HTMLElement | null = null;
let visible = false;

const SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: '/', description: 'Focus search field' },
  { keys: 'Ctrl+F', description: 'Filter cards in deck' },
  { keys: 'Esc', description: 'Close sidebar / clear selection' },
  { keys: 'Ctrl+Z', description: 'Undo' },
  { keys: 'Ctrl+Y', description: 'Redo' },
  { keys: '1', description: 'Switch to Commander' },
  { keys: '2', description: 'Switch to Mainboard' },
  { keys: '3', description: 'Switch to Maybeboard' },
  { keys: '4', description: 'Switch to Sideboard' },
  { keys: 'Ctrl+A', description: 'Select all cards' },
  { keys: 'Delete', description: 'Remove selected cards' },
  { keys: '\u2191 / \u2193', description: 'Navigate search results' },
  { keys: 'Enter', description: 'Add highlighted search card' },
  { keys: '?', description: 'Toggle this help overlay' },
  { keys: '', description: '\u2500\u2500 Collab Panels \u2500\u2500' },
  { keys: 'Alt+C', description: 'Toggle Chat' },
  { keys: 'Alt+A', description: 'Toggle Activity' },
  { keys: 'Alt+T', description: 'Toggle Timeline' },
  { keys: 'Alt+D', description: 'Toggle Diff' },
  { keys: 'Alt+P', description: 'Toggle Proposals' },
  { keys: 'Alt+H', description: 'Toggle Threads' },
  { keys: 'Alt+L', description: 'Toggle Decisions' },
  { keys: 'Alt+K', description: 'Toggle Tasks' },
  { keys: 'Alt+O', description: 'Toggle Collection' },
  { keys: 'Alt+N', description: 'Toggle Constraints' },
  { keys: 'Alt+G', description: 'Toggle Packages' },
  { keys: 'Alt+S', description: 'Toggle Spectator' },
  { keys: 'Alt+E', description: 'Toggle Tests' },
  { keys: 'Alt+B', description: 'Toggle Sideboard' },
  { keys: 'Esc', description: 'Close open collab panel' },
];

// ==================== F4: Custom Shortcut Mapping ====================

interface ShortcutMapping {
  [defaultKeys: string]: string; // defaultKeys -> customKeys
}

let customMappings: ShortcutMapping = {};
let rebindMode = false;
let rebindTarget: string | null = null;

export function loadCustomShortcuts(): void {
  customMappings = storageGet<ShortcutMapping>(STORAGE_KEYS.DECKBUILDER_CUSTOM_SHORTCUTS, {});
}

export function getCustomShortcut(defaultKeys: string): string {
  return customMappings[defaultKeys] || defaultKeys;
}

export function setCustomShortcut(defaultKeys: string, newKeys: string): boolean {
  // Conflict detection: check if newKeys is already assigned to another custom mapping
  const conflict = Object.entries(customMappings).find(([dk, ck]) => ck === newKeys && dk !== defaultKeys);
  if (conflict) return false;

  // Also check default shortcuts that haven't been remapped
  const defaultConflict = SHORTCUTS.find((s) => s.keys === newKeys && s.keys !== defaultKeys);
  if (defaultConflict && !customMappings[defaultConflict.keys]) return false;

  if (newKeys === defaultKeys) {
    delete customMappings[defaultKeys];
  } else {
    customMappings[defaultKeys] = newKeys;
  }
  storageSet(STORAGE_KEYS.DECKBUILDER_CUSTOM_SHORTCUTS, customMappings);
  return true;
}

export function resetAllShortcuts(): void {
  customMappings = {};
  storageSet(STORAGE_KEYS.DECKBUILDER_CUSTOM_SHORTCUTS, {});
}

export function getEffectiveShortcuts(): Array<{ keys: string; description: string; customized: boolean }> {
  return SHORTCUTS.map((s) => ({
    keys: customMappings[s.keys] || s.keys,
    description: s.description,
    customized: !!customMappings[s.keys],
  }));
}

// ==================== Overlay ====================

function buildKeyComboString(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const key = event.key;
  // Avoid adding modifier keys themselves
  if (!['Control', 'Alt', 'Shift', 'Meta'].includes(key)) {
    parts.push(key.length === 1 ? key.toUpperCase() : key);
  }

  return parts.join('+');
}

function createOverlay(): HTMLElement {
  const effective = getEffectiveShortcuts();

  const backdrop = h('div', {
    className: 'shortcut-help-backdrop',
    onClick: () => hideShortcutHelp(),
  });

  // Action buttons row
  const customizeBtn = h('button', {
    className: 'shortcut-customize-btn',
    onClick: () => {
      rebindMode = !rebindMode;
      rebindTarget = null;
      // Re-render overlay to reflect mode change
      destroyOverlay();
      showShortcutHelp();
    },
  }, rebindMode ? 'Done' : 'Customize');

  const resetBtn = h('button', {
    className: 'shortcut-reset-btn',
    onClick: () => {
      resetAllShortcuts();
      rebindMode = false;
      rebindTarget = null;
      destroyOverlay();
      showShortcutHelp();
    },
  }, 'Reset Defaults');

  const actionsRow = h('div', { className: 'shortcut-help-actions' }, customizeBtn, resetBtn);

  // Build shortcut rows
  const rows = effective.map((sc) => {
    const isSection = sc.keys === '' || sc.keys === '\u2500\u2500 Collab Panels \u2500\u2500';
    const rowClass = sc.customized ? 'shortcut-help-row shortcut-customized' : 'shortcut-help-row';

    const keyEl = h('kbd', { className: 'shortcut-key' }, sc.keys);
    const descChildren: (HTMLElement | string)[] = [sc.description];
    if (sc.customized) {
      descChildren.push(h('span', { className: 'shortcut-custom-badge' }, '(custom)') as unknown as string);
    }
    const descEl = h('span', { className: 'shortcut-desc' }, ...descChildren);

    const row = h('div', { className: rowClass }, keyEl, descEl);

    // In rebind mode, make non-section keys clickable
    if (rebindMode && !isSection && sc.keys) {
      keyEl.style.cursor = 'pointer';
      keyEl.title = 'Click to rebind this shortcut';
      keyEl.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        // Find the original default key for this shortcut
        const idx = effective.indexOf(sc);
        const defaultKey = SHORTCUTS[idx]?.keys;
        if (!defaultKey) return;

        rebindTarget = defaultKey;
        // Highlight the active rebind target
        const allKeys = backdrop.querySelectorAll('.shortcut-key');
        allKeys.forEach((el) => el.classList.remove('shortcut-rebind-active'));
        keyEl.classList.add('shortcut-rebind-active');
        keyEl.textContent = 'Press new key...';
      });
    }

    return row;
  });

  const modal = h('div', {
    className: 'shortcut-help-modal',
    onClick: (e: Event) => e.stopPropagation(),
  },
    h('div', { className: 'shortcut-help-header' },
      h('h3', {}, 'Keyboard Shortcuts'),
      h('button', {
        className: 'shortcut-help-close',
        'aria-label': 'Close',
        onClick: () => hideShortcutHelp(),
      }, '\u00d7'),
    ),
    actionsRow,
    h('div', { className: 'shortcut-help-grid' }, ...rows),
  );

  backdrop.appendChild(modal);
  return backdrop;
}

function destroyOverlay(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
  }
}

export function showShortcutHelp(): void {
  if (!overlayEl) {
    overlayEl = createOverlay();
    document.body.appendChild(overlayEl);
  }
  overlayEl.style.display = '';
  visible = true;
}

export function hideShortcutHelp(): void {
  if (overlayEl) {
    overlayEl.style.display = 'none';
  }
  visible = false;
  rebindMode = false;
  rebindTarget = null;
}

export function toggleShortcutHelp(): void {
  if (visible) hideShortcutHelp();
  else showShortcutHelp();
}

/**
 * Initialize keyboard shortcut help.
 * Binds '?' key to toggle the overlay.
 * F4: Also loads custom shortcut mappings and handles rebind key capture.
 */
export function initShortcutHelp(): void {
  loadCustomShortcuts();

  document.addEventListener('keydown', (event) => {
    // F4: If we are in rebind mode and waiting for a key, capture it
    if (rebindMode && rebindTarget && visible) {
      const combo = buildKeyComboString(event);
      // Ignore bare modifier presses
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;

      event.preventDefault();
      event.stopPropagation();

      const success = setCustomShortcut(rebindTarget, combo);
      rebindTarget = null;

      // Re-render to show the result
      destroyOverlay();
      if (!success) {
        // Show briefly, then re-open with rebind mode still on
        rebindMode = true;
        showShortcutHelp();
        // Flash a warning on the actions row
        const actionsEl = overlayEl?.querySelector('.shortcut-help-actions');
        if (actionsEl) {
          const warn = h('span', {
            style: 'color: var(--danger, #ef4444); font-size: 0.75rem; margin-left: 8px;',
          }, 'Conflict! Key already in use.');
          actionsEl.appendChild(warn);
          setTimeout(() => warn.remove(), 2500);
        }
      } else {
        rebindMode = true;
        showShortcutHelp();
      }
      return;
    }

    // Only trigger when no input is focused
    const target = event.target as HTMLElement | null;
    const isInputLike = target && (
      target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.isContentEditable
    );

    if (event.key === '?' && !isInputLike) {
      event.preventDefault();
      toggleShortcutHelp();
      return;
    }

    // Escape closes the help if visible
    if (event.key === 'Escape' && visible) {
      event.preventDefault();
      hideShortcutHelp();
    }
  });
}
