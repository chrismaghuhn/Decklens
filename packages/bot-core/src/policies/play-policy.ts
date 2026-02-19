import type { GameState, GameAction, Card, ManaPayment } from '@mtg/game-engine';
import {
  parseManaCost, canPayCost, autoPayCost, totalMana,
  isLand, isCreature, isInstant, hasFlash,
  parseCost, canPayAbilityCost,
} from '@mtg/game-engine';
import { scoreCardInHand, getLandsInHand, getSpellsInHand } from '../evaluators/hand-evaluator.ts';

/**
 * Play Policy — Decides what to play during main phases.
 *
 * Handles:
 * - Land drops (which land to play)
 * - Spell sequencing (what order to cast spells)
 * - Resource management (save mana for responses?)
 */

/** Score a card for how good it is to play right now */
export interface PlayCandidate {
  card: Card;
  action: GameAction;
  /** Priority score (higher = play first) */
  priority: number;
  /** Reason for the score */
  reason: string;
}

/** Turn-based phase priority weights */
const PHASE_WEIGHTS: Record<string, Record<string, number>> = {
  early: { ramp: 10, 'fast-mana': 12, 'mana-dork': 9, draw: 6, removal: 4, 'land-fetch': 8 },
  mid: { draw: 8, engine: 9, removal: 6, counter: 5, ramp: 5, 'combo-piece': 7 },
  late: { 'win-condition': 12, finisher: 10, 'combo-piece': 11, wipe: 8, draw: 5 },
};

/** Determine game phase by turn number */
function getGamePhase(turn: number): 'early' | 'mid' | 'late' {
  if (turn <= 3) return 'early';
  if (turn <= 7) return 'mid';
  return 'late';
}

/**
 * Choose which land to play (if any).
 * Prefers color-producing lands that enable the most casts.
 */
export function chooseLandDrop(state: GameState, player: 0 | 1): PlayCandidate | null {
  const ps = state.players[player];

  // Check if we can play a land
  if (state.step !== 'main' || state.activePlayer !== player) return null;
  if (ps.landsPlayedThisTurn >= ps.maxLandPlays) return null;
  if (state.stack.length > 0) return null;

  const lands = getLandsInHand(ps.hand);
  if (lands.length === 0) return null;

  // Score each land based on what it enables
  let bestLand = lands[0];
  let bestScore = 0;

  for (const land of lands) {
    let score = 5; // Base score for any land drop

    // Prefer lands that produce colors we need
    const textLower = (land.oracleText || '').toLowerCase();
    const spells = getSpellsInHand(ps.hand);

    for (const spell of spells) {
      const cost = parseManaCost(spell.manaCost);
      // Check if this land helps cast spells in hand
      if (cost.W > 0 && textLower.includes('{w}')) score += 2;
      if (cost.U > 0 && textLower.includes('{u}')) score += 2;
      if (cost.B > 0 && textLower.includes('{b}')) score += 2;
      if (cost.R > 0 && textLower.includes('{r}')) score += 2;
      if (cost.G > 0 && textLower.includes('{g}')) score += 2;
    }

    // Penalty for tapped lands if we have plays this turn
    if (textLower.includes('enters tapped') || textLower.includes('enters the battlefield tapped')) {
      score -= 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestLand = land;
    }
  }

  return {
    card: bestLand,
    action: { type: 'play-land', player, cardId: bestLand.id },
    priority: bestScore,
    reason: `Play land: ${bestLand.name}`,
  };
}

/**
 * Get all castable spell candidates with priorities.
 */
