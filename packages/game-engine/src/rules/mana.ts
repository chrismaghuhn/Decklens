import type { Color } from '../types/card.ts';
import type { ManaPool, ManaCost, ManaPayment } from '../types/mana.ts';
import type { Permanent } from '../types/permanent.ts';
import type { PlayerState } from '../types/player.ts';

/** Create an empty mana pool */
export function emptyPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, S: 0, generic: 0 };
}

/** Get total mana available in a pool */
export function totalMana(pool: ManaPool): number {
  return pool.W + pool.U + pool.B + pool.R + pool.G + pool.C + pool.S + pool.generic;
}

/** Add mana of a specific type to a pool (returns new pool) */
export function addMana(
  pool: ManaPool,
  type: Color | 'C' | 'S' | 'generic',
  amount: number
): ManaPool {
  const newPool = { ...pool };
  if (type === 'generic') {
    newPool.generic += amount;
  } else {
    newPool[type] += amount;
  }
  return newPool;
}

/** Create an empty mana cost */
export function emptyManaCost(): ManaCost {
  return {
    W: 0, U: 0, B: 0, R: 0, G: 0, C: 0,
    generic: 0, X: 0, snow: 0,
    phyrexian: [], hybrid: [],
  };
}

/**
 * Parse a mana cost string into a ManaCost object.
 *
 * Supports:
 * - Generic: {0}, {1}, {2}, ..., {15}
 * - Colored: {W}, {U}, {B}, {R}, {G}
 * - Colorless: {C}
 * - Snow: {S}
 * - Variable: {X}
 * - Phyrexian: {W/P}, {U/P}, {B/P}, {R/P}, {G/P}
 * - Hybrid: {W/U}, {W/B}, {U/B}, {U/R}, {B/R}, {B/G}, {R/G}, {R/W}, {G/W}, {G/U}
 */
export function parseManaCost(costString: string): ManaCost {
  const cost = emptyManaCost();

  if (!costString) return cost;

  const symbols = costString.match(/\{[^}]+\}/g);
  if (!symbols) return cost;

  for (const symbol of symbols) {
    const inner = symbol.slice(1, -1);

    // Generic mana: {0}, {1}, {2}, ... {15}
    if (/^\d+$/.test(inner)) {
      cost.generic += parseInt(inner, 10);
      continue;
    }

    // Variable: {X}
    if (inner === 'X') {
      cost.X++;
      continue;
    }

    // Colored: {W}, {U}, {B}, {R}, {G}
    if (/^[WUBRG]$/.test(inner)) {
      cost[inner as Color]++;
      continue;
    }

    // Colorless: {C}
    if (inner === 'C') {
      cost.C++;
      continue;
    }

    // Snow: {S}
    if (inner === 'S') {
      cost.snow++;
      continue;
    }

    // Phyrexian: {W/P}, {U/P}, etc.
    const phyrexianMatch = inner.match(/^([WUBRG])\/P$/);
    if (phyrexianMatch) {
      cost.phyrexian.push({ color: phyrexianMatch[1] as Color, count: 1 });
      continue;
    }

    // Hybrid: {W/U}, {B/G}, etc.
    const hybridMatch = inner.match(/^([WUBRG])\/([WUBRG])$/);
    if (hybridMatch) {
      cost.hybrid.push({
        colors: [hybridMatch[1] as Color, hybridMatch[2] as Color],
        count: 1,
      });
      continue;
    }
  }

  return cost;
}

/** Calculate the total converted mana cost (mana value) */
export function calculateCMC(cost: ManaCost): number {
  let cmc = cost.W + cost.U + cost.B + cost.R + cost.G + cost.C + cost.generic + cost.snow;
  // Phyrexian costs count as their colored cost
  cmc += cost.phyrexian.reduce((sum, p) => sum + p.count, 0);
  // Hybrid costs count as the higher CMC option (which is 1 per symbol)
  cmc += cost.hybrid.reduce((sum, h) => sum + h.count, 0);
  // X is 0 for CMC purposes unless specified
  return cmc;
}

/**
 * Check if a mana pool can pay a given mana cost.
 *
 * For phyrexian mana: assumes pay with life if not enough colored mana (needs lifeTotal >= 2 per phyrexian).
 * For hybrid mana: checks if either color is available.
 * Does NOT consider X costs (X must be specified in the payment).
 */
