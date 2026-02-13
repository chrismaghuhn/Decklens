import type { GameState, Card, Permanent, PlayerState } from '@mtg/game-engine';
import {
  createSimpleCard,
  createPlayerState,
  createInitialGameState,
  cardToPermanent,
  emptyPool,
  addMana,
  resetIdCounter,
} from '@mtg/game-engine';

/**
 * Shared test helpers for bot-core tests.
 */

/** Reset ID counter before each test module */
export function resetIds() {
  resetIdCounter();
}

/** Create a basic creature card */
export function makeCreature(
  name: string,
  cost: string,
  power: string,
  toughness: string,
  owner: 0 | 1,
  opts?: Partial<Card>,
): Card {
  return createSimpleCard(name, `Creature — Test`, cost, owner, {
    power,
    toughness,
    colors: [],
    colorIdentity: [],
    ...opts,
  });
}

/** Create a basic instant card */
export function makeInstant(
  name: string,
  cost: string,
  owner: 0 | 1,
  opts?: Partial<Card>,
): Card {
  return createSimpleCard(name, 'Instant', cost, owner, {
    colors: [],
    colorIdentity: [],
    ...opts,
  });
}

/** Create a basic sorcery card */
export function makeSorcery(
  name: string,
  cost: string,
  owner: 0 | 1,
  opts?: Partial<Card>,
): Card {
  return createSimpleCard(name, 'Sorcery', cost, owner, {
    colors: [],
    colorIdentity: [],
    ...opts,
  });
}

/** Create a basic land card */
export function makeLand(name: string, owner: 0 | 1, opts?: Partial<Card>): Card {
  return createSimpleCard(name, 'Land — Forest', '', owner, {
    oracleText: '{T}: Add {G}.',
    colors: [],
    colorIdentity: ['G'],
    ...opts,
  });
}

/** Place a card on the battlefield as a permanent */
export function putOnBattlefield(
  state: GameState,
  card: Card,
  player: 0 | 1,
  turn?: number,
): GameState {
  const entryTurn = turn ?? state.turn;
  const perm = cardToPermanent(card, player, entryTurn);
  // If the creature entered on a previous turn, it's no longer summoning sick
  const resolved = entryTurn < state.turn
    ? { ...perm, summoningSick: false }
    : perm;
  return {
    ...state,
    players: state.players.map((p, i) =>
      i === player
        ? { ...p, battlefield: [...p.battlefield, resolved] }
        : p
    ) as [PlayerState, PlayerState],
  };
}

/** Add a card to a player's hand */
export function addToHand(state: GameState, card: Card, player: 0 | 1): GameState {
  return {
    ...state,
    players: state.players.map((p, i) =>
      i === player
        ? { ...p, hand: [...p.hand, card] }
        : p
    ) as [PlayerState, PlayerState],
  };
}

/** Set a player's mana pool */
export function setMana(
  state: GameState,
  player: 0 | 1,
  mana: Partial<Record<'W' | 'U' | 'B' | 'R' | 'G' | 'C' | 'generic', number>>,
): GameState {
  let pool = emptyPool();
  for (const [key, val] of Object.entries(mana)) {
    pool = addMana(pool, key as any, val as number);
  }
  return {
    ...state,
    players: state.players.map((p, i) =>
      i === player ? { ...p, manaPool: pool } : p
    ) as [PlayerState, PlayerState],
  };
}

/** Create a minimal game state in precombat main phase */
export function createMainPhaseState(): GameState {
  const commander0 = createSimpleCard('Commander A', 'Legendary Creature — Human', '{2}{W}{U}', 0, {
    power: '3', toughness: '3', colors: ['W', 'U'], colorIdentity: ['W', 'U'],
  });
  const commander1 = createSimpleCard('Commander B', 'Legendary Creature — Elf', '{2}{G}{B}', 1, {
    power: '4', toughness: '4', colors: ['G', 'B'], colorIdentity: ['G', 'B'],
  });

  // Build minimal decks
  const deck0: Card[] = [commander0];
  const deck1: Card[] = [commander1];
  for (let i = 0; i < 98; i++) {
    deck0.push(makeLand(`Forest ${i}`, 0));
    deck1.push(makeLand(`Swamp ${i}`, 1, { typeLine: 'Land — Swamp', oracleText: '{T}: Add {B}.' }));
  }

  const state = createInitialGameState(
    createPlayerState(0, 'Human', deck0, commander0),
    createPlayerState(1, 'Bot', deck1, commander1),
  );

  // Set to main phase, skip mulligan
  return {
    ...state,
    mulliganPhase: false,
    phase: 'precombat-main',
    step: 'main',
    turn: 3,
  };
}
