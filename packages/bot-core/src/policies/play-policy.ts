import type { GameState, GameAction, Card, ManaPayment, Permanent } from '@mtg/game-engine';
import {
  parseManaCost, canPayCost, autoPayCost, totalMana,
  isLand, isCreature, isInstant, hasFlash,
  parseCost, canPayAbilityCost, hasKeyword,
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

// ─── Removal Targeting Intelligence ───

/**
 * Rank an opponent's permanent as a removal target.
 * Higher score = more valuable to remove.
 *
 * Priority order:
 *  1. Highest threat (power + abilities)
 *  2. Commanders (huge tempo hit)
 *  3. Equipped/Enchanted creatures (buffed = more value)
 *  4. Tokens last (least value, they're free)
 */
export function rankTarget(perm: Permanent, state: GameState): number {
  let score = 0;
  const typeLine = (perm.typeLine ?? '').toLowerCase();
  const oracle = (perm.oracleText || '').toLowerCase();

  // Base: power + toughness for creatures
  score += (perm.currentPower || 0) + (perm.currentToughness || 0);

  // Planeswalker bonus (high threat, generates value every turn)
  if (typeLine.includes('planeswalker')) {
    score += 8 + (perm.currentLoyalty || 0);
  }

  // Commander bonus (killing a commander = tempo + commander tax)
  if (typeLine.includes('legendary') && typeLine.includes('creature')) {
    score += 10;
  }

  // Equipment/Aura attachments (removing a buffed creature is higher value)
  score += (perm.attachments?.length || 0) * 3;

  // Keywords that make it dangerous
  if (hasKeyword(perm, 'flying')) score += 2;
  if (hasKeyword(perm, 'trample')) score += 2;
  if (hasKeyword(perm, 'lifelink')) score += 2;
  if (hasKeyword(perm, 'deathtouch')) score += 3;
  if (hasKeyword(perm, 'double strike')) score += (perm.currentPower || 0); // Effective double power
  if (hasKeyword(perm, 'infect')) score += 5;
  if (hasKeyword(perm, "can't be blocked")) score += 3;

  // Hexproof penalty: don't waste targeted removal (will be filtered out)
  if (hasKeyword(perm, 'hexproof')) score -= 100;
  // Indestructible penalty for destroy effects (not exile)
  if (hasKeyword(perm, 'indestructible')) score -= 50;

  // Engine permanents generating ongoing value
  if (oracle.includes('whenever') && oracle.includes('draw')) score += 5;
  if (oracle.includes('at the beginning') && oracle.includes('draw')) score += 4;
  if (oracle.includes('whenever') && oracle.includes('create')) score += 3;

  // Must-answer threats
  if (oracle.includes('you win the game')) score += 15;
  if (oracle.includes('extra turn')) score += 10;
  if (oracle.includes('each opponent loses')) score += 8;

  // Token penalty (less valuable to remove — they're expendable and free)
  if (perm.id?.startsWith('token-') || perm.oracleId?.startsWith('token_')) {
    score -= 3;
  }

  // Non-creature, non-planeswalker permanents (enchantments, artifacts) that generate value
  if (typeLine.includes('enchantment') && !typeLine.includes('creature')) {
    score += 4;
  }
  if (typeLine.includes('artifact') && !typeLine.includes('creature')) {
    score += 3;
  }

  return score;
}

/**
 * Choose the best targets for a removal spell by ranking opponent permanents.
 * Returns target IDs sorted by priority (best target first).
 *
 * @param isDestroyEffect - true if the spell uses "destroy" (indestructible immune)
 * @param isExileEffect - true if the spell exiles (ignores indestructible)
 */
export function chooseRemovalTargets(
  state: GameState,
  player: 0 | 1,
  card: Card,
  isDestroyEffect: boolean = false,
  isExileEffect: boolean = false,
): string[] {
  const opponent = (player === 0 ? 1 : 0) as 0 | 1;
  const opponentField = state.players[opponent].battlefield;
  const oracle = (card.oracleText || '').toLowerCase();

  // Determine what kind of targets the spell can hit
  const canTargetCreatures = oracle.includes('target creature') || oracle.includes('target permanent');
  const canTargetPlaneswalkers = oracle.includes('target planeswalker') || oracle.includes('target permanent');
  const canTargetArtifacts = oracle.includes('target artifact') || oracle.includes('target permanent');
  const canTargetEnchantments = oracle.includes('target enchantment') || oracle.includes('target permanent');
  const canTargetNonland = oracle.includes('target nonland permanent');

  // If the spell text doesn't specify target types, assume it targets creatures
  const hasTargetType = canTargetCreatures || canTargetPlaneswalkers || canTargetArtifacts || canTargetEnchantments || canTargetNonland;

  const scored: { id: string; score: number }[] = [];

  for (const perm of opponentField) {
    const typeLine = (perm.typeLine ?? '').toLowerCase();

    // Filter by valid target types
    if (hasTargetType) {
      const isCreaturePerm = typeLine.includes('creature');
      const isPwPerm = typeLine.includes('planeswalker');
      const isArtifactPerm = typeLine.includes('artifact');
      const isEnchantmentPerm = typeLine.includes('enchantment');
      const isLandPerm = typeLine.includes('land') && !typeLine.includes('creature');

      const valid = (canTargetCreatures && isCreaturePerm)
        || (canTargetPlaneswalkers && isPwPerm)
        || (canTargetArtifacts && isArtifactPerm)
        || (canTargetEnchantments && isEnchantmentPerm)
        || (canTargetNonland && !isLandPerm);

      if (!valid) continue;
    }

    let score = rankTarget(perm, state);

    // Filter out hexproof targets (can't be targeted by opponent spells)
    if (hasKeyword(perm, 'hexproof')) continue;

    // If destroy effect, penalize indestructible (won't work)
    if (isDestroyEffect && !isExileEffect && hasKeyword(perm, 'indestructible')) {
      continue; // Skip entirely — destroy won't work on indestructible
    }

    scored.push({ id: perm.id, score });
  }

  // Sort by score descending, return IDs
  scored.sort((a, b) => b.score - a.score);
  return scored.map(s => s.id);
}

/**
 * Detect whether a card is a removal spell and auto-select the best targets.
 */
function autoSelectTargets(state: GameState, player: 0 | 1, card: Card): string[] {
  const oracle = (card.oracleText || '').toLowerCase();
  const tags = card.tags;

  // Check if this is a targeted removal spell
  const isRemoval = tags.includes('removal')
    || oracle.includes('destroy target')
    || oracle.includes('exile target')
    || oracle.includes('return target')
    || oracle.includes('deals damage to target');

  if (!isRemoval) return [];

  const isDestroyEffect = oracle.includes('destroy');
  const isExileEffect = oracle.includes('exile');

  const targets = chooseRemovalTargets(state, player, card, isDestroyEffect, isExileEffect);
  // Return only the top target (most removal spells target one thing)
  return targets.length > 0 ? [targets[0]] : [];
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

    // Smart targeting: auto-select best targets for removal spells
    const targets = autoSelectTargets(state, player, card);

    candidates.push({
      card,
      action: {
        type: 'cast-spell',
        player,
        cardId: card.id,
        targets,
        manaPayment: payment,
        ...(xValue > 0 ? { xValue } : {}),
      } as any,
      priority,
      reason: `Cast ${card.name}${xValue > 0 ? ` (X=${xValue})` : ''}${targets.length > 0 ? ` (targeting)` : ''} (tags: ${card.tags.join(', ')})`,
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
