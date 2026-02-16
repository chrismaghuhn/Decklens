// ==================== Deck Comparison Tool (S3-F2) ====================
// Sprint 3 S3-F2: Deck Comparison MVP
//
// Features:
// - Compare two decklists side-by-side
// - Show cards added/removed/changed
// - Calculate diff statistics
// - Visual diff view

import { h, replaceChildren } from '../dom.js';
import { escapeHtml } from '../utils.js';

// ==================== Types ====================

export interface DeckEntry {
  name: string;
  qty: number;
}

export interface DeckZones {
  main: DeckEntry[];
  sideboard: DeckEntry[];
  commander: DeckEntry[];
}

export interface DiffEntry {
  name: string;
  qtyA: number;
  qtyB: number;
  diff: number;
  status: 'added' | 'removed' | 'changed' | 'unchanged';
}

export interface DeckDiff {
  main: DiffEntry[];
  sideboard: DiffEntry[];
  commander: DiffEntry[];
  stats: DiffStats;
}

export interface DiffStats {
  totalAdded: number;
  totalRemoved: number;
  totalChanged: number;
  totalUnchanged: number;
  cardsAddedA: number;
  cardsAddedB: number;
  uniqueToA: string[];
  uniqueToB: string[];
  similarity: number; // 0-100%
}

// ==================== Diff Algorithm ====================

/**
 * Convert deck entries to a map for fast lookup.
 */
function deckToMap(entries: DeckEntry[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    map.set(key, (map.get(key) || 0) + entry.qty);
  }
  return map;
}

/**
 * Compare two sets of deck entries.
 */
function compareZone(entriesA: DeckEntry[], entriesB: DeckEntry[]): DiffEntry[] {
  const mapA = deckToMap(entriesA);
  const mapB = deckToMap(entriesB);
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);
  
  const diff: DiffEntry[] = [];
  
  for (const key of allKeys) {
    const qtyA = mapA.get(key) || 0;
    const qtyB = mapB.get(key) || 0;
    const diffQty = qtyB - qtyA;
    
    // Find original case name
    const nameA = entriesA.find(e => e.name.toLowerCase() === key)?.name;
    const nameB = entriesB.find(e => e.name.toLowerCase() === key)?.name;
    const name = nameB || nameA || key;
    
    let status: DiffEntry['status'];
    if (qtyA === 0) status = 'added';
    else if (qtyB === 0) status = 'removed';
    else if (qtyA !== qtyB) status = 'changed';
    else status = 'unchanged';
    
    diff.push({ name, qtyA, qtyB, diff: diffQty, status });
  }
  
  // Sort: removed first, then changed, then added, then unchanged
  const statusOrder = { removed: 0, changed: 1, added: 2, unchanged: 3 };
  diff.sort((a, b) => {
    const orderDiff = statusOrder[a.status] - statusOrder[b.status];
    if (orderDiff !== 0) return orderDiff;
    return a.name.localeCompare(b.name);
  });
  
  return diff;
}

/**
 * Calculate diff statistics.
 */
function calculateStats(diff: DeckDiff): DiffStats {
  const allEntries = [...diff.main, ...diff.sideboard, ...diff.commander];
  
  let totalAdded = 0;
  let totalRemoved = 0;
  let totalChanged = 0;
  let totalUnchanged = 0;
  let cardsAddedA = 0;
  let cardsAddedB = 0;
  const uniqueToA: string[] = [];
  const uniqueToB: string[] = [];
  
  for (const entry of allEntries) {
    switch (entry.status) {
      case 'added':
        totalAdded++;
        cardsAddedB += entry.qtyB;
        uniqueToB.push(entry.name);
        break;
      case 'removed':
        totalRemoved++;
        cardsAddedA += entry.qtyA;
        uniqueToA.push(entry.name);
        break;
      case 'changed':
        totalChanged++;
        break;
      case 'unchanged':
        totalUnchanged++;
        break;
    }
  }
  
  const total = allEntries.length;
  const similarity = total > 0 ? Math.round((totalUnchanged / total) * 100) : 100;
  
  return {
    totalAdded,
    totalRemoved,
    totalChanged,
    totalUnchanged,
    cardsAddedA,
    cardsAddedB,
    uniqueToA,
    uniqueToB,
    similarity,
  };
}

