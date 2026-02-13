import type { GameState, Card, Permanent } from '@mtg/game-engine';

/**
 * Combo Evaluator — Detects combo opportunities.
 *
 * Tracks known combo patterns and their assembly state.
 * In this heuristic bot, combo detection is based on card tags
 * and simple pattern matching rather than full simulation.
 */

/** A known combo pattern */
export interface ComboPattern {
  name: string;
  /** Card names required (all must be present to execute) */
  pieces: string[];
  /** Minimum total mana needed */
  manaCost: number;
  /** Does this combo win the game outright? */
  winsGame: boolean;
}

/** State of a combo in the current game */
export interface ComboState {
  pattern: ComboPattern;
  /** Pieces we have (on board or in hand) */
  piecesAvailable: string[];
  /** Pieces still missing */
  piecesMissing: string[];
  /** Percentage complete (0-1) */
  completion: number;
  /** Whether we can execute right now */
  canExecute: boolean;
}

/**
 * Built-in combo patterns for common EDH combos.
 * These are recognized by card name matching.
 */
export const KNOWN_COMBOS: ComboPattern[] = [
  {
    name: 'Dramatic Scepter',
    pieces: ['Isochron Scepter', 'Dramatic Reversal'],
    manaCost: 4,
    winsGame: false, // Infinite mana, but need an outlet
  },
  {
    name: 'Thassa\'s Oracle + Demonic Consultation',
    pieces: ['Thassa\'s Oracle', 'Demonic Consultation'],
    manaCost: 4,
    winsGame: true,
  },
  {
    name: 'Exquisite Blood + Sanguine Bond',
    pieces: ['Exquisite Blood', 'Sanguine Bond'],
    manaCost: 10,
    winsGame: true,
  },
  {
    name: 'Kiki-Jiki + Zealous Conscripts',
    pieces: ['Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts'],
    manaCost: 10,
    winsGame: true,
  },
  {
    name: 'Splinter Twin + Pestermite',
    pieces: ['Splinter Twin', 'Pestermite'],
    manaCost: 7,
    winsGame: true,
  },
  {
    name: 'Deadeye Navigator + Peregrine Drake',
    pieces: ['Deadeye Navigator', 'Peregrine Drake'],
    manaCost: 11,
    winsGame: false, // Infinite mana
  },
  {
    name: 'Mikaeus + Triskelion',
    pieces: ['Mikaeus, the Unhallowed', 'Triskelion'],
    manaCost: 12,
    winsGame: true,
  },
];

/**
 * Get all card names available to a player (hand + battlefield).
 */
function getAvailableCardNames(state: GameState, player: 0 | 1): Set<string> {
  const names = new Set<string>();

  for (const card of state.players[player].hand) {
    names.add(card.name);
  }
  for (const perm of state.players[player].battlefield) {
    names.add(perm.name);
  }

  return names;
}

/**
 * Evaluate all known combos for a player.
 * Returns combo states sorted by completion (most complete first).
 */
export function evaluateCombos(state: GameState, player: 0 | 1): ComboState[] {
  const available = getAvailableCardNames(state, player);
  const results: ComboState[] = [];

  for (const pattern of KNOWN_COMBOS) {
    const piecesAvailable: string[] = [];
    const piecesMissing: string[] = [];

    for (const piece of pattern.pieces) {
      if (available.has(piece)) {
        piecesAvailable.push(piece);
      } else {
        piecesMissing.push(piece);
      }
    }

    // Only include if at least one piece is available
    if (piecesAvailable.length === 0) continue;

    const completion = piecesAvailable.length / pattern.pieces.length;
    const canExecute = piecesMissing.length === 0;

    results.push({
      pattern,
      piecesAvailable,
      piecesMissing,
      completion,
      canExecute,
    });
  }

  // Sort by completion descending
  results.sort((a, b) => b.completion - a.completion);

  return results;
}

/**
 * Check if a player has a game-winning combo ready to execute.
 */
export function hasWinningCombo(state: GameState, player: 0 | 1): boolean {
  const combos = evaluateCombos(state, player);
  return combos.some((c) => c.canExecute && c.pattern.winsGame);
}

/**
 * Check if any card is a combo piece the bot should prioritize.
 * Returns the most relevant combo for tutor decisions.
 */
export function getBestComboTarget(
  state: GameState,
  player: 0 | 1,
): { comboName: string; missingPiece: string } | null {
  const combos = evaluateCombos(state, player);

  // Find the highest-completion combo that's missing exactly 1 piece
  for (const combo of combos) {
    if (combo.piecesMissing.length === 1) {
      return {
        comboName: combo.pattern.name,
        missingPiece: combo.piecesMissing[0],
      };
    }
  }

  return null;
}

/**
 * Score how valuable a card is as a combo piece.
 * Higher = more important to protect/play.
 */
export function scoreComboRelevance(
  cardName: string,
  state: GameState,
  player: 0 | 1,
): number {
  const combos = evaluateCombos(state, player);
  let maxScore = 0;

  for (const combo of combos) {
    if (combo.piecesAvailable.includes(cardName) || combo.piecesMissing.includes(cardName)) {
      // Score based on how close the combo is
      const score = combo.completion * 10 + (combo.pattern.winsGame ? 5 : 0);
      maxScore = Math.max(maxScore, score);
    }
  }

  return maxScore;
}
