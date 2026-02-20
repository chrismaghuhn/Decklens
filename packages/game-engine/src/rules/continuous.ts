/**
 * Continuous Effects System
 *
 * Handles static abilities from permanents that continuously modify
 * creatures on the battlefield:
 *
 * - Lord effects: "Other creatures you control get +1/+1"
 * - Anthem effects: "Creatures you control get +1/+1" (enchantments like Glorious Anthem)
 * - Type-specific lords: "Other Elf creatures you control get +1/+1"
 * - Keyword grants: "Other creatures you control have flying"
 * - Opponent debuffs: "Creatures your opponents control get -2/-2"
 *
 * MTG Layer System (Rule 613):
 * This module implements the full layer system:
 *   Layer 1: Copy effects (Clone, etc.)
 *   Layer 2: Control-changing effects (handled imperatively elsewhere)
 *   Layer 3: Text-changing effects (not implemented — extremely rare)
 *   Layer 4: Type-changing effects (type additions/removals)
 *   Layer 5: Color-changing effects (color additions/replacements)
 *   Layer 6: Ability adding/removing effects (Humility, etc.)
 *   Layer 7: P/T modifications (sublayers 7a-7e)
 *
 * Layers 1-6 are applied first, then Layer 7 operates on the modified state.
 * Within each layer, effects are ordered by timestamp where applicable.
 *
 * Called frequently (on every state change), so performance matters.
 */

import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import {
  isEquipment,
  isAura,
  getEquipmentBonuses,
  getAuraBonuses,
} from './equipment.ts';
import { hasKeyword } from './combat.ts';
import { parseAbilities } from './abilities.ts';

// ─── Types ───

/** Bonuses from a single static ability source */
export interface StaticBonus {
  power: number;
  toughness: number;
  keywords: string[];
}

/** A parsed static ability from a permanent's oracle text */
interface ParsedStaticEffect {
  /** The permanent providing this effect */
  sourceId: string;
  /** Controller of the source permanent */
  sourceController: number;
  /** Whether the effect excludes the source permanent ("Other ...") */
  excludeSelf: boolean;
  /** Applies to the controller's creatures (true) or opponent's (false) */
  appliesToController: boolean;
  /** Type filter — e.g. "elf", "zombie", "goblin". Empty string = all creatures */
  typeFilter: string;
  /** Power modification */
  power: number;
  /** Toughness modification */
  toughness: number;
  /** Keywords granted by this effect */
  keywords: string[];
}

// ─── Regex Patterns (compiled once for performance) ───

/**
 * Matches lord/anthem P/T patterns in oracle text. Captures:
 * 1. Optional "other" / "each other" prefix
 * 2. Optional type filter (e.g. "Elf", "Zombie", "Goblin")
 * 3. "creature" or "creatures" keyword
 * 4. "you control" or "your opponents control"
 * 5. Power mod (e.g. +1, -2)
 * 6. Toughness mod (e.g. +1, -2)
 *
 * Examples matched:
 *   "Other creatures you control get +1/+1"
 *   "Other Elf creatures you control get +1/+1"
 *   "Zombie creatures you control get +2/+2"
 *   "Creatures your opponents control get -2/-2"
 *   "Each other creature you control gets +1/+1"
 */
const PT_BONUS_PATTERN =
  /(?:(other|each other)\s+)?(?:(\w+)\s+)?creatures?\s+(?:(you|your opponents?)\s+control)\s+gets?\s+([+-]\d+)\/([+-]\d+)/gi;

/**
 * Matches keyword-granting patterns in oracle text. Captures:
 * 1. Optional "other" prefix
 * 2. Optional type filter
 * 3. "you control" or "your opponents control"
 * 4. Keyword(s) granted
 *
 * Examples matched:
 *   "Other creatures you control have flying"
 *   "Creatures you control have vigilance"
 *   "Elf creatures you control have forestwalk"
 *   "Other Goblin creatures you control have haste"
 */
const KEYWORD_GRANT_PATTERN =
  /(?:(other|each other)\s+)?(?:(\w+)\s+)?creatures?\s+(?:(you|your opponents?)\s+control)\s+(?:have|has|gain|gains)\s+(.+)/gi;

/**
 * Matches static "set base P/T" patterns (Layer 7b), e.g.:
 *   "Creatures you control have base power and toughness 1/1" (Humility variant)
 *   "Creatures your opponents control are 1/1" (mass debuff)
 *   "Other creatures you control have base power and toughness 0/1"
 *
 * Captures:
 * 1. Optional "other" prefix
 * 2. Optional type filter (e.g. "Elf")
 * 3. Controller filter: "you control" or "your opponents control"
 * 4. Power value
 * 5. Toughness value
 */
const SET_PT_PATTERN =
  /(?:(other|each other)\s+)?(?:(\w+)\s+)?creatures?\s+(?:(you|your opponents?)\s+control)\s+(?:have\s+base\s+power\s+and\s+toughness\s+|(?:are|become)\s+)(\d+)\/(\d+)/gi;

