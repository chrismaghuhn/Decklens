/**
 * Ability Parser
 *
 * Parses oracle text from cards to extract structured abilities:
 * - Mana abilities: "{T}: Add {G}", "{T}: Add {C}{C}" (Sol Ring), etc.
 * - Activated abilities: "{cost}: {effect}"
 * - Static keyword abilities: flying, lifelink, etc.
 *
 * Used by cardToPermanent() to populate the abilities[] array on permanents.
 */

import type { Ability } from '../types/permanent.ts';
import type { Card } from '../types/card.ts';
import type { Color } from '../types/card.ts';

let abilityIdCounter = 0;

export function resetAbilityIdCounter(): void {
  abilityIdCounter = 0;
}

function nextAbilityId(): string {
  return `ability_${abilityIdCounter++}`;
}

// ─── Mana Color Mapping ───

/** Maps basic land type names to their mana colors */
const BASIC_LAND_MANA: Record<string, Color> = {
  plains: 'W',
  island: 'U',
  swamp: 'B',
  mountain: 'R',
  forest: 'G',
};

// ─── Mana Ability Patterns ───

interface ManaAbilityMatch {
  produces: string; // e.g. "G", "CC", "any", "WU" (choice)
  text: string;     // original oracle text segment
  requiresSacrifice?: boolean; // true for Treasure tokens, Lotus Petal, etc.
}

/**
 * Detect mana production from oracle text patterns.
 * Returns array of mana ability definitions found.
 */
function detectManaAbilities(oracleText: string, typeLine: string): ManaAbilityMatch[] {
  const results: ManaAbilityMatch[] = [];
  const text = oracleText.toLowerCase();
  const tl = typeLine.toLowerCase();

  // Pattern 1: Basic lands (have intrinsic mana abilities based on type)
  for (const [landType, color] of Object.entries(BASIC_LAND_MANA)) {
    if (tl.includes(landType)) {
      results.push({
        produces: color,
        text: `{T}: Add {${color}}`,
      });
    }
  }

  // If basic land type already handled and no oracle text, return early
  if (results.length > 0 && !text.includes('add')) {
    return results;
  }

  // Pattern 2: Explicit "{T}: Add {X}" patterns in oracle text
  // Matches: "{T}: Add {G}", "{T}: Add {C}{C}", "{T}: Add {W}{U}{B}{R}{G}"
  const tapAddPattern = /\{t\}:\s*add\s+((?:\{[wubrgc]\})+)/gi;
  let match: RegExpExecArray | null;
  const seen = new Set<string>();

  while ((match = tapAddPattern.exec(oracleText)) !== null) {
    const manaSymbols = match[1];
    const colors = (manaSymbols.match(/\{([wubrgc])\}/gi) || [])
      .map(s => s.replace(/[{}]/g, '').toUpperCase());
    const produces = colors.join('');
    if (produces && !seen.has(produces)) {
      seen.add(produces);
      results.push({ produces, text: match[0] });
    }
  }

  // Pattern 3: "{T}: Add one mana of any color"
  if (/\{t\}:\s*add\s+one\s+mana\s+of\s+any\s+color/i.test(oracleText)) {
    if (!seen.has('any')) {
      seen.add('any');
      results.push({ produces: 'any', text: '{T}: Add one mana of any color' });
    }
  }

  // Pattern 4: "{T}: Add {W} or {U}" (dual lands like Hallowed Fountain)
  const orPattern = /\{t\}:\s*add\s+\{([wubrg])\}\s+or\s+\{([wubrg])\}/gi;
  while ((match = orPattern.exec(oracleText)) !== null) {
    const c1 = match[1].toUpperCase();
    const c2 = match[2].toUpperCase();
    const key = `${c1}or${c2}`;
    if (!seen.has(key)) {
      seen.add(key);
      // Represent as choice — each color is a separate ability
      results.push({ produces: c1, text: `{T}: Add {${c1}}` });
      results.push({ produces: c2, text: `{T}: Add {${c2}}` });
    }
  }

  // Pattern 5: "{T}: Add {C}" (Wastes, Eldrazi lands)
  if (/\{t\}:\s*add\s+\{c\}/i.test(oracleText) && !seen.has('C')) {
    seen.add('C');
    results.push({ produces: 'C', text: '{T}: Add {C}' });
  }

  // Pattern 6: Mana dorks — "add one mana of any type" or similar (without {T}: prefix)
  // e.g. "Tap: Add one mana of any color" or creature abilities
  if (/add\s+one\s+mana\s+of\s+any\s+(color|type)/i.test(oracleText) && !seen.has('any')) {
    seen.add('any');
    results.push({ produces: 'any', text: 'Add one mana of any color' });
  }

  // Pattern 7: "{T}, Sacrifice this/~: Add [mana]" (Treasure tokens, Lotus Petal, Chromatic Sphere)
  const tapSacManaPattern = /\{t\},?\s*sacrifice\s+(?:this\s+(?:artifact|creature|permanent)|~)[^:]*:\s*add\s+(one\s+mana\s+of\s+any\s+(?:color|type)|(?:\{[wubrgc]\}\s*)+)/gi;
  let tapSacMatch: RegExpExecArray | null;
  while ((tapSacMatch = tapSacManaPattern.exec(oracleText)) !== null) {
    const manaText = tapSacMatch[1].toLowerCase();
    if (/any\s+(?:color|type)/i.test(manaText)) {
      if (!seen.has('any-sac')) {
        seen.add('any-sac');
        results.push({ produces: 'any', text: tapSacMatch[0], requiresSacrifice: true });
      }
    } else {
      const colors = (manaText.match(/\{([wubrgc])\}/gi) || []).map(s => s.replace(/[{}]/g, '').toUpperCase());
      const key = colors.join('') + '-sac';
      if (!seen.has(key)) {
        seen.add(key);
        results.push({ produces: colors.join(''), text: tapSacMatch[0], requiresSacrifice: true });
      }
    }
  }

  return results;
}

