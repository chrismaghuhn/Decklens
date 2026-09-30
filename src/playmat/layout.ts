// ==================== Playmat Free-Mode Layout ====================
// Grid-snapped pile positions for the "Frei" sort mode. Positions are
// stored as grid coordinates so layouts stay aligned across viewports.

import type { DeckbuilderDeck, MatLayout } from '../deckbuilder/types.js';
import type { Pile } from './sort.js';

/** Snap grid cell size in px at default zoom (spec: half a card width). */
export const GRID_CELL = 72;

/** Columns 0-1 are reserved for the commander zone. */
const FIRST_FREE_COL = 2;
/** Grid columns a pile occupies when seeding. */
const PILE_SPAN = 2;
/** Piles per seeded row before wrapping. */
const SEED_COLS = 6;

export function snapToGrid(xPx: number, yPx: number, cell = GRID_CELL): { col: number; row: number } {
  return {
    col: Math.max(0, Math.round(xPx / cell)),
    row: Math.max(0, Math.round(yPx / cell)),
  };
}

export function seedLayout(piles: Pile[]): MatLayout {
  return {
    piles: piles.map((pile, i) => ({
      id: pile.id,
      col: FIRST_FREE_COL + (i % SEED_COLS) * PILE_SPAN,
      row: Math.floor(i / SEED_COLS) * 3,
    })),
  };
}

/**
 * Reconcile a stored layout with the current pile set: keep known
 * positions, append new piles after the highest used row, drop entries
 * whose pile no longer exists.
 */
export function layoutFor(deck: DeckbuilderDeck, piles: Pile[]): MatLayout {
  const stored = deck.matLayout;
  if (!stored) return seedLayout(piles);

  const known = new Map(stored.piles.map((p) => [p.id, p]));
  const result: MatLayout = { piles: [] };
  const newPiles: Pile[] = [];

  for (const pile of piles) {
    const pos = known.get(pile.id);
    if (pos) result.piles.push({ id: pile.id, col: pos.col, row: pos.row });
    else newPiles.push(pile);
  }

  if (newPiles.length > 0) {
    const maxRow = result.piles.reduce((m, p) => Math.max(m, p.row), 0);
    newPiles.forEach((pile, i) => {
      result.piles.push({
        id: pile.id,
        col: FIRST_FREE_COL + (i % SEED_COLS) * PILE_SPAN,
        row: maxRow + 3 + Math.floor(i / SEED_COLS) * 3,
      });
    });
  }

  return result;
}