/** All MTG combat/evergreen keywords we recognize */
const RECOGNIZED_KEYWORDS = new Set([
  'flying', 'first strike', 'double strike', 'trample', 'lifelink',
  'deathtouch', 'vigilance', 'haste', 'hexproof', 'indestructible',
  'menace', 'reach', 'defender', 'flash', 'ward', 'shroud',
  'fear', 'intimidate', 'skulk', 'forestwalk', 'islandwalk',
  'mountainwalk', 'swampwalk', 'plainswalk',
  'prowess', 'extort', 'undying', 'persist', 'afflict', 'infect', 'wither',
  'cascade', 'storm', 'cycling', 'escape', 'convoke', 'delve', 'affinity', 'improvise', 'crew',
  'fabricate', 'riot', 'adapt', 'explore', 'surveil', 'connive', 'myriad',
  'annihilator', 'battle cry', 'totem armor', 'bestow', 'embalm', 'eternalize',
  'exalted', 'encore', 'reconfigure',
  'ninjutsu', 'exploit', 'modular', 'devour', 'bloodthirst', 'blitz', 'emerge',
  'spectacle', 'aftermath', 'cipher', 'champion', 'hideaway', 'casualty',
  'daybound', 'nightbound', 'living weapon', 'amass', 'mutate',
  'companion',
]);

// ─── Oracle Text Parsing ───

/**
 * Parse all static P/T and keyword-granting effects from a permanent's oracle text.
 * Returns an array of parsed effects. Skips triggered/activated abilities that
 * use "until end of turn" (those are handled by temporaryPtMods).
 */
function parseStaticEffects(perm: Permanent): ParsedStaticEffect[] {
  const text = perm.oracleText || '';
  if (!text) return [];

  const effects: ParsedStaticEffect[] = [];

  // Skip lines that are clearly triggered or activated abilities with temporary duration.
  // Static abilities have no duration — they just say "get +X/+Y" with no "until" clause.
  // We process each paragraph (newline-separated) independently.
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // Skip triggered abilities: "When ... enters the battlefield, ..."
    // Skip activated abilities: "{cost}: ..."
    // Skip temporary effects: "... until end of turn"
    if (/^when(ever)?[\s,]/i.test(trimmed)) continue;
    if (/^at\s+(the\s+)?beginning/i.test(trimmed)) continue;
    if (/until\s+end\s+of\s+turn/i.test(trimmed)) continue;
    if (/\{[^}]*\}\s*:/i.test(trimmed) && !/^\{t\}\s*:/i.test(trimmed)) continue;

    // --- Parse P/T bonuses ---
    PT_BONUS_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PT_BONUS_PATTERN.exec(trimmed)) !== null) {
      const otherPrefix = match[1]; // "other" or "each other" or undefined
      const typeWord = match[2];    // e.g. "Elf", "Zombie", or undefined
      const target = match[3];      // "you" or "your opponents"
      const powerMod = parseInt(match[4], 10);
      const toughnessMod = parseInt(match[5], 10);

      const excludeSelf = !!otherPrefix;
      const appliesToController = target.toLowerCase() === 'you';

      // Determine type filter — "creature" alone is not a type filter, just a selector
      let typeFilter = '';
      if (typeWord && typeWord.toLowerCase() !== 'creature' && typeWord.toLowerCase() !== 'creatures') {
        typeFilter = typeWord.toLowerCase();
      }

      effects.push({
        sourceId: perm.id,
        sourceController: perm.controller,
        excludeSelf,
        appliesToController,
        typeFilter,
        power: powerMod,
        toughness: toughnessMod,
        keywords: [],
      });
    }

    // --- Parse keyword grants ---
    KEYWORD_GRANT_PATTERN.lastIndex = 0;

    while ((match = KEYWORD_GRANT_PATTERN.exec(trimmed)) !== null) {
      const otherPrefix = match[1];
      const typeWord = match[2];
      const target = match[3];
      const keywordText = match[4].toLowerCase().trim();

      const excludeSelf = !!otherPrefix;
      const appliesToController = target.toLowerCase() === 'you';

      let typeFilter = '';
      if (typeWord && typeWord.toLowerCase() !== 'creature' && typeWord.toLowerCase() !== 'creatures') {
        typeFilter = typeWord.toLowerCase();
      }

      // Extract actual keywords from the matched text.
      // The keyword text might be something like "flying and first strike" or "haste"
      // or "mountainwalk" or "+1/+1 and have flying" — we only want keyword parts.
      const grantedKeywords = extractKeywords(keywordText);

      // Only add if we actually found recognized keywords
      // (avoids false positives from non-keyword grant text)
      if (grantedKeywords.length > 0) {
        // Check if we already have a P/T effect for the same source/filter/target
        // combination — if so, merge keywords into that effect
        const existing = effects.find(
          (e) =>
            e.sourceId === perm.id &&
            e.excludeSelf === excludeSelf &&
            e.appliesToController === appliesToController &&
            e.typeFilter === typeFilter
        );

        if (existing) {
          for (const kw of grantedKeywords) {
            if (!existing.keywords.includes(kw)) {
              existing.keywords.push(kw);
            }
          }
        } else {
          effects.push({
            sourceId: perm.id,
            sourceController: perm.controller,
            excludeSelf,
            appliesToController,
            typeFilter,
            power: 0,
            toughness: 0,
            keywords: grantedKeywords,
          });
        }
      }
    }
  }

  return effects;
}

/**
 * Parse static "set base P/T" effects from a permanent's oracle text (Layer 7b).
 *
 * These are continuous effects like Humility ("All creatures lose all abilities
 * and have base power and toughness 1/1") that override a creature's base P/T
 * rather than adding a +/- modifier.
 *
 * Unlike temporaryPtMods with isSetEffect (which are one-shot spell effects),
 * these are static abilities that continuously apply as long as the source is
 * on the battlefield.
 */
