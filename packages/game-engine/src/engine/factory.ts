import type { Card, Color, CardTag } from '../types/card.ts';
import type { PlayerState } from '../types/player.ts';
import type { GameState } from '../types/game-state.ts';
import { createPlayerState } from '../types/player.ts';
import { createInitialGameState } from './turn-manager.ts';
import { drawOpeningHand, shuffleLibrary } from './zone-manager.ts';

let nextId = 0;

/** Generate a unique card instance ID */
export function generateCardId(): string {
  return `card_${++nextId}_${Date.now().toString(36)}`;
}

/** Reset the ID counter (useful for tests) */
export function resetIdCounter(): void {
  nextId = 0;
}

/**
 * Create a Card from raw Scryfall data.
 *
 * Accepts the Scryfall card JSON format and maps it to our Card interface.
 */
export function createCard(
  scryfallData: {
    oracle_id?: string;
    name: string;
    mana_cost?: string;
    cmc?: number;
    type_line?: string;
    oracle_text?: string;
    power?: string;
    toughness?: string;
    loyalty?: string;
    colors?: string[];
    color_identity?: string[];
    rarity?: string;
    image_uris?: { normal?: string; small?: string };
  },
  owner: number
): Card {
  return {
    id: generateCardId(),
    oracleId: scryfallData.oracle_id || '',
    name: scryfallData.name,
    manaCost: scryfallData.mana_cost || '',
    cmc: scryfallData.cmc || 0,
    typeLine: scryfallData.type_line || '',
    oracleText: scryfallData.oracle_text || '',
    power: scryfallData.power,
    toughness: scryfallData.toughness,
    loyalty: scryfallData.loyalty,
    colors: (scryfallData.colors || []) as Color[],
    colorIdentity: (scryfallData.color_identity || []) as Color[],
    rarity: (scryfallData.rarity || 'common') as Card['rarity'],
    tags: [],
    imageUrl:
      scryfallData.image_uris?.normal ||
      scryfallData.image_uris?.small ||
      '',
    owner,
  };
}

/**
 * Create a simple Card from minimal data (for testing or manual creation).
 */
export function createSimpleCard(
  name: string,
  typeLine: string,
  manaCost: string,
  owner: number,
  opts?: Partial<Card>
): Card {
  return {
    id: generateCardId(),
    oracleId: '',
    name,
    manaCost,
    cmc: 0,
    typeLine,
    oracleText: '',
    colors: [],
    colorIdentity: [],
    rarity: 'common',
    tags: [],
    imageUrl: '',
    owner,
    ...opts,
  };
}

/**
 * London Mulligan implementation.
 *
 * 1. Player shuffles hand back into library
 * 2. Draws 7 new cards
 * 3. Puts N cards on bottom of library (N = mulligan count)
 */
export function performLondonMulligan(
  state: GameState,
  player: number,
  bottomCards: string[]
): GameState {
  const playerState = state.players[player];

  // Put chosen cards on the bottom of library
  const remainingHand: Card[] = [];
  const toBottom: Card[] = [];

  for (const card of playerState.hand) {
    if (bottomCards.includes(card.id)) {
      toBottom.push(card);
    } else {
      remainingHand.push(card);
    }
  }

  const updatedPlayer = {
    ...playerState,
    hand: remainingHand,
    library: [...playerState.library, ...toBottom],
  };

  const players = [...state.players];
  players[player] = updatedPlayer;

  const mulliganCount = [...state.mulliganCount];

  return {
    ...state,
    players,
    mulliganCount,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message: `${playerState.name} puts ${bottomCards.length} card${bottomCards.length !== 1 ? 's' : ''} on the bottom.`,
      },
    ],
  };
}

/**
 * Start the mulligan process: shuffle library and draw 7.
 * Increment mulligan counter.
 */
export function startMulligan(
  state: GameState,
  player: number
): GameState {
  const playerState = state.players[player];

  // Shuffle hand back into library
  const updatedPlayer = {
    ...playerState,
    library: [...playerState.library, ...playerState.hand],
    hand: [],
  };

  const players = [...state.players];
  players[player] = updatedPlayer;

  let newState: GameState = { ...state, players };

  // Increment mulligan count
  const mulliganCount = [...state.mulliganCount];
  mulliganCount[player]++;
  newState.mulliganCount = mulliganCount;

  // Shuffle and draw 7
  newState = shuffleLibrary(newState, player);
  newState = drawOpeningHand(newState, player, 7);

  newState.log = [
    ...newState.log,
    {
      timestamp: Date.now(),
      turn: state.turn,
      phase: state.phase,
      step: state.step,
      player,
      message: `${playerState.name} mulligans to ${7 - mulliganCount[player]}.`,
    },
  ];

  return newState;
}

/**
 * Keep the current hand (end mulligan for this player).
 * If both players have kept, exit mulligan phase.
 */
export function keepHand(
  state: GameState,
  player: number
): GameState {
  return {
    ...state,
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message: `${state.players[player].name} keeps their hand.`,
      },
    ],
  };
}

/**
 * Set up a new game: create player states, shuffle, draw opening hands.
 */
export function setupNewGame(
  player1Name: string,
  player1Deck: Card[],
  player1Commander: Card,
  player2Name: string,
  player2Deck: Card[],
  player2Commander: Card
): GameState {
  const p1 = createPlayerState(0, player1Name, player1Deck, player1Commander);
  const p2 = createPlayerState(1, player2Name, player2Deck, player2Commander);

  let state = createInitialGameState(p1, p2);

  // Shuffle libraries
  state = shuffleLibrary(state, 0);
  state = shuffleLibrary(state, 1);

  // Draw opening hands (7 cards each)
  state = drawOpeningHand(state, 0, 7);
  state = drawOpeningHand(state, 1, 7);

  return state;
}
