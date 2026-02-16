/**
 * DeckDiffPanel — Visual diff panel for comparing deck states.
 *
 * Shows +/- cards between two deck snapshots or branches,
 * with color-coded additions/removals, mana curve changes,
 * and summary statistics.
 */

import { h } from '../shared/dom.js';

// ───── Types ─────

export interface DiffCardEntry {
  name: string;
  qty: number;
  board: string;
}

export interface DeckDiffResult {
  added: DiffCardEntry[];
  removed: DiffCardEntry[];
  changed: Array<{ name: string; board: string; oldQty: number; newQty: number }>;
  summary: {
    totalAdded: number;
    totalRemoved: number;
    totalChanged: number;
    netChange: number;
  };
}

interface BoardCards {
  commander?: Array<{ name: string; qty: number }>;
  mainboard?: Array<{ name: string; qty: number }>;
  sideboard?: Array<{ name: string; qty: number }>;
  maybeboard?: Array<{ name: string; qty: number }>;
}

// ───── State ─────

let panelVisible = false;
let panelEl: HTMLElement | null = null;
let currentDiff: DeckDiffResult | null = null;

// ───── G4: Diff Share Helpers ─────

/** G4: Generate text diff for clipboard */
function diffToText(diff: DeckDiffResult): string {
  const lines: string[] = ['=== Deck Diff ===', ''];

  if (diff.added.length > 0) {
    lines.push('--- Added ---');
    for (const card of diff.added) {
      lines.push(`+ ${card.qty}x ${card.name} [${card.board}]`);
    }
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push('--- Removed ---');
    for (const card of diff.removed) {
      lines.push(`- ${card.qty}x ${card.name} [${card.board}]`);
    }
    lines.push('');
  }

  if (diff.changed.length > 0) {
    lines.push('--- Changed ---');
    for (const card of diff.changed) {
      lines.push(`~ ${card.name}: ${card.oldQty} \u2192 ${card.newQty} [${card.board}]`);
    }
    lines.push('');
  }

  const s = diff.summary;
  lines.push(`Summary: +${s.totalAdded} added, -${s.totalRemoved} removed, ~${s.totalChanged} changed (net ${s.netChange >= 0 ? '+' : ''}${s.netChange})`);

  return lines.join('\n');
}

/** G4: Generate markdown diff */
function diffToMarkdown(diff: DeckDiffResult): string {
  const lines: string[] = ['## Deck Diff', ''];

  if (diff.added.length > 0) {
    lines.push('### Added');
    for (const card of diff.added) {
      lines.push(`- **+${card.qty}** ${card.name} *(${card.board})*`);
    }
    lines.push('');
  }

  if (diff.removed.length > 0) {
    lines.push('### Removed');
    for (const card of diff.removed) {
      lines.push(`- **-${card.qty}** ${card.name} *(${card.board})*`);
    }
    lines.push('');
  }

  if (diff.changed.length > 0) {
    lines.push('### Changed');
    for (const card of diff.changed) {
      lines.push(`- **~** ${card.name}: ${card.oldQty} \u2192 ${card.newQty} *(${card.board})*`);
    }
    lines.push('');
  }

  const s = diff.summary;
  lines.push(`> **Summary:** +${s.totalAdded} added, -${s.totalRemoved} removed, ~${s.totalChanged} changed (net ${s.netChange >= 0 ? '+' : ''}${s.netChange})`);

  return lines.join('\n');
}

// ───── Public API ─────

/** Compute diff between two board states. */
export function computeDiff(boardsA: BoardCards, boardsB: BoardCards): DeckDiffResult {
  const mapA = buildCardMap(boardsA);
  const mapB = buildCardMap(boardsB);

  const added: DiffCardEntry[] = [];
  const removed: DiffCardEntry[] = [];
  const changed: Array<{ name: string; board: string; oldQty: number; newQty: number }> = [];

  // Find cards in B that are not in A (added) or have different qty (changed)
  for (const [key, entryB] of mapB) {
    const entryA = mapA.get(key);
    if (!entryA) {
      added.push(entryB);
    } else if (entryA.qty !== entryB.qty) {
      changed.push({ name: entryB.name, board: entryB.board, oldQty: entryA.qty, newQty: entryB.qty });
    }
  }

  // Find cards in A that are not in B (removed)
  for (const [key, entryA] of mapA) {
    if (!mapB.has(key)) {
      removed.push(entryA);
    }
  }

  const totalAdded = added.reduce((s, e) => s + e.qty, 0);
  const totalRemoved = removed.reduce((s, e) => s + e.qty, 0);
  const totalChanged = changed.length;
  const netChange = totalAdded - totalRemoved + changed.reduce((s, c) => s + (c.newQty - c.oldQty), 0);

  return { added, removed, changed, summary: { totalAdded, totalRemoved, totalChanged, netChange } };
}

/** Show the diff panel with a computed diff result. */
export function showDiffPanel(diff: DeckDiffResult, labelA: string = 'Before', labelB: string = 'After'): void {
  currentDiff = diff;
  panelVisible = true;
  renderPanel(labelA, labelB);
}

