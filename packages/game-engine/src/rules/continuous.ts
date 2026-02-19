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
 * This module applies in Layer 7c (power/toughness modifications) and
 * Layer 6 (ability-adding effects). The full layer system is simplified
 * here since we don't track timestamps for dependency ordering — all
 * continuous effects are applied simultaneously from a clean base.
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
  sourceController: 0 | 1;
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
  playerIdx: 0 | 1
): StaticBonus {
  let power = 0;
  let toughness = 0;
  const keywords: string[] = [];

  // Gather all static effects from both players' battlefields
  for (let p = 0; p < 2; p++) {
    const player = state.players[p as 0 | 1];

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
  creatureController: 0 | 1
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

  for (let p = 0; p < 2; p++) {
    const player = state.players[p as 0 | 1];
    for (const perm of player.battlefield) {
      if (!perm.oracleText) continue;
      const effects = parseStaticEffects(perm);
      allEffects.push(...effects);
      const setPtEffects = parseStaticSetPtEffects(perm);
      allStaticSetPtEffects.push(...setPtEffects);
    }
  }

  // Build a lookup map of all permanents by ID across both battlefields
  // for fast attachment resolution
  const allPermsById = new Map<string, Permanent>();
  for (let p = 0; p < 2; p++) {
    for (const perm of state.players[p as 0 | 1].battlefield) {
      allPermsById.set(perm.id, perm);
    }
  }

  let stateChanged = false;
  const newPlayers = [...state.players] as [PlayerState, PlayerState];

  for (let p = 0; p < 2; p++) {
    const playerIdx = p as 0 | 1;
    const player = state.players[playerIdx];
    let bfChanged = false;
    const newBattlefield = [...player.battlefield];

    for (let i = 0; i < newBattlefield.length; i++) {
      const creature = newBattlefield[i];

      // Only recalculate creatures (permanents with base P/T)
      if (creature.basePower === undefined || creature.baseToughness === undefined) {
        continue;
      }

      // === CR 613.4: Layer 7 Sublayers (applied in order) ===

      // --- Layer 7a: Characteristic-Defining Abilities (e.g. Tarmogoyf */*+1) ---
      // For now, CDA creatures use their base P/T as-is (parsed from card data).
      // A future enhancement can dynamically calculate * values.
      let totalPower = creature.basePower;
      let totalToughness = creature.baseToughness;

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

  return {
    ...state,
    players: newPlayers,
  };
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
  playerIdx: 0 | 1
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
  playerIdx: 0 | 1,
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
