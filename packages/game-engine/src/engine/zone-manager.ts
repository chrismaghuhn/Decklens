import type { Card } from '../types/card.ts';
import type { Permanent } from '../types/permanent.ts';
import type { GameState } from '../types/game-state.ts';
import type { Zone } from '../types/zones.ts';
import { cardToPermanent } from '../types/permanent.ts';

/**
 * Fisher-Yates shuffle for arrays (returns new array).
 */
function shuffle<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Get all cards in a specific zone for a player.
 * For battlefield, returns Permanent[] (which extends Card).
 */
export function getCardsInZone(
  state: GameState,
  zone: Zone,
  player: number
): Card[] {
  const playerState = state.players[player];

  switch (zone) {
    case 'library':
      return playerState.library;
    case 'hand':
      return playerState.hand;
    case 'battlefield':
      return playerState.battlefield;
    case 'graveyard':
      return playerState.graveyard;
    case 'exile':
      return playerState.exile;
    case 'commandZone':
      return playerState.commandZone;
    case 'stack':
      return state.stack
        .filter((s) => s.controller === player && s.card)
        .map((s) => s.card!);
    default:
      return [];
  }
}

/**
 * Find a card by ID across all zones for a player.
 * Returns the zone and index if found.
 */
export function findCard(
  state: GameState,
  cardId: string,
  player: number
): { zone: Zone; index: number; card: Card } | null {
  const playerState = state.players[player];
  const zones: { zone: Zone; cards: Card[] }[] = [
    { zone: 'library', cards: playerState.library },
    { zone: 'hand', cards: playerState.hand },
    { zone: 'battlefield', cards: playerState.battlefield },
    { zone: 'graveyard', cards: playerState.graveyard },
    { zone: 'exile', cards: playerState.exile },
    { zone: 'commandZone', cards: playerState.commandZone },
  ];

  for (const { zone, cards } of zones) {
    const index = cards.findIndex((c) => c.id === cardId);
    if (index !== -1) {
      return { zone, index, card: cards[index] };
    }
  }

  return null;
}

/**
 * Move a card from one zone to another for a player.
 * Handles Permanent creation when moving to battlefield.
 * Returns updated GameState.
 */
export function moveCard(
  state: GameState,
  cardId: string,
  fromZone: Zone,
  toZone: Zone,
  player: number
): GameState {
  const playerState = state.players[player];

  // Remove card from source zone
  let card: Card | null = null;
  const updatedPlayer = { ...playerState };

  switch (fromZone) {
    case 'library': {
      const idx = updatedPlayer.library.findIndex((c) => c.id === cardId);
      if (idx === -1) return state;
      card = updatedPlayer.library[idx];
      updatedPlayer.library = [
        ...updatedPlayer.library.slice(0, idx),
        ...updatedPlayer.library.slice(idx + 1),
      ];
      break;
    }
    case 'hand': {
      const idx = updatedPlayer.hand.findIndex((c) => c.id === cardId);
      if (idx === -1) return state;
      card = updatedPlayer.hand[idx];
      updatedPlayer.hand = [
        ...updatedPlayer.hand.slice(0, idx),
        ...updatedPlayer.hand.slice(idx + 1),
      ];
      break;
    }
    case 'battlefield': {
      const idx = updatedPlayer.battlefield.findIndex((c) => c.id === cardId);
      if (idx === -1) return state;
      card = updatedPlayer.battlefield[idx];
      updatedPlayer.battlefield = [
        ...updatedPlayer.battlefield.slice(0, idx),
        ...updatedPlayer.battlefield.slice(idx + 1),
      ];
      break;
    }
    case 'graveyard': {
      const idx = updatedPlayer.graveyard.findIndex((c) => c.id === cardId);
      if (idx === -1) return state;
      card = updatedPlayer.graveyard[idx];
      updatedPlayer.graveyard = [
        ...updatedPlayer.graveyard.slice(0, idx),
        ...updatedPlayer.graveyard.slice(idx + 1),
      ];
      break;
    }
    case 'exile': {
      const idx = updatedPlayer.exile.findIndex((c) => c.id === cardId);
      if (idx === -1) return state;
      card = updatedPlayer.exile[idx];
      updatedPlayer.exile = [
        ...updatedPlayer.exile.slice(0, idx),
        ...updatedPlayer.exile.slice(idx + 1),
      ];
      break;
    }
    case 'commandZone': {
      const idx = updatedPlayer.commandZone.findIndex((c) => c.id === cardId);
      if (idx === -1) return state;
      card = updatedPlayer.commandZone[idx];
      updatedPlayer.commandZone = [
        ...updatedPlayer.commandZone.slice(0, idx),
        ...updatedPlayer.commandZone.slice(idx + 1),
      ];
      break;
    }
    default:
      return state;
  }

  if (!card) return state;

  // Add card to destination zone
  switch (toZone) {
    case 'library':
      updatedPlayer.library = [...updatedPlayer.library, card];
      break;
    case 'hand':
      updatedPlayer.hand = [...updatedPlayer.hand, card];
      break;
    case 'battlefield': {
      const permanent = cardToPermanent(card, player, state.turn);
      updatedPlayer.battlefield = [...updatedPlayer.battlefield, permanent];
      break;
    }
    case 'graveyard':
      updatedPlayer.graveyard = [...updatedPlayer.graveyard, card];
      break;
    case 'exile':
      updatedPlayer.exile = [...updatedPlayer.exile, card];
      break;
    case 'commandZone':
      updatedPlayer.commandZone = [...updatedPlayer.commandZone, card];
      break;
    default:
      return state;
  }

  const players = [...state.players];
  players[player] = updatedPlayer;

  return { ...state, players };
}