export function getCastCandidates(state: GameState, player: 0 | 1): PlayCandidate[] {
  const ps = state.players[player];
  const phase = getGamePhase(state.turn);
  const weights = PHASE_WEIGHTS[phase];
  const candidates: PlayCandidate[] = [];

  for (const card of ps.hand) {
    if (isLand(card)) continue;

    // Check timing restrictions
    if (state.step !== 'main' && !isInstant(card) && !hasFlash(card)) continue;
    if (!isInstant(card) && !hasFlash(card)) {
      if (state.activePlayer !== player || state.stack.length > 0) continue;
    }

    // Check mana (with X-spell support)
    const cost = parseManaCost(card.manaCost);
    let payment = autoPayCost(ps.manaPool, cost, ps.life);
    let xValue = 0;

    // X-spell detection: if manaCost contains {X}, try to pay with X≥1
    if (!payment && card.manaCost?.includes('{X}')) {
      // Try with X=0 first (just the base cost)
      const baseCost = parseManaCost(card.manaCost.replace(/\{X\}/g, ''));
      payment = autoPayCost(ps.manaPool, baseCost, ps.life);
      if (payment) {
        // Calculate max X from remaining mana
        const totalPool = Object.values(ps.manaPool).reduce((s, v) => s + v, 0);
        const baseCostTotal = Object.values(baseCost).reduce((s, v) => s + v, 0);
        xValue = Math.max(0, totalPool - baseCostTotal);
      }
    } else if (payment && card.manaCost?.includes('{X}')) {
      // Payment succeeded with X=0, calculate max X
      const totalPool = Object.values(ps.manaPool).reduce((s, v) => s + v, 0);
      const costTotal = Object.values(cost).reduce((s, v) => s + v, 0);
      xValue = Math.max(0, totalPool - costTotal);
    }

    if (!payment) continue;

    // Score the card
    let priority = 0;

    // Tag-based scoring
    for (const tag of card.tags) {
      priority += weights[tag] ?? 1;
    }

    // CMC efficiency (prefer cheaper spells when equal priority)
    priority += (10 - card.cmc) * 0.1;

    // X-spell bonus: higher X = more valuable
    if (xValue > 0) priority += xValue * 1.5;

    // Creature bonus (develops board)
    if (isCreature(card)) priority += 1;

    candidates.push({
      card,
      action: {
        type: 'cast-spell',
        player,
        cardId: card.id,
        targets: [], // Simplified — no targeting AI yet
        manaPayment: payment,
        ...(xValue > 0 ? { xValue } : {}),
      } as any,
      priority,
      reason: `Cast ${card.name}${xValue > 0 ? ` (X=${xValue})` : ''} (tags: ${card.tags.join(', ')})`,
    });
  }

  // ── Alternative Cost Candidates ──

  // Evoke: cast creature for evoke cost (ETB then sacrifice)
  for (const card of ps.hand) {
    if (isLand(card)) continue;
    const oracle = card.oracleText?.toLowerCase() || '';
    const evokeMatch = oracle.match(/evoke\s+(\{[^}]+\})/i);
    if (!evokeMatch) continue;
    // Don't duplicate if already castable normally
    if (candidates.some(c => c.card.id === card.id)) continue;
    const evokeCost = parseManaCost(evokeMatch[1]);
    const evokePayment = autoPayCost(ps.manaPool, evokeCost, ps.life);
    if (!evokePayment) continue;
    let priority = 0;
    for (const tag of card.tags) priority += weights[tag] ?? 1;
    priority += 3; // Bonus for cheap ETB effect
    candidates.push({
      card,
      action: { type: 'cast-spell', player, cardId: card.id, targets: [], manaPayment: evokePayment, evokePaid: true } as any,
      priority,
      reason: `Evoke ${card.name}`,
    });
  }

  // Dash: cast creature for dash cost (haste, return at end step)
  for (const card of ps.hand) {
    if (isLand(card)) continue;
    const oracle = card.oracleText?.toLowerCase() || '';
    const dashMatch = oracle.match(/dash\s+(\{[^}]+\})/i);
    if (!dashMatch) continue;
    if (candidates.some(c => c.card.id === card.id && (c.action as any).dashPaid)) continue;
    const dashCost = parseManaCost(dashMatch[1]);
    const dashPayment = autoPayCost(ps.manaPool, dashCost, ps.life);
    if (!dashPayment) continue;
    let priority = 0;
    for (const tag of card.tags) priority += weights[tag] ?? 1;
    priority += 2; // Surprise attack bonus
    if (isCreature(card)) priority += 1;
    candidates.push({
      card,
      action: { type: 'cast-spell', player, cardId: card.id, targets: [], manaPayment: dashPayment, dashPaid: true } as any,
      priority,
      reason: `Dash ${card.name}`,
    });
  }

  // Flashback: cast from graveyard
  for (const card of ps.graveyard) {
    const oracle = card.oracleText?.toLowerCase() || '';
    const fbMatch = oracle.match(/flashback\s+(\{[^}]+\})/i);
    if (!fbMatch) continue;
    if (state.step !== 'main' && !isInstant(card) && !hasFlash(card)) continue;
    if (!isInstant(card) && !hasFlash(card)) {
      if (state.activePlayer !== player || state.stack.length > 0) continue;
    }
    const fbCost = parseManaCost(fbMatch[1]);
    const fbPayment = autoPayCost(ps.manaPool, fbCost, ps.life);
    if (!fbPayment) continue;
    let priority = 0;
    for (const tag of card.tags) priority += weights[tag] ?? 1;
    priority += 2; // Bonus for "free" card from graveyard
    candidates.push({
      card,
      action: { type: 'cast-spell', player, cardId: card.id, targets: [], manaPayment: fbPayment, isFlashback: true } as any,
      priority,
      reason: `Flashback ${card.name}`,
    });
  }

  // Sort by priority descending
  candidates.sort((a, b) => b.priority - a.priority);

  return candidates;
}