export function canPayCost(
  pool: ManaPool,
  cost: ManaCost,
  lifeTotal: number
): boolean {
  // Work on a copy to simulate spending
  const available = { ...pool };
  let lifeAvailable = lifeTotal;

  // 1. Pay colored costs first (most constrained)
  const colors: Color[] = ['W', 'U', 'B', 'R', 'G'];
  for (const color of colors) {
    const needed = cost[color];
    if (needed > available[color]) return false;
    available[color] -= needed;
  }

  // 2. Pay colorless-specific costs
  if (cost.C > 0) {
    let colorlessAvailable = available.C;
    if (colorlessAvailable < cost.C) return false;
    available.C -= cost.C;
  }

  // 3. Pay snow costs (any snow mana)
  if (cost.snow > 0) {
    if (available.S < cost.snow) return false;
    available.S -= cost.snow;
  }

  // 4. Pay phyrexian costs (try color first, then life)
  for (const phyrexian of cost.phyrexian) {
    for (let i = 0; i < phyrexian.count; i++) {
      if (available[phyrexian.color] > 0) {
        available[phyrexian.color]--;
      } else if (lifeAvailable >= 2) {
        lifeAvailable -= 2;
      } else {
        return false;
      }
    }
  }

  // 5. Pay hybrid costs (try first color, then second)
  for (const hybrid of cost.hybrid) {
    for (let i = 0; i < hybrid.count; i++) {
      if (available[hybrid.colors[0]] > 0) {
        available[hybrid.colors[0]]--;
      } else if (available[hybrid.colors[1]] > 0) {
        available[hybrid.colors[1]]--;
      } else {
        return false;
      }
    }
  }

  // 6. Pay generic costs (any remaining mana)
  if (cost.generic > 0) {
    const remaining =
      available.W + available.U + available.B + available.R + available.G +
      available.C + available.S + available.generic;
    if (remaining < cost.generic) return false;
  }

  return true;
}

/**
 * Pay a mana cost from a pool using a specified payment.
 * Returns the updated mana pool after payment.
 * Assumes the payment is valid (use canPayCost first).
 */
export function payCost(
  pool: ManaPool,
  _cost: ManaCost,
  payment: ManaPayment
): ManaPool {
  const newPool = { ...pool };

  // Subtract paid mana
  const spent = payment.from;
  newPool.W -= spent.W;
  newPool.U -= spent.U;
  newPool.B -= spent.B;
  newPool.R -= spent.R;
  newPool.G -= spent.G;
  newPool.C -= spent.C;
  newPool.S -= spent.S;
  newPool.generic -= spent.generic;

  return newPool;
}

/**
 * Auto-pay a mana cost from a pool (greedy algorithm).
 * Pays colored costs first, then generic from least-constrained colors.
 * Returns the payment or null if cannot pay.
 */
export function autoPayCost(
  pool: ManaPool,
  cost: ManaCost,
  lifeTotal: number
): ManaPayment | null {
  if (!canPayCost(pool, cost, lifeTotal)) return null;

  const spent = emptyPool();
  const available = { ...pool };
  let lifePaid = 0;
  const hybridChoices: Color[] = [];

  // 1. Pay colored costs
  const colors: Color[] = ['W', 'U', 'B', 'R', 'G'];
  for (const color of colors) {
    const needed = cost[color];
    spent[color] = needed;
    available[color] -= needed;
  }

  // 2. Pay colorless
  if (cost.C > 0) {
    spent.C = cost.C;
    available.C -= cost.C;
  }

  // 3. Pay snow
  if (cost.snow > 0) {
    spent.S = cost.snow;
    available.S -= cost.snow;
  }

  // 4. Pay phyrexian (prefer mana over life)
  for (const phyrexian of cost.phyrexian) {
    for (let i = 0; i < phyrexian.count; i++) {
      if (available[phyrexian.color] > 0) {
        spent[phyrexian.color]++;
        available[phyrexian.color]--;
      } else {
        lifePaid += 2;
      }
    }
  }

  // 5. Pay hybrid (prefer first color)
  for (const hybrid of cost.hybrid) {
    for (let i = 0; i < hybrid.count; i++) {
      if (available[hybrid.colors[0]] > 0) {
        spent[hybrid.colors[0]]++;
        available[hybrid.colors[0]]--;
        hybridChoices.push(hybrid.colors[0]);
      } else if (available[hybrid.colors[1]] > 0) {
        spent[hybrid.colors[1]]++;
        available[hybrid.colors[1]]--;
        hybridChoices.push(hybrid.colors[1]);
      }
    }
  }

  // 6. Pay generic (use generic mana first, then least-constrained colors)
  let genericRemaining = cost.generic;

  // Use generic pool first
  if (available.generic > 0) {
    const fromGeneric = Math.min(genericRemaining, available.generic);
    spent.generic += fromGeneric;
    available.generic -= fromGeneric;
    genericRemaining -= fromGeneric;
  }

  // Use colorless mana
  if (genericRemaining > 0 && available.C > 0) {
    const fromC = Math.min(genericRemaining, available.C);
    spent.C += fromC;
    available.C -= fromC;
    genericRemaining -= fromC;
  }

  // Use snow mana
  if (genericRemaining > 0 && available.S > 0) {
    const fromS = Math.min(genericRemaining, available.S);
    spent.S += fromS;
    available.S -= fromS;
    genericRemaining -= fromS;
  }

  // Use colored mana (most available first to preserve flexibility)
  if (genericRemaining > 0) {
    const colorOrder = [...colors].sort((a, b) => available[b] - available[a]);
    for (const color of colorOrder) {
      if (genericRemaining <= 0) break;
      const fromColor = Math.min(genericRemaining, available[color]);
      spent[color] += fromColor;
      available[color] -= fromColor;
      genericRemaining -= fromColor;
    }
  }

  return {
    from: spent,
    phyrexianLife: lifePaid,
    hybridChoices,
    xValue: 0,
  };
}

