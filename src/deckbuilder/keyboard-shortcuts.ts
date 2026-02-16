// ============================================================
// Keyboard Shortcuts — Customizable hotkey system
// ============================================================
// Extends cmd-palette with user-configurable shortcuts.
// Persisted in localStorage under DECKBUILDER_CUSTOM_SHORTCUTS.
// ============================================================

import { registerCommands, type PaletteCommand } from './cmd-palette.js';

// ==================== Types ====================

export interface ShortcutBinding {
  id: string;
  shortcut: string;       // e.g. "Ctrl+S", "Ctrl+Shift+Z"
  label: string;
  category: string;
}

export interface ShortcutConfig {
  bindings: ShortcutBinding[];
  version: number;
}

// ==================== Storage ====================

const STORAGE_KEY = 'DECKBUILDER_CUSTOM_SHORTCUTS';
const DEFAULT_VERSION = 1;

function loadConfig(): ShortcutConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { bindings: [], version: DEFAULT_VERSION };
}

function saveConfig(config: ShortcutConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// ==================== Default Bindings ====================

const DEFAULT_BINDINGS: ShortcutBinding[] = [
  { id: 'shortcut.save', shortcut: 'Ctrl+S', label: 'Save Deck / Commit', category: 'File' },
  { id: 'shortcut.undo', shortcut: 'Ctrl+Z', label: 'Undo', category: 'Edit' },
  { id: 'shortcut.redo', shortcut: 'Ctrl+Shift+Z', label: 'Redo', category: 'Edit' },
  { id: 'shortcut.search', shortcut: 'Ctrl+F', label: 'Search Cards', category: 'Navigation' },
  { id: 'shortcut.palette', shortcut: 'Ctrl+K', label: 'Command Palette', category: 'Navigation' },
  { id: 'shortcut.bulkEdit', shortcut: 'Ctrl+Shift+V', label: 'Bulk Edit / Paste List', category: 'Edit' },
  { id: 'shortcut.newBranch', shortcut: 'Ctrl+B', label: 'New Branch', category: 'Git' },
  { id: 'shortcut.switchBranch', shortcut: 'Ctrl+Shift+B', label: 'Switch Branch', category: 'Git' },
  { id: 'shortcut.viewDiff', shortcut: 'Ctrl+D', label: 'View Diff', category: 'Git' },
  { id: 'shortcut.toggleSidebar', shortcut: 'Ctrl+\\', label: 'Toggle Sidebar', category: 'View' },
  { id: 'shortcut.export', shortcut: 'Ctrl+E', label: 'Export Deck', category: 'File' },
  { id: 'shortcut.help', shortcut: 'F1', label: 'Show Help', category: 'Navigation' },
];

// ==================== Manager ====================

const actionMap = new Map<string, () => void | Promise<void>>();

/**
 * Get effective bindings: user overrides merged with defaults.
 */
export function getEffectiveBindings(): ShortcutBinding[] {
  const config = loadConfig();
  const userMap = new Map(config.bindings.map(b => [b.id, b]));

  return DEFAULT_BINDINGS.map(def => {
    const override = userMap.get(def.id);
    return override ? { ...def, shortcut: override.shortcut } : def;
  });
}

/**
 * Set a custom shortcut for a command.
 */
export function setCustomShortcut(id: string, shortcut: string): void {
  const config = loadConfig();
  const existing = config.bindings.find(b => b.id === id);
  if (existing) {
    existing.shortcut = shortcut;
  } else {
    const def = DEFAULT_BINDINGS.find(b => b.id === id);
    if (def) {
      config.bindings.push({ ...def, shortcut });
    }
  }
  saveConfig(config);
}

/**
 * Reset a shortcut to its default.
 */
export function resetShortcut(id: string): void {
  const config = loadConfig();
  config.bindings = config.bindings.filter(b => b.id !== id);
  saveConfig(config);
}

/**
 * Reset all shortcuts to defaults.
 */
export function resetAllShortcuts(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Register a shortcut action handler.
 */
export function registerShortcutAction(id: string, action: () => void | Promise<void>): void {
  actionMap.set(id, action);
}

/**
 * Check if a shortcut string conflicts with an existing binding.
 */
export function hasConflict(shortcut: string, excludeId?: string): ShortcutBinding | null {
  const bindings = getEffectiveBindings();
  return bindings.find(b => b.shortcut.toLowerCase() === shortcut.toLowerCase() && b.id !== excludeId) ?? null;
}

/**
 * Initialize keyboard shortcuts: register all as palette commands.
 */
export function initKeyboardShortcuts(actions: Record<string, () => void | Promise<void>>): void {
  // Register action handlers
  for (const [id, action] of Object.entries(actions)) {
    actionMap.set(id, action);
  }

  // Register as palette commands
  const bindings = getEffectiveBindings();
  const cmds: PaletteCommand[] = bindings
    .filter(b => actionMap.has(b.id))
    .map(b => ({
      id: b.id,
      label: b.label,
      shortcut: b.shortcut,
      category: b.category,
      action: actionMap.get(b.id)!,
    }));

  registerCommands(cmds);
}

/**
 * Format a shortcut string for display (platform-aware).
 */
export function formatShortcut(shortcut: string): string {
  const isMac = navigator.platform?.toLowerCase().includes('mac');
  if (isMac) {
    return shortcut
      .replace(/Ctrl\+/gi, '⌘')
      .replace(/Alt\+/gi, '⌥')
      .replace(/Shift\+/gi, '⇧');
  }
  return shortcut;
}
