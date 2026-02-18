/**
 * Unified Modal System — Parse and resolve modal spells (Choose one/two/more).
 *
 * MTG modal spells have the format:
 *   "Choose one —"
 *   • Mode A text.
 *   • Mode B text.
 *   • Mode C text.
 *
 * This module detects modal text, extracts modes, and resolves chosen modes
 * by delegating each mode's text to the effect resolver.
 */

import type { GameState } from '../types/game-state.ts';
import type { StackObject } from '../types/action.ts';
import { resolveEffect } from './effects.ts';

// ─── Types ───

export interface ModalMode {
  /** 0-based index of this mode */
  index: number;
  /** Display text e.g. "Draw two cards" */
  text: string;
  /** Oracle text fed to effect resolver */
  oracleText: string;
}

export interface ModalSpell {
  /** Minimum number of modes to choose (1 for "choose one", 2 for "choose two") */
  minChoices: number;
  /** Maximum number of modes to choose (same as min for "choose one/two", modes.length for "one or more") */
  maxChoices: number;
  /** Available modes */
  modes: ModalMode[];
}

// ─── Number word mapping ───

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

// ─── Parse ───

/**
 * Detect a modal spell from oracle text and extract its modes.
 *
 * Supported headers:
 * - "Choose one —"
 * - "Choose two —"
 * - "Choose three —"
 * - "Choose one or both —"  (min=1, max=2)
 * - "Choose one or more —"  (min=1, max=modes.length)
 * - "Choose one that hasn't been chosen —" (treated as choose one)
 *
 * Modes are delimited by bullet points (•) after the header.
 *
 * Returns null if the text is not a modal spell.
 */
export function parseModalSpell(oracleText: string): ModalSpell | null {
  if (!oracleText) return null;

  // Match the "Choose X —" header (case-insensitive)
  const headerRegex = /choose\s+(one|two|three|four|five)(?:\s+(?:or\s+(both|more))|(?:\s+that\s+hasn'?t\s+been\s+chosen))?\s*(?:—|--|-)/i;
  const headerMatch = oracleText.match(headerRegex);
  if (!headerMatch) return null;

  const countWord = headerMatch[1].toLowerCase();
  const modifier = headerMatch[2]?.toLowerCase(); // "both" | "more" | undefined

  // Extract modes from bullet points
  // Bullets can be on separate lines (\n•) or inline (• )
  const headerEnd = headerMatch.index! + headerMatch[0].length;
  const modesText = oracleText.substring(headerEnd);

  // Split on bullet points — handle both \n• and inline •
  const bulletParts = modesText.split(/(?:\n\s*•|(?:^|\s)•)\s*/);

  // Filter out empty strings and the text before the first bullet
  const rawModes = bulletParts
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (rawModes.length === 0) return null;

  // Build ModalMode objects
  const modes: ModalMode[] = rawModes.map((raw, idx) => {
    // Strip trailing period and whitespace
    const cleaned = raw.replace(/\.\s*$/, '').trim();
    return {
      index: idx,
      text: cleaned,
      oracleText: cleaned,
    };
  });

  // Determine min/max choices
  const baseCount = NUMBER_WORDS[countWord] ?? 1;
  let minChoices: number;
  let maxChoices: number;

  if (modifier === 'both') {
    // "Choose one or both —"
    minChoices = 1;
    maxChoices = 2;
  } else if (modifier === 'more') {
    // "Choose one or more —"
    minChoices = 1;
    maxChoices = modes.length;
  } else {
    // "Choose one/two/three —" or "Choose one that hasn't been chosen —"
    minChoices = baseCount;
    maxChoices = baseCount;
  }

  return { minChoices, maxChoices, modes };
}

// ─── Resolve ───

/**
 * Execute each chosen mode as an effect.
 *
 * For each chosen mode index, calls `resolveEffect()` with a modified
 * StackObject whose oracleText is set to the mode's text. States are
 * chained so mode 1's result feeds into mode 2.
 */
export function resolveModalChoices(
  state: GameState,
  stackObj: StackObject,
  chosenModes: number[],
): GameState {
  let currentState = state;
  const modal = parseModalSpell(stackObj.oracleText || stackObj.card?.oracleText || '');
  if (!modal) return currentState;

  for (const modeIdx of chosenModes) {
    const mode = modal.modes.find(m => m.index === modeIdx);
    if (!mode) continue;

    // Create a modified stack object with just this mode's text
    const modeStackObj: StackObject = {
      ...stackObj,
      oracleText: mode.oracleText,
      text: mode.text,
    };

    const result = resolveEffect(currentState, modeStackObj);
    currentState = result.state;
  }

  return currentState;
}
