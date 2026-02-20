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

/** Configuration for a single player when starting an N-player game */
export interface PlayerConfig {
  name: string;
  deck: Card[];
  commander: Card;
}

/**
 * Set up an N-player game: create player states, shuffle, draw opening hands.
 * Supports any number of players (2+).
 */
export function setupNewGameN(configs: PlayerConfig[]): GameState {
  if (configs.length < 2) {
    throw new Error('setupNewGameN requires at least 2 players');
  }

  // Create player states for each config
  const playerStates: PlayerState[] = configs.map((cfg, i) =>
    createPlayerState(i, cfg.name, cfg.deck, cfg.commander)
  );

  let state = createInitialGameState(playerStates);

  // Shuffle libraries and deal opening hands for all players
  for (let i = 0; i < configs.length; i++) {
    state = shuffleLibrary(state, i);
  }
  for (let i = 0; i < configs.length; i++) {
    state = drawOpeningHand(state, i, 7);
  }

  return state;
}

/**
 * Set up a new game: create player states, shuffle, draw opening hands.
 * Backward-compatible 2-player wrapper around setupNewGameN.
 */
export function setupNewGame(
  player1Name: string,
  player1Deck: Card[],
  player1Commander: Card,
  player2Name: string,
  player2Deck: Card[],
  player2Commander: Card
): GameState {
  return setupNewGameN([
    { name: player1Name, deck: player1Deck, commander: player1Commander },
    { name: player2Name, deck: player2Deck, commander: player2Commander },
  ]);
}