// ─── Activated Ability Patterns ───

interface ActivatedAbilityMatch {
  cost: string;
  effect: string;
  isInstantSpeed: boolean;
}

/**
 * Detect activated abilities from oracle text.
 * Format: "Cost: Effect"
 */
function detectActivatedAbilities(oracleText: string): ActivatedAbilityMatch[] {
  const results: ActivatedAbilityMatch[] = [];

  // Split oracle text by newlines (each paragraph is potentially a different ability)
  const paragraphs = oracleText.split('\n').map(p => p.trim()).filter(Boolean);

  for (const paragraph of paragraphs) {
    // Skip if it's a triggered ability (starts with When/Whenever/At)
    if (/^(when(ever)?|at)\s/i.test(paragraph)) continue;
    // Skip if it's a keyword ability line (single word or comma-separated keywords)
    if (/^[a-z]+(,\s*[a-z]+)*$/i.test(paragraph)) continue;

    // Look for "Cost: Effect" pattern
    // Cost can include {T}, {N}, mana symbols, "sacrifice", "pay N life", "discard"
    const colonIdx = paragraph.indexOf(':');
    if (colonIdx < 1) continue;

    const costPart = paragraph.slice(0, colonIdx).trim();
    const effectPart = paragraph.slice(colonIdx + 1).trim();

    // Validate that cost part looks like a cost (has mana symbols, {T}, or action words)
    const hasCostIndicator = /\{[0-9wubrgctxs/]+\}|sacrifice|discard|pay|remove|exile|tap/i.test(costPart);
    if (!hasCostIndicator) continue;

    // Skip mana abilities (already handled above)
    if (/^add\s+/i.test(effectPart) && /mana|{[wubrgc]}/i.test(effectPart)) continue;

    // Activated abilities are instant-speed by default (unless sorcery-speed is specified)
    const isInstantSpeed = !/activate (this ability |only )?(as a sorcery|during your (main )?turn)/i.test(paragraph);

    results.push({
      cost: costPart,
      effect: effectPart,
      isInstantSpeed,
    });
  }

  return results;
}

// ─── Planeswalker Loyalty Abilities ───

interface LoyaltyAbilityMatch {
  cost: string;    // e.g. "+1", "-2", "0", "-7"
  loyaltyCost: number; // numeric value: +1, -2, 0, -7
  effect: string;
  text: string;    // full ability text for display
}

/**
 * Detect planeswalker loyalty abilities from oracle text.
 * Format: "+X: Effect", "−X: Effect", "0: Effect"
 * The cost is in loyalty counters (+ adds, - removes, 0 is free).
 */
function detectLoyaltyAbilities(oracleText: string, typeLine: string): LoyaltyAbilityMatch[] {
  if (!typeLine.toLowerCase().includes('planeswalker')) return [];

  const results: LoyaltyAbilityMatch[] = [];
  const paragraphs = oracleText.split('\n').map(p => p.trim()).filter(Boolean);

  for (const paragraph of paragraphs) {
    // Match loyalty costs: +N, −N, -N, 0 at start of line followed by colon
    // Unicode minus (−) and ASCII minus (-) both accepted
    const loyaltyMatch = paragraph.match(/^([+\u2212-]?\d+)\s*:\s*(.+)/);
    if (!loyaltyMatch) continue;

    const costStr = loyaltyMatch[1];
    const effect = loyaltyMatch[2].trim();

    // Parse the loyalty cost (handle both − and -)
    let loyaltyCost: number;
    if (costStr.startsWith('+')) {
      loyaltyCost = parseInt(costStr.slice(1));
    } else if (costStr.startsWith('\u2212') || costStr.startsWith('-')) {
      loyaltyCost = -parseInt(costStr.slice(1));
    } else {
      loyaltyCost = parseInt(costStr);
    }

    const displayCost = loyaltyCost >= 0 ? `+${loyaltyCost}` : `${loyaltyCost}`;

    results.push({
      cost: displayCost,
      loyaltyCost,
      effect,
      text: `[${displayCost}]: ${effect}`,
    });
  }

  return results;
}

