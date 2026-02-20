import type { GameState } from '../types/game-state.ts';
import type { Target } from '../types/action.ts';
import type { Permanent } from '../types/permanent.ts';
import { hasKeyword } from './combat.ts';

/**
 * Targeting System — Phase 6 Wave 1
 *
 * Parses oracle-text target descriptions into structured filters,
 * enumerates legal targets on the board, and validates previously-chosen
 * targets at resolution time.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface TargetFilter {
  zone?: 'battlefield' | 'graveyard' | 'hand' | 'library';
  controller?: 'you' | 'opponent' | 'any';
  cardType?: string[];        // ['creature'], ['artifact', 'enchantment']
  excludeType?: string[];     // ['land'] for "nonland permanent"
  power?: { op: 'leq' | 'geq' | 'eq'; value: number };
  toughness?: { op: 'leq' | 'geq' | 'eq'; value: number };
  cmc?: { op: 'leq' | 'geq' | 'eq'; value: number };
  color?: { includes?: string[]; excludes?: string[] };
  keyword?: { has?: string[]; hasNot?: string[] };
  other?: boolean;            // "another creature" (exclude source)
  nontoken?: boolean;
  tapped?: boolean;
  attacking?: boolean;
}

// ─── Color Mapping ───────────────────────────────────────────────────────

const COLOR_NAME_TO_CODE: Record<string, string> = {
  white: 'W',
  blue: 'U',
  black: 'B',
  red: 'R',
  green: 'G',
};

// ─── Parse Target Filter ─────────────────────────────────────────────────

/**
 * Parse an oracle-text target description into a structured TargetFilter.
 *
 * Returns `null` for patterns we deliberately don't handle (e.g. "target player")
 * or for text that doesn't match any known pattern.
 */
export function parseTargetFilter(text: string): TargetFilter | null {
  const t = text.toLowerCase().trim();

  // Player targeting is handled separately
  if (/^target player/.test(t) || t === 'target player') {
    return null;
  }

  const filter: TargetFilter = {};

  // Work on a mutable copy we can strip tokens from
  let remaining = t;

  // Strip leading "target " or "another "
  const isAnother = /^another\s+/.test(remaining);
  if (isAnother) {
    filter.other = true;
    remaining = remaining.replace(/^another\s+/, '');
  }
  remaining = remaining.replace(/^target\s+/, '');

  // ─── Controller suffix ─────────────────────────────────────────────────
  if (/\s+an?\s+opponent\s+controls$/.test(remaining)) {
    filter.controller = 'opponent';
    remaining = remaining.replace(/\s+an?\s+opponent\s+controls$/, '');
  } else if (/\s+you\s+control$/.test(remaining)) {
    filter.controller = 'you';
    remaining = remaining.replace(/\s+you\s+control$/, '');
  }

  // ─── Keyword modifiers: "with <keyword>" / "without <keyword>" ─────────
  const withKwMatch = remaining.match(/\s+with\s+(\w+)$/);
  if (withKwMatch) {
    const kw = withKwMatch[1];
    // Distinguish "with power ..." from "with flying"
    if (kw !== 'power' && kw !== 'toughness') {
      filter.keyword = { has: [kw] };
      remaining = remaining.replace(/\s+with\s+\w+$/, '');
    }
  }

  const withoutKwMatch = remaining.match(/\s+without\s+(\w+)$/);
  if (withoutKwMatch) {
    const kw = withoutKwMatch[1];
    filter.keyword = { hasNot: [kw] };
    remaining = remaining.replace(/\s+without\s+\w+$/, '');
  }

  // ─── Power / toughness comparison: "with power N or less" etc. ─────────
  const powerMatch = remaining.match(/\s+with\s+power\s+(\d+)\s+or\s+(less|more)$/);
  if (powerMatch) {
    const value = parseInt(powerMatch[1], 10);
    const op = powerMatch[2] === 'less' ? 'leq' : 'geq';
    filter.power = { op, value };
    remaining = remaining.replace(/\s+with\s+power\s+\d+\s+or\s+(?:less|more)$/, '');
  }

  const toughnessMatch = remaining.match(/\s+with\s+toughness\s+(\d+)\s+or\s+(less|more)$/);
  if (toughnessMatch) {
    const value = parseInt(toughnessMatch[1], 10);
    const op = toughnessMatch[2] === 'less' ? 'leq' : 'geq';
    filter.toughness = { op, value };
    remaining = remaining.replace(/\s+with\s+toughness\s+\d+\s+or\s+(?:less|more)$/, '');
  }

  // ─── Tapped / Attacking modifiers ──────────────────────────────────────
  if (/^tapped\s+/.test(remaining)) {
    filter.tapped = true;
    remaining = remaining.replace(/^tapped\s+/, '');
  }
  if (/^attacking\s+/.test(remaining)) {
    filter.attacking = true;
    remaining = remaining.replace(/^attacking\s+/, '');
  }

  // ─── Noncreature / Nonland / Non<color> prefix ─────────────────────────
  const nonTypeMatch = remaining.match(/^non(\w+)\s+permanent$/);
  if (nonTypeMatch) {
    filter.excludeType = [nonTypeMatch[1]];
    return filter;
  }

  // Non-color creature: "nonblack creature", "nonwhite creature"
  const nonColorCreatureMatch = remaining.match(/^non(\w+)\s+(\w+)$/);
  if (nonColorCreatureMatch) {
    const colorWord = nonColorCreatureMatch[1];
    const typeWord = nonColorCreatureMatch[2];
    if (COLOR_NAME_TO_CODE[colorWord]) {
      filter.color = { excludes: [COLOR_NAME_TO_CODE[colorWord]] };
      filter.cardType = [typeWord];
      return filter;
    }
  }

  // ─── "X or Y" compound types ───────────────────────────────────────────
  const orMatch = remaining.match(/^(\w+)\s+or\s+(\w+)$/);
  if (orMatch) {
    filter.cardType = [orMatch[1], orMatch[2]];
    return filter;
  }

  // ─── Single permanent type / "permanent" ───────────────────────────────
  const singleType = remaining.trim();
  if (singleType === 'permanent') {
    // "target permanent" — no cardType filter, matches everything on battlefield
    return filter;
  }

  if (singleType.length > 0) {
    filter.cardType = [singleType];
  }

  // If we ended up with an essentially empty filter and no useful data, return null
  if (
    !filter.cardType &&
    !filter.excludeType &&
    !filter.power &&
    !filter.toughness &&
    !filter.cmc &&
    !filter.color &&
    !filter.keyword &&
    !filter.tapped &&
    !filter.attacking &&
    !filter.other &&
    filter.controller === undefined
  ) {
    return null;
  }

  return filter;
}

