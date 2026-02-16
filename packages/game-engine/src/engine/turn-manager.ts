import type { GameState, Phase, Step } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import { PHASES, PHASE_STEPS } from '../types/game-state.ts';
import { emptyManaPool } from '../types/player.ts';


/**
 * Get the next step within the current phase.
 * Returns null if we're at the last step of the phase.
 */
export function getNextStep(phase: Phase, currentStep: Step): Step | null {
  const steps = PHASE_STEPS[phase];
  const idx = steps.indexOf(currentStep);
  if (idx === -1 || idx >= steps.length - 1) return null;
  return steps[idx + 1];
}

/**
 * Get the next phase after the current one.
 * Returns null if we're at the ending phase (need new turn).
 */
export function getNextPhase(currentPhase: Phase): Phase | null {
  const idx = PHASES.indexOf(currentPhase);
  if (idx === -1 || idx >= PHASES.length - 1) return null;
  return PHASES[idx + 1];
}

/**
 * Advance to the next step within the current phase.
 * If at end of phase, advances to next phase's first step.
 * If at end of turn, starts a new turn.
 */
export function advanceStep(state: GameState): GameState {
  const nextStep = getNextStep(state.phase, state.step);

  if (nextStep !== null) {
    // Stay in same phase, move to next step
    return applyStepEffects({
      ...state,
      step: nextStep,
      bothPlayersPassed: false,
    });
  }

  // End of phase -> advance to next phase
  return advancePhase(state);
}

/**
 * Advance to the next phase (first step of that phase).
 * If at ending phase, starts a new turn.
 */
export function advancePhase(state: GameState): GameState {
  const nextPhase = getNextPhase(state.phase);

  if (nextPhase !== null) {
    const firstStep = PHASE_STEPS[nextPhase][0];
    return applyStepEffects({
      ...state,
      phase: nextPhase,
      step: firstStep,
      bothPlayersPassed: false,
      combat: nextPhase === 'combat' ? {
        attackers: [],
        blockers: [],
        currentStep: 'begin',
      } : state.combat,
    });
  }

  // End of turn -> start new turn
  return startNewTurn(state);
}

/**
 * Start a new turn for the next player.
 * Handles: untap, reset turn state, mana pool empty, draw.
 */
export function startNewTurn(state: GameState): GameState {
  const nextActivePlayer: 0 | 1 = state.activePlayer === 0 ? 1 : 0;
  const newTurn = state.activePlayer === 1 ? state.turn + 1 : state.turn;

  // Reset active player's turn state
  const players = [...state.players] as [PlayerState, PlayerState];

  // Untap all permanents for the new active player
  players[nextActivePlayer] = {
    ...players[nextActivePlayer],
    battlefield: players[nextActivePlayer].battlefield.map((p) => ({
      ...p,
      tapped: false,
      summoningSick:
        p.enteredBattlefieldTurn === newTurn ? true : false,
      attacking: false,
      blocking: null,
    })),
    landPlayedThisTurn: false,
    landsPlayedThisTurn: 0,
    maxLandPlays: 1,
    manaPool: emptyManaPool(),
  };

  // Empty the other player's mana pool too
  const otherPlayer: 0 | 1 = nextActivePlayer === 0 ? 1 : 0;
  players[otherPlayer] = {
    ...players[otherPlayer],
    manaPool: emptyManaPool(),
  };

  const newState: GameState = {
    ...state,
    players,
    activePlayer: nextActivePlayer,
    priorityPlayer: nextActivePlayer,
    turn: newTurn,
    phase: 'beginning',
    step: 'untap',
    stack: [],
    combat: null,
    bothPlayersPassed: false,
    mulliganPhase: false, // Ensure mulligan phase is over for new turns
  };

  return applyStepEffects(newState);
}

/**
 * Apply automatic effects when entering a step.
 * Untap step: untap is already handled in startNewTurn.
 * Draw step: draw a card (skip for first player's first turn).
 */