function parseStaticSetPtEffects(perm: Permanent): ParsedStaticEffect[] {
  const text = perm.oracleText || '';
  if (!text) return [];

  const effects: ParsedStaticEffect[] = [];
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    // Skip triggered/activated/temporary abilities (same filters as parseStaticEffects)
    if (/^when(ever)?[\s,]/i.test(trimmed)) continue;
    if (/^at\s+(the\s+)?beginning/i.test(trimmed)) continue;
    if (/until\s+end\s+of\s+turn/i.test(trimmed)) continue;
    if (/\{[^}]*\}\s*:/i.test(trimmed) && !/^\{t\}\s*:/i.test(trimmed)) continue;

    SET_PT_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = SET_PT_PATTERN.exec(trimmed)) !== null) {
      const otherPrefix = match[1];
      const typeWord = match[2];
      const target = match[3];
      const power = parseInt(match[4], 10);
      const toughness = parseInt(match[5], 10);

      const excludeSelf = !!otherPrefix;
      const appliesToController = target.toLowerCase() === 'you';

      let typeFilter = '';
      if (typeWord && typeWord.toLowerCase() !== 'creature' && typeWord.toLowerCase() !== 'creatures') {
        typeFilter = typeWord.toLowerCase();
      }

      effects.push({
        sourceId: perm.id,
        sourceController: perm.controller,
        excludeSelf,
        appliesToController,
        typeFilter,
        power,
        toughness,
        keywords: [],
      });
    }
  }

  return effects;
}

// ─── Layer 6: Static "Loses All Abilities" Parsing ───

/** Parsed static "loses all abilities" effect from a permanent */
interface ParsedStaticLoseAbilities {
  sourceId: string;
  sourceController: number;
  appliesToController: boolean;
  excludeSelf: boolean;
  typeFilter: string;
}

const LOSE_ABILITIES_PATTERN =
  /(?:(other|each other)\s+)?(?:(\w+)\s+)?creatures?\s+(?:(you|your opponents?)\s+control)\s+(?:lose|have\s+no)\s+(?:all\s+)?abilities/gi;

/**
 * Parse static "loses all abilities" effects from a permanent's oracle text (Layer 6).
 *
 * These are continuous effects like Humility ("All creatures lose all abilities")
 * that strip abilities from affected creatures as long as the source is on the battlefield.
 */
function parseStaticLoseAbilitiesEffects(perm: Permanent): ParsedStaticLoseAbilities[] {
  const text = perm.oracleText || '';
  if (!text) return [];
  const effects: ParsedStaticLoseAbilities[] = [];
  const paragraphs = text.split('\n');
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (/^when(ever)?[\s,]/i.test(trimmed)) continue;
    if (/^at\s+(the\s+)?beginning/i.test(trimmed)) continue;
    if (/until\s+end\s+of\s+turn/i.test(trimmed)) continue;
    if (/\{[^}]*\}\s*:/i.test(trimmed) && !/^\{t\}\s*:/i.test(trimmed)) continue;

    LOSE_ABILITIES_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LOSE_ABILITIES_PATTERN.exec(trimmed)) !== null) {
      const otherPrefix = match[1];
      const typeWord = match[2];
      const target = match[3];
      const excludeSelf = !!otherPrefix;
      const appliesToController = target.toLowerCase() === 'you';
      let typeFilter = '';
      if (typeWord && typeWord.toLowerCase() !== 'creature' && typeWord.toLowerCase() !== 'creatures') {
        typeFilter = typeWord.toLowerCase();
      }
      effects.push({ sourceId: perm.id, sourceController: perm.controller, appliesToController, excludeSelf, typeFilter });
    }
  }
  return effects;
}

/**
 * Extract recognized MTG keywords from a text fragment.
 * Handles "flying", "flying and first strike", "haste, menace", etc.
 */
function extractKeywords(text: string): string[] {
  const keywords: string[] = [];
  const cleaned = text
    .replace(/\band\b/g, ',')
    .replace(/\./g, '')
    .trim();

  // Try matching multi-word keywords first (e.g. "first strike", "double strike")
  for (const kw of RECOGNIZED_KEYWORDS) {
    if (kw.includes(' ')) {
      if (cleaned.includes(kw)) {
        keywords.push(kw);
      }
    }
  }

  // Then single-word keywords from comma/space-separated tokens
  const tokens = cleaned.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  for (const token of tokens) {
    if (RECOGNIZED_KEYWORDS.has(token) && !keywords.includes(token)) {
      keywords.push(token);
    }
  }

  return keywords;
}

// ─── Type Matching ───

/**
 * Check if a creature matches a type filter (e.g. "elf", "zombie", "goblin").
 *
 * Compares case-insensitively against the creature's typeLine.
 * The special filter "creature" (or empty string) matches all creatures.
 *
 * Examples:
 *   matchesTypeFilter(elfWarrior, "elf") → true
 *   matchesTypeFilter(goblinChieftain, "goblin") → true
 *   matchesTypeFilter(humanSoldier, "elf") → false
 *   matchesTypeFilter(anythingCreature, "") → true
 */
export function matchesTypeFilter(creature: Permanent, filter: string): boolean {
  if (!filter || filter === 'creature' || filter === 'creatures') {
    return true;
  }

  const typeLine = creature.typeLine.toLowerCase();
  const normalizedFilter = filter.toLowerCase();

  // Check for exact word match within the type line to avoid partial matches
  // e.g., "Elf" should match "Elf Warrior" but not "Shelf"
  // Split on common type line separators: spaces, hyphens, em-dashes
  const typeWords = typeLine.split(/[\s\u2014—-]+/);
  return typeWords.some((word) => word === normalizedFilter);
}

// ─── Static Bonus Calculation ───

/**
 * Calculate all static ability bonuses that apply to a specific creature
 * from all other permanents on the battlefield.
 *
 * Scans both players' battlefields for permanents with lord/anthem effects
 * and sums up all applicable P/T bonuses and keyword grants.
 *
 * @param state - Current game state
 * @param creature - The creature to calculate bonuses for
 * @param playerIdx - Which player controls the creature
 * @returns Combined power/toughness bonuses and granted keywords
 */
