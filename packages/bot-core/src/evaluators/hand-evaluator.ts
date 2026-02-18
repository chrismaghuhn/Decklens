import type { GameState, Card, ManaPool } from '@mtg/game-engine';
import { parseManaCost, canPayCost, totalMana, isLand, isCreature, isInstant } from '@mtg/game-engine';

/**
 * Hand Evaluator — Assesses the quality and playability of a hand.
 *
 * Used for mulligan decisions and play sequencing.
 */

/** Hand quality assessment */
export interface HandAssessment {
  /** Overall quality score (0-10) */
  quality: number;
  /** Number of lands */
  landCount: number;
  /** Number of playable spells with current mana */
  playableCount: number;
  /** Whether the hand has early game plays (turns 1-3) */
  hasEarlyGame: boolean;
  /** Whether the hand has ramp */
  hasRamp: boolean;
  /** Whether the hand has card draw */
  hasDraw: boolean;
  /** Whether the hand has interaction (removal/counter) */
  hasInteraction: boolean;
  /** Average CMC of non-land cards */
  averageCMC: number;
}

/** Score a card's individual value in hand (for mulligan bottom decisions) */
export function scoreCardInHand(
  card: Card,
  handLandCount: number,
  turn: number,
): number {
  // Lands are valuable early, less so when you have enough
  if (isLand(card)) {
    if (handLandCount <= 2) return 8;
    if (handLandCount <= 3) return 5;
    return 2; // Excess lands less valuable
  }

  let score = 0;

  // Cheap spells are better early
  if (card.cmc <= 2) score += 6;
  else if (card.cmc <= 4) score += 4;
  else score += 2;

  // Ramp is premium early
  if (card.tags.includes('ramp') && turn <= 3) score += 3;
  if (card.tags.includes('fast-mana')) score += 4;

  // Card draw keeps options open
  if (card.tags.includes('draw')) score += 2;

  // Removal is always useful
  if (card.tags.includes('removal') || card.tags.includes('counter')) score += 2;

  // Win conditions are less urgent in opening hand
  if (card.tags.includes('win-condition') || card.tags.includes('finisher')) score -= 1;

  // ── Mechanic Flexibility Bonuses (Phase 4) ──
  // Cards with alternative uses/modes are more valuable in hand
  const oracle = card.oracleText?.toLowerCase() || '';
  if (/cycling/i.test(oracle)) score += 1.5;    // Can cycle away if not needed
  if (/flashback/i.test(oracle)) score += 1;     // Double use from graveyard
  if (/evoke/i.test(oracle)) score += 1;         // Cheap ETB option
  if (/dash/i.test(oracle)) score += 0.5;        // Surprise attack option
  if (/kicker/i.test(oracle)) score += 0.5;      // Scales with mana
  if (/rebound/i.test(oracle)) score += 1;       // Free second cast
  if (/adventure/i.test(oracle)) score += 1.5;   // Two cards in one

  return score;
}

/** Count lands in a set of cards */
export function countLands(cards: Card[]): number {
  return cards.filter((c) => isLand(c)).length;
}

/** Get castable spells given current mana pool */
export function getCastableSpells(hand: Card[], manaPool: ManaPool, life: number): Card[] {
  return hand.filter((card) => {
    if (isLand(card)) return false;
    const cost = parseManaCost(card.manaCost);
    return canPayCost(manaPool, cost, life);
  });
}

/** Get lands from hand */
export function getLandsInHand(hand: Card[]): Card[] {
  return hand.filter((c) => isLand(c));
}

/** Get non-land cards from hand */
export function getSpellsInHand(hand: Card[]): Card[] {
  return hand.filter((c) => !isLand(c));
}

/**
 * Assess overall hand quality (for mulligan decisions).
 * Score: 0 = unplayable, 10 = perfect.
 */
export function assessHand(hand: Card[], manaPool: ManaPool, life: number): HandAssessment {
  const landCount = countLands(hand);
  const spells = getSpellsInHand(hand);
  const playable = getCastableSpells(hand, manaPool, life);

  const hasRamp = hand.some((c) => c.tags.includes('ramp') || c.tags.includes('fast-mana') || c.tags.includes('mana-dork'));
  const hasDraw = hand.some((c) => c.tags.includes('draw'));
  const hasInteraction = hand.some((c) => c.tags.includes('removal') || c.tags.includes('counter'));

  // Early game: has something to do on turns 1-3
  const hasEarlyGame = spells.some((c) => c.cmc <= 3);

  // Average CMC
  const totalCMC = spells.reduce((sum, c) => sum + c.cmc, 0);
  const averageCMC = spells.length > 0 ? totalCMC / spells.length : 0;

  // Quality scoring
  let quality = 0;

  // Land balance (ideal: 2-4 in 7 cards)
  if (landCount >= 2 && landCount <= 4) quality += 3;
  else if (landCount === 1 || landCount === 5) quality += 1;
  // 0 or 6+ lands is terrible

  // Early game presence
  if (hasEarlyGame) quality += 2;

  // Ramp
  if (hasRamp) quality += 1.5;

  // Card draw
  if (hasDraw) quality += 1;

  // Interaction
  if (hasInteraction) quality += 1;

  // Good curve (average CMC 2-3.5)
  if (averageCMC >= 2 && averageCMC <= 3.5) quality += 1;

  // Penalty for too-expensive hand
  if (averageCMC > 5) quality -= 1;

  // Cap at 10
  quality = Math.min(10, Math.max(0, quality));

  return {
    quality,
    landCount,
    playableCount: playable.length,
    hasEarlyGame,
    hasRamp,
    hasDraw,
    hasInteraction,
    averageCMC,
  };
}

/**
 * Decide which cards to put on bottom for London Mulligan.
 * Returns card IDs to bottom, sorted by least valuable.
 */
export function chooseMulliganBottoms(hand: Card[], count: number): string[] {
  if (count <= 0) return [];
  if (count >= hand.length) return hand.map((c) => c.id);

  const landCount = countLands(hand);

  // Score all cards
  const scored = hand.map((card) => ({
    card,
    score: scoreCardInHand(card, landCount, 0),
  }));

  // Sort ascending (worst first)
  scored.sort((a, b) => a.score - b.score);

  // Bottom the worst N cards
  return scored.slice(0, count).map((s) => s.card.id);
}
