// ============================================================
// Deck Templates / Blueprints — Save, load, share deck skeletons
// ============================================================
// Create templates from existing decks, load templates to
// seed new decks, and browse a shared template gallery.
// ============================================================

import { h } from '../shared/dom.js';
import type {
  DeckbuilderBoards,
  DeckbuilderCardEntry,
  DeckBoard,
  DeckFormat,
} from './types.js';

// ==================== Types ====================

export interface DeckTemplate {
  id: string;
  name: string;
  description: string;
  format: DeckFormat;
  boards: DeckbuilderBoards;
  tags: string[];              // ["aggro", "combo", "budget", "competitive"]
  authorName?: string;
  createdAt: string;
  cardCount: number;
}

export interface TemplateCallbacks {
  apiBaseUrl: string;
  getUserId: () => string | null;
  getUserName: () => string;
}

// ==================== Template Creation ====================

/**
 * Create a template from an existing deck.
 */
export function createTemplateFromDeck(
  name: string,
  description: string,
  format: DeckFormat,
  boards: DeckbuilderBoards,
  tags: string[] = []
): Omit<DeckTemplate, 'id' | 'createdAt'> {
  const cardCount = (['commander', 'mainboard', 'sideboard', 'maybeboard'] as DeckBoard[])
    .reduce((sum, board) => sum + boards[board].reduce((s, c) => s + c.qty, 0), 0);

  return {
    name,
    description,
    format,
    boards: stripSensitiveData(boards),
    tags,
    cardCount,
  };
}

/**
 * Strip set/collector data from template (keep just card names + qty).
 */
function stripSensitiveData(boards: DeckbuilderBoards): DeckbuilderBoards {
  const strip = (entries: DeckbuilderCardEntry[]): DeckbuilderCardEntry[] =>
    entries.map(e => ({ name: e.name, qty: e.qty, tags: e.tags }));

  return {
    commander: strip(boards.commander),
    mainboard: strip(boards.mainboard),
    sideboard: strip(boards.sideboard),
    maybeboard: strip(boards.maybeboard),
  };
}

// ==================== Template Application ====================

/**
 * Apply a template to create a new deck's boards.
 * Returns a fresh copy of the template boards.
 */
export function applyTemplate(template: DeckTemplate): DeckbuilderBoards {
  const clone = (entries: DeckbuilderCardEntry[]): DeckbuilderCardEntry[] =>
    entries.map(e => ({ ...e, tags: [...e.tags] }));

  return {
    commander: clone(template.boards.commander),
    mainboard: clone(template.boards.mainboard),
    sideboard: clone(template.boards.sideboard),
    maybeboard: clone(template.boards.maybeboard),
  };
}

/**
 * Merge a template into an existing deck (add missing cards).
 */
export function mergeTemplate(
  existing: DeckbuilderBoards,
  template: DeckTemplate
): { added: string[]; skipped: string[] } {
  const added: string[] = [];
  const skipped: string[] = [];

  for (const board of ['commander', 'mainboard', 'sideboard', 'maybeboard'] as DeckBoard[]) {
    const existingNames = new Set(existing[board].map(e => e.name));
    for (const entry of template.boards[board]) {
      if (existingNames.has(entry.name)) {
        skipped.push(entry.name);
      } else {
        existing[board].push({ ...entry, tags: [...entry.tags] });
        added.push(entry.name);
      }
    }
  }

  return { added, skipped };
}

// ==================== Built-in Templates ====================

/**
 * Get built-in starter templates for common archetypes.
 */
export function getBuiltinTemplates(): DeckTemplate[] {
  return [
    {
      id: 'builtin-edh-ramp-shell',
      name: 'EDH Ramp Shell',
      description: 'A solid 37-land, 10-ramp base for any EDH deck.',
      format: 'commander',
      boards: {
        commander: [],
        mainboard: [
          { name: 'Sol Ring', qty: 1, tags: ['ramp'] },
          { name: 'Arcane Signet', qty: 1, tags: ['ramp'] },
          { name: 'Command Tower', qty: 1, tags: ['land'] },
          { name: 'Thought Vessel', qty: 1, tags: ['ramp'] },
          { name: 'Fellwar Stone', qty: 1, tags: ['ramp'] },
          { name: 'Mind Stone', qty: 1, tags: ['ramp'] },
          { name: 'Talisman of Progress', qty: 1, tags: ['ramp'] },
          { name: 'Cultivate', qty: 1, tags: ['ramp'] },
          { name: 'Kodama\'s Reach', qty: 1, tags: ['ramp'] },
          { name: 'Rampant Growth', qty: 1, tags: ['ramp'] },
        ],
        sideboard: [],
        maybeboard: [],
      },
      tags: ['edh', 'ramp', 'base', 'starter'],
      cardCount: 10,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'builtin-edh-draw-package',
      name: 'EDH Draw Package',
      description: '10 flexible card draw options for any EDH deck.',
      format: 'commander',
      boards: {
        commander: [],
        mainboard: [
          { name: 'Rhystic Study', qty: 1, tags: ['draw'] },
          { name: 'Mystic Remora', qty: 1, tags: ['draw'] },
          { name: 'Phyrexian Arena', qty: 1, tags: ['draw'] },
          { name: 'Beast Whisperer', qty: 1, tags: ['draw'] },
          { name: 'Guardian Project', qty: 1, tags: ['draw'] },
          { name: 'Esper Sentinel', qty: 1, tags: ['draw'] },
          { name: 'Sylvan Library', qty: 1, tags: ['draw'] },
          { name: 'Dark Confidant', qty: 1, tags: ['draw'] },
          { name: 'Skullclamp', qty: 1, tags: ['draw'] },
          { name: 'Brainstorm', qty: 1, tags: ['draw'] },
        ],
        sideboard: [],
        maybeboard: [],
      },
      tags: ['edh', 'draw', 'package'],
      cardCount: 10,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ];
}

// ==================== API Integration ====================

/**
 * Save a template to the server.
 */
export async function saveTemplate(
  template: Omit<DeckTemplate, 'id' | 'createdAt'>,
  callbacks: TemplateCallbacks
): Promise<DeckTemplate> {
  const response = await fetch(`${callbacks.apiBaseUrl}/api/templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      ...template,
      authorName: callbacks.getUserName(),
    }),
  });

  if (!response.ok) throw new Error('Failed to save template');
  return response.json();
}

/**
 * Load templates from the server.
 */
export async function loadTemplates(
  callbacks: TemplateCallbacks,
  options?: { format?: DeckFormat; tag?: string }
): Promise<DeckTemplate[]> {
  const params = new URLSearchParams();
  if (options?.format) params.set('format', options.format);
  if (options?.tag) params.set('tag', options.tag);

  const response = await fetch(
    `${callbacks.apiBaseUrl}/api/templates?${params.toString()}`,
    { credentials: 'include' }
  );

  if (!response.ok) throw new Error('Failed to load templates');
  return response.json();
}