export function getStaticBonuses(
  state: GameState,
  creature: Permanent,
  playerIdx: number
): StaticBonus {
  let power = 0;
  let toughness = 0;
  const keywords: string[] = [];

  // Gather all static effects from both players' battlefields
  for (let p = 0; p < state.players.length; p++) {
    const player = state.players[p];

    for (const perm of player.battlefield) {
      // Only parse permanents that have oracle text (optimization)
      if (!perm.oracleText) continue;

      const effects = parseStaticEffects(perm);

      for (const effect of effects) {
        // Does this effect apply to this creature?
        if (!doesEffectApply(effect, creature, playerIdx)) continue;

        power += effect.power;
        toughness += effect.toughness;

        for (const kw of effect.keywords) {
          if (!keywords.includes(kw)) {
            keywords.push(kw);
          }
        }
      }
    }
  }

  return { power, toughness, keywords };
}

/**
 * Determine if a parsed static effect applies to a given creature.
 */
function doesEffectApply(
  effect: ParsedStaticEffect,
  creature: Permanent,
  creatureController: number
): boolean {
  // "Exclude self" check — "Other creatures..." doesn't apply to the source
  if (effect.excludeSelf && creature.id === effect.sourceId) {
    return false;
  }

  // Controller targeting check
  if (effect.appliesToController) {
    // "Creatures you control" — applies to creatures controlled by the source's controller
    if (creatureController !== effect.sourceController) {
      return false;
    }
  } else {
    // "Creatures your opponents control" — applies to creatures NOT controlled by the source's controller
    if (creatureController === effect.sourceController) {
      return false;
    }
  }

  // The creature must actually be a creature (has power/toughness)
  if (creature.basePower === undefined || creature.baseToughness === undefined) {
    return false;
  }

  // Type filter check
  if (effect.typeFilter && !matchesTypeFilter(creature, effect.typeFilter)) {
    return false;
  }

  return true;
}

// ─── Layer 7a: Characteristic-Defining Abilities (CR 604.3) ───

/**
 * Evaluate a star formula like "*", "*+1", "1+*", "2+*" etc.
 * Star (*) is replaced by the count value.
 */
function evaluateStarFormula(
  powerStr: string | undefined,
  toughnessStr: string | undefined,
  starValue: number
): { power: number; toughness: number } {
  const evalOne = (formula: string | undefined): number => {
    if (!formula) return 0;
    // Replace * with the actual value
    const resolved = formula.replace(/\*/g, String(starValue));
    // Handle "+1", "1+3", etc. as simple arithmetic
    try {
      // Safe eval for simple expressions like "3+1", "0", "4"
      const parts = resolved.split('+').map(p => parseInt(p.trim(), 10) || 0);
      return parts.reduce((a, b) => a + b, 0);
    } catch {
      return starValue;
    }
  };
  return { power: evalOne(powerStr), toughness: evalOne(toughnessStr) };
}

/**
 * Calculate Characteristic-Defining Abilities (CR 604.3, Layer 7a).
 * CDA creatures have * in their power/toughness, e.g. Tarmogoyf is *\/*+1.
 * These are calculated FIRST in Layer 7, before any other modifications.
 */
