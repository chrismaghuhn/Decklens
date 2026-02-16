/**
 * Headless Goldfish Simulation — DOM-free playtest runner
 * 
 * Runs goldfish playtests without rendering to collect statistics.
 * Used for Monte Carlo analysis and deck performance metrics.
 */

import type { DeckbuilderDeck, DeckbuilderCardEntry } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';

// ==================== Types ====================

type SimPhase = 'untap' | 'upkeep' | 'draw' | 'main1' | 'combat' | 'main2' | 'end';

interface SimState {
  library: string[];
  hand: string[];
  battlefield: string[]; // Simplified - just names
  graveyard: string[];
  exile: string[];
  manaPool: Record<string, number>; // W, U, B, R, G, C
  turn: number;
  phase: SimPhase;
  landPlayedThisTurn: boolean;
  lifeTotal: number;
  log: string[]; // For debugging
}

export interface SimulationConfig {
  /** Number of simulations to run */
  iterations: number;
  /** Maximum turns before stopping */
  maxTurns: number;
  /** Strategy: how aggressive to play */
  strategy: 'aggressive' | 'value' | 'control';
  /** Enable logging (slows down simulation) */
  debug?: boolean;
}

export interface SimulationResult {
  /** Total iterations run */
  iterations: number;
  
  /** Average turns to reach "goldfish" (no opponent) */
  avgGoldfishTurn: number;
  
  /** Distribution of goldfish turns [turn3: 12, turn4: 45, ...] */
  goldfishTurnDistribution: Record<number, number>;
  
  /** Percentage of games that mulliganed */
  mulliganRate: number;
  
  /** Percentage of games mana screwed (< 3 lands by turn 5) */
  manaScrewed: number;
  
  /** Percentage of games mana flooded (> 10 lands by turn 10) */
  manaFlooded: number;
  
  /** Average cards drawn per game */
  avgCardsDrawn: number;
  
  /** Average lands played per game */
  avgLandsPlayed: number;
  
  /** Percentage of games that reached a "win condition" */
  winConditionReached: number;
}

// ==================== Helpers ====================

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function shuffle(arr: string[], seed?: number): string[] {
  // Simple Fisher-Yates with optional seeding for deterministic tests
  const a = [...arr];
  let random: () => number;
  
  if (seed !== undefined) {
    let currentSeed = seed;
    random = () => { currentSeed = (currentSeed * 9301 + 49297) % 233280; return currentSeed / 233280; };
  } else {
    random = Math.random;
  }
  
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isLand(cardName: string, cardByName: Record<string, DeckbuilderSearchCard | undefined>): boolean {
  const card = cardByName[normalizeKey(cardName)];
  return card?.type_line?.toLowerCase().includes('land') || false;
}

function getCMC(cardName: string, cardByName: Record<string, DeckbuilderSearchCard | undefined>): number {
  const card = cardByName[normalizeKey(cardName)];
  return card?.cmc || 0;
}

// ==================== Simulation Engine ====================

/**
 * Initialize state from decklist
 */
function initState(deck: DeckbuilderDeck): SimState {
  const library: string[] = [];
  
  // Build library from mainboard
  for (const entry of deck.boards.mainboard) {
    for (let i = 0; i < entry.qty; i++) {
      library.push(entry.name);
    }
  }
  
  return {
    library: shuffle(library),
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 },
    turn: 0,
    phase: 'untap',
    landPlayedThisTurn: false,
    lifeTotal: 40, // EDH starting life
    log: [],
  };
}

/**
 * Draw opening hand
 */
function drawOpeningHand(state: SimState): void {
  for (let i = 0; i < 7; i++) {
    if (state.library.length > 0) {
      state.hand.push(state.library.shift()!);
    }
  }
}

/**
 * Simple mulligan logic: keep if 2-5 lands, else mulligan once
 */
function shouldMulligan(state: SimState, cardByName: Record<string, DeckbuilderSearchCard | undefined>): boolean {
  const landCount = state.hand.filter(c => isLand(c, cardByName)).length;
  return landCount < 2 || landCount > 5;
}

/**
 * Execute one turn of goldfish
 */
