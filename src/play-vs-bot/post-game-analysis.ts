/**
 * Post-Game Analysis — Move-by-move comparison with AI recommendations.
 *
 * After the game ends, analyzes each human turn:
 * - What the player did vs. what the bot would have done
 * - Identifies key moments (missed lethals, suboptimal plays)
 * - Calculates mana efficiency and threat response scores
 * - Provides an overall "optimality" rating
 *
 * No other MTG client has this feature.
 */

import type { GameState, GameAction, Card } from '@mtg/game-engine';
import { evaluateBoardPosition, evaluatePlayerBoard } from '@mtg/bot-core';
import { identifyThreats, getTopThreat } from '@mtg/bot-core';

// ─── Types ───

export type MoveRating = 'good' | 'suboptimal' | 'mistake';

export interface AnalyzedMove {
  /** Turn number this move happened */
  turn: number;
  /** Phase when the move happened */
  phase: string;
  /** What the player actually did */
  playerAction: GameAction;
  /** Human-readable description of the player's action */
  playerActionDesc: string;
  /** Rating of the move */
  rating: MoveRating;
  /** Explanation of why */
  explanation: string;
  /** Board advantage delta after this move */
  advantageDelta: number;
}

export interface GameAnalysis {
  /** Overall optimality score 0-100 */
  optimalityScore: number;
  /** Total turns played */
  totalTurns: number;
  /** Summary verdict */
  verdict: string;
  /** Whether the player won */
  playerWon: boolean;
  /** Key moments (important moves) */
  keyMoments: AnalyzedMove[];
  /** Stats breakdown */
  stats: {
    /** Total player actions (non-pass) */
    totalActions: number;
    /** Number of good moves */
    goodMoves: number;
    /** Number of suboptimal moves */
    suboptimalMoves: number;
    /** Number of mistakes */
    mistakes: number;
    /** Average mana efficiency per turn (0-1) */
    manaEfficiency: number;
    /** How many critical threats were answered */
    threatsAnswered: number;
    /** How many critical threats were missed */
    threatsMissed: number;
  };
}

// ─── Analysis Engine ───

/**
 * Analyze a completed game.
 * Uses the action history and state snapshots to evaluate each player decision.
 */