function calculateCDA(
  creature: Permanent,
  state: GameState
): { power: number; toughness: number } | null {
  const oracleText = (creature.oracleText || '').toLowerCase();
  const power = creature.power; // string like "*" or "1+*"
  const toughness = creature.toughness; // string like "*" or "*+1"

  // Only process if power or toughness contains '*'
  if (!power?.includes('*') && !toughness?.includes('*')) return null;

  // Pattern 1: Card types in graveyards (Tarmogoyf, Deathrite Shaman)
  if (oracleText.includes('card type') && (oracleText.includes('graveyard') || oracleText.includes('graveyards'))) {
    const types = new Set<string>();
    for (const player of state.players) {
      for (const card of player.graveyard) {
        const tl = (card.typeLine || '').toLowerCase();
        if (tl.includes('creature')) types.add('creature');
        if (tl.includes('artifact')) types.add('artifact');
        if (tl.includes('enchantment')) types.add('enchantment');
        if (tl.includes('instant')) types.add('instant');
        if (tl.includes('sorcery')) types.add('sorcery');
        if (tl.includes('land')) types.add('land');
        if (tl.includes('planeswalker')) types.add('planeswalker');
        if (tl.includes('tribal')) types.add('tribal');
        if (tl.includes('kindred')) types.add('kindred');
        if (tl.includes('battle')) types.add('battle');
      }
    }
    return evaluateStarFormula(power, toughness, types.size);
  }

  // Pattern 2: Creature cards in graveyards (Nighthowler, Lhurgoyf, Boneyard Wurm)
  if ((oracleText.includes('creature card') && oracleText.includes('graveyard')) ||
      (oracleText.includes('creatures') && oracleText.includes('graveyard'))) {
    let count = 0;
    for (const player of state.players) {
      count += player.graveyard.filter(c => (c.typeLine || '').toLowerCase().includes('creature')).length;
    }
    return evaluateStarFormula(power, toughness, count);
  }

  // Pattern 3: Cards in opponents' graveyards (Consuming Aberration)
  if (oracleText.includes('opponent') && oracleText.includes('graveyard') && oracleText.includes('card')) {
    const opponent = creature.controller === 0 ? 1 : 0;
    const count = state.players[opponent].graveyard.length;
    return evaluateStarFormula(power, toughness, count);
  }

  // Pattern 4: Cards in hand (Maro, Kagemaro, Soramaro)
  if (oracleText.includes('cards in your hand') || oracleText.includes('cards in hand')) {
    const count = state.players[creature.controller].hand.length;
    return evaluateStarFormula(power, toughness, count);
  }

  // Pattern 5: Lands you control (Dakkon Blackblade, Multani)
  if (oracleText.includes('land') && oracleText.includes('you control') &&
      (power?.includes('*') || toughness?.includes('*'))) {
    const count = state.players[creature.controller].battlefield.filter(
      p => (p.typeLine || '').toLowerCase().includes('land')
    ).length;
    return evaluateStarFormula(power, toughness, count);
  }

  // Pattern 6: Enchantments you control (Drove of Elves variant)
  if (oracleText.includes('enchantment') && oracleText.includes('you control')) {
    const count = state.players[creature.controller].battlefield.filter(
      p => (p.typeLine || '').toLowerCase().includes('enchantment')
    ).length;
    return evaluateStarFormula(power, toughness, count);
  }

  // Pattern 7: Devotion (Nykthos creature aspects, Erebos, Thassa)
  if (oracleText.includes('devotion')) {
    // Count mana symbols of a color in mana costs of permanents you control
    const devotionColor = oracleText.includes('devotion to black') ? 'B' :
                          oracleText.includes('devotion to blue') ? 'U' :
                          oracleText.includes('devotion to red') ? 'R' :
                          oracleText.includes('devotion to green') ? 'G' :
                          oracleText.includes('devotion to white') ? 'W' : null;
    if (devotionColor) {
      let devotion = 0;
      for (const perm of state.players[creature.controller].battlefield) {
        const mc = perm.manaCost || '';
        const regex = new RegExp(`\\{${devotionColor}\\}`, 'gi');
        const matches = mc.match(regex);
        if (matches) devotion += matches.length;
      }
      return evaluateStarFormula(power, toughness, devotion);
    }
  }

  // Pattern 8: Instants and sorceries in graveyard (Crackling Drake variant)
  if ((oracleText.includes('instant') && oracleText.includes('sorcery')) &&
      (oracleText.includes('graveyard') || oracleText.includes('exile'))) {
    let count = 0;
    for (const player of state.players) {
      count += player.graveyard.filter(c => {
        const tl = (c.typeLine || '').toLowerCase();
        return tl.includes('instant') || tl.includes('sorcery');
      }).length;
    }
    return evaluateStarFormula(power, toughness, count);
  }

  // Pattern 9: Artifacts you control (Broodstar, Cranial Plating CDA)
  if (oracleText.includes('artifact') && oracleText.includes('you control') && !oracleText.includes('enchantment')) {
    const count = state.players[creature.controller].battlefield.filter(
      p => (p.typeLine || '').toLowerCase().includes('artifact')
    ).length;
    return evaluateStarFormula(power, toughness, count);
  }

  return null; // Not a recognized CDA — use base P/T
}

// ─── Main: Apply Continuous Effects ───

/**
 * Recalculate ALL creatures' currentPower and currentToughness from scratch,
 * considering the full bonus stack:
 *
 * 1. Base P/T (basePower, baseToughness)
 * 2. +1/+1 and -1/-1 counters
 * 3. Equipment and Aura bonuses (from attachments)
 * 4. Temporary P/T mods (temporaryPtMods — pump spells, etc.)
 * 5. Static ability bonuses from other permanents (Lords, Anthems)
 *
 * Returns a new GameState with updated creature stats. The original state
 * is not mutated (immutable pattern).
 *
 * This function should be called whenever the board state changes:
 * - A permanent enters or leaves the battlefield
 * - A counter is added or removed
 * - Equipment is attached or detached
 * - A static ability source changes controllers
 *
 * Performance: O(P * E) where P = total permanents, E = permanents with
 * static effects. In practice this is fast for typical board states
 * (usually < 50 permanents total).
 */
