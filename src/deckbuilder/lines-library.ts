// ============================================================
// Lines Library — Named combo lines with ordered steps
// ============================================================
// Store, search, and visualize named card combos ("lines")
// with step-by-step resolution order and tags.
// Persisted via combo_lines D1 table.
// ============================================================

import { h } from '../shared/dom.js';

// ==================== Types ====================

export interface ComboLine {
  id: string;
  repoId: string;
  name: string;
  description: string;
  cards: string[];           // ["Card A", "Card B", "Card C"]
  steps: ComboStep[];        // Ordered activation steps
  tags: string[];            // ["infinite", "wincon", "value"]
  authorId: string;
  createdAt: string;
}

export interface ComboStep {
  order: number;
  action: string;            // "Tap Krark-Clan Ironworks, sacrifice Sol Ring"
  cardName: string;          // Which card performs this step
  result: string;            // "Generate 2 colorless mana"
}

export interface LineSearchResult {
  line: ComboLine;
  matchScore: number;        // lower = better
}

// ==================== API ====================

const API_BASE = typeof window !== 'undefined'
  ? (window.location.hostname === 'localhost' ? 'http://localhost:8787' : 'https://decklens-api.chrisgarkisch.workers.dev')
  : '';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export const linesApi = {
  list: (repoId: string) =>
    apiFetch<ComboLine[]>(`/api/repos/${repoId}/lines`),

  create: (repoId: string, line: Omit<ComboLine, 'id' | 'repoId' | 'authorId' | 'createdAt'>) =>
    apiFetch<ComboLine>(`/api/repos/${repoId}/lines`, {
      method: 'POST',
      body: JSON.stringify(line),
    }),

  delete: (repoId: string, lineId: string) =>
    apiFetch<{ ok: boolean }>(`/api/repos/${repoId}/lines/${lineId}`, { method: 'DELETE' }),
};

// ==================== Local Store ====================

let localLines: ComboLine[] = [];
const LOCAL_KEY = 'DECKLENS_COMBO_LINES';

