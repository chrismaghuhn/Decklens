import type { Card } from './card.ts';
import type { Permanent } from './permanent.ts';
import type { ManaPool } from './mana.ts';

/** Complete state for one player */
export interface PlayerState {
  id: number;
  name: string;

  // --- Zones ---
  library: Card[];
  hand: Card[];
  battlefield: Permanent[];
  graveyard: Card[];
  exile: Card[];
  commandZone: Card[];

  // --- Resources ---
  life: number;
  manaPool: ManaPool;
  poisonCounters: number;
  /** Energy counters (Kaladesh+, CR 122.1e) */
  energyCounters: number;
  /** Experience counters (Commander 2015+, CR 122.1d) */
  experienceCounters: number;
  /** Commander damage received, keyed by commander instance ID */
  commanderDamage: Record<string, number>;

  // --- Commander ---
  commanderTax: number;

  // --- Turn state ---
  landPlayedThisTurn: boolean;
  landsPlayedThisTurn: number;
  maxLandPlays: number;

  // --- Game state ---
  /** Whether this player has had their first draw (skipped on turn 1 for starting player) */
  hasDrawnThisGame: boolean;

  /** Names of this player's commander(s) for commander zone replacement detection */
  commanderNames?: string[];

  /** Whether this player has been eliminated from the game (N-player: game continues without them) */
  eliminated?: boolean;
}

/** Starting life total for Commander */
export const STARTING_LIFE = 40;

/** Create an empty mana pool */
export function emptyManaPool(): ManaPool {
  return { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, S: 0, generic: 0 };
}

/** Create initial player state */
export function createPlayerState(
  id: number,
  name: string,
  deck: Card[],
  commander: Card
): PlayerState {
  return {
    id,
    name,
    library: deck.filter((c) => c.id !== commander.id),
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    commandZone: [commander],
    life: STARTING_LIFE,
    manaPool: emptyManaPool(),
    poisonCounters: 0,
    energyCounters: 0,
    experienceCounters: 0,
    commanderDamage: {},
    commanderTax: 0,
    landPlayedThisTurn: false,
    landsPlayedThisTurn: 0,
    maxLandPlays: 1,
    hasDrawnThisGame: false,
    commanderNames: [commander.name],
  };
}