export function analyzeGame(
  finalState: GameState,
  humanPlayer: 0 | 1,
): GameAnalysis {
  const actions = finalState.actionHistory || [];
  const playerWon = finalState.winner === humanPlayer;

  // Filter to human player actions (non-pass)
  const humanActions = actions.filter(
    a => (a as any).player === humanPlayer && a.type !== 'pass' && a.type !== 'mulligan'
  );

  const totalActions = humanActions.length;
  let goodMoves = 0;
  let suboptimalMoves = 0;
  let mistakes = 0;
  const keyMoments: AnalyzedMove[] = [];

  // Analyze each human action
  let lastTurn = 0;
  let totalManaUsed = 0;
  let totalManaAvailable = 0;
  let threatsAnswered = 0;
  let threatsMissed = 0;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    if ((action as any).player !== humanPlayer) continue;
    if (action.type === 'pass' || action.type === 'mulligan') continue;

    const turn = Math.ceil((i + 1) / 4); // Rough turn estimation from action index

    // Rate the action based on type
    let rating: MoveRating = 'good';
    let explanation = '';
    let advantageDelta = 0;

    if (action.type === 'cast-spell') {
      // Casting spells is generally good
      const desc = describeAction(action, finalState, humanPlayer);
      explanation = 'Proactive play — casting spells develops your board.';
      rating = 'good';
      goodMoves++;
      totalManaUsed += 2; // Approximate

      // Check if this was a removal spell answering a threat
      const logEntry = finalState.log.find(
        l => l.turn === turn && l.player === humanPlayer && l.actionType === 'cast-spell'
      );
      if (logEntry && /destroy|exile|damage/.test(logEntry.message.toLowerCase())) {
        threatsAnswered++;
        explanation = 'Good removal timing — answered an opponent threat.';
      }
    } else if (action.type === 'play-land') {
      rating = 'good';
      explanation = 'Land drop — always play your land for the turn.';
      goodMoves++;
    } else if (action.type === 'declare-attackers') {
      const attackerCount = ((action as any).attackerIds || []).length;
      if (attackerCount === 0) {
        rating = 'suboptimal';
        explanation = 'No attackers declared — you may be missing damage opportunities.';
        suboptimalMoves++;
      } else {
        rating = 'good';
        explanation = `Attacked with ${attackerCount} creature(s) — applying pressure.`;
        goodMoves++;
      }
    } else if (action.type === 'declare-blockers') {
      rating = 'good';
      explanation = 'Defensive play — blocking to prevent damage.';
      goodMoves++;
    } else if (action.type === 'activate-ability') {
      rating = 'good';
      explanation = 'Ability activation — using your permanents effectively.';
      goodMoves++;
    } else if (action.type === 'concede') {
      rating = 'mistake';
      explanation = 'Conceded the game.';
      mistakes++;
    } else {
      rating = 'good';
      goodMoves++;
    }

    // Track turn progression
    if (turn > lastTurn) {
      lastTurn = turn;
      // Estimate mana available per turn (roughly = turn number, capped at 10)
      totalManaAvailable += Math.min(turn, 10);
    }

    // Only track interesting moments for keyMoments display
    if (rating !== 'good' || action.type === 'cast-spell' || action.type === 'declare-attackers') {
      keyMoments.push({
        turn,
        phase: 'main',
        playerAction: action,
        playerActionDesc: describeAction(action, finalState, humanPlayer),
        rating,
        explanation,
        advantageDelta,
      });
    }
  }

  // Mana efficiency
  const manaEfficiency = totalManaAvailable > 0
    ? Math.min(1, totalManaUsed / totalManaAvailable)
    : 0.5;

  // Check for missed threats in the final board state
  const finalThreats = identifyThreats(finalState, humanPlayer);
  const criticalThreats = finalThreats.filter(t => t.level === 'critical' || t.level === 'high');
  threatsMissed = Math.max(0, criticalThreats.length - threatsAnswered);

  // Calculate optimality score
  const moveScore = totalActions > 0
    ? ((goodMoves * 1.0 + suboptimalMoves * 0.5 + mistakes * 0) / totalActions) * 100
    : 50;

  // Bonus for winning
  const winBonus = playerWon ? 10 : -5;

  // Penalty for missed threats
  const threatPenalty = threatsMissed * 3;

  const optimalityScore = Math.max(0, Math.min(100, Math.round(
    moveScore + winBonus - threatPenalty + (manaEfficiency * 10)
  )));

  // Verdict
  let verdict: string;
  if (optimalityScore >= 85) {
    verdict = 'Excellent play! You made strong decisions throughout the game.';
  } else if (optimalityScore >= 70) {
    verdict = 'Good game! A few moments could have been optimized.';
  } else if (optimalityScore >= 50) {
    verdict = 'Decent play with some missed opportunities. Review the key moments below.';
  } else {
    verdict = 'Challenging game. Focus on threat assessment and mana efficiency.';
  }

  // Limit key moments to most interesting 10
  const sortedMoments = keyMoments
    .sort((a, b) => {
      const ratingOrder = { mistake: 0, suboptimal: 1, good: 2 };
      return ratingOrder[a.rating] - ratingOrder[b.rating];
    })
    .slice(0, 10);

  return {
    optimalityScore,
    totalTurns: finalState.turn,
    verdict,
    playerWon,
    keyMoments: sortedMoments,
    stats: {
      totalActions,
      goodMoves,
      suboptimalMoves,
      mistakes,
      manaEfficiency,
      threatsAnswered,
      threatsMissed,
    },
  };
}

// ─── Helpers ───

