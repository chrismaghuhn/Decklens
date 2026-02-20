/**
 * Universal Cost Parser for MTG Activated Abilities
 *
 * Parses cost strings from Oracle text into structured AbilityCost objects.
 * Supports: mana, tap, sacrifice (self/type), pay life, discard, exile from GY,
 * remove counters, Phyrexian mana.
 */

import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import type { Card } from '../types/card.ts';
import {
  canPayCost as canPayManaCost,
  parseManaCost,
  autoTapLandsForCost,
  autoPayCost,
  payCost as payManaCost,
} from './mana.ts';

export interface AbilityCost {
  mana?: string;
  tap?: boolean;
  untap?: boolean;
  sacrificeSelf?: boolean;
  sacrificeType?: string;
  sacrificeCount?: number;
  payLife?: number;
  discardCount?: number;
  discardType?: string;
  exileFromGY?: number;
  removeCounters?: { type: string; count: number };
  loyalty?: number;
  phyrexianMana?: string;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

function parseNumber(s: string): number {
  const lower = s.toLowerCase().trim();
  return NUMBER_WORDS[lower] ?? (parseInt(lower, 10) || 1);
}

/**
 * Parse a cost string into a structured AbilityCost.
 * Examples:
 *   "{T}" -> { tap: true }
 *   "{2}{B}, {T}" -> { mana: "{2}{B}", tap: true }
 *   "{T}, Sacrifice ~" -> { tap: true, sacrificeSelf: true }
 *   "Sacrifice a creature" -> { sacrificeType: "creature", sacrificeCount: 1 }
 *   "Pay 3 life" -> { payLife: 3 }
 *   "{1}{B}, {T}, Sacrifice a creature" -> { mana: "{1}{B}", tap: true, sacrificeType: "creature", sacrificeCount: 1 }
 */
export function parseCost(costString: string): AbilityCost {
  const cost: AbilityCost = {};
  if (!costString || !costString.trim()) return cost;

  // Normalize: split by comma, process each segment
  const segments = costString.split(',').map((s) => s.trim());

  for (const seg of segments) {
    // {T} -- tap
    if (/\{t\}/i.test(seg)) cost.tap = true;
    // {Q} -- untap
    if (/\{q\}/i.test(seg)) cost.untap = true;

    // Sacrifice self: "Sacrifice ~" or "Sacrifice this" or "Sacrifice CARDNAME"
    if (
      /sacrifice\s+(~|this\s+(creature|permanent|artifact)|CARDNAME)/i.test(seg)
    ) {
      cost.sacrificeSelf = true;
    }
    // Sacrifice type: "Sacrifice a/an/two creature(s)"
    else if (
      /sacrifice\s+(a|an|one|two|three|four|five|\d+)\s+(\w+)/i.test(seg)
    ) {
      const m = seg.match(
        /sacrifice\s+(a|an|one|two|three|four|five|\d+)\s+(\w+)/i,
      );
      if (m) {
        cost.sacrificeCount = parseNumber(m[1]);
        cost.sacrificeType = m[2].replace(/s$/, '').toLowerCase();
      }
    }

    // Pay life: "Pay N life"
    const lifeMatch = seg.match(/pay\s+(\d+)\s+life/i);
    if (lifeMatch) cost.payLife = parseInt(lifeMatch[1], 10);

    // Discard: "Discard a/N card(s)"
    const discardMatch = seg.match(
      /discard\s+(a|an|one|two|three|\d+)\s+(\w+)/i,
    );
    if (discardMatch) {
      cost.discardCount = parseNumber(discardMatch[1]);
      const type = discardMatch[2].replace(/s$/, '').toLowerCase();
      if (type !== 'card') cost.discardType = type;
    }

    // Exile from graveyard: "Exile N cards from your graveyard"
    const exileMatch = seg.match(
      /exile\s+(a|an|one|two|three|four|five|\d+)\s+cards?\s+from\s+your\s+graveyard/i,
    );
    if (exileMatch) cost.exileFromGY = parseNumber(exileMatch[1]);

    // Remove counters: "Remove a +1/+1 counter from ~"
    const counterMatch = seg.match(
      /remove\s+(a|an|one|two|three|\d+)\s+([+\-\d/]+)\s+counter/i,
    );
    if (counterMatch) {
      cost.removeCounters = {
        count: parseNumber(counterMatch[1]),
        type: counterMatch[2],
      };
    }

    // Phyrexian mana: {W/P}, {U/P}, etc.
    const phyrexMatch = seg.match(/\{[WUBRG]\/P\}/i);
    if (phyrexMatch) cost.phyrexianMana = phyrexMatch[0].toUpperCase();

    // Mana symbols: {N}, {W}, {U}, {B}, {R}, {G}, {C}, {X}, {S}
    // Exclude {T} and {Q} which are tap/untap
    const manaSymbols = seg.match(/\{[0-9WUBRGCXS]+\}/gi);
    if (manaSymbols) {
      const filtered = manaSymbols.filter((s) => !/^\{[TQ]\}$/i.test(s));
      if (filtered.length > 0) {
        cost.mana = cost.mana
          ? cost.mana + filtered.join('')
          : filtered.join('');
      }
    }
  }

  return cost;
}

/**
 * Check whether a player can afford an ability cost.
 */
export function canPayAbilityCost(
  state: GameState,
  player: number,
  permanentId: string,
  cost: AbilityCost,
): boolean {
  const ps = state.players[player];

  // Tap: permanent must be untapped (and not summoning sick for creatures)
  if (cost.tap) {
    const perm = ps.battlefield.find((p) => p.id === permanentId);
    if (!perm || perm.tapped) return false;
    // Summoning sickness blocks tap abilities on creatures (not artifacts/lands/etc.)
    if (
      perm.summoningSick &&
      perm.currentPower !== undefined &&
      !perm.typeLine.toLowerCase().includes('artifact') &&
      !perm.typeLine.toLowerCase().includes('land')
    ) {
      // But creatures with haste can still tap
      const hasHaste =
        (perm.oracleText || '').toLowerCase().includes('haste') ||
        perm.temporaryKeywords?.some((tk) => tk.keyword === 'haste');
      if (!hasHaste) return false;
    }
  }

  // Mana: can the player pay? (check pool first, then auto-tap)
  if (cost.mana) {
    const manaCost = parseManaCost(cost.mana);
    if (!canPayManaCost(ps.manaPool, manaCost, ps.life)) {
      const tapResult = autoTapLandsForCost(ps, manaCost);
      if (!tapResult) return false;
    }
  }

  // Sacrifice self: permanent must be on battlefield
  if (cost.sacrificeSelf) {
    if (!ps.battlefield.some((p) => p.id === permanentId)) return false;
  }

  // Sacrifice type: enough matching permanents (excluding self if also sacrificing self)
  if (cost.sacrificeType && cost.sacrificeCount) {
    const matching = ps.battlefield.filter(
      (p) =>
        p.typeLine.toLowerCase().includes(cost.sacrificeType!) &&
        (!cost.sacrificeSelf || p.id !== permanentId),
    );
    if (matching.length < cost.sacrificeCount) return false;
  }

  // Pay life: must have enough life
  if (cost.payLife !== undefined && ps.life < cost.payLife) return false;

  // Discard: must have enough cards in hand
  if (cost.discardCount !== undefined && ps.hand.length < cost.discardCount)
    return false;

  // Exile from graveyard: must have enough cards in GY
  if (cost.exileFromGY !== undefined && ps.graveyard.length < cost.exileFromGY)
    return false;

  // Remove counters: permanent must have enough counters of that type
  if (cost.removeCounters) {
    const perm = ps.battlefield.find((p) => p.id === permanentId);
    if (!perm) return false;
    const available = perm.counters[cost.removeCounters.type] || 0;
    if (available < cost.removeCounters.count) return false;
  }

  return true;
}

/** Helper: convert a Permanent back to a Card for zone changes */
function permanentToCard(perm: Permanent): Card {
  return {
    id: perm.id,
    oracleId: perm.oracleId,
    name: perm.name,
    manaCost: perm.manaCost,
    cmc: perm.cmc,
    typeLine: perm.typeLine,
    oracleText: perm.oracleText,
    power: perm.power,
    toughness: perm.toughness,
    loyalty: perm.loyalty,
    colors: perm.colors,
    colorIdentity: perm.colorIdentity,
    rarity: perm.rarity,
    tags: perm.tags,
    imageUrl: perm.imageUrl,
    owner: perm.owner,
  };
}

/**
 * Pay an ability cost. Modifies game state to reflect payment.
 * Assumes canPayAbilityCost() already returned true.
 */
export function payAbilityCost(
  state: GameState,
  player: number,
  permanentId: string,
  cost: AbilityCost,
): GameState {
  let ps = { ...state.players[player] };
  let bf = [...ps.battlefield];
  const logMessages: string[] = [];

  // 1. Tap
  if (cost.tap) {
    const idx = bf.findIndex((p) => p.id === permanentId);
    if (idx !== -1) {
      bf[idx] = { ...bf[idx], tapped: true };
    }
  }

  // 2. Remove counters (before sacrifice so the perm still exists)
  if (cost.removeCounters) {
    const idx = bf.findIndex((p) => p.id === permanentId);
    if (idx !== -1) {
      const counters = { ...bf[idx].counters };
      counters[cost.removeCounters.type] = Math.max(
        0,
        (counters[cost.removeCounters.type] || 0) - cost.removeCounters.count,
      );
      bf[idx] = { ...bf[idx], counters };
      logMessages.push(
        `Removes ${cost.removeCounters.count} ${cost.removeCounters.type} counter(s).`,
      );
    }
  }

  // 3. Sacrifice self
  if (cost.sacrificeSelf) {
    const permIdx = bf.findIndex((p) => p.id === permanentId);
    if (permIdx !== -1) {
      const perm = bf[permIdx];
      bf = bf.filter((p) => p.id !== permanentId);
      ps = { ...ps, graveyard: [...ps.graveyard, permanentToCard(perm)] };
      logMessages.push(`Sacrifices ${perm.name}.`);
    }
  }

  // 4. Sacrifice type (auto-select least valuable matching permanent)
  if (cost.sacrificeType && cost.sacrificeCount && !cost.sacrificeSelf) {
    const matching = bf
      .filter((p) => p.typeLine.toLowerCase().includes(cost.sacrificeType!))
      .sort((a, b) => (a.cmc || 0) - (b.cmc || 0)); // sacrifice cheapest first

    const toSacrifice = matching.slice(0, cost.sacrificeCount);
    const sacIds = new Set(toSacrifice.map((p) => p.id));
    bf = bf.filter((p) => !sacIds.has(p.id));
    ps = {
      ...ps,
      graveyard: [...ps.graveyard, ...toSacrifice.map(permanentToCard)],
    };
    logMessages.push(
      `Sacrifices ${toSacrifice.map((p) => p.name).join(', ')}.`,
    );
  }

  // 5. Pay life
  if (cost.payLife) {
    ps = { ...ps, life: ps.life - cost.payLife };
    logMessages.push(`Pays ${cost.payLife} life.`);
  }

  // 6. Discard (auto-discard highest CMC cards -- bot can override)
  if (cost.discardCount) {
    const sorted = [...ps.hand].sort(
      (a, b) => (b.cmc || 0) - (a.cmc || 0),
    );
    const toDiscard = sorted.slice(0, cost.discardCount);
    const discardIds = new Set(toDiscard.map((c) => c.id));
    ps = {
      ...ps,
      hand: ps.hand.filter((c) => !discardIds.has(c.id)),
      graveyard: [...ps.graveyard, ...toDiscard],
    };
    logMessages.push(
      `Discards ${toDiscard.map((c) => c.name).join(', ')}.`,
    );
  }

  // 7. Exile from graveyard (auto-select least useful)
  if (cost.exileFromGY) {
    const toExile = ps.graveyard.slice(0, cost.exileFromGY);
    const exileIds = new Set(toExile.map((c) => c.id));
    ps = {
      ...ps,
      graveyard: ps.graveyard.filter((c) => !exileIds.has(c.id)),
      exile: [...ps.exile, ...toExile],
    };
    logMessages.push(
      `Exiles ${toExile.length} card(s) from graveyard.`,
    );
  }

  // 8. Mana payment (last, after other costs that might change board state)
  if (cost.mana) {
    const manaCost = parseManaCost(cost.mana);
    let updatedPlayer = { ...ps, battlefield: bf };

    if (
      !canPayManaCost(updatedPlayer.manaPool, manaCost, updatedPlayer.life)
    ) {
      const tapResult = autoTapLandsForCost(updatedPlayer, manaCost);
      if (tapResult) {
        updatedPlayer = tapResult.updatedPlayer;
        bf = updatedPlayer.battlefield;
      }
    }

    const payment = autoPayCost(
      updatedPlayer.manaPool,
      manaCost,
      updatedPlayer.life,
    );
    if (payment) {
      const newPool = payManaCost(updatedPlayer.manaPool, manaCost, payment);
      ps = { ...updatedPlayer, manaPool: newPool };
    } else {
      ps = updatedPlayer;
    }
  }

  // Apply battlefield changes
  ps = { ...ps, battlefield: bf };

  const players = [...state.players];
  players[player] = ps;

  return {
    ...state,
    players,
    log: [
      ...state.log,
      ...logMessages.map((message) => ({
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message,
      })),
    ],
  };
}