/**
 * Determine what color of mana a land produces from its oracle text.
 * Returns the Color or 'C' for colorless, or null if unknown.
 */
function getLandManaColor(perm: Permanent): Color | 'C' | null {
  const text = (perm.oracleText ?? '').toLowerCase();
  const typeLine = perm.typeLine.toLowerCase();

  // Basic lands and typed lands
  if (typeLine.includes('forest') || text.includes('add {g}')) return 'G';
  if (typeLine.includes('island') || text.includes('add {u}')) return 'U';
  if (typeLine.includes('plains') || text.includes('add {w}')) return 'W';
  if (typeLine.includes('swamp') || text.includes('add {b}')) return 'B';
  if (typeLine.includes('mountain') || text.includes('add {r}')) return 'R';

  // "Add one mana of any color" — pick based on name or default to C
  if (text.includes('any color')) return 'C'; // treated as generic/colorless for auto-tap
  // "Add {C}{C}" (Sol Ring) or "Add {C}"
  if (text.includes('add {c}')) return 'C';

  return null;
}

/**
 * Auto-tap lands on a player's battlefield to produce enough mana to pay a cost.
 * Returns updated player state (with tapped lands + filled mana pool) and ManaPayment,
 * or null if not enough lands to pay.
 *
 * This is a simplified auto-tap: taps basics first for colored costs, then generics.
 */
export function autoTapLandsForCost(
  player: PlayerState,
  cost: ManaCost,
): { updatedPlayer: PlayerState; payment: ManaPayment } | null {
  // Gather untapped lands and mana-producing artifacts
  const untappedSources: { index: number; color: Color | 'C'; perm: Permanent }[] = [];

  for (let i = 0; i < player.battlefield.length; i++) {
    const perm = player.battlefield[i];
    if (perm.tapped) continue;

    const typeLine = perm.typeLine.toLowerCase();
    const oracleText = (perm.oracleText ?? '').toLowerCase();
    const isManaSource = typeLine.includes('land') || oracleText.includes('{t}: add');

    if (!isManaSource) continue;

    const manaColor = getLandManaColor(perm);
    if (manaColor !== null) {
      untappedSources.push({ index: i, color: manaColor, perm });
    }
  }

  // Build a virtual pool from all untapped sources
  const virtualPool = emptyPool();
  for (const src of untappedSources) {
    if (src.color === 'C') {
      // "Any color" lands and colorless — add to generic
      virtualPool.generic++;
    } else {
      virtualPool[src.color]++;
    }
  }

  // Check if we can pay at all
  if (!canPayCost(virtualPool, cost, player.life)) return null;

  // Determine payment from virtual pool
  const payment = autoPayCost(virtualPool, cost, player.life);
  if (!payment) return null;

  // Now tap exactly the lands needed
  const toTap = new Set<number>();
  const spent = { ...payment.from };

  // Helper: tap a source of a specific color
  const tapColor = (color: Color | 'C' | 'generic', needed: number) => {
    let remaining = needed;
    for (const src of untappedSources) {
      if (remaining <= 0) break;
      if (toTap.has(src.index)) continue;

      if (color === 'generic') {
        // Any untapped source works for generic
        toTap.add(src.index);
        remaining--;
      } else if (src.color === color) {
        toTap.add(src.index);
        remaining--;
      }
    }
  };

  // Tap for colored costs first
  const colors: Color[] = ['W', 'U', 'B', 'R', 'G'];
  for (const color of colors) {
    if (spent[color] > 0) tapColor(color, spent[color]);
  }

  // Tap for colorless
  if (spent.C > 0) tapColor('C', spent.C);

  // Tap for generic (from remaining spent that wasn't covered above)
  if (spent.generic > 0) tapColor('generic', spent.generic);

  // Also tap any remaining needed (colors used for generic payment)
  const totalSpent = spent.W + spent.U + spent.B + spent.R + spent.G + spent.C + spent.S + spent.generic;
  if (toTap.size < totalSpent) {
    // Need more taps for generic portion paid with colored mana
    let stillNeeded = totalSpent - toTap.size;
    for (const src of untappedSources) {
      if (stillNeeded <= 0) break;
      if (toTap.has(src.index)) continue;
      toTap.add(src.index);
      stillNeeded--;
    }
  }

  // Update battlefield (tap the lands) and build actual mana pool
  const newPool = { ...player.manaPool };
  const newBattlefield = player.battlefield.map((perm, i) => {
    if (toTap.has(i)) {
      // Add mana to pool from this source
      const src = untappedSources.find(s => s.index === i)!;
      if (src.color === 'C') {
        newPool.generic++;
      } else {
        newPool[src.color]++;
      }
      return { ...perm, tapped: true };
    }
    return perm;
  });

  // Now calculate actual payment from the real pool
  const actualPayment = autoPayCost(newPool, cost, player.life);
  if (!actualPayment) return null;

  return {
    updatedPlayer: {
      ...player,
      battlefield: newBattlefield,
      manaPool: newPool,
    },
    payment: actualPayment,
  };
}
