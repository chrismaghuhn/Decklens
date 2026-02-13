import type { GameState } from '../types/game-state.ts';
import type { StackObject, Target } from '../types/action.ts';
import type { Card } from '../types/card.ts';
import type { Permanent } from '../types/permanent.ts';
import type { ManaPayment } from '../types/mana.ts';
import type { PlayerState } from '../types/player.ts';
import { giveActivePlayerPriority } from './priority.ts';

let nextStackId = 0;

/** Reset stack ID counter (for tests) */
export function resetStackIdCounter(): void {
  nextStackId = 0;
}

/** Generate a unique stack object ID */
function generateStackId(): string {
  return `stack_${++nextStackId}_${Date.now().toString(36)}`;
}

/**
 * Add a spell to the stack.
 * The card is removed from hand and tracked in the StackObject.
 */
export function addSpellToStack(
  state: GameState,
  cardId: string,
  player: 0 | 1,
  targets: Target[],
  _manaPayment: ManaPayment
): GameState {
  const playerState = state.players[player];
  const cardIndex = playerState.hand.findIndex((c) => c.id === cardId);
  if (cardIndex === -1) return state;

  const card = playerState.hand[cardIndex];

  const stackObject: StackObject = {
    id: generateStackId(),
    type: 'spell',
    card,
    controller: player,
    targets,
    text: card.name,
  };

  // Remove card from hand
  const updatedPlayer = {
    ...playerState,
    hand: [
      ...playerState.hand.slice(0, cardIndex),
      ...playerState.hand.slice(cardIndex + 1),
    ],
  };

  const players = [...state.players] as [PlayerState, PlayerState];
  players[player] = updatedPlayer;

  return {
    ...state,
    players,
    stack: [...state.stack, stackObject],
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message: `${playerState.name} casts ${card.name}.`,
        cardName: card.name,
        actionType: 'cast-spell',
      },
    ],
  };
}

/**
 * Add an activated ability to the stack.
 */
export function addAbilityToStack(
  state: GameState,
  sourceId: string,
  abilityIndex: number,
  player: 0 | 1,
  targets: Target[]
): GameState {
  const playerState = state.players[player];
  const source = playerState.battlefield.find((p) => p.id === sourceId);
  if (!source) return state;

  const ability = source.abilities[abilityIndex];
  if (!ability) return state;

  const stackObject: StackObject = {
    id: generateStackId(),
    type: 'ability',
    source,
    controller: player,
    targets,
    text: `${source.name}: ${ability.text}`,
  };

  return {
    ...state,
    stack: [...state.stack, stackObject],
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message: `${playerState.name} activates ${source.name}'s ability.`,
        cardName: source.name,
        actionType: 'activate-ability',
      },
    ],
  };
}

/**
 * Resolve the top object on the stack (LIFO).
 *
 * Spells: permanent types go to battlefield, instants/sorceries go to graveyard.
 * Abilities: effect is logged (actual effect execution is future work).
 *
 * After resolution, active player gets priority.
 */
export function resolveTopOfStack(state: GameState): GameState {
  if (state.stack.length === 0) return state;

  const stackCopy = [...state.stack];
  const resolving = stackCopy.pop()!;
  let newState: GameState = { ...state, stack: stackCopy };

  if (resolving.type === 'spell' && resolving.card) {
    const card = resolving.card;
    const controller = resolving.controller;

    if (isPermanentType(card)) {
      // Permanent spell → battlefield
      const permanent = createPermanentFromCard(card, controller, newState.turn);
      const players = [...newState.players] as [PlayerState, PlayerState];
      players[controller] = {
        ...players[controller],
        battlefield: [...players[controller].battlefield, permanent],
      };
      newState = { ...newState, players };
    } else {
      // Instant/Sorcery → graveyard
      const players = [...newState.players] as [PlayerState, PlayerState];
      players[controller] = {
        ...players[controller],
        graveyard: [...players[controller].graveyard, card],
      };
      newState = { ...newState, players };
    }

    newState = {
      ...newState,
      log: [
        ...newState.log,
        {
          timestamp: Date.now(),
          turn: newState.turn,
          phase: newState.phase,
          step: newState.step,
          player: controller,
          message: `${card.name} resolves.`,
          cardName: card.name,
        },
      ],
    };
  } else if (resolving.type === 'ability') {
    newState = {
      ...newState,
      log: [
        ...newState.log,
        {
          timestamp: Date.now(),
          turn: newState.turn,
          phase: newState.phase,
          step: newState.step,
          player: resolving.controller,
          message: `Ability resolves: ${resolving.text}`,
        },
      ],
    };
  }

  return giveActivePlayerPriority(newState);
}

/** Check if a card type represents a permanent */
function isPermanentType(card: Card): boolean {
  const tl = card.typeLine.toLowerCase();
  return (
    tl.includes('creature') ||
    tl.includes('artifact') ||
    tl.includes('enchantment') ||
    tl.includes('planeswalker') ||
    tl.includes('battle')
  );
}

/** Create a Permanent from a Card (inline to avoid circular import with permanent.ts) */
function createPermanentFromCard(
  card: Card,
  controller: 0 | 1,
  turn: number
): Permanent {
  return {
    ...card,
    controller,
    tapped: false,
    flipped: false,
    faceDown: false,
    currentPower: card.power ? parseInt(card.power, 10) || 0 : undefined,
    currentToughness: card.toughness ? parseInt(card.toughness, 10) || 0 : undefined,
    damage: 0,
    currentLoyalty: card.loyalty ? parseInt(card.loyalty, 10) || 0 : undefined,
    counters: {},
    summoningSick: true,
    attacking: false,
    blocking: null,
    abilities: [],
    x: 0,
    y: 0,
    enteredBattlefieldTurn: turn,
  };
}

/** Get the number of objects on the stack */
export function getStackSize(state: GameState): number {
  return state.stack.length;
}

/** Check if the stack is empty */
export function isStackEmpty(state: GameState): boolean {
  return state.stack.length === 0;
}

/** Peek at the top of the stack without removing */
export function peekStack(state: GameState): StackObject | null {
  if (state.stack.length === 0) return null;
  return state.stack[state.stack.length - 1];
}