/**
 * Get cycling candidates from hand.
 * Cards with cycling can be discarded for their cycling cost to draw a card.
 */
export function getCyclingCandidates(state: GameState, player: 0 | 1): PlayCandidate[] {
  const ps = state.players[player];
  const candidates: PlayCandidate[] = [];
  const currentMana = totalMana(ps.manaPool);

  for (const card of ps.hand) {
    const oracle = card.oracleText?.toLowerCase() || '';
    const cycleMatch = oracle.match(/cycling\s+(\{[^}]+\})/i);
    if (!cycleMatch) continue;

    // Check if we can pay the cycling cost
    const cycleCostStr = cycleMatch[1];
    const cycleCost = parseManaCost(cycleCostStr);
    const payment = autoPayCost(ps.manaPool, cycleCost, ps.life);
    if (!payment) continue;

    // Score cycling decision
    let priority = 3; // Base cycling score
    const cardValue = scoreCardInHand(card, ps.hand.filter(c => isLand(c)).length, state.turn);

    // Low-value cards are better to cycle
    if (cardValue <= 3) priority += 3;
    else if (cardValue <= 5) priority += 1;
    else priority -= 5; // Don't cycle high-value cards

    // Cycle more aggressively with large hands
    if (ps.hand.length > 5) priority += 2;

    // Cycle when mana-stuck (no lands and expensive hand)
    const landCount = ps.hand.filter(c => isLand(c)).length;
    if (landCount === 0 && state.turn <= 3) priority += 2;

    // Don't cycle if hand is small
    if (ps.hand.length <= 3) priority -= 3;

    if (priority > 0) {
      candidates.push({
        card,
        action: { type: 'cycle', player, cardId: card.id } as any,
        priority,
        reason: `Cycle ${card.name} (value: ${cardValue.toFixed(1)})`,
      });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority);
  return candidates;
}

/**
 * Choose the best main phase action.
 * Considers land drops, spell casting, and holding mana for responses.
 */
export function choosePlayAction(
  state: GameState,
  player: 0 | 1,
  holdManaForResponses: boolean = false,
): PlayCandidate | null {
  // Always try land drop first (free action)
  const landDrop = chooseLandDrop(state, player);

  // Get spell candidates
  const spells = getCastCandidates(state, player);

  // If holding mana for instant-speed responses, skip sorcery-speed plays
  if (holdManaForResponses && spells.length > 0) {
    const instantSpells = spells.filter(
      (c) => isInstant(c.card) || hasFlash(c.card)
    );
    if (instantSpells.length === 0) {
      // Only have sorcery-speed options — play land and pass
      return landDrop;
    }
  }

  // Land drop has priority if we haven't played one
  if (landDrop) return landDrop;

  // Otherwise best spell
  return spells.length > 0 ? spells[0] : null;
}

/**
 * Decide if we should hold mana open for instant-speed responses.
 */
export function shouldHoldMana(state: GameState, player: 0 | 1): boolean {
  const ps = state.players[player];

  // Check if we have instant-speed interaction in hand
  const hasInstants = ps.hand.some((c) => {
    if (!isInstant(c) && !hasFlash(c)) return false;
    const cost = parseManaCost(c.manaCost);
    return canPayCost(ps.manaPool, cost, ps.life);
  });

  if (!hasInstants) return false;

  // Hold mana if we have counterspells and opponent is likely to cast something
  const hasCounter = ps.hand.some((c) => c.tags.includes('counter'));
  if (hasCounter && state.phase === 'precombat-main') return true;

  // Hold mana for removal during combat
  const hasRemoval = ps.hand.some(
    (c) => c.tags.includes('removal') && (isInstant(c) || hasFlash(c))
  );
  if (hasRemoval) return true;

  return false;
}