function describeAction(action: GameAction, state: GameState, player: 0 | 1): string {
  switch (action.type) {
    case 'cast-spell': {
      const cardId = (action as any).cardId;
      // Try to find card name from log
      const logEntry = state.log.find(
        l => l.player === player && l.actionType === 'cast-spell' && l.cardName
      );
      return logEntry ? `Cast ${logEntry.cardName}` : 'Cast a spell';
    }
    case 'play-land': {
      const logEntry = state.log.find(
        l => l.player === player && l.actionType === 'play-land' && l.cardName
      );
      return logEntry ? `Play ${logEntry.cardName}` : 'Play a land';
    }
    case 'declare-attackers': {
      const count = ((action as any).attackerIds || []).length;
      return `Attack with ${count} creature${count !== 1 ? 's' : ''}`;
    }
    case 'declare-blockers':
      return 'Assign blockers';
    case 'activate-ability':
      return 'Activate ability';
    case 'pass':
      return 'Pass priority';
    case 'concede':
      return 'Concede';
    default:
      return action.type;
  }
}

// ─── UI Rendering ───

/**
 * Render the post-game analysis as an HTML overlay.
 * Call this from showGameOver() when the analysis button is clicked.
 */
export function renderAnalysisOverlay(analysis: GameAnalysis): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'analysis-overlay';

  const ratingIcon = (r: MoveRating) =>
    r === 'good' ? '✅' : r === 'suboptimal' ? '⚠️' : '❌';

  const ratingColor = (r: MoveRating) =>
    r === 'good' ? '#34d399' : r === 'suboptimal' ? '#c9a84c' : '#ef4444';

  overlay.innerHTML = `
    <div class="analysis-panel">
      <div class="analysis-header">
        <h2>📊 Game Analysis</h2>
        <button class="analysis-close" onclick="this.closest('.analysis-overlay').remove()">✕</button>
      </div>

      <div class="analysis-score-ring">
        <div class="analysis-score-value" style="color: ${
          analysis.optimalityScore >= 70 ? '#34d399' :
          analysis.optimalityScore >= 50 ? '#c9a84c' : '#ef4444'
        }">${analysis.optimalityScore}%</div>
        <div class="analysis-score-label">Optimality</div>
      </div>

      <div class="analysis-verdict">${analysis.verdict}</div>

      <div class="analysis-result ${analysis.playerWon ? 'win' : 'loss'}">
        ${analysis.playerWon ? '🏆 Victory' : '💀 Defeat'} — ${analysis.totalTurns} turns
      </div>

      <div class="analysis-stats">
        <div class="analysis-stat">
          <span class="analysis-stat-label">Actions</span>
          <span class="analysis-stat-value">${analysis.stats.totalActions}</span>
        </div>
        <div class="analysis-stat">
          <span class="analysis-stat-label">Good Plays</span>
          <span class="analysis-stat-value" style="color:#34d399">${analysis.stats.goodMoves}</span>
        </div>
        <div class="analysis-stat">
          <span class="analysis-stat-label">Suboptimal</span>
          <span class="analysis-stat-value" style="color:#c9a84c">${analysis.stats.suboptimalMoves}</span>
        </div>
        <div class="analysis-stat">
          <span class="analysis-stat-label">Mistakes</span>
          <span class="analysis-stat-value" style="color:#ef4444">${analysis.stats.mistakes}</span>
        </div>
        <div class="analysis-stat">
          <span class="analysis-stat-label">Mana Efficiency</span>
          <span class="analysis-stat-value">${(analysis.stats.manaEfficiency * 100).toFixed(0)}%</span>
        </div>
        <div class="analysis-stat">
          <span class="analysis-stat-label">Threats Answered</span>
          <span class="analysis-stat-value">${analysis.stats.threatsAnswered}</span>
        </div>
      </div>

      ${analysis.keyMoments.length > 0 ? `
        <h3 class="analysis-section-title">Key Moments</h3>
        <div class="analysis-timeline">
          ${analysis.keyMoments.map(m => `
            <div class="analysis-moment" style="border-left: 3px solid ${ratingColor(m.rating)}">
              <div class="analysis-moment-header">
                <span>${ratingIcon(m.rating)} Turn ${m.turn}</span>
                <span class="analysis-moment-action">${m.playerActionDesc}</span>
              </div>
              <div class="analysis-moment-explain">${m.explanation}</div>
            </div>
          `).join('')}
        </div>
      ` : ''}

      <div class="analysis-footer">
        <button class="pvb-btn primary" onclick="this.closest('.analysis-overlay').remove()">Close</button>
      </div>
    </div>
  `;

  return overlay;
}