export function applyStepEffects(state: GameState): GameState {
  
  if (state.step === 'draw') {
    const activePlayer = state.players[state.activePlayer];

    // First player skips their first draw
    if (state.turn === 1 && state.activePlayer === 0 && !activePlayer.hasDrawnThisGame) {
      const players = [...state.players] as [PlayerState, PlayerState];
      players[state.activePlayer] = {
        ...players[state.activePlayer],
        hasDrawnThisGame: true,
      };
      return {
        ...state,
        players,
        log: [
          ...state.log,
          {
            timestamp: Date.now(),
            turn: state.turn,
            phase: state.phase,
            step: state.step,
            player: state.activePlayer,
            message: `${activePlayer.name} skips first draw.`,
          },
        ],
      };
    }

    // Normal draw
    if (activePlayer.library.length > 0) {
      const drawnCard = activePlayer.library[0];
      const players = [...state.players] as [PlayerState, PlayerState];
      players[state.activePlayer] = {
        ...players[state.activePlayer],
        library: players[state.activePlayer].library.slice(1),
        hand: [...players[state.activePlayer].hand, drawnCard],
        hasDrawnThisGame: true,
      };
      return {
        ...state,
        players,
        log: [
          ...state.log,
          {
            timestamp: Date.now(),
            turn: state.turn,
            phase: state.phase,
            step: state.step,
            player: state.activePlayer,
            message: `${activePlayer.name} draws a card.`,
            cardName: drawnCard.name,
          },
        ],
      };
    }

    // Empty library = lose (handled by state-based actions in Week 3)
    return state;
  }

  // Combat Damage Steps: Damage is resolved by Game.resolveCombat() called by UI/bot
  // NOT automatically here to avoid double resolution
  // CRITICAL FIX: Removed duplicate combat damage resolution
  // The damage is resolved in Game.resolveCombat() which is called explicitly

  // Cleanup step: discard to hand size, remove damage, etc.
  if (state.step === 'cleanup') {
    const players = [...state.players] as [PlayerState, PlayerState];
    const active = players[state.activePlayer];

    // Remove damage from creatures
    players[state.activePlayer] = {
      ...active,
      battlefield: active.battlefield.map((p) => ({
        ...p,
        damage: 0,
      })),
    };

    return { ...state, players };
  }

  return state;
}

/**
 * Get the actions that are generally allowed in the current step.
 * This is a high-level list; actual legality depends on game state.
 */
export function getCurrentStepActions(state: GameState): string[] {
  const actions: string[] = ['pass'];

  switch (state.step) {
    case 'untap':
      // Allow mulligan during mulligan phase
      if (state.mulliganPhase) {
        actions.push('mulligan');
      }
      return actions;

    case 'upkeep':
      if (state.mulliganPhase) actions.push('mulligan');
      actions.push('cast-instant', 'activate-ability');
      break;

    case 'draw':
      if (state.mulliganPhase) actions.push('mulligan');
      actions.push('cast-instant', 'activate-ability');
      break;

    case 'main':
      actions.push(
        'play-land',
        'cast-spell',
        'activate-ability'
      );
      break;

    case 'begin-combat':
      actions.push('cast-instant', 'activate-ability');
      break;

    case 'declare-attackers':
      if (state.activePlayer === state.priorityPlayer) {
        actions.push('declare-attackers');
      }
      actions.push('cast-instant', 'activate-ability');
      break;

    case 'declare-blockers':
      if (state.activePlayer !== state.priorityPlayer) {
        actions.push('declare-blockers');
      }
      actions.push('cast-instant', 'activate-ability');
      break;

    case 'first-strike-damage':
    case 'combat-damage':
      actions.push('cast-instant', 'activate-ability');
      break;

    case 'end-combat':
      actions.push('cast-instant', 'activate-ability');
      break;

    case 'end':
      actions.push('cast-instant', 'activate-ability');
      break;

    case 'cleanup':
      // Normally no actions during cleanup
      return [];
  }

  return actions;
}

/**
 * Create the initial game state from two player states.
 */
export function createInitialGameState(
  player1: PlayerState,
  player2: PlayerState
): GameState {
  return {
    players: [player1, player2],
    activePlayer: 0,
    priorityPlayer: 0,
    turn: 1,
    phase: 'beginning',
    step: 'untap',
    stack: [],
    combat: null,
    winner: null,
    gameOver: false,
    log: [
      {
        timestamp: Date.now(),
        turn: 1,
        phase: 'beginning',
        step: 'untap',
        player: null,
        message: 'Game started!',
      },
    ],
    actionHistory: [],
    bothPlayersPassed: false,
    mulliganPhase: true,
    mulliganCount: [0, 0],
  };
}
