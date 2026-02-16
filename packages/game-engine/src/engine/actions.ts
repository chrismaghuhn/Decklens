import type { GameState } from '../types/game-state.ts';
import type { GameAction } from '../types/action.ts';
import type { PlayerState } from '../types/player.ts';
import { cardToPermanent } from '../types/permanent.ts';
import { validateAction } from './validation.ts';
import { retainPriorityAfterAction } from '../rules/priority.ts';
import { addSpellToStack, addAbilityToStack } from '../rules/stack.ts';
import { payCost, parseManaCost, canPayCost, autoTapLandsForCost } from '../rules/mana.ts';
import { keepHand, performLondonMulligan, startMulligan } from './factory.ts';
import { passPriority } from '../rules/priority.ts';
import { applyStepEffects } from './turn-manager.ts';

/**
 * Execute a game action and return the new state.
 * Validates the action first, then applies it.
 * Returns unchanged state if action is invalid.
 */
export function executeAction(
  state: GameState,
  action: GameAction
): GameState {
  const error = validateAction(state, action);
  if (error !== null) return state;

  let newState: GameState;

  switch (action.type) {
    case 'pass':
      if (state.mulliganPhase) {
        // Treat pass as 'keep hand' during mulligan phase
        newState = keepHand(state, action.player);
        
        // Check if both kept (copied from mulligan case)
        const keepCount = newState.log.filter(e => e.message && e.message.includes('keeps their hand')).length;
        if (keepCount >= 2) {
             newState = {
              ...newState,
              mulliganPhase: false,
              step: 'draw',
              priorityPlayer: newState.activePlayer,
              bothPlayersPassed: false,
            };
            newState = applyStepEffects(newState);
        }
        return newState;
      }

      // Pass is handled by priority system, just record it
      return {
        ...state,
        actionHistory: [...state.actionHistory, action],
      };

    case 'play-land':
      newState = executePlayLand(state, action);
      break;

    case 'cast-spell':
      newState = executeCastSpell(state, action);
      break;

    case 'activate-ability':
      newState = executeActivateAbility(state, action);
      break;

    case 'declare-attackers':
      newState = executeDeclareAttackers(state, action);
      break;

    case 'declare-blockers':
      newState = executeDeclareBlockers(state, action);
      break;

    case 'mulligan':
      // Handle London Mulligan: keep hand or put cards on bottom
      
      // Sentinel value to trigger a new mulligan (shuffle & draw)
      if (action.toBottom.length === 1 && action.toBottom[0] === 'MULLIGAN') {
         newState = startMulligan(state, action.player);
         break; // startMulligan handles state update and log
      }

      if (action.toBottom.length === 0) {
        // Player keeps their hand
        newState = keepHand(state, action.player);
      } else {
        // Player puts cards on bottom (London mulligan)
        newState = performLondonMulligan(state, action.player, action.toBottom);
      }
      
      // Check if both players have kept their hands - if so, exit mulligan phase
      const bothPlayersKept = newState.log.some(
        entry => entry.message && entry.message.includes('keeps their hand')
      );
      // Count how many "keeps their hand" messages exist
      const keepCount = newState.log.filter(
        entry => entry.message && entry.message.includes('keeps their hand')
      ).length;
      
      // If both players have kept, exit mulligan phase and advance to draw step
      if (keepCount >= 2) {
        newState = {
          ...newState,
          mulliganPhase: false,
          // Move from untap to draw step (skip priority in untap)
          step: 'draw',
          // Active player gets priority in draw step
          priorityPlayer: newState.activePlayer,
          bothPlayersPassed: false,
        };
        // Apply draw step effects (draw a card for active player)
        newState = applyStepEffects(newState);
      }
      
      break;

    case 'concede':
      newState = executeConcede(state, action);
      break;

    default:
      return state;
  }

  // Record action in history
  newState = {
    ...newState,
    actionHistory: [...newState.actionHistory, action],
  };

  // Non-pass, non-concede actions: retain priority for the acting player
  if (action.type !== 'concede') {
    newState = retainPriorityAfterAction(newState);
  }

  return newState;
}

/** Play a land from hand to battlefield. Does NOT use the stack. */
function executePlayLand(
  state: GameState,
  action: Extract<GameAction, { type: 'play-land' }>
): GameState {
  const player = state.players[action.player];
  const cardIndex = player.hand.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) return state;

  const card = player.hand[cardIndex];
  const permanent = cardToPermanent(card, action.player, state.turn);
  permanent.summoningSick = false; // Lands don't have summoning sickness

  const updatedPlayer: PlayerState = {
    ...player,
    hand: [...player.hand.slice(0, cardIndex), ...player.hand.slice(cardIndex + 1)],
    battlefield: [...player.battlefield, permanent],
    landPlayedThisTurn: true,
    landsPlayedThisTurn: player.landsPlayedThisTurn + 1,
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

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
        player: action.player,
        message: `${player.name} plays ${card.name}.`,
        cardName: card.name,
        actionType: 'play-land',
      },
    ],
  };
}