// ─── Comparison Helper ───────────────────────────────────────────────────

function compare(actual: number, op: 'leq' | 'geq' | 'eq', value: number): boolean {
  switch (op) {
    case 'leq': return actual <= value;
    case 'geq': return actual >= value;
    case 'eq': return actual === value;
  }
}

// ─── Get Valid Targets ───────────────────────────────────────────────────

/**
 * Return all legal targets given a filter, the current game state,
 * the casting player, and optionally the source permanent ID
 * (used when `filter.other` is true to exclude the source).
 */
export function getValidTargets(
  state: GameState,
  controller: number,
  filter: TargetFilter,
  sourceId?: string,
): Target[] {
  const zone = filter.zone ?? 'battlefield';
  const targets: Target[] = [];

  // Determine which players' permanents to search
  const playerIndicesToCheck: number[] =
    filter.controller === 'you'
      ? [controller]
      : filter.controller === 'opponent'
        ? [controller === 0 ? 1 : 0]
        : [0, 1];

  if (zone === 'battlefield') {
    for (const pi of playerIndicesToCheck) {
      const battlefield = state.players[pi].battlefield;
      for (const perm of battlefield) {
        if (matchesPermanentFilter(perm, filter, sourceId, state)) {
          targets.push({ type: 'permanent', id: perm.id });
        }
      }
    }
  } else {
    // Non-battlefield zones use Card arrays; we check type line etc.
    for (const pi of playerIndicesToCheck) {
      const player = state.players[pi];
      const cards =
        zone === 'graveyard' ? player.graveyard :
        zone === 'hand' ? player.hand :
        zone === 'library' ? player.library :
        [];

      for (const card of cards) {
        if (matchesCardFilter(card, filter)) {
          targets.push({ type: 'card-in-zone', id: card.id, zone });
        }
      }
    }
  }

  return targets;
}

// ─── Validate Target ─────────────────────────────────────────────────────

/**
 * Check if a previously-chosen target is still valid at resolution time.
 *
 * If the permanent no longer exists on the battlefield, returns false.
 * Otherwise applies the same filters as getValidTargets.
 */
export function validateTarget(
  state: GameState,
  target: Target,
  filter: TargetFilter,
  sourceId?: string,
): boolean {
  if (target.type === 'player') {
    // Player targeting is not handled by TargetFilter
    const playerIndex = parseInt(target.id, 10);
    if (playerIndex !== 0 && playerIndex !== 1) return false;
    return state.players[playerIndex].life > 0 && !state.gameOver;
  }

  const zone = filter.zone ?? 'battlefield';

  if (zone === 'battlefield') {
    // Find the permanent on any player's battlefield
    for (const player of state.players) {
      const perm = player.battlefield.find(p => p.id === target.id);
      if (perm) {
        return matchesPermanentFilter(perm, filter, sourceId, state);
      }
    }
    // Permanent not found on battlefield
    return false;
  }

  // Non-battlefield zones
  for (const player of state.players) {
    const cards =
      zone === 'graveyard' ? player.graveyard :
      zone === 'hand' ? player.hand :
      zone === 'library' ? player.library :
      [];

    const card = cards.find(c => c.id === target.id);
    if (card) {
      return matchesCardFilter(card, filter);
    }
  }

  return false;
}