export function applyContinuousEffects(state: GameState): GameState {
  // Pre-parse all static effects from both battlefields (avoid re-parsing per creature)
  const allEffects: ParsedStaticEffect[] = [];
  // Pre-parse Layer 7b static "set P/T" effects (e.g. Humility: "creatures ... have base power and toughness 1/1")
  const allStaticSetPtEffects: ParsedStaticEffect[] = [];

  for (let p = 0; p < state.players.length; p++) {
    const player = state.players[p];
    for (const perm of player.battlefield) {
      if (!perm.oracleText) continue;
      const effects = parseStaticEffects(perm);
      allEffects.push(...effects);
      const setPtEffects = parseStaticSetPtEffects(perm);
      allStaticSetPtEffects.push(...setPtEffects);
    }
  }

  // Pre-parse static "loses all abilities" effects (Humility-type, Layer 6)
  const allStaticLoseAbilities: ParsedStaticLoseAbilities[] = [];
  for (let p = 0; p < state.players.length; p++) {
    const player = state.players[p];
    for (const perm of player.battlefield) {
      if (!perm.oracleText) continue;
      const loseAbilityEffects = parseStaticLoseAbilitiesEffects(perm);
      allStaticLoseAbilities.push(...loseAbilityEffects);
    }
  }

  // Build a lookup map of all permanents by ID across both battlefields
  // for fast attachment resolution
  const allPermsById = new Map<string, Permanent>();
  for (let p = 0; p < state.players.length; p++) {
    for (const perm of state.players[p].battlefield) {
      allPermsById.set(perm.id, perm);
    }
  }

  let stateChanged = false;
  const newPlayers = [...state.players];

  // === CR 613: Layers 1-6 (applied before P/T modifications) ===

  // --- Layer 1: Copy Effects ---
  // If a permanent has a copyEffect, its copiable values become those of the copied card.
  // This affects name, types, oracle text, P/T, colors, mana cost.
  for (let p = 0; p < state.players.length; p++) {
    const playerIdx = p;
    const player = newPlayers[playerIdx];
    for (let i = 0; i < player.battlefield.length; i++) {
      const perm = player.battlefield[i];
      if (perm.copyEffect) {
        const copy = perm.copyEffect;
        const updatedBf = [...player.battlefield];
        const newBasePower = copy.copiedPower ? parseInt(copy.copiedPower, 10) || 0 : perm.basePower;
        const newBaseToughness = copy.copiedToughness ? parseInt(copy.copiedToughness, 10) || 0 : perm.baseToughness;
        // Re-parse abilities from the copied oracle text so the copy gains the right triggered/static abilities
        // Permanent extends Card, so spread with overridden fields is valid as Card argument.
        const copiedAbilities = parseAbilities({
          ...perm,
          oracleText: copy.copiedOracleText,
          name: copy.copiedName,
        });
        updatedBf[i] = {
          ...perm,
          name: copy.copiedName,
          typeLine: copy.copiedTypeLine,
          // Preserve original oracle text before overwriting (for restoration if copy effect is removed)
          originalOracleText: perm.originalOracleText || perm.oracleText,
          oracleText: copy.copiedOracleText,
          colors: copy.copiedColors,
          manaCost: copy.copiedManaCost || perm.manaCost,
          basePower: newBasePower,
          baseToughness: newBaseToughness,
          currentPower: newBasePower,
          currentToughness: newBaseToughness,
          power: copy.copiedPower || perm.power,
          toughness: copy.copiedToughness || perm.toughness,
          abilities: copiedAbilities,
        };
        newPlayers[playerIdx] = { ...player, battlefield: updatedBf };
        stateChanged = true;
      }
    }
  }

  // --- Layer 2: Control-Changing Effects ---
  // Already handled at action execution time via temporaryControlChange field.
  // The controller field is set when the effect is applied and reverted at end of turn.
  // No additional processing needed here since it's done imperatively.

  // --- Layer 3: Text-Changing Effects (not implemented — extremely rare) ---

  // --- Layer 4: Type-Changing Effects ---
  // Apply type modifications (e.g., "creatures you control are Zombies in addition to their other types")
  for (let p = 0; p < state.players.length; p++) {
    const playerIdx = p;
    const player = newPlayers[playerIdx];
    let bfChanged = false;
    const updatedBf = [...player.battlefield];
    for (let i = 0; i < updatedBf.length; i++) {
      const perm = updatedBf[i];
      if (perm.typeChanges && perm.typeChanges.length > 0) {
        // Sort by timestamp, apply in order
        const sorted = [...perm.typeChanges].sort((a, b) => a.timestamp - b.timestamp);
        let typeLine = perm.typeLine;
        for (const tc of sorted) {
          if (tc.removedAllTypes) {
            // Remove all creature types (keep supertypes and card types)
            const parts = typeLine.split('\u2014');
            typeLine = parts[0].trim(); // keep everything before the dash
          }
          for (const addType of tc.addedTypes) {
            if (!typeLine.toLowerCase().includes(addType.toLowerCase())) {
              if (typeLine.includes('\u2014')) {
                typeLine = typeLine + ' ' + addType;
              } else {
                typeLine = typeLine + ' \u2014 ' + addType;
              }
            }
          }
        }
        if (typeLine !== perm.typeLine) {
          updatedBf[i] = { ...perm, typeLine };
          bfChanged = true;
        }
      }
    }
    if (bfChanged) {
      newPlayers[playerIdx] = { ...newPlayers[playerIdx], battlefield: updatedBf };
      stateChanged = true;
    }
  }

  // --- Layer 5: Color-Changing Effects ---
  for (let p = 0; p < state.players.length; p++) {
    const playerIdx = p;
    const player = newPlayers[playerIdx];
    let bfChanged = false;
    const updatedBf = [...player.battlefield];
    for (let i = 0; i < updatedBf.length; i++) {
      const perm = updatedBf[i];
      if (perm.colorChanges && perm.colorChanges.length > 0) {
        const sorted = [...perm.colorChanges].sort((a, b) => a.timestamp - b.timestamp);
        let colors = [...(perm.colors || [])];
        for (const cc of sorted) {
          if (cc.setColors) {
            colors = [...cc.setColors]; // Replace all colors
          }
          for (const addColor of cc.addedColors) {
            if (!colors.includes(addColor)) {
              colors.push(addColor);
            }
          }
        }
        const currentColors = perm.colors || [];
        if (colors.length !== currentColors.length || colors.some((c, idx) => c !== currentColors[idx])) {
          updatedBf[i] = { ...perm, colors };
          bfChanged = true;
        }
      }
    }
    if (bfChanged) {
      newPlayers[playerIdx] = { ...newPlayers[playerIdx], battlefield: updatedBf };
      stateChanged = true;
    }
  }

  // --- Layer 6: Ability Adding/Removing Effects ---
  // Apply static "loses all abilities" effects to matching creatures (e.g. Humility)
  // Each frame: first restore oracle text for creatures whose static source is gone,
  // then re-apply for creatures still under a static "lose abilities" effect.
  // This allows correct behavior when Humility enters/leaves the battlefield.
  for (let p = 0; p < state.players.length; p++) {
    const playerIdx = p;
    const player = newPlayers[playerIdx];
    let bfChanged = false;
    const updatedBf = [...player.battlefield];
    for (let i = 0; i < updatedBf.length; i++) {
      const creature = updatedBf[i];
      if (creature.basePower === undefined) continue; // Skip non-creatures

      // Check if any static source currently applies "loses all abilities" to this creature
      let staticSourceActive = false;
      for (const effect of allStaticLoseAbilities) {
        const matches = doesEffectApply(
          { ...effect, power: 0, toughness: 0, keywords: [] } as ParsedStaticEffect,
          creature, playerIdx
        );
        if (matches) { staticSourceActive = true; break; }
      }

      if (staticSourceActive && !creature.lostAllAbilities) {
        // Static source active AND creature doesn't have the flag yet — apply it
        updatedBf[i] = {
          ...creature,
          lostAllAbilities: { source: 'static', timestamp: 0 },
          originalOracleText: creature.originalOracleText || creature.oracleText,
          oracleText: '',
          temporaryKeywords: [],
          abilities: [],
        };
        bfChanged = true;
      } else if (!staticSourceActive && creature.lostAllAbilities?.source === 'static') {
        // Static source is GONE — restore original oracle text (static effect expired)
        updatedBf[i] = {
          ...creature,
          lostAllAbilities: undefined,
          oracleText: creature.originalOracleText ?? creature.oracleText,
          originalOracleText: undefined,
        };
        bfChanged = true;
      }
      // If creature.lostAllAbilities exists with source !== 'static', it was set by a targeted spell
      // (handled by turn-manager cleanup at EOT — don't touch it here)

      // Also handle per-permanent lostAllAbilities flag (set by targeted spells like Turn to Frog)
      const perm = updatedBf[i]; // Re-read in case we just modified it above
      if (perm.lostAllAbilities && perm.lostAllAbilities.source !== 'static' && perm.oracleText && perm.oracleText.length > 0) {
        updatedBf[i] = {
          ...perm,
          originalOracleText: perm.originalOracleText || perm.oracleText,
          oracleText: '',
          temporaryKeywords: [],
          abilities: [],
        };
        bfChanged = true;
      }
    }
    if (bfChanged) {
      newPlayers[playerIdx] = { ...newPlayers[playerIdx], battlefield: updatedBf };
      stateChanged = true;
    }
  }

  // === CR 613.4: Layer 7 — P/T Modifications ===

  for (let p = 0; p < state.players.length; p++) {
    const playerIdx = p;
    const player = newPlayers[playerIdx];
    let bfChanged = false;
    const newBattlefield = [...player.battlefield];

    for (let i = 0; i < newBattlefield.length; i++) {
      const creature = newBattlefield[i];

      // Only recalculate creatures (permanents with base P/T)
      if (creature.basePower === undefined || creature.baseToughness === undefined) {
        continue;
      }

      // === CR 613.4: Layer 7 Sublayers (applied in order) ===

      // --- Layer 7a: Characteristic-Defining Abilities (CR 604.3) ---
      // CDA creatures have * in their power/toughness that depends on game state.
      // Examples: Tarmogoyf (*/*+1 = card types in GY), Nighthowler (*/* = creatures in GY)
      let totalPower = creature.basePower;
      let totalToughness = creature.baseToughness;
      const cdaResult = calculateCDA(creature, state);
      if (cdaResult !== null) {
        totalPower = cdaResult.power;
        totalToughness = cdaResult.toughness;
      }

      // --- Layer 7b: Set P/T to specific value (e.g. "becomes a 3/3") ---
      // Sort set-effects by timestamp; the latest one wins (CR 613.7)
      const setEffects = creature.temporaryPtMods.filter(m => m.isSetEffect);
      if (setEffects.length > 0) {
        // Sort by timestamp (ascending), last one wins
        setEffects.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
        const latest = setEffects[setEffects.length - 1];
        totalPower = latest.power;
        totalToughness = latest.toughness;
      }

      // Static "set P/T" effects from permanents (e.g. Humility: "Creatures lose all abilities and have base power and toughness 1/1")
      // These are parsed from oracle text and applied as Layer 7b effects
      for (const effect of allStaticSetPtEffects) {
        if (doesEffectApply(effect, creature, playerIdx)) {
          totalPower = effect.power;
          totalToughness = effect.toughness;
        }
      }

      // --- Layer 7c: P/T modifications (+X/+Y from all sources) ---
      // Equipment and Aura bonuses
      for (const attachId of creature.attachments) {
        const attachment = allPermsById.get(attachId);
        if (!attachment) continue;

        if (isEquipment(attachment)) {
          const bonuses = getEquipmentBonuses(attachment);
          totalPower += bonuses.power;
          totalToughness += bonuses.toughness;
        } else if (isAura(attachment)) {
          const bonuses = getAuraBonuses(attachment);
          totalPower += bonuses.power;
          totalToughness += bonuses.toughness;
        }
      }

      // Temporary P/T mods (pump spells, "until end of turn" effects)
      // Skip set-effects here — they were already handled in Layer 7b above
      for (const mod of creature.temporaryPtMods) {
        if (!mod.isSetEffect) {
          totalPower += mod.power;
          totalToughness += mod.toughness;
        }
      }

      // Static ability bonuses (Lords, Anthems, opponent debuffs)
      for (const effect of allEffects) {
        if (doesEffectApply(effect, creature, playerIdx)) {
          totalPower += effect.power;
          totalToughness += effect.toughness;
        }
      }

      // --- Layer 7d: Counters (+1/+1, -1/-1) ---
      const plusCounters = creature.counters['+1/+1'] || 0;
      const minusCounters = creature.counters['-1/-1'] || 0;
      totalPower += plusCounters - minusCounters;
      totalToughness += plusCounters - minusCounters;

      // --- Layer 7e: Switching P/T (e.g. "switch power and toughness") ---
      // Check oracle text for self-switch effects (e.g., "switch its power and toughness")
      const oracleLower = (creature.oracleText || '').toLowerCase();
      if (oracleLower.includes('switch') && oracleLower.includes('power and toughness')) {
        const temp = totalPower;
        totalPower = totalToughness;
        totalToughness = temp;
      }
      // Check temporary keywords for switch effects (e.g., "target creature switches P/T until EOT")
      if (creature.temporaryKeywords?.some(tk => tk.keyword === 'switch-pt')) {
        const temp = totalPower;
        totalPower = totalToughness;
        totalToughness = temp;
      }

      // Only update if values actually changed (avoid unnecessary object creation)
      if (
        creature.currentPower !== totalPower ||
        creature.currentToughness !== totalToughness
      ) {
        newBattlefield[i] = {
          ...creature,
          currentPower: totalPower,
          currentToughness: totalToughness,
        };
        bfChanged = true;
      }
    }

    if (bfChanged) {
      stateChanged = true;
      newPlayers[playerIdx] = {
        ...player,
        battlefield: newBattlefield,
      };
    }
  }

  // If nothing changed, return original state reference (allows === equality checks)
  if (!stateChanged) return state;

  // Apply ring-bearer continuous effects (The Ring Tempts You, CR 701.52)
  const stateWithNewPlayers = { ...state, players: newPlayers };
  return applyRingBearerEffects(stateWithNewPlayers);
}

