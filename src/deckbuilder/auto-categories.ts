/**
 * Auto-Categories System for Deck Builder
 * Analyzes card text, type line, and keywords to assign functional categories.
 * Inspired by Archidekt's auto-categories feature.
 */

import type { DeckbuilderCardEntry, DeckbuilderCardView } from './types.js';

// ==================== Category Types ====================

export type CardCategory =
  | 'Ramp'
  | 'Mana Rock'
  | 'Draw'
  | 'Removal'
  | 'Board Wipe'
  | 'Counter'
  | 'Tutor'
  | 'Protection'
  | 'Recursion'
  | 'Finisher'
  | 'Combo Piece'
  | 'Utility'
  | 'Token Generator'
  | 'Lifegain'
  | 'Land'
  | 'Tribal Payoff'
  | 'Stax';

/**
 * Display priority for categories in pile view.
 * Lower number = displayed first.
 */
export const CATEGORY_PRIORITY: Record<CardCategory, number> = {
  'Land': 0,
  'Mana Rock': 1,
  'Ramp': 2,
  'Draw': 3,
  'Removal': 4,
  'Board Wipe': 5,
  'Counter': 6,
  'Tutor': 7,
  'Protection': 8,
  'Stax': 9,
  'Recursion': 10,
  'Token Generator': 11,
  'Tribal Payoff': 12,
  'Lifegain': 13,
  'Finisher': 14,
  'Combo Piece': 15,
  'Utility': 16,
};

/**
 * Aether-theme category colors for pile headers.
 */
export const CATEGORY_COLORS: Record<CardCategory, string> = {
  'Land': '#6b7280',
  'Mana Rock': '#a3e635',
  'Ramp': '#22c55e',
  'Draw': '#3b82f6',
  'Removal': '#ef4444',
  'Board Wipe': '#dc2626',
  'Counter': '#8b5cf6',
  'Tutor': '#a855f7',
  'Protection': '#f9faf4',
  'Stax': '#f97316',
  'Recursion': '#6366f1',
  'Token Generator': '#f59e0b',
  'Tribal Payoff': '#14b8a6',
  'Lifegain': '#34d399',
  'Finisher': '#e2b340',
  'Combo Piece': '#ec4899',
  'Utility': '#94a3b8',
};

// ==================== Pattern Helpers ====================

function text(card: DeckbuilderCardView): string {
  return (card.oracle_text || '').toLowerCase();
}

function typeLine(card: DeckbuilderCardView): string {
  return (card.type_line || '').toLowerCase();
}

function hasKeyword(card: DeckbuilderCardView, keyword: string): boolean {
  if (!card.keywords) return false;
  return card.keywords.some((k) => k.toLowerCase() === keyword.toLowerCase());
}

// ==================== Category Rules ====================
// Rules are checked in priority order. A card can match multiple categories.

interface CategoryRule {
  category: CardCategory;
  /** Higher = checked first */
  priority: number;
  match: (card: DeckbuilderCardView) => boolean;
}

