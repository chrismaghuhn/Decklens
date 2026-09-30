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

export function snapToGrid(xPx: number, yPx: number, cell = GRID_CELL): { col: number; row: number } {
  return {
    col: Math.max(0, Math.round(xPx / cell)),
    row: Math.max(0, Math.round(yPx / cell)),
  };
}

export function seedLayout(piles: Pile[]): MatLayout {
  // one top-aligned row: piles vary a lot in height, so vertical
  // wrapping always ends in overlaps — horizontal scroll does not
  return {
    piles: piles.map((pile, i) => ({
      id: pile.id,
      col: FIRST_FREE_COL + i * PILE_SPAN,
      row: 0,
    })),
  };
}

/**
 * Reconcile a stored layout with the current pile set: keep known
 * positions, append new piles top-aligned to the right of the occupied
 * columns, drop entries whose pile no longer exists.
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
    // fill free columns from the left so a shared pile id parked far
    // right (e.g. pile-lands across groupings) cannot push everything out
    const used = result.piles.map((p) => p.col);
    const isFree = (c: number): boolean => used.every((u) => Math.abs(u - c) >= PILE_SPAN);
    for (const pile of newPiles) {
      let col = FIRST_FREE_COL;
      while (!isFree(col)) col += PILE_SPAN;
      used.push(col);
      result.piles.push({ id: pile.id, col, row: 0 });
    }
  }

  return result;
}