/**
 * Compare two decks and return the diff.
 */
export function compareDecksDiff(deckA: DeckZones, deckB: DeckZones): DeckDiff {
  const diff: DeckDiff = {
    main: compareZone(deckA.main, deckB.main),
    sideboard: compareZone(deckA.sideboard, deckB.sideboard),
    commander: compareZone(deckA.commander, deckB.commander),
    stats: { 
      totalAdded: 0, totalRemoved: 0, totalChanged: 0, totalUnchanged: 0,
      cardsAddedA: 0, cardsAddedB: 0, uniqueToA: [], uniqueToB: [], similarity: 0 
    },
  };
  
  diff.stats = calculateStats(diff);
  return diff;
}

// ==================== Rendering ====================

/**
 * Render a diff entry row.
 */
function renderDiffRow(entry: DiffEntry): HTMLElement {
  const statusClass = `diff-row--${entry.status}`;
  const diffText = entry.diff > 0 ? `+${entry.diff}` : entry.diff === 0 ? '' : `${entry.diff}`;
  
  return h('div', { className: `diff-row ${statusClass}` },
    h('span', { className: 'diff-row__name' }, entry.name),
    h('span', { className: 'diff-row__qty-a' }, entry.qtyA > 0 ? `${entry.qtyA}` : '-'),
    h('span', { className: 'diff-row__arrow' }, '→'),
    h('span', { className: 'diff-row__qty-b' }, entry.qtyB > 0 ? `${entry.qtyB}` : '-'),
    diffText ? h('span', { className: 'diff-row__diff' }, diffText) : null
  );
}

/**
 * Render a zone diff section.
 */
function renderZoneDiff(title: string, entries: DiffEntry[]): HTMLElement | null {
  if (entries.length === 0) return null;
  
  const hasChanges = entries.some(e => e.status !== 'unchanged');
  
  return h('div', { className: 'diff-zone' },
    h('h4', { className: 'diff-zone__title' }, 
      title,
      !hasChanges ? h('span', { className: 'diff-zone__badge' }, 'No changes') : null
    ),
    h('div', { className: 'diff-zone__entries' },
      ...entries.map(renderDiffRow)
    )
  );
}

/**
 * Render diff statistics.
 */
function renderDiffStats(stats: DiffStats): HTMLElement {
  return h('div', { className: 'diff-stats' },
    h('div', { className: 'diff-stats__similarity' },
      h('span', { className: 'diff-stats__similarity-value' }, `${stats.similarity}%`),
      h('span', { className: 'diff-stats__similarity-label' }, 'Similar')
    ),
    h('div', { className: 'diff-stats__grid' },
      h('div', { className: 'diff-stats__item diff-stats__item--added' },
        h('span', { className: 'diff-stats__value' }, `+${stats.totalAdded}`),
        h('span', { className: 'diff-stats__label' }, 'Added')
      ),
      h('div', { className: 'diff-stats__item diff-stats__item--removed' },
        h('span', { className: 'diff-stats__value' }, `-${stats.totalRemoved}`),
        h('span', { className: 'diff-stats__label' }, 'Removed')
      ),
      h('div', { className: 'diff-stats__item diff-stats__item--changed' },
        h('span', { className: 'diff-stats__value' }, `${stats.totalChanged}`),
        h('span', { className: 'diff-stats__label' }, 'Changed')
      ),
      h('div', { className: 'diff-stats__item diff-stats__item--unchanged' },
        h('span', { className: 'diff-stats__value' }, `${stats.totalUnchanged}`),
        h('span', { className: 'diff-stats__label' }, 'Unchanged')
      )
    )
  );
}

/**
 * Render the full deck comparison view.
 */