function executeTurn(
  state: SimState,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  strategy: 'aggressive' | 'value' | 'control'
): void {
  state.turn++;
  state.phase = 'draw';
  
  // Draw card (skip turn 1)
  if (state.turn > 1 && state.library.length > 0) {
    state.hand.push(state.library.shift()!);
  } else if (state.turn === 1 && state.library.length > 0) {
    // Turn 1 still draws (except on the play in non-EDH)
    state.hand.push(state.library.shift()!);
  }
  
  state.phase = 'main1';
  state.landPlayedThisTurn = false;
  
  // Play a land if possible
  const landIndex = state.hand.findIndex(c => isLand(c, cardByName));
  if (landIndex !== -1 && !state.landPlayedThisTurn) {
    const land = state.hand.splice(landIndex, 1)[0];
    state.battlefield.push(land);
    state.landPlayedThisTurn = true;
  }
  
  // In a real simulation, we'd play spells here
  // For now, this is a simplified "land drop simulator"
  // Future: Add spell casting logic based on mana availability
  
  state.phase = 'end';
}

/**
 * Check if game reached a "win" condition (heuristic)
 */
function reachedWinCondition(state: SimState, cardByName: Record<string, DeckbuilderSearchCard | undefined>): boolean {
  // Heuristic: 6+ lands + 3+ nonland permanents = "goldfish achieved"
  const lands = state.battlefield.filter(c => isLand(c, cardByName)).length;
  const nonlands = state.battlefield.filter(c => !isLand(c, cardByName)).length;
  
  return lands >= 6 && nonlands >= 3;
}

/**
 * Run a single goldfish simulation
 */
function runSingleSimulation(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  config: SimulationConfig
): {
  turn: number;
  mulliganed: boolean;
  screwed: boolean;
  flooded: boolean;
  cardsDrawn: number;
  landsPlayed: number;
  reachedWin: boolean;
} {
  const state = initState(deck);
  drawOpeningHand(state);
  
  let mulliganed = false;
  if (shouldMulligan(state, cardByName)) {
    // Mulligan once
    mulliganed = true;
    state.hand = [];
    state.library = shuffle([...state.library]);
    for (let i = 0; i < 6; i++) {
      if (state.library.length > 0) {
        state.hand.push(state.library.shift()!);
      }
    }
  }
  
  // Run turns
  for (let t = 1; t <= config.maxTurns; t++) {
    executeTurn(state, cardByName, config.strategy);
    
    if (reachedWinCondition(state, cardByName)) {
      break;
    }
  }
  
  // Calculate stats
  const lands = state.battlefield.filter(c => isLand(c, cardByName)).length;
  const screwed = lands < 3 && state.turn >= 5;
  const flooded = lands > 10 && state.turn >= 10;
  const cardsDrawn = 7 + state.turn - 1; // Opening hand + draws
  const reachedWin = reachedWinCondition(state, cardByName);
  
  return {
    turn: state.turn,
    mulliganed,
    screwed,
    flooded,
    cardsDrawn,
    landsPlayed: lands,
    reachedWin,
  };
}

// ==================== Simulation Orchestrator ====================

/**
 * Run N simulations and aggregate results
 */
export function runSimulation(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  config: SimulationConfig
): SimulationResult {
  const results: ReturnType<typeof runSingleSimulation>[] = [];
  
  for (let i = 0; i < config.iterations; i++) {
    results.push(runSingleSimulation(deck, cardByName, config));
  }
  
  // Aggregate statistics
  const totalTurns = results.reduce((sum, r) => sum + r.turn, 0);
  const avgGoldfishTurn = totalTurns / results.length;
  
  const goldfishTurnDistribution: Record<number, number> = {};
  for (const r of results) {
    goldfishTurnDistribution[r.turn] = (goldfishTurnDistribution[r.turn] || 0) + 1;
  }
  
  const mulliganCount = results.filter(r => r.mulliganed).length;
  const screwedCount = results.filter(r => r.screwed).length;
  const floodedCount = results.filter(r => r.flooded).length;
  const winCount = results.filter(r => r.reachedWin).length;
  
  const totalCardsDrawn = results.reduce((sum, r) => sum + r.cardsDrawn, 0);
  const totalLandsPlayed = results.reduce((sum, r) => sum + r.landsPlayed, 0);
  
  return {
    iterations: config.iterations,
    avgGoldfishTurn,
    goldfishTurnDistribution,
    mulliganRate: (mulliganCount / results.length) * 100,
    manaScrewed: (screwedCount / results.length) * 100,
    manaFlooded: (floodedCount / results.length) * 100,
    avgCardsDrawn: totalCardsDrawn / results.length,
    avgLandsPlayed: totalLandsPlayed / results.length,
    winConditionReached: (winCount / results.length) * 100,
  };
}
