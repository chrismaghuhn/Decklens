import type { GameState, GameAction } from '@mtg/game-engine';
import { makeDecision } from './decision-tree.ts';
import type { Decision } from './decision-tree.ts';
import { evaluateBoardPosition } from './evaluators/board-evaluator.ts';
import { evaluateCombos } from './evaluators/combo-evaluator.ts';
import { identifyThreats } from './evaluators/threat-evaluator.ts';

/**
 * HeuristicBot — Main bot interface.
 *
 * This is the primary class for the AI opponent.
 * It wraps the decision tree and evaluators into a clean API
 * that the UI/Game class can call.
 *
 * Usage:
 * ```ts
 * const bot = new HeuristicBot(1); // Bot is player 1
 * const action = bot.chooseAction(gameState);
 * game.submitAction(action);
 * ```
 */
export class HeuristicBot {
  /** Which player slot the bot occupies */
  player: 0 | 1;

  /** Decision history for replay/debugging */
  private decisions: Decision[] = [];

  /** Max decisions to keep in history */
  private maxHistory = 200;

  constructor(player: 0 | 1) {
    this.player = player;
  }

  /**
   * Choose the best action for the current game state.
   * This is the main entry point called by the game loop.
   */
  chooseAction(state: GameState): GameAction {
    const decision = makeDecision(state, this.player);

    // Record decision for debugging
    this.recordDecision(decision);

    return decision.action;
  }

  /**
   * Get the full decision with reasoning (for UI display).
   */
  chooseActionWithReason(state: GameState): Decision {
    const decision = makeDecision(state, this.player);
    this.recordDecision(decision);
    return decision;
  }

  /**
   * Get a summary of the current board evaluation.
   * Useful for UI tooltips or debug display.
   */
  evaluatePosition(state: GameState): {
    boardAdvantage: number;
    threats: number;
    combosReady: number;
  } {
    const boardAdvantage = evaluateBoardPosition(state, this.player);
    const threats = identifyThreats(state, this.player).length;
    const combos = evaluateCombos(state, this.player);
    const combosReady = combos.filter((c) => c.canExecute).length;

    return { boardAdvantage, threats, combosReady };
  }

  /**
   * Get decision history for debugging/replay.
   */
  getDecisionHistory(): Decision[] {
    return [...this.decisions];
  }

  /**
   * Clear decision history.
   */
  resetHistory(): void {
    this.decisions = [];
  }

  /** Record a decision to history */
  private recordDecision(decision: Decision): void {
    this.decisions.push(decision);
    if (this.decisions.length > this.maxHistory) {
      this.decisions.shift();
    }
  }
}