export function renderDeckComparison(
  container: HTMLElement,
  diff: DeckDiff,
  options: {
    deckNameA?: string;
    deckNameB?: string;
    showUnchanged?: boolean;
  } = {}
): void {
  const { 
    deckNameA = 'Deck A', 
    deckNameB = 'Deck B',
    showUnchanged = true,
  } = options;
  
  // Filter entries if hiding unchanged
  const filterEntries = (entries: DiffEntry[]) => 
    showUnchanged ? entries : entries.filter(e => e.status !== 'unchanged');
  
  const content = h('div', { className: 'deck-comparison' },
    // Header
    h('div', { className: 'deck-comparison__header' },
      h('h3', { className: 'deck-comparison__title' }, 'Deck Comparison'),
      h('div', { className: 'deck-comparison__names' },
        h('span', { className: 'deck-comparison__name-a' }, escapeHtml(deckNameA)),
        h('span', { className: 'deck-comparison__vs' }, 'vs'),
        h('span', { className: 'deck-comparison__name-b' }, escapeHtml(deckNameB))
      )
    ),
    
    // Stats
    renderDiffStats(diff.stats),
    
    // Zones
    h('div', { className: 'deck-comparison__zones' },
      renderZoneDiff('Main Deck', filterEntries(diff.main)),
      renderZoneDiff('Sideboard', filterEntries(diff.sideboard)),
      renderZoneDiff('Commander', filterEntries(diff.commander))
    ),
    
    // Legend
    h('div', { className: 'deck-comparison__legend' },
      h('span', { className: 'legend-item legend-item--added' }, '● Added'),
      h('span', { className: 'legend-item legend-item--removed' }, '● Removed'),
      h('span', { className: 'legend-item legend-item--changed' }, '● Changed'),
      h('span', { className: 'legend-item legend-item--unchanged' }, '● Unchanged')
    )
  );
  
  replaceChildren(container, content);
}

// ==================== Quick Diff View ====================

/**
 * Create a compact diff summary for display.
 */
export function createDiffSummary(diff: DeckDiff): string {
  const { stats } = diff;
  const parts: string[] = [];
  
  if (stats.totalAdded > 0) parts.push(`+${stats.totalAdded} added`);
  if (stats.totalRemoved > 0) parts.push(`-${stats.totalRemoved} removed`);
  if (stats.totalChanged > 0) parts.push(`${stats.totalChanged} changed`);
  
  if (parts.length === 0) return 'No differences';
  return parts.join(', ') + ` (${stats.similarity}% similar)`;
}


// ==================== CSS ====================