const RULES: CategoryRule[] = [
  // ---- Land (highest priority, type-based) ----
  {
    category: 'Land',
    priority: 100,
    match: (card) => typeLine(card).includes('land'),
  },

  // ---- Board Wipe (before Removal to avoid overlap) ----
  {
    category: 'Board Wipe',
    priority: 90,
    match: (card) => {
      const t = text(card);
      return (
        t.includes('destroy all') ||
        t.includes('exile all') ||
        /each creature gets -\d+\/-\d+/.test(t) ||
        /all creatures get -\d+\/-\d+/.test(t) ||
        (t.includes('destroy each') && !t.includes('destroy each opponent')) ||
        t.includes('exile each') ||
        // Overload + destroy/exile pattern
        (hasKeyword(card, 'overload') && (/destroy target|exile target/.test(t)))
      );
    },
  },

  // ---- Counter ----
  {
    category: 'Counter',
    priority: 85,
    match: (card) => {
      const t = text(card);
      return (
        t.includes('counter target spell') ||
        t.includes('counter target activated') ||
        t.includes('counter target triggered') ||
        t.includes('counter that spell') ||
        // Instants/Sorceries that counter
        (typeLine(card).includes('instant') && t.includes('counter target'))
      );
    },
  },

  // ---- Removal ----
  {
    category: 'Removal',
    priority: 80,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      // Skip lands, they aren't removal
      if (tl.includes('land')) return false;
      return (
        t.includes('destroy target') ||
        t.includes('exile target') ||
        t.includes('return target') && t.includes('to its owner') ||
        /deals \d+ damage to (target|any|each)/.test(t) ||
        /-\d+\/-\d+ until end of turn/.test(t) ||
        t.includes('fight') ||
        t.includes('destroy another') ||
        t.includes('exile another')
      );
    },
  },

  // ---- Tutor (must check before Ramp to differentiate land search) ----
  {
    category: 'Tutor',
    priority: 75,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      // "search your library" but NOT for lands specifically
      if (!t.includes('search your library')) return false;
      // If it specifically searches for a land card, it's Ramp, not Tutor
      if (/search your library for a (basic )?land/.test(t)) return false;
      if (/search your library for up to \w+ basic land/.test(t)) return false;
      return true;
    },
  },

  // ---- Ramp ----
  {
    category: 'Ramp',
    priority: 70,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land') && !tl.includes('creature')) return false;
      return (
        // Mana dork: creature that taps for mana
        (tl.includes('creature') && /add \{[wubrgc]\}/i.test(t)) ||
        // Mana rocks: artifact that taps for mana
        (tl.includes('artifact') && /add \{[wubrgc]\}/i.test(t) && !tl.includes('creature')) ||
        // Land fetch
        /search your library for a (basic )?land/.test(t) ||
        /search your library for up to \w+ basic land/.test(t) ||
        // Put land onto battlefield
        /put .* land .* onto the battlefield/.test(t) ||
        // Additional land drops
        t.includes('you may play an additional land') ||
        // Treasure/mana token creation
        t.includes('create a treasure token') ||
        // Classic ramp patterns
        /add \{[wubrgc]\}\{[wubrgc]\}/i.test(t) ||
        // Sol Ring pattern: add {C}{C}
        t.includes('add {c}{c}')
      );
    },
  },

  // ---- Draw ----
  {
    category: 'Draw',
    priority: 65,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        t.includes('draw a card') ||
        t.includes('draw cards') ||
        /draw \w+ cards?/.test(t) ||
        t.includes('draw x cards') ||
        hasKeyword(card, 'cycling') ||
        // Impulse draw
        t.includes('exile the top') && t.includes('you may play') ||
        t.includes('exile the top') && t.includes('you may cast') ||
        // Cantrip-like: ETB draw
        (t.includes('enters') && t.includes('draw'))
      );
    },
  },

  // ---- Recursion ----
  {
    category: 'Recursion',
    priority: 60,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        /return .* from .* graveyard/.test(t) ||
        /put .* from .* graveyard/.test(t) ||
        t.includes('from your graveyard to your hand') ||
        t.includes('from your graveyard to the battlefield') ||
        t.includes('from a graveyard to the battlefield') ||
        hasKeyword(card, 'flashback') ||
        hasKeyword(card, 'unearth') ||
        hasKeyword(card, 'embalm') ||
        hasKeyword(card, 'eternalize')
      );
    },
  },

  // ---- Protection ----
  {
    category: 'Protection',
    priority: 55,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        t.includes('hexproof') ||
        t.includes('indestructible') ||
        /protection from \w+/.test(t) ||
        t.includes('shroud') ||
        t.includes('can\'t be the target') ||
        t.includes('can\'t be countered') ||
        t.includes('phase out')
      );
    },
  },

  // ---- Token Generator ----
  {
    category: 'Token Generator',
    priority: 50,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      // Don't count treasure token creators as token generators (they're ramp)
      const noTreasure = t.replace(/create .* treasure token/g, '');
      return (
        /create .* token/.test(noTreasure) ||
        /put .* token/.test(noTreasure)
      );
    },
  },

  // ---- Lifegain ----
  {
    category: 'Lifegain',
    priority: 40,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      // Only if lifegain is the primary function, not incidental
      const gainCount = (t.match(/gain .* life/g) || []).length;
      return (
        gainCount >= 1 && (
          hasKeyword(card, 'lifelink') ||
          t.includes('whenever you gain life') ||
          t.includes('you gain life equal to') ||
          // Primarily a lifegain card
          gainCount >= 2
        )
      );
    },
  },

  // ---- Finisher ----
  {
    category: 'Finisher',
    priority: 35,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      const power = Number(card.power);
      return (
        t.includes('you win the game') ||
        t.includes('target player loses the game') ||
        (tl.includes('creature') && !isNaN(power) && power >= 6) ||
        // Infect with decent body
        (hasKeyword(card, 'infect') && tl.includes('creature'))
      );
    },
  },

  // ---- Mana Rock (more specific than generic Ramp) ----
  {
    category: 'Mana Rock',
    priority: 71,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      // Must be a non-creature artifact that taps for mana
      return (
        tl.includes('artifact') &&
        !tl.includes('creature') &&
        !tl.includes('land') &&
        /add \{[wubrgc]\}/i.test(t)
      );
    },
  },

  // ---- Tribal Payoff ----
  {
    category: 'Tribal Payoff',
    priority: 45,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        t.includes('choose a creature type') ||
        /each .* you control get/.test(t) ||
        /other .* you control get/.test(t) ||
        /whenever another .* enters the battlefield/.test(t) && /creature type/.test(t) ||
        t.includes('creatures of the chosen type') ||
        t.includes('shares a creature type')
      );
    },
  },

  // ---- Stax / Tax ----
  {
    category: 'Stax',
    priority: 42,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      return (
        /opponents can't/.test(t) ||
        /players can't/.test(t) ||
        /spells cost \{?\d?\}? ?more to cast/.test(t) ||
        t.includes('nonland permanents don\'t untap') ||
        t.includes('opponents can\'t cast') ||
        t.includes('each opponent\'s upkeep') && t.includes('sacrifice') ||
        t.includes('at the beginning of each opponent\'s upkeep') ||
        (t.includes('each player') && t.includes('sacrifice'))
      );
    },
  },

  // ---- Combo Piece (heuristic fallback) ----
  {
    category: 'Combo Piece',
    priority: 30,
    match: (card) => {
      const t = text(card);
      const tl = typeLine(card);
      if (tl.includes('land')) return false;
      // Cards with many trigger words are likely combo pieces
      const triggerWords = (t.match(/whenever|at the beginning|at end of|if .* would/g) || []).length;
      const hasUntap = t.includes('untap') && !t.includes('untap step');
      const hasInfiniteIndicator = t.includes('doesn\'t untap') || t.includes('skip your');
      return (
        (triggerWords >= 3) ||
        (hasUntap && triggerWords >= 1) ||
        hasInfiniteIndicator ||
        t.includes('take an extra turn')
      );
    },
  },
];