/** Hide the diff panel. */
export function hideDiffPanel(): void {
  panelVisible = false;
  if (panelEl) {
    panelEl.style.display = 'none';
  }
}

/** Toggle diff panel. */
export function toggleDiffPanel(): void {
  if (panelVisible) {
    hideDiffPanel();
  } else if (currentDiff) {
    panelVisible = true;
    renderPanel();
  }
}

/** Is the diff panel open? */
export function isDiffPanelOpen(): boolean {
  return panelVisible;
}

// ───── Internal ─────

function buildCardMap(boards: BoardCards): Map<string, DiffCardEntry> {
  const map = new Map<string, DiffCardEntry>();
  for (const boardName of ['commander', 'mainboard', 'sideboard', 'maybeboard'] as const) {
    const cards = boards[boardName];
    if (!Array.isArray(cards)) continue;
    for (const card of cards) {
      const key = `${boardName}:${card.name.toLowerCase()}`;
      map.set(key, { name: card.name, qty: card.qty, board: boardName });
    }
  }
  return map;
}

function renderPanel(labelA: string = 'Before', labelB: string = 'After'): void {
  if (!currentDiff) return;

  if (panelEl) {
    panelEl.remove();
  }

  const diff = currentDiff;

  panelEl = h('div', { className: 'diff-panel' },
    h('div', { className: 'diff-panel-header' },
      h('span', { className: 'diff-panel-title' }, `📊 Diff: ${labelA} → ${labelB}`),
      h('div', { className: 'diff-panel-actions' },
        h('button', {
          className: 'diff-action-btn diff-action-copy',
          onClick: () => {
            if (!currentDiff) return;
            const text = diffToText(currentDiff);
            navigator.clipboard.writeText(text).then(() => {
              const btn = document.querySelector('.diff-action-copy') as HTMLElement | null;
              if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => { btn.textContent = '📋 Copy Text'; }, 1500); }
            }).catch(() => {
              // Fallback: create textarea for manual copy
              const ta = document.createElement('textarea');
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              ta.remove();
            });
          },
          title: 'Copy diff as text',
        }, '📋 Copy Text'),
        h('button', {
          className: 'diff-action-btn',
          onClick: () => {
            if (!currentDiff) return;
            const md = diffToMarkdown(currentDiff);
            const blob = new Blob([md], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'deck-diff.md';
            a.click();
            URL.revokeObjectURL(url);
          },
          title: 'Download diff as Markdown',
        }, '📥 Save MD'),
      ),
      h('button', {
        className: 'diff-panel-close',
        onClick: () => hideDiffPanel(),
        title: 'Close',
      }, '✕'),
    ),

    // Summary bar
    h('div', { className: 'diff-summary' },
      h('span', { className: 'diff-summary-stat diff-stat-added' },
        `+${diff.summary.totalAdded} added`),
      h('span', { className: 'diff-summary-stat diff-stat-removed' },
        `-${diff.summary.totalRemoved} removed`),
      h('span', { className: 'diff-summary-stat diff-stat-changed' },
        `~${diff.summary.totalChanged} changed`),
      h('span', { className: 'diff-summary-stat diff-stat-net' },
        `Net: ${diff.summary.netChange >= 0 ? '+' : ''}${diff.summary.netChange}`),
    ),

    // Diff list
    h('div', { className: 'diff-list' },
      // Added section
      diff.added.length > 0
        ? h('div', { className: 'diff-section' },
            h('div', { className: 'diff-section-header diff-section-added' }, `Added (${diff.added.length})`),
            ...diff.added.map((card) =>
              h('div', { className: 'diff-card diff-card-added' },
                h('span', { className: 'diff-card-qty' }, `+${card.qty}`),
                h('span', { className: 'diff-card-name' }, card.name),
                h('span', { className: 'diff-card-board' }, card.board),
              ),
            ),
          )
        : '',

      // Removed section
      diff.removed.length > 0
        ? h('div', { className: 'diff-section' },
            h('div', { className: 'diff-section-header diff-section-removed' }, `Removed (${diff.removed.length})`),
            ...diff.removed.map((card) =>
              h('div', { className: 'diff-card diff-card-removed' },
                h('span', { className: 'diff-card-qty' }, `-${card.qty}`),
                h('span', { className: 'diff-card-name' }, card.name),
                h('span', { className: 'diff-card-board' }, card.board),
              ),
            ),
          )
        : '',

      // Changed section
      diff.changed.length > 0
        ? h('div', { className: 'diff-section' },
            h('div', { className: 'diff-section-header diff-section-changed' }, `Changed (${diff.changed.length})`),
            ...diff.changed.map((card) =>
              h('div', { className: 'diff-card diff-card-changed' },
                h('span', { className: 'diff-card-qty' },
                  `${card.oldQty} → ${card.newQty}`),
                h('span', { className: 'diff-card-name' }, card.name),
                h('span', { className: 'diff-card-board' }, card.board),
              ),
            ),
          )
        : '',

      // Empty state
      diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0
        ? h('div', { className: 'diff-empty' }, 'No differences found.')
        : '',
    ),
  );

  panelEl.style.display = 'flex';
  document.body.appendChild(panelEl);
}
