/**
 * AI Coach — Real-time gameplay coaching using bot evaluators.
 *
 * Provides contextual tips based on the current game state:
 * - Suggestion: Better plays the player might be missing
 * - Warning: Opponent threats that need answering
 * - Info: Mana efficiency, sequencing, general tips
 *
 * No other MTG client (Forge, XMage, Cockatrice) has this.
 */

import type { GameState, Card, GameAction } from '@mtg/game-engine';
import {
  evaluateBoardPosition,
  evaluatePlayerBoard,
  getOpponentTotalPower,
  hasBoardDominance,
} from '@mtg/bot-core';
import {
  identifyThreats,
  hasMustAnswerThreat,
  getTopThreat,
} from '@mtg/bot-core';
import {
  getCastCandidates,
  shouldHoldMana,
} from '@mtg/bot-core';
import {
  assessHand,
  countLands,
  getCastableSpells,
} from '@mtg/bot-core';
import { makeDecision } from '@mtg/bot-core';
import { totalMana, emptyPool } from '@mtg/game-engine';

// ─── Types ───

export type TipSeverity = 'info' | 'suggestion' | 'warning';

export interface CoachTip {
  severity: TipSeverity;
  icon: string;
  message: string;
  /** Optional: the action the coach recommends */
  suggestedAction?: GameAction;
}

// ─── Coach Logic ───

/**
 * Generate coaching tips for the current game state.
 * Called after each state change when coach mode is enabled.
 */
export function generateCoachTips(state: GameState, humanPlayer: 0 | 1): CoachTip[] {
  const tips: CoachTip[] = [];
  const opponent = (humanPlayer === 0 ? 1 : 0) as 0 | 1;
  const me = state.players[humanPlayer];
  const opp = state.players[opponent];

  // Only generate tips when it's the human's priority
  if (state.priorityPlayer !== humanPlayer) return tips;
  if (state.gameOver) return tips;

  // ─── 1. Threat Warnings ───
  const threats = identifyThreats(state, humanPlayer);
  const topThreat = getTopThreat(state, humanPlayer);

  if (topThreat && topThreat.level === 'critical') {
    tips.push({
      severity: 'warning',
      icon: '⚠️',
      message: `Critical threat: ${topThreat.name} (score: ${topThreat.score.toFixed(0)}). Consider removal NOW.`,
    });
  } else if (topThreat && topThreat.level === 'high') {
    tips.push({
      severity: 'warning',
      icon: '⚠️',
      message: `High threat: ${topThreat.name} — find an answer soon.`,
    });
  }

  // ─── 2. Lethal Check ───
  const oppPower = getOpponentTotalPower(state, humanPlayer);
  if (oppPower >= me.life && me.life > 0) {
    tips.push({
      severity: 'warning',
      icon: '💀',
      message: `Opponent has ${oppPower} power on board — lethal on their next attack! Consider blockers or removal.`,
    });
  }

  // ─── 3. Mana Efficiency ───
  if (state.step === 'main' && state.activePlayer === humanPlayer) {
    const landsUntapped = me.battlefield.filter(
      p => p.typeLine.toLowerCase().includes('land') && !p.tapped
    ).length;

    const castable = getCastableSpells(me.hand, emptyPool(), me.life);

    if (landsUntapped >= 3 && castable.length > 0 && state.stack.length === 0) {
      const bestCastable = castable.sort((a, b) => b.cmc - a.cmc)[0];
      tips.push({
        severity: 'info',
        icon: '💰',
        message: `You have ${landsUntapped} untapped lands — consider casting ${bestCastable.name} (CMC ${bestCastable.cmc}).`,
      });
    }

    // No plays warning
    if (landsUntapped === 0 && me.hand.length > 0) {
      tips.push({
        severity: 'info',
        icon: '💡',
        message: `All lands tapped. Pass priority to continue.`,
      });
    }
  }

  // ─── 4. Board Position Assessment ───
  const advantage = evaluateBoardPosition(state, humanPlayer);
  if (advantage < -15) {
    tips.push({
      severity: 'warning',
      icon: '📉',
      message: `You're significantly behind on board. Look for a board wipe or combo to catch up.`,
    });
  } else if (advantage > 15) {
    tips.push({
      severity: 'info',
      icon: '📈',
      message: `Strong board position! Keep the pressure on — avoid overextending into potential wipes.`,
    });
  }

  // ─── 5. Land Drop Reminder ───
  if (state.step === 'main' && state.activePlayer === humanPlayer) {
    const landsInHand = me.hand.filter(c => c.typeLine.toLowerCase().includes('land'));
    const landDropUsed = me.landsPlayedThisTurn >= 1;
    if (landsInHand.length > 0 && !landDropUsed) {
      tips.push({
        severity: 'suggestion',
        icon: '🏔️',
        message: `Don't forget your land drop! You have ${landsInHand.length} land(s) in hand.`,
      });
    }
  }

  // ─── 6. Hand Size Concern ───
  if (me.hand.length >= 7 && state.step === 'main') {
    tips.push({
      severity: 'info',
      icon: '✋',
      message: `Hand is full (${me.hand.length} cards). You'll need to discard at end of turn — try to cast something.`,
    });
  }

  // Limit to top 3 most relevant tips
  return tips.slice(0, 3);
}

/**
 * Get suggested plays using the bot's decision engine.
 * Shows the human what the bot would do in their position.
 */
export function getSuggestedPlays(state: GameState, humanPlayer: 0 | 1): CoachTip[] {
  if (state.priorityPlayer !== humanPlayer) return [];
  if (state.gameOver) return [];

  try {
    // Run the bot's decision tree from the human's perspective
    const decision = makeDecision(state, humanPlayer);

    if (decision.action.type === 'pass') {
      return [{
        severity: 'info',
        icon: '🤖',
        message: `AI suggests: Pass priority (${decision.reason}).`,
        suggestedAction: decision.action,
      }];
    }

    const tips: CoachTip[] = [];
    const action = decision.action;

    let actionDesc = '';
    if (action.type === 'cast-spell') {
      const card = state.players[humanPlayer].hand.find(c => c.id === (action as any).cardId);
      actionDesc = card ? `Cast ${card.name}` : `Cast a spell`;
    } else if (action.type === 'play-land') {
      const card = state.players[humanPlayer].hand.find(c => c.id === (action as any).cardId);
      actionDesc = card ? `Play ${card.name}` : `Play a land`;
    } else if (action.type === 'declare-attackers') {
      const attackers = (action as any).attackerIds?.length ?? 0;
      actionDesc = `Attack with ${attackers} creature${attackers !== 1 ? 's' : ''}`;
    } else if (action.type === 'activate-ability') {
      actionDesc = `Activate an ability`;
    } else {
      actionDesc = `${action.type}`;
    }

    tips.push({
      severity: 'suggestion',
      icon: '🤖',
      message: `AI suggests: ${actionDesc} — ${decision.reason} (confidence: ${(decision.confidence * 100).toFixed(0)}%)`,
      suggestedAction: decision.action,
    });

    return tips;
  } catch {
    return [];
  }
}