function loadLocalLines(): ComboLine[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveLocalLines(): void {
  localStorage.setItem(LOCAL_KEY, JSON.stringify(localLines));
}

/**
 * Initialize lines library (load from server or local).
 */
export async function initLinesLibrary(repoId?: string): Promise<ComboLine[]> {
  if (repoId) {
    try {
      localLines = await linesApi.list(repoId);
    } catch {
      localLines = loadLocalLines();
    }
  } else {
    localLines = loadLocalLines();
  }
  return localLines;
}

/**
 * Get all lines.
 */
export function getLines(): ComboLine[] {
  return [...localLines];
}

/**
 * Add a new combo line.
 */
export async function addLine(
  line: Omit<ComboLine, 'id' | 'repoId' | 'authorId' | 'createdAt'>,
  repoId?: string
): Promise<ComboLine> {
  if (repoId) {
    const created = await linesApi.create(repoId, line);
    localLines.push(created);
    return created;
  }

  const newLine: ComboLine = {
    ...line,
    id: `line_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    repoId: '',
    authorId: 'local',
    createdAt: new Date().toISOString(),
  };
  localLines.push(newLine);
  saveLocalLines();
  return newLine;
}

/**
 * Remove a combo line.
 */
export async function removeLine(lineId: string, repoId?: string): Promise<void> {
  if (repoId) {
    await linesApi.delete(repoId, lineId);
  }
  localLines = localLines.filter(l => l.id !== lineId);
  saveLocalLines();
}

// ==================== Search ====================

/**
 * Search lines by card name or tag.
 */
export function searchLines(query: string): LineSearchResult[] {
  const q = query.toLowerCase();
  const results: LineSearchResult[] = [];

  for (const line of localLines) {
    let score = Infinity;

    // Match by name
    if (line.name.toLowerCase().includes(q)) {
      score = Math.min(score, line.name.toLowerCase().indexOf(q));
    }

    // Match by card
    for (const card of line.cards) {
      if (card.toLowerCase().includes(q)) {
        score = Math.min(score, 50 + card.toLowerCase().indexOf(q));
      }
    }

    // Match by tag
    for (const tag of line.tags) {
      if (tag.toLowerCase().includes(q)) {
        score = Math.min(score, 100);
      }
    }

    if (score < Infinity) {
      results.push({ line, matchScore: score });
    }
  }

  return results.sort((a, b) => a.matchScore - b.matchScore);
}

/**
 * Find all lines that contain a specific card.
 */
export function findLinesForCard(cardName: string): ComboLine[] {
  const name = cardName.toLowerCase();
  return localLines.filter(line =>
    line.cards.some(c => c.toLowerCase() === name)
  );
}

/**
 * Find all lines that include ALL of the given cards (complete combo).
 */
export function findCompleteCombos(cardNames: string[]): ComboLine[] {
  const nameSet = new Set(cardNames.map(n => n.toLowerCase()));
  return localLines.filter(line =>
    line.cards.every(c => nameSet.has(c.toLowerCase()))
  );
}

/**
 * Find lines that are partially present in the deck.
 */
export function findPartialCombos(deckCardNames: string[]): Array<{ line: ComboLine; missing: string[]; have: string[] }> {
  const nameSet = new Set(deckCardNames.map(n => n.toLowerCase()));
  const results: Array<{ line: ComboLine; missing: string[]; have: string[] }> = [];

  for (const line of localLines) {
    const have = line.cards.filter(c => nameSet.has(c.toLowerCase()));
    const missing = line.cards.filter(c => !nameSet.has(c.toLowerCase()));

    // At least one card present and at least one missing
    if (have.length > 0 && missing.length > 0) {
      results.push({ line, missing, have });
    }
  }

  // Sort by completeness (most complete first)
  results.sort((a, b) => a.missing.length - b.missing.length);
  return results;
}

// ==================== Render ====================

/**
 * Render a combo line as a visual card.
 */
export function renderLineCard(line: ComboLine, onSelect?: (line: ComboLine) => void): HTMLElement {
  const tagEls = line.tags.map(tag =>
    h('span', {
      className: `lines-lib__tag lines-lib__tag--${tag}`,
    }, tag)
  );

  const cardEls = line.cards.map((card, i) =>
    h('span', { className: 'lines-lib__card-chip' },
      `${i + 1}. ${card}`)
  );

  return h('div', {
    className: 'lines-lib__line-card',
    onClick: () => onSelect?.(line),
  },
    h('div', { className: 'lines-lib__line-header' },
      h('strong', { className: 'lines-lib__line-name' }, line.name),
      h('div', { className: 'lines-lib__tags' }, ...tagEls),
    ),
    line.description
      ? h('p', { className: 'lines-lib__line-desc' }, line.description)
      : null,
    h('div', { className: 'lines-lib__cards' }, ...cardEls),
  );
}

/**
 * Render steps for a combo line.
 */
export function renderLineSteps(line: ComboLine): HTMLElement {
  if (line.steps.length === 0) {
    return h('div', { className: 'lines-lib__no-steps' }, 'No steps defined');
  }

  const steps = line.steps
    .sort((a, b) => a.order - b.order)
    .map(step =>
      h('div', { className: 'lines-lib__step' },
        h('span', { className: 'lines-lib__step-num' }, `${step.order}.`),
        h('div', { className: 'lines-lib__step-content' },
          h('strong', {}, step.cardName),
          h('span', { className: 'lines-lib__step-action' }, step.action),
          h('span', { className: 'lines-lib__step-result' }, `→ ${step.result}`),
        ),
      )
    );

  return h('div', { className: 'lines-lib__steps' }, ...steps);
}

// ==================== Built-in Lines ====================

export function getBuiltInLines(): Omit<ComboLine, 'id' | 'repoId' | 'authorId' | 'createdAt'>[] {
  return [
    {
      name: 'Dramatic Scepter',
      description: 'Infinite mana with Isochron Scepter + Dramatic Reversal + 3 mana in rocks',
      cards: ['Isochron Scepter', 'Dramatic Reversal'],
      steps: [
        { order: 1, action: 'Imprint Dramatic Reversal on Isochron Scepter', cardName: 'Isochron Scepter', result: 'Scepter has Dramatic Reversal imprinted' },
        { order: 2, action: 'Activate Isochron Scepter (2 mana)', cardName: 'Isochron Scepter', result: 'Cast copy of Dramatic Reversal' },
        { order: 3, action: 'Dramatic Reversal resolves, untap all nonland permanents', cardName: 'Dramatic Reversal', result: 'All mana rocks and Scepter untap' },
        { order: 4, action: 'Repeat for infinite mana', cardName: 'Isochron Scepter', result: 'Infinite mana of any color your rocks produce' },
      ],
      tags: ['infinite', 'mana', 'wincon'],
    },
    {
      name: 'Thoracle Consultation',
      description: 'Win the game by exiling your library then checking devotion',
      cards: ['Thassa\'s Oracle', 'Demonic Consultation'],
      steps: [
        { order: 1, action: 'Cast Thassa\'s Oracle', cardName: 'Thassa\'s Oracle', result: 'ETB trigger goes on the stack' },
        { order: 2, action: 'Holding priority, cast Demonic Consultation naming a card not in your deck', cardName: 'Demonic Consultation', result: 'Exile entire library' },
        { order: 3, action: 'Oracle trigger resolves with 0 cards in library', cardName: 'Thassa\'s Oracle', result: 'You win the game' },
      ],
      tags: ['wincon', 'instant-speed'],
    },
    {
      name: 'Dockside + Temur Sabertooth',
      description: 'Infinite mana and ETB triggers with enough opposing artifacts/enchantments',
      cards: ['Dockside Extortionist', 'Temur Sabertooth'],
      steps: [
        { order: 1, action: 'Cast Dockside Extortionist', cardName: 'Dockside Extortionist', result: 'Create treasure tokens' },
        { order: 2, action: 'Activate Temur Sabertooth (1G), return Dockside to hand', cardName: 'Temur Sabertooth', result: 'Dockside in hand, treasures remain' },
        { order: 3, action: 'Recast Dockside Extortionist', cardName: 'Dockside Extortionist', result: 'Create more treasures (net positive if opponents have 3+ artifacts/enchantments)' },
        { order: 4, action: 'Repeat for infinite mana and infinite ETBs', cardName: 'Temur Sabertooth', result: 'Infinite mana, infinite ETB triggers' },
      ],
      tags: ['infinite', 'mana', 'etb', 'value'],
    },
  ];
}