// Sort rules by priority descending
const SORTED_RULES = [...RULES].sort((a, b) => b.priority - a.priority);

// ==================== Public API ====================

/**
 * Categorize a single card. Returns all matching categories sorted by priority.
 * The first element is the "primary" category.
 */
export function categorizeCard(card: DeckbuilderCardView): CardCategory[] {
  const categories: CardCategory[] = [];

  for (const rule of SORTED_RULES) {
    try {
      if (rule.match(card)) {
        categories.push(rule.category);
      }
    } catch {
      // Skip rules that fail (e.g., missing data)
    }
  }

  // If no category matched, it's Utility
  if (categories.length === 0) {
    categories.push('Utility');
  }

  return categories;
}

/**
 * Categorize all cards in a deck.
 * Returns a Map from normalized card name to their categories.
 */
export function categorizeAllCards(
  entries: DeckbuilderCardEntry[],
  resolvedByName: Record<string, DeckbuilderCardView | undefined>,
): Map<string, CardCategory[]> {
  const result = new Map<string, CardCategory[]>();

  for (const entry of entries) {
    const key = entry.name.trim().toLowerCase().replace(/\s+/g, ' ');
    const card = resolvedByName[key];
    if (card) {
      result.set(key, categorizeCard(card));
    } else {
      result.set(key, ['Utility']);
    }
  }

  return result;
}

/**
 * Get the primary auto-tag for a deck entry.
 * Manual tags take priority over auto-categorization.
 */
export function getAutoTagForEntry(
  entry: DeckbuilderCardEntry,
  resolvedByName: Record<string, DeckbuilderCardView | undefined>,
): string {
  // Manual tags always win
  if (entry.tags.length > 0) return entry.tags[0];

  const key = entry.name.trim().toLowerCase().replace(/\s+/g, ' ');
  const card = resolvedByName[key];
  if (!card) return 'Utility';

  const categories = categorizeCard(card);
  return categories[0];
}