/** Ability activation candidate */
export interface AbilityCandidate {
  permanentId: string;
  abilityIndex: number;
  priority: number;
  name: string;
  /** Whether this is a loyalty ability (use activate-loyalty action) */
  isLoyalty?: boolean;
  /** Loyalty cost (positive = +N, negative = -N) */
  loyaltyCost?: number;
  /** Whether this is an equip ability (use equip action) */
  isEquip?: boolean;
  /** Equip target creature ID */
  equipTargetId?: string;
}

/**
 * Find all activated abilities the bot could activate right now.
 *
 * Evaluates each non-mana, non-static ability on every permanent the player
 * controls, checking cost affordability and timing restrictions, then scores
 * the ability by its effect text so the bot can pick the best one.
 *
 * Also detects planeswalker loyalty abilities and equipment equip abilities.
 */
export function getAbilityActivationCandidates(
  state: GameState,
  player: 0 | 1,
): AbilityCandidate[] {
  const candidates: AbilityCandidate[] = [];
  const ps = state.players[player];
  const opponent = (player === 0 ? 1 : 0) as 0 | 1;

  for (const perm of ps.battlefield) {
    // ── Planeswalker Loyalty Abilities ──
    if (perm.typeLine?.toLowerCase().includes('planeswalker') && perm.oracleText) {
      const loyaltyAbilities = parseLoyaltyAbilities(perm.oracleText);
      const currentLoyalty = perm.currentLoyalty ?? perm.loyalty ?? 0;

      // Only during main phase with empty stack (sorcery speed)
      if (state.step === 'main' && state.activePlayer === player && (!state.stack || state.stack.length === 0)) {
        for (let i = 0; i < loyaltyAbilities.length; i++) {
          const la = loyaltyAbilities[i];
          // Can we pay the loyalty cost?
          if (la.cost < 0 && currentLoyalty + la.cost < 0) continue;

          let priority = 0;
          const text = la.text.toLowerCase();

          // Score loyalty abilities
          if (text.includes('draw') || text.includes('card')) priority += 5;
          if (text.includes('destroy') || text.includes('exile')) priority += 6;
          if (text.includes('token') || text.includes('create')) priority += 4;
          if (text.includes('damage')) priority += 4;
          if (text.includes('return') && text.includes('graveyard')) priority += 4;
          if (text.includes('counter')) priority += 5;
          if (text.includes('emblem') || text.includes('ultimate')) priority += 8;
          if (text.includes('search')) priority += 5;

          // +N abilities: usually card advantage — prefer if loyalty is low
          if (la.cost > 0) {
            priority += 2; // Safe option (builds loyalty)
            if (currentLoyalty <= 3) priority += 2; // Protect walker
          }
          // -N abilities: powerful but expensive
          if (la.cost < 0) {
            // Don't use ultimate if it kills walker (unless very valuable)
            if (currentLoyalty + la.cost <= 0 && priority < 6) priority -= 3;
          }

          if (priority > 0) {
            candidates.push({
              permanentId: perm.id,
              abilityIndex: i,
              priority,
              name: perm.name,
              isLoyalty: true,
              loyaltyCost: la.cost,
            });
          }
        }
      }
    }

    // ── Equipment Equip Abilities ──
    const typeLine = (perm.typeLine ?? '').toLowerCase();
    if (typeLine.includes('equipment') && !perm.attachedTo && perm.oracleText) {
      const equipMatch = perm.oracleText.match(/equip\s+(\{[^}]+\}(?:\{[^}]+\})*)/i);
      if (equipMatch && state.step === 'main' && state.activePlayer === player && (!state.stack || state.stack.length === 0)) {
        const equipCostStr = equipMatch[1];
        const equipCost = parseManaCost(equipCostStr);
        const payment = autoPayCost(ps.manaPool, equipCost, ps.life);
        if (payment) {
          // Find best creature to equip (biggest non-equipped creature)
          const creatures = ps.battlefield.filter(p =>
            p.typeLine?.toLowerCase().includes('creature') && p.id !== perm.id
          );
          // Skip if already attached to best creature
          const attachedTo = perm.attachments ? null : null; // equipment doesn't have attachments, it IS attachment
          if (creatures.length > 0) {
            const best = creatures.sort((a, b) =>
              ((b.currentPower || 0) + (b.currentToughness || 0)) - ((a.currentPower || 0) + (a.currentToughness || 0))
            )[0];

            let priority = 3; // Base equip value
            const eqText = (perm.oracleText ?? '').toLowerCase();
            if (eqText.includes('+2/+2') || eqText.includes('+3/')) priority += 3;
            else if (eqText.includes('+1/+1')) priority += 2;
            if (eqText.includes('flying') || eqText.includes('trample') || eqText.includes('double strike')) priority += 3;
            if (eqText.includes('hexproof') || eqText.includes('indestructible') || eqText.includes('shroud')) priority += 4;
            if (eqText.includes('draw') || eqText.includes('card')) priority += 3;
            // Skullclamp special: equip to small creature for card draw
            if (perm.name === 'Skullclamp') priority += 5;
            // Lightning Greaves/Swiftfoot Boots: protection
            if (eqText.includes('haste') && (eqText.includes('hexproof') || eqText.includes('shroud'))) priority += 4;

            candidates.push({
              permanentId: perm.id,
              abilityIndex: -1, // Special marker for equip
              priority,
              name: perm.name,
              isEquip: true,
              equipTargetId: best.id,
            });
          }
        }
      }
    }

    // ── Regular Activated Abilities ──
    for (let i = 0; i < perm.abilities.length; i++) {
      const ability = perm.abilities[i];

      // Skip mana abilities (handled by mana system) and static abilities (passive)
      if (ability.type === 'mana' || ability.type === 'static') continue;
      // Only consider activated abilities (triggered resolve automatically)
      if (ability.type !== 'activated') continue;

      // Parse and check if we can pay the cost
      const cost = parseCost(ability.cost || '');
      if (!canPayAbilityCost(state, player, perm.id, cost)) continue;

      // Timing check: non-instant-speed abilities only during main phase with empty stack
      if (!ability.instantSpeed) {
        if (state.step !== 'main') continue;
        if (state.stack && state.stack.length > 0) continue;
      }

      // Score the ability based on its effect text
      let priority = 0;
      const text = ability.text.toLowerCase();

      // High-value effects
      if (text.includes('draw')) priority += 4;
      if (text.includes('destroy') || text.includes('exile')) priority += 5;
      if (text.includes('search your library')) priority += 4;
      if (text.includes('counter target')) priority += 5;

      // Medium-value effects
      if (text.includes('token')) priority += 3;
      if (text.includes('damage')) priority += 3;
      if (text.includes('+1/+1 counter')) priority += 2;
      if (text.includes('return') && text.includes('graveyard')) priority += 3;

      // Low-value effects
      if (text.includes('scry')) priority += 1;
      if (text.includes('gain') && text.includes('life')) priority += 1;
      if (text.includes('tap target')) priority += 2;

      // Penalize expensive costs
      if (cost.sacrificeSelf) priority -= 1; // Only sacrifice if the effect is worth it
      if (cost.payLife && cost.payLife >= 3) priority -= 1;
      if (cost.discardCount) priority -= 2;

      // Only add if net positive value
      if (priority > 0) {
        candidates.push({
          permanentId: perm.id,
          abilityIndex: i,
          priority,
          name: perm.name,
        });
      }
    }
  }

  return candidates.sort((a, b) => b.priority - a.priority);
}

/** Parse loyalty abilities from planeswalker oracle text */
function parseLoyaltyAbilities(oracleText: string): { cost: number; text: string }[] {
  const abilities: { cost: number; text: string }[] = [];
  // Match patterns like "+1: Draw a card" or "−2: Destroy target creature" or "0: Create a token"
  const regex = /([+\-−]?\d+):\s*([^\n]+)/g;
  let m;
  while ((m = regex.exec(oracleText)) !== null) {
    const costStr = m[1].replace('−', '-');
    const cost = parseInt(costStr, 10);
    if (!isNaN(cost)) {
      abilities.push({ cost, text: m[2].trim() });
    }
  }
  return abilities;
}