/**
 * Parse the loyalty cost from an ability's cost string.
 * Returns the numeric loyalty cost or null if not a loyalty ability.
 */
export function parseLoyaltyCost(cost: string): number | null {
  // Match [+N], [-N], [0] patterns
  const match = cost.match(/^([+\u2212-]?\d+)$/);
  if (!match) return null;

  const costStr = match[1];
  if (costStr.startsWith('+')) return parseInt(costStr.slice(1));
  if (costStr.startsWith('\u2212') || costStr.startsWith('-')) return -parseInt(costStr.slice(1));
  return parseInt(costStr);
}

// ─── Main Parser ───

/**
 * Parse all abilities from a card's oracle text.
 * Returns an array of structured Ability objects.
 */
export function parseAbilities(card: Card): Ability[] {
  const abilities: Ability[] = [];
  const oracleText = card.oracleText || '';
  const typeLine = card.typeLine || '';

  if (!oracleText && !typeLine) return abilities;

  // 1. Mana abilities
  const manaAbilities = detectManaAbilities(oracleText, typeLine);
  for (const ma of manaAbilities) {
    abilities.push({
      id: nextAbilityId(),
      type: 'mana',
      cost: ma.requiresSacrifice ? '{T}, Sacrifice ~' : '{T}',
      text: ma.text,
      instantSpeed: true, // Mana abilities don't use the stack
    });
  }

  // 2. Planeswalker loyalty abilities (before generic activated to avoid conflicts)
  const loyaltyAbilities = detectLoyaltyAbilities(oracleText, typeLine);
  for (const la of loyaltyAbilities) {
    abilities.push({
      id: nextAbilityId(),
      type: 'activated',
      cost: la.cost,
      text: la.text,
      instantSpeed: false, // Loyalty abilities are sorcery speed
    });
  }

  // 2b. Activated abilities (skip if planeswalker — loyalty abilities already handled)
  if (!typeLine.toLowerCase().includes('planeswalker')) {
    const activatedAbilities = detectActivatedAbilities(oracleText);
    for (const aa of activatedAbilities) {
      abilities.push({
        id: nextAbilityId(),
        type: 'activated',
        cost: aa.cost,
        text: `${aa.cost}: ${aa.effect}`,
        instantSpeed: aa.isInstantSpeed,
      });
    }
  }

  // 3. Static keyword abilities (flying, lifelink, etc.)
  // These are listed as single words or comma-separated at the start of oracle text
  const keywordLine = oracleText.split('\n')[0] || '';
  const keywordPattern = /^((?:flying|first strike|double strike|deathtouch|hexproof|indestructible|lifelink|menace|reach|trample|vigilance|haste|defender|flash|ward|protection\b[^,\n]*?)(?:,\s*(?:flying|first strike|double strike|deathtouch|hexproof|indestructible|lifelink|menace|reach|trample|vigilance|haste|defender|flash|ward|protection\b[^,\n]*?))*)/i;
  const kwMatch = keywordPattern.exec(keywordLine);
  if (kwMatch) {
    const keywords = kwMatch[1].split(',').map(k => k.trim()).filter(Boolean);
    for (const kw of keywords) {
      abilities.push({
        id: nextAbilityId(),
        type: 'static',
        text: kw,
        instantSpeed: false,
      });
    }
  }

  return abilities;
}

/**
 * Get the mana colors a permanent can produce.
 * Returns an array of color strings (W, U, B, R, G, C) or 'any'.
 */
export function getManaProduction(card: Card): string[] {
  const manaAbilities = detectManaAbilities(card.oracleText || '', card.typeLine || '');
  const colors: string[] = [];
  for (const ma of manaAbilities) {
    if (ma.produces === 'any') {
      return ['W', 'U', 'B', 'R', 'G']; // any color = all 5
    }
    // Each character in produces is a separate color
    for (const c of ma.produces) {
      if (!colors.includes(c)) colors.push(c);
    }
  }
  return colors;
}

/**
 * Check if a permanent has a mana ability (can be tapped for mana).
 */
export function hasManaAbility(abilities: Ability[]): boolean {
  return abilities.some(a => a.type === 'mana');
}
