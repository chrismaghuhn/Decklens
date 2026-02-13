import type { CardTag } from '@mtg/game-engine';
import type { CardData } from './scryfall-loader.ts';

/**
 * Oracle Text Auto-Parser.
 *
 * Regex-based parser that automatically assigns CardTag labels
 * to cards based on their oracle text and type line.
 *
 * Covers all 20 CardTag types defined in game-engine.
 */

/** A parsing rule that maps patterns to a tag */
export interface ParsingRule {
  tag: CardTag;
  /** Patterns to check (oracle text + type line) */
  patterns: RegExp[];
  /** If any of these match, skip the tag even if patterns match */
  exclusions?: RegExp[];
}

/**
 * All parsing rules for the 20 CardTag types.
 * Order doesn't matter — all rules are evaluated independently.
 */
export const PARSING_RULES: ParsingRule[] = [
  // === Ramp ===
  {
    tag: 'ramp',
    patterns: [
      /add \{[WUBRGC]\}/i,
      /add \{[WUBRGC]\}\{[WUBRGC]\}/i,
      /adds? (\w+ )?mana of any (color|type)/i,
      /search your library for.*land.*put.*onto the battlefield/i,
      /you may put.*land.*onto the battlefield/i,
      /additional land/i,
    ],
    exclusions: [
      /^Land/i, // Exclude lands themselves (type line check)
    ],
  },

  // === Card Draw ===
  {
    tag: 'draw',
    patterns: [
      /draw (a|one|two|three|\d+) cards?/i,
      /draws? (a|one|two|three|\d+) cards?/i,
      /whenever.*draw a card/i,
      /you may draw/i,
      /look at the top.*put.*into your hand/i,
    ],
  },

  // === Removal ===
  {
    tag: 'removal',
    patterns: [
      /destroy target (creature|artifact|enchantment|permanent|planeswalker)/i,
      /exile target (creature|artifact|enchantment|permanent|planeswalker)/i,
      /deals? \d+ damage to (target|any target|each)/i,
      /return target.*to (its|their) owner('s)? hand/i,
      /target creature gets? -\d+\/-\d+/i,
      /destroy (target )?nonland permanent/i,
      /exile (target )?nonland permanent/i,
    ],
    exclusions: [
      /destroy all/i, // Board wipes are a separate tag
      /exile all/i,
    ],
  },

  // === Counterspells ===
  {
    tag: 'counter',
    patterns: [
      /counter target spell/i,
      /counter target (creature|artifact|enchantment|instant|sorcery|noncreature|activated|triggered)/i,
      /counter (it|that spell)/i,
      /counter target.*unless/i,
    ],
  },

  // === Tutors ===
  {
    tag: 'tutor',
    patterns: [
      /search your library for a card/i,
      /search your library for (a|an) (creature|artifact|enchantment|instant|sorcery|planeswalker)/i,
    ],
    exclusions: [
      /search your library for a basic land/i, // Basic fetch = land-fetch, not tutor
      /search your library for.*basic.*land/i,
      /search your library for.*forest|plains|island|swamp|mountain.*card/i,
    ],
  },

  // === Board Wipes ===
  {
    tag: 'wipe',
    patterns: [
      /destroy all creatures/i,
      /destroy all (nonland )?permanents/i,
      /exile all creatures/i,
      /all creatures get -\d+\/-\d+/i,
      /each creature gets -\d+\/-\d+/i,
      /deals? \d+ damage to each creature/i,
    ],
  },

  // === Engine (value generators) ===
  {
    tag: 'engine',
    patterns: [
      /whenever (a|an).*enters (the battlefield)?.*draw/i,
      /whenever you cast.*draw/i,
      /whenever.*dies.*draw/i,
      /at the beginning of (your )?(upkeep|end step).*draw/i,
      /whenever an opponent (casts|draws)/i,
    ],
  },

  // === Payoff (benefits from a strategy) ===
  {
    tag: 'payoff',
    patterns: [
      /for each (creature|permanent|land|artifact|enchantment)/i,
      /equal to the number of/i,
      /gets? \+\d+\/\+\d+ for each/i,
      /whenever another (creature|permanent).*enters/i,
    ],
  },

  // === Combo Piece ===
  {
    tag: 'combo-piece',
    patterns: [
      /infinite/i,
      /untap (all|each).*you control/i,
      /copy (target )?(spell|ability|activated|triggered)/i,
      /take an extra turn/i,
      /extra combat/i,
      /you win the game/i,
      /target player loses the game/i,
    ],
  },

  // === Protection ===
  {
    tag: 'protection',
    patterns: [
      /hexproof/i,
      /shroud/i,
      /indestructible/i,
      /protection from/i,
      /phase out/i,
      /target (creature|permanent).*gains? (hexproof|indestructible|protection)/i,
      /can't be (the target|countered|destroyed)/i,
    ],
    exclusions: [
      /^(Creature|Artifact|Enchantment)/i, // Only count if it's a SPELL granting protection
    ],
  },

  // === Recursion ===
  {
    tag: 'recursion',
    patterns: [
      /return.*from (your )?graveyard to (your )?hand/i,
      /return target.*from.*graveyard to/i,
      /exile.*from your graveyard.*cast/i,
      /you may cast.*from your graveyard/i,
      /flashback/i,
      /escape/i,
      /disturb/i,
    ],
  },

  // === Reanimation ===
  {
    tag: 'reanimation',
    patterns: [
      /return.*creature.*from.*graveyard to the battlefield/i,
      /put.*creature.*from.*graveyard onto the battlefield/i,
      /reanimate/i,
    ],
  },

  // === Token Generator ===
  {
    tag: 'token-generator',
    patterns: [
      /create (a|one|two|three|\d+|an?|X) .*token/i,
      /creates? .* tokens?/i,
    ],
  },

  // === Sacrifice Outlet ===
  {
    tag: 'sacrifice-outlet',
    patterns: [
      /sacrifice (a|an|another) (creature|permanent|artifact|enchantment)/i,
      /sacrifice.*:/i, // Activated ability with sacrifice cost
    ],
    exclusions: [
      /sacrifice.*this/i, // Sacrificing itself is not an outlet
    ],
  },

  // === Mana Dork ===
  {
    tag: 'mana-dork',
    patterns: [
      /creature.*\n.*\{T\}:.*add/i, // Tap ability that adds mana on a creature
    ],
  },

  // === Fast Mana ===
  {
    tag: 'fast-mana',
    patterns: [
      // Known fast mana cards by oracle text patterns
      /\{0\}.*\{T\}:.*add/i, // 0-cost artifacts that tap for mana
    ],
  },

  // === Land Fetch ===
  {
    tag: 'land-fetch',
    patterns: [
      /search your library for a basic land/i,
      /search your library for.*basic.*land/i,
      /search your library for.*(forest|plains|island|swamp|mountain)/i,
      /search your library for a land card with a basic land type/i,
    ],
  },

  // === Card Selection ===
  {
    tag: 'card-selection',
    patterns: [
      /scry \d+/i,
      /surveil \d+/i,
      /look at the top \d+ cards/i,
      /reveal the top \d+ cards/i,
    ],
  },

  // === Win Condition ===
  {
    tag: 'win-condition',
    patterns: [
      /you win the game/i,
      /target player loses the game/i,
      /each opponent loses the game/i,
      /deals? 10 or more.*damage/i,
    ],
  },

  // === Finisher ===
  {
    tag: 'finisher',
    patterns: [
      /double.*power/i,
      /double strike/i,
      /deals? combat damage.*equal to/i,
      /commander damage/i,
      /infect/i,
    ],
  },
];

/**
 * Parse a single card and assign tags based on oracle text and type line.
 */
export function parseCardTags(card: CardData): CardTag[] {
  const tags = new Set<CardTag>();
  const oracleText = card.oracleText || '';
  const typeLine = card.typeLine || '';

  // Special handling for mana dorks: need type line + oracle text combined
  const fullText = `${typeLine}\n${oracleText}`;

  for (const rule of PARSING_RULES) {
    // Check exclusions first
    if (rule.exclusions) {
      const excluded = rule.exclusions.some(
        (ex) => ex.test(typeLine) || ex.test(oracleText)
      );
      if (excluded) continue;
    }

    // Check patterns against oracle text, type line, or full text
    const matched = rule.patterns.some(
      (p) => p.test(oracleText) || p.test(typeLine) || p.test(fullText)
    );

    if (matched) {
      tags.add(rule.tag);
    }
  }

  // Keyword-based tags from Scryfall keywords
  if (card.keywords) {
    for (const keyword of card.keywords) {
      const lower = keyword.toLowerCase();
      if (lower === 'flashback' || lower === 'escape' || lower === 'disturb') {
        tags.add('recursion');
      }
      if (lower === 'double strike' || lower === 'infect') {
        tags.add('finisher');
      }
    }
  }

  return Array.from(tags);
}

/**
 * Parse tags for all cards in a collection.
 * Returns a new array with tags populated.
 */
export function parseAllCardTags(cards: CardData[]): CardData[] {
  return cards.map((card) => ({
    ...card,
    tags: parseCardTags(card),
  }));
}

/**
 * Get statistics about tag distribution across a card collection.
 */
export function getTagStatistics(cards: CardData[]): Record<CardTag, number> {
  const stats: Partial<Record<CardTag, number>> = {};

  for (const card of cards) {
    for (const tag of card.tags) {
      stats[tag] = (stats[tag] || 0) + 1;
    }
  }

  return stats as Record<CardTag, number>;
}
