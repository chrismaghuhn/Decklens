/**
 * Deck Linter — Validates deck against DSL requirements
 * 
 * Takes parsed DSL requirements and checks if the deck satisfies them.
 * Returns violations with actionable fixes.
 */

import type { DeckbuilderDeck, DeckbuilderCardEntry } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import type { DeckRequirement } from './deck-dsl-parser.js';

export interface LintViolation {
  requirement: DeckRequirement;
  message: string;
  severity: 'error' | 'warning' | 'info';
  /** Suggested fix (e.g., "Add 3 more ramp cards") */
  fix?: string;
  /** Current state (e.g., "7/10 ramp cards") */
  current?: string;
}

/**
 * Normalize card name for comparison
 */
function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Count cards with a specific tag
 */
function countTag(cards: DeckbuilderCardEntry[], tag: string): number {
  let count = 0;
  for (const entry of cards) {
    if (entry.tags.includes(tag)) {
      count += entry.qty;
    }
  }
  return count;
}

/**
 * Check if all combo pieces are in the deck
 */
function hasAllComboCards(
  cards: DeckbuilderCardEntry[],
  comboCards: string[]
): { has: boolean; missing: string[] } {
  const cardNames = new Set(cards.map(c => normalizeKey(c.name)));
  const missing: string[] = [];

  for (const comboCard of comboCards) {
    if (!cardNames.has(normalizeKey(comboCard))) {
      missing.push(comboCard);
    }
  }

  return { has: missing.length === 0, missing };
}

/**
 * Calculate total deck price in EUR
 */
function calculateTotalPrice(
  cards: DeckbuilderCardEntry[],
  cardByName: Record<string, DeckbuilderSearchCard | undefined>
): number {
  let total = 0;
  for (const entry of cards) {
    const card = cardByName[normalizeKey(entry.name)];
    if (card?.prices?.eur) {
      const price = parseFloat(card.prices.eur) || 0;
      total += price * entry.qty;
    }
  }
  return total;
}

/**
 * Get maximum CMC in deck
 */
function getMaxCMC(
  cards: DeckbuilderCardEntry[],
  cardByName: Record<string, DeckbuilderSearchCard | undefined>
): number {
  let maxCMC = 0;
  for (const entry of cards) {
    const card = cardByName[normalizeKey(entry.name)];
    if (card?.cmc && card.cmc > maxCMC) {
      maxCMC = card.cmc;
    }
  }
  return maxCMC;
}

/**
 * Lint deck against DSL requirements
 */
export function lintDeck(
  deck: DeckbuilderDeck,
  requirements: DeckRequirement[],
  cardByName: Record<string, DeckbuilderSearchCard | undefined>
): LintViolation[] {
  const violations: LintViolation[] = [];
  const mainboard = deck.boards.mainboard;

  for (const req of requirements) {
    switch (req.type) {
      case 'tag': {
        if (!req.tag || !req.operator || req.value === undefined) break;
        
        const count = countTag(mainboard, req.tag);
        const targetValue = req.value;
        let violated = false;

        switch (req.operator) {
          case '>=':
            violated = count < targetValue;
            break;
          case '<=':
            violated = count > targetValue;
            break;
          case '>':
            violated = count <= targetValue;
            break;
          case '<':
            violated = count >= targetValue;
            break;
          case '=':
            violated = count !== targetValue;
            break;
        }

        if (violated) {
          const deficit = targetValue - count;
          violations.push({
            requirement: req,
            severity: req.severity,
            message: `Tag "${req.tag}" requirement not met`,
            current: `${count}/${targetValue} ${req.tag} cards`,
            fix: deficit > 0 
              ? `Add ${deficit} more ${req.tag} card${deficit > 1 ? 's' : ''}`
              : `Remove ${Math.abs(deficit)} ${req.tag} card${Math.abs(deficit) > 1 ? 's' : ''}`,
          });
        }
        break;
      }

      case 'combo': {
        if (!req.comboCards || req.comboCards.length === 0) break;

        const result = hasAllComboCards(mainboard, req.comboCards);
        if (!result.has) {
          violations.push({
            requirement: req,
            severity: req.severity,
            message: `Combo incomplete: missing ${result.missing.join(', ')}`,
            fix: `Add: ${result.missing.join(', ')}`,
          });
        }
        break;
      }

      case 'budget': {
        if (req.maxBudget === undefined) break;

        const totalPrice = calculateTotalPrice(mainboard, cardByName);
        if (totalPrice > req.maxBudget) {
          const overage = totalPrice - req.maxBudget;
          violations.push({
            requirement: req,
            severity: req.severity,
            message: `Budget exceeded`,
            current: `€${totalPrice.toFixed(2)}/€${req.maxBudget.toFixed(2)}`,
            fix: `Reduce price by €${overage.toFixed(2)}`,
          });
        }
        break;
      }

      case 'max-cmc': {
        if (req.value === undefined) break;

        const maxCMC = getMaxCMC(mainboard, cardByName);
        if (maxCMC > req.value) {
          violations.push({
            requirement: req,
            severity: req.severity,
            message: `CMC too high`,
            current: `Max CMC: ${maxCMC}`,
            fix: `Remove cards with CMC > ${req.value}`,
          });
        }
        break;
      }

      case 'custom': {
        // Custom requirements are not validated automatically
        // Just informational
        break;
      }
    }
  }

  return violations;
}