/** Cast a spell: pay mana, put on stack. */
function executeCastSpell(
  state: GameState,
  action: Extract<GameAction, { type: 'cast-spell' }>
): GameState {
  let player = state.players[action.player];
  const card = player.hand.find((c) => c.id === action.cardId);
  if (!card) return state;

  // Pay mana (auto-tap if needed)
  const cost = parseManaCost(card.manaCost);
  let payment = action.manaPayment;

  if (!canPayCost(player.manaPool, cost, player.life)) {
    const tapResult = autoTapLandsForCost(player, cost);
    if (tapResult) {
      player = tapResult.updatedPlayer;
      payment = tapResult.payment;
    }
  }

  const newPool = payCost(player.manaPool, cost, payment);

  const updatedPlayer = { ...player, manaPool: newPool };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  let newState: GameState = { ...state, players };

  // Add to stack
  newState = addSpellToStack(newState, action.cardId, action.player, action.targets, action.manaPayment);

  return newState;
}

/** Activate an ability: put on stack. */
function executeActivateAbility(
  state: GameState,
  action: Extract<GameAction, { type: 'activate-ability' }>
): GameState {
  return addAbilityToStack(state, action.sourceId, action.abilityIndex, action.player, action.targets);
}

/** Declare attackers: mark creatures as attacking and tap them.
 *  CRITICAL FIX: Creatures with vigilance don't tap when attacking
 */
function executeDeclareAttackers(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-attackers' }>
): GameState {
  const player = state.players[action.player];
  const defenderId: 0 | 1 = action.player === 0 ? 1 : 0;

  const updatedBattlefield = player.battlefield.map((perm) => {
    if (action.attackers.includes(perm.id)) {
      // Check for vigilance keyword
      const hasVigilance = perm.oracleText?.toLowerCase().includes('vigilance') ?? false;
      return { 
        ...perm, 
        attacking: true, 
        tapped: !hasVigilance  // Don't tap if has vigilance
      };
    }
    return perm;
  });

  const updatedPlayer = { ...player, battlefield: updatedBattlefield };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  const attackers = action.attackers.map((id) => ({ permanentId: id, defenderId }));
  const combat = {
    ...(state.combat || { blockers: [], currentStep: 'declare-attackers' as const }),
    attackers,
    currentStep: 'declare-attackers' as const,
  };

  const attackerNames = action.attackers
    .map((id) => player.battlefield.find((p) => p.id === id)?.name || id)
    .join(', ');

  return {
    ...state,
    players,
    combat,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: action.player,
        message: `${player.name} attacks with ${attackerNames}.`,
        actionType: 'declare-attackers',
      },
    ],
  };
}

/** Declare blockers: assign blocking creatures. */
function executeDeclareBlockers(
  state: GameState,
  action: Extract<GameAction, { type: 'declare-blockers' }>
): GameState {
  if (!state.combat) return state;

  const player = state.players[action.player];

  const updatedBattlefield = player.battlefield.map((perm) => {
    const block = action.blocks.find((b) => b.blocker === perm.id);
    if (block) return { ...perm, blocking: block.attacker };
    return perm;
  });

  const updatedPlayer = { ...player, battlefield: updatedBattlefield };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[action.player] = updatedPlayer;

  const blockers = action.blocks.map((b) => ({ permanentId: b.blocker, blockingId: b.attacker }));
  const combat = { ...state.combat, blockers, currentStep: 'declare-blockers' as const };

  const blockDescriptions = action.blocks
    .map((b) => player.battlefield.find((p) => p.id === b.blocker)?.name || b.blocker)
    .join(', ');

  return {
    ...state,
    players,
    combat,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: action.player,
        message: blockDescriptions
          ? `${player.name} blocks with ${blockDescriptions}.`
          : `${player.name} declares no blockers.`,
        actionType: 'declare-blockers',
      },
    ],
  };
}

/** Concede the game. */
function executeConcede(
  state: GameState,
  action: Extract<GameAction, { type: 'concede' }>
): GameState {
  const winner: 0 | 1 = action.player === 0 ? 1 : 0;

  return {
    ...state,
    winner,
    gameOver: true,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player: action.player,
        message: `${state.players[action.player].name} concedes. ${state.players[winner].name} wins!`,
        actionType: 'concede',
      },
    ],
  };
}