const COMPARISON_STYLES = `
/* Deck Comparison Container */
.deck-comparison {
  background: var(--bg-1, #1a1a1f);
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: var(--radius-lg, 12px);
  padding: 1.5rem;
}

.deck-comparison__header {
  margin-bottom: 1.5rem;
  text-align: center;
}

.deck-comparison__title {
  font-family: var(--font-display, sans-serif);
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0 0 0.5rem 0;
  color: var(--text-bright, #fafafa);
}

.deck-comparison__names {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  color: var(--text-dim, #62626e);
}

.deck-comparison__name-a,
.deck-comparison__name-b {
  font-weight: 500;
  color: var(--text, #d4d4d8);
}

.deck-comparison__vs {
  font-size: 0.75rem;
  text-transform: uppercase;
}

/* Stats */
.diff-stats {
  display: flex;
  align-items: center;
  gap: 2rem;
  padding: 1rem;
  background: var(--bg-2, #18181c);
  border-radius: var(--radius-sm, 8px);
  margin-bottom: 1.5rem;
}

.diff-stats__similarity {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-right: 2rem;
  border-right: 1px solid var(--border, rgba(255,255,255,0.1));
}

.diff-stats__similarity-value {
  font-size: 2rem;
  font-weight: 700;
  color: var(--gold, #e2b340);
}

.diff-stats__similarity-label {
  font-size: 0.75rem;
  color: var(--text-dim, #62626e);
}

.diff-stats__grid {
  display: flex;
  gap: 1.5rem;
  flex: 1;
}

.diff-stats__item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.diff-stats__value {
  font-size: 1.25rem;
  font-weight: 600;
}

.diff-stats__label {
  font-size: 0.75rem;
  color: var(--text-dim, #62626e);
}

.diff-stats__item--added .diff-stats__value { color: var(--legal, #22c55e); }
.diff-stats__item--removed .diff-stats__value { color: var(--banned, #ef4444); }
.diff-stats__item--changed .diff-stats__value { color: var(--restricted, #f59e0b); }
.diff-stats__item--unchanged .diff-stats__value { color: var(--text-dim, #62626e); }

/* Zones */
.deck-comparison__zones {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.diff-zone {
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: var(--radius-sm, 8px);
  overflow: hidden;
}

.diff-zone__title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  background: var(--bg-2, #18181c);
  color: var(--text, #d4d4d8);
}

.diff-zone__badge {
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--text-dim, #62626e);
}

.diff-zone__entries {
  padding: 0.5rem;
}

/* Diff Row */
.diff-row {
  display: grid;
  grid-template-columns: 1fr 2.5rem 1.5rem 2.5rem 2.5rem;
  align-items: center;
  padding: 0.375rem 0.5rem;
  gap: 0.5rem;
  border-radius: 4px;
  font-size: 0.875rem;
}

.diff-row:hover {
  background: rgba(255,255,255,0.03);
}

.diff-row__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.diff-row__qty-a,
.diff-row__qty-b {
  text-align: center;
  font-family: var(--font-mono, monospace);
}

.diff-row__arrow {
  text-align: center;
  color: var(--text-dim, #62626e);
  font-size: 0.75rem;
}

.diff-row__diff {
  text-align: center;
  font-family: var(--font-mono, monospace);
  font-weight: 500;
}

/* Status Colors */
.diff-row--added {
  background: rgba(34, 197, 94, 0.1);
}
.diff-row--added .diff-row__name,
.diff-row--added .diff-row__diff {
  color: var(--legal, #22c55e);
}

.diff-row--removed {
  background: rgba(239, 68, 68, 0.1);
}
.diff-row--removed .diff-row__name,
.diff-row--removed .diff-row__diff {
  color: var(--banned, #ef4444);
}

.diff-row--changed {
  background: rgba(245, 158, 11, 0.1);
}
.diff-row--changed .diff-row__diff {
  color: var(--restricted, #f59e0b);
}

.diff-row--unchanged {
  opacity: 0.6;
}

/* Legend */
.deck-comparison__legend {
  display: flex;
  justify-content: center;
  gap: 1.5rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border, rgba(255,255,255,0.1));
  font-size: 0.75rem;
  color: var(--text-dim, #62626e);
}

.legend-item--added { color: var(--legal, #22c55e); }
.legend-item--removed { color: var(--banned, #ef4444); }
.legend-item--changed { color: var(--restricted, #f59e0b); }
.legend-item--unchanged { color: var(--text-dim, #62626e); }

/* Responsive */
@media (max-width: 600px) {
  .diff-stats {
    flex-direction: column;
    gap: 1rem;
  }
  
  .diff-stats__similarity {
    padding-right: 0;
    padding-bottom: 1rem;
    border-right: none;
    border-bottom: 1px solid var(--border, rgba(255,255,255,0.1));
  }
  
  .diff-row {
    grid-template-columns: 1fr 2rem 1rem 2rem 2rem;
    font-size: 0.8125rem;
  }
}
`;

// Inject styles once
let _stylesInjected = false;
export function injectComparisonStyles(): void {
  if (_stylesInjected) return;
  const style = document.createElement('style');
  style.textContent = COMPARISON_STYLES;
  document.head.appendChild(style);
  _stylesInjected = true;
}

// Auto-inject on module load
if (typeof document !== 'undefined') {
  injectComparisonStyles();
}
