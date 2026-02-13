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

/** Minimum threat score to counter a spell */
const COUNTER_THRESHOLD = 5;

/** Minimum threat score to use removal in response */
const REMOVAL_THRESHOLD = 3;

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
 * Decide if we should counter the top spell on the stack.
 */
export function shouldCounterTopSpell(state: GameState, player: 0 | 1): GameAction | null {
  if (state.stack.length === 0) return null;

  const topSpell = state.stack[state.stack.length - 1];

  // Don't counter our own spells
  if (topSpell.controller === player) return null;

  // Evaluate the threat
  const threat = evaluateStackThreat(topSpell, player);
  if (!threat || threat.score < COUNTER_THRESHOLD) return null;

  // Find a counterspell in hand
  const ps = state.players[player];
  const counterSpells = getInstantSpeedOptions(state, player).filter((c) =>
    c.tags.includes('counter')
  );

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
 * Decide if we should respond with instant-speed removal.
 */
export function shouldRespondWithRemoval(state: GameState, player: 0 | 1): GameAction | null {
  const ps = state.players[player];

  // Find instant-speed removal
  const removal = getInstantSpeedOptions(state, player).filter((c) =>
    c.tags.includes('removal')
  );

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
    else if (perm.currentPower !== undefined && (perm.currentPower ?? 0) >= 5) score = 5;
    else if (perm.currentLoyalty !== undefined) score = 6;

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
