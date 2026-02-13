import type { GameState, GameAction, Card, ManaPayment } from '@mtg/game-engine';
import {
  parseManaCost, canPayCost, autoPayCost,
  isLand, isCreature, isInstant, hasFlash,
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

    // Check mana
    const cost = parseManaCost(card.manaCost);
    const payment = autoPayCost(ps.manaPool, cost, ps.life);
    if (!payment) continue;

    // Score the card
    let priority = 0;

    // Tag-based scoring
    for (const tag of card.tags) {
      priority += weights[tag] ?? 1;
    }

    // CMC efficiency (prefer cheaper spells when equal priority)
    priority += (10 - card.cmc) * 0.1;

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
      },
      priority,
      reason: `Cast ${card.name} (tags: ${card.tags.join(', ')})`,
    });
  }

  // Sort by priority descending
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