// ─── Internal Filter Helpers ─────────────────────────────────────────────

/**
 * Check whether a permanent on the battlefield matches all criteria
 * in the given TargetFilter.
 */
function matchesPermanentFilter(
  perm: Permanent,
  filter: TargetFilter,
  sourceId: string | undefined,
  state: GameState,
): boolean {
  const tl = perm.typeLine.toLowerCase();

  // ─── cardType: typeLine must include at least one of these
  if (filter.cardType) {
    const matches = filter.cardType.some(ct => tl.includes(ct.toLowerCase()));
    if (!matches) return false;
  }

  // ─── excludeType: typeLine must NOT include any of these
  if (filter.excludeType) {
    const excluded = filter.excludeType.some(et => tl.includes(et.toLowerCase()));
    if (excluded) return false;
  }

  // ─── power comparison
  if (filter.power && perm.currentPower !== undefined) {
    if (!compare(perm.currentPower, filter.power.op, filter.power.value)) return false;
  }
  // If power filter is set but perm has no power (not a creature), exclude it
  if (filter.power && perm.currentPower === undefined) return false;

  // ─── toughness comparison
  if (filter.toughness && perm.currentToughness !== undefined) {
    if (!compare(perm.currentToughness, filter.toughness.op, filter.toughness.value)) return false;
  }
  if (filter.toughness && perm.currentToughness === undefined) return false;

  // ─── cmc comparison
  if (filter.cmc) {
    if (!compare(perm.cmc, filter.cmc.op, filter.cmc.value)) return false;
  }

  // ─── color includes/excludes
  if (filter.color) {
    const permColors = perm.colors || [];
    if (filter.color.includes) {
      const hasAll = filter.color.includes.every(c => permColors.includes(c as any));
      if (!hasAll) return false;
    }
    if (filter.color.excludes) {
      const hasExcluded = filter.color.excludes.some(c => permColors.includes(c as any));
      if (hasExcluded) return false;
    }
  }

  // ─── keyword has/hasNot
  if (filter.keyword) {
    if (filter.keyword.has) {
      const hasAll = filter.keyword.has.every(kw => hasKeyword(perm, kw));
      if (!hasAll) return false;
    }
    if (filter.keyword.hasNot) {
      const hasAny = filter.keyword.hasNot.some(kw => hasKeyword(perm, kw));
      if (hasAny) return false;
    }
  }

  // ─── other: exclude the source permanent
  if (filter.other && sourceId && perm.id === sourceId) {
    return false;
  }

  // ─── nontoken
  if (filter.nontoken && (perm as any).isToken) {
    return false;
  }

  // ─── tapped
  if (filter.tapped === true && !perm.tapped) {
    return false;
  }

  // ─── attacking
  if (filter.attacking === true) {
    // Check both perm.attacking flag and the combat attackers list
    const isAttacking = perm.attacking ||
      (state.combat?.attackers.some(a => a.permanentId === perm.id) ?? false);
    if (!isAttacking) return false;
  }

  // ─── Phased-out permanents are treated as though they don't exist
  if (perm.phasedOut) return false;

  return true;
}

/**
 * Lightweight filter check for cards in non-battlefield zones (graveyard, hand, library).
 */
function matchesCardFilter(
  card: { typeLine: string; colors?: string[]; cmc: number },
  filter: TargetFilter,
): boolean {
  const tl = card.typeLine.toLowerCase();

  if (filter.cardType) {
    const matches = filter.cardType.some(ct => tl.includes(ct.toLowerCase()));
    if (!matches) return false;
  }

  if (filter.excludeType) {
    const excluded = filter.excludeType.some(et => tl.includes(et.toLowerCase()));
    if (excluded) return false;
  }

  if (filter.cmc) {
    if (!compare(card.cmc, filter.cmc.op, filter.cmc.value)) return false;
  }

  if (filter.color) {
    const cardColors = card.colors || [];
    if (filter.color.includes) {
      const hasAll = filter.color.includes.every(c => cardColors.includes(c));
      if (!hasAll) return false;
    }
    if (filter.color.excludes) {
      const hasExcluded = filter.color.excludes.some(c => cardColors.includes(c));
      if (hasExcluded) return false;
    }
  }

  return true;
}
