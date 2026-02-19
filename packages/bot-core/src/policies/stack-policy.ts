import type { GameState, GameAction, Card } from '@mtg/game-engine';
import {
  parseManaCost, autoPayCost,
  isInstant, hasFlash,
} from '@mtg/game-engine';
import { evaluateStackThreat } from '../evaluators/threat-evaluator.ts';

/**
 * Stack Policy — Decides instant-speed responses.
 *
 * Handles:
 * - When to counter a spell
 * - When to cast removal in response
 * - When to just let things resolve
 */

/** Minimum threat score to counter a spell (lowered for more responsiveness) */
const COUNTER_THRESHOLD = 3;

/** Minimum threat score to use removal in response (lowered for board control) */
const REMOVAL_THRESHOLD = 2;

/**
 * Get all instant-speed cards the bot can currently cast.
 */
function getInstantSpeedOptions(state: GameState, player: 0 | 1): Card[] {
  const ps = state.players[player];
  return ps.hand.filter((card) => {
    if (!isInstant(card) && !hasFlash(card)) return false;
    const cost = parseManaCost(card.manaCost);
    return autoPayCost(ps.manaPool, cost, ps.life) !== null;
  });
}

/**
 * Check if a card is a counterspell by tags or oracle text.
 */
function isCounterSpell(card: Card): boolean {
  if (card.tags.includes('counter')) return true;
  const text = (card.oracleText ?? '').toLowerCase();
  return /counter\s+target\s+spell/.test(text);
}

/**
 * Decide if we should counter the top spell on the stack.
 *
 * Uses tag-based detection first, then falls back to oracle text
 * matching for "counter target spell" patterns.
 */
export function shouldCounterTopSpell(state: GameState, player: 0 | 1): GameAction | null {
  if (state.stack.length === 0) return null;

  const topSpell = state.stack[state.stack.length - 1];

  // Don't counter our own spells
  if (topSpell.controller === player) return null;

  // Evaluate the threat
  const threat = evaluateStackThreat(topSpell, player);
  if (!threat || threat.score < COUNTER_THRESHOLD) return null;

  // Find a counterspell in hand (by tag or oracle text)
  const ps = state.players[player];
  const counterSpells = getInstantSpeedOptions(state, player).filter(isCounterSpell);

  if (counterSpells.length === 0) return null;

  // Use the cheapest counter available
  const cheapest = counterSpells.sort((a, b) => a.cmc - b.cmc)[0];
  const cost = parseManaCost(cheapest.manaCost);
  const payment = autoPayCost(ps.manaPool, cost, ps.life);

  if (!payment) return null;

  return {
    type: 'cast-spell',
    player,
    cardId: cheapest.id,
    targets: [{ type: 'card-in-zone', id: topSpell.id, zone: 'stack' }],
    manaPayment: payment,
  };
}

/**
 * Check if a card is removal by tags or oracle text.
 */
function isRemovalSpell(card: Card): boolean {
  if (card.tags.includes('removal')) return true;
  const text = (card.oracleText ?? '').toLowerCase();
  return /destroy\s+target|exile\s+target|deals?\s+\d+\s+damage\s+to\s+target|target\s+creature\s+gets?\s+-/.test(text);
}

/**
 * Decide if we should respond with instant-speed removal.
 */
export function shouldRespondWithRemoval(state: GameState, player: 0 | 1): GameAction | null {
  const ps = state.players[player];

  // Find instant-speed removal (by tag OR oracle text)
  const removal = getInstantSpeedOptions(state, player).filter(isRemovalSpell);

  if (removal.length === 0) return null;

  // Check if there's a threatening permanent or stack spell worth answering
  const opponent = (player === 0 ? 1 : 0) as 0 | 1;
  const oppField = state.players[opponent].battlefield;

  // Find the biggest threat on the opponent's board
  let bestTarget: { id: string; score: number } | null = null;

  for (const perm of oppField) {
    const textLower = (perm.oracleText || '').toLowerCase();
    let score = 0;

    // Critical threats
    if (textLower.includes('you win the game')) score = 15;
    else if (textLower.includes('extra turn')) score = 10;
    else if (perm.currentLoyalty !== undefined) score = 6;
    else if (perm.currentPower !== undefined && (perm.currentPower ?? 0) >= 5) score = 5;
    // Medium threats
    else if (perm.currentPower !== undefined && (perm.currentPower ?? 0) >= 3) score = 3;
    else if (textLower.includes('draw a card') || textLower.includes('whenever')) score = 3;
    else if (textLower.includes('deals damage') || textLower.includes('each opponent')) score = 3;
    // Low threats — at least worth considering
    else if (perm.currentPower !== undefined) score = 2;

    if (score > REMOVAL_THRESHOLD && (!bestTarget || score > bestTarget.score)) {
      bestTarget = { id: perm.id, score };
    }
  }

  if (!bestTarget) return null;

  // Use the cheapest removal
  const cheapest = removal.sort((a, b) => a.cmc - b.cmc)[0];
  const cost = parseManaCost(cheapest.manaCost);
  const payment = autoPayCost(ps.manaPool, cost, ps.life);

  if (!payment) return null;

  return {
    type: 'cast-spell',
    player,
    cardId: cheapest.id,
    targets: [{ type: 'permanent', id: bestTarget.id }],
    manaPayment: payment,
  };
}

/**
 * Choose the best stack interaction action.
 * Priority: counter > removal > pass.
 */
export function chooseStackAction(state: GameState, player: 0 | 1): GameAction {
  // Try to counter
  const counterAction = shouldCounterTopSpell(state, player);
  if (counterAction) return counterAction;

  // Try removal response
  const removalAction = shouldRespondWithRemoval(state, player);
  if (removalAction) return removalAction;

  // Default: pass priority
  return { type: 'pass', player };
}