/**
 * Draw a single card from library to hand.
 * Returns updated state. If library is empty, returns state unchanged
 * (state-based actions will handle the loss condition).
 */
export function drawCard(state: GameState, player: number): GameState {
  // Track first draw this turn for Miracle
  if (!state.firstDrawThisTurn) {
    state = { ...state, firstDrawThisTurn: true };
  }

  const playerState = state.players[player];
  if (playerState.library.length === 0) return state;

  const drawnCard = playerState.library[0];
  const updatedPlayer = {
    ...playerState,
    library: playerState.library.slice(1),
    hand: [...playerState.hand, drawnCard],
    hasDrawnThisGame: true, // CR 704.5b: track draw attempts for empty-library SBA
  };

  const players = [...state.players];
  players[player] = updatedPlayer;

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
        player,
        message: `${playerState.name} draws ${drawnCard.name}.`,
        cardName: drawnCard.name,
      },
    ],
  };
}

/**
 * Draw multiple cards from library to hand.
 */
export function drawCards(
  state: GameState,
  player: number,
  count: number
): GameState {
  let currentState = state;
  for (let i = 0; i < count; i++) {
    const before = currentState.players[player].library.length;
    currentState = drawCard(currentState, player);
    // Stop if library was empty
    if (currentState.players[player].library.length === before) break;
  }
  return currentState;
}

/**
 * Shuffle a player's library.
 */
export function shuffleLibrary(state: GameState, player: number): GameState {
  const playerState = state.players[player];
  const updatedPlayer = {
    ...playerState,
    library: shuffle(playerState.library),
  };

  const players = [...state.players];
  players[player] = updatedPlayer;

  return { ...state, players };
}

/**
 * Mill cards from library to graveyard.
 */
export function millCards(
  state: GameState,
  player: number,
  count: number
): GameState {
  const playerState = state.players[player];
  const toMill = Math.min(count, playerState.library.length);
  const milledCards = playerState.library.slice(0, toMill);

  const updatedPlayer = {
    ...playerState,
    library: playerState.library.slice(toMill),
    graveyard: [...playerState.graveyard, ...milledCards],
  };

  const players = [...state.players];
  players[player] = updatedPlayer;

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
        player,
        message: `${playerState.name} mills ${toMill} card${toMill !== 1 ? 's' : ''}.`,
      },
    ],
  };
}

/**
 * Move top N cards of library to hand (initial draw).
 */
export function drawOpeningHand(
  state: GameState,
  player: number,
  count: number = 7
): GameState {
  return drawCards(state, player, count);
}