/**
 * Apply The Ring's passive bonuses to the ring-bearer (CR 701.52).
 * Level 1: menace
 * Level 2: menace, lifelink
 * Level 3: menace, lifelink, can only be blocked by legendary creatures
 * Level 4: menace, lifelink, legendary-blocker-only, drain 3 on attack (tracked via keyword)
 */
function applyRingBearerEffects(state: GameState): GameState {
  if (!state.theRing?.ringBearerId) return state;
  const { ringBearerId, ringTemptedCount, player } = state.theRing;
  if (ringTemptedCount === 0) return state;

  const playerState = state.players[player];
  const bearerIdx = playerState.battlefield.findIndex(p => p.id === ringBearerId);
  if (bearerIdx === -1) return state; // Bearer left battlefield

  const bearer = playerState.battlefield[bearerIdx];
  const keywords: string[] = [];

  // Level 1+: menace
  if (ringTemptedCount >= 1) keywords.push('menace');
  // Level 2+: lifelink
  if (ringTemptedCount >= 2) keywords.push('lifelink');
  // Level 3+: can only be blocked by legendary (tracked as a special keyword)
  if (ringTemptedCount >= 3) keywords.push('ring-bearer-level-3');
  // Level 4+: drain on attack (tracked as special keyword for combat system)
  if (ringTemptedCount >= 4) keywords.push('ring-bearer-level-4');

  // Strip any existing ring-bearer keywords, then add fresh ones
  const existingRingKeywords = (bearer.temporaryKeywords || []).filter(
    tk => !tk.source.startsWith('ring-bearer'),
  );
  const newRingKeywords = keywords.map(kw => ({
    keyword: kw,
    source: 'ring-bearer',
    turn: state.turn,
  }));

  const updatedBearer = {
    ...bearer,
    temporaryKeywords: [...existingRingKeywords, ...newRingKeywords],
  };

  // Only create new objects if something actually changed
  const existingRingKws = (bearer.temporaryKeywords || []).filter(
    tk => tk.source.startsWith('ring-bearer'),
  ).map(tk => tk.keyword);
  const same =
    existingRingKws.length === keywords.length &&
    keywords.every(kw => existingRingKws.includes(kw));
  if (same) return state; // No change needed

  const updatedBf = [...playerState.battlefield];
  updatedBf[bearerIdx] = updatedBearer;
  const players = [...state.players];
  players[player] = { ...playerState, battlefield: updatedBf };
  return { ...state, players };
}

/**
 * Get all keywords that are granted to a creature via continuous effects
 * (static abilities from other permanents on the battlefield).
 *
 * This is intended to be used alongside hasKeyword() in combat.ts to
 * check for keywords that the creature doesn't natively have but are
 * granted by lords/anthems.
 *
 * @param state - Current game state
 * @param creature - The creature to check
 * @param playerIdx - Controller of the creature
 * @returns Array of keyword strings granted by static effects
 */
export function getGrantedKeywords(
  state: GameState,
  creature: Permanent,
  playerIdx: number
): string[] {
  const bonuses = getStaticBonuses(state, creature, playerIdx);
  return bonuses.keywords;
}

/**
 * Check if a creature has a specific keyword, including keywords granted
 * by continuous effects from other permanents.
 *
 * This is a convenience wrapper that combines the permanent's native keywords
 * with any keywords granted by lords/anthems on the battlefield.
 *
 * @param state - Current game state
 * @param creature - The creature to check
 * @param playerIdx - Controller of the creature
 * @param keyword - The keyword to check for (e.g. "flying", "haste")
 * @returns true if the creature has the keyword from any source
 */
export function hasKeywordWithContinuous(
  state: GameState,
  creature: Permanent,
  playerIdx: number,
  keyword: string
): boolean {
  const lowerKw = keyword.toLowerCase();

  // Use the same keyword detection as combat.ts (Bug 10 fix: avoids false positives
  // from oracle text like "destroy target creature with flying" matching "flying")
  if (hasKeyword(creature, keyword)) {
    return true;
  }

  // Check keywords from continuous effects (lords/anthems)
  const granted = getGrantedKeywords(state, creature, playerIdx);
  return granted.some((kw) => kw === lowerKw);
}
