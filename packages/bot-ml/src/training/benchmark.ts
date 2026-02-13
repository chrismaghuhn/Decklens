/**
 * Benchmark System
 * Evaluates MLBot performance against HeuristicBot (baseline).
 */

import { HeuristicBot } from '@mtg/bot-core';
import { Game, setupNewGame, createSimpleCard } from '@mtg/game-engine';
import { MLBot } from '../bot-ml.ts';

export interface BenchmarkResult {
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  avgTurns: number;
  avgScore?: number;
}

/**
 * Run a benchmark series between MLBot and HeuristicBot.
 * @param mlBot The ML agent to test
 * @param games Number of games to play
 * @param heuristicBotVersion optional version string/config for heuristic bot
 */
export async function runBenchmark(
  mlBot: MLBot,
  games: number,
  heuristicBotVersion?: string
): Promise<BenchmarkResult> {
  const heuristicBot = new HeuristicBot(1);
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let totalTurns = 0;

  console.log(`Starting benchmark: ${games} games vs HeuristicBot...`);

  for (let i = 0; i < games; i++) {
    // Alternate starting player
    const mlStarts = i % 2 === 0;
    
    // Setup Game
    const deck1 = createBenchmarkDeck(0); 
    const deck2 = createBenchmarkDeck(1);
    
    // If ML starts (Player 0), P0=ML, P1=Heuristic
    // If Heuristic starts (Player 0), P0=Heuristic, P1=ML
    
    // Create new instances for correct player indexing
    let p0Bot, p1Bot;
    
    if (mlStarts) {
        // ML is Player 0
        p0Bot = new MLBot(0, mlBot.getPolicyNetwork(), mlBot.getValueNetwork(), 0.05);
        p1Bot = new HeuristicBot(1);
    } else {
        // Heuristic is Player 0
        p0Bot = new HeuristicBot(0);
        p1Bot = new MLBot(1, mlBot.getPolicyNetwork(), mlBot.getValueNetwork(), 0.05);
    }
    
    const initialState = setupNewGame(
        mlStarts ? 'MLBot' : 'Heuristic', 
        deck1, deck1[0],
        mlStarts ? 'Heuristic' : 'MLBot', 
        deck2, deck2[0]
    );
    
    const game = new Game(initialState);
    // Game is already started/initialized by setupNewGame
    
    // Run game loop
    let turns = 0;
    const MAX_TURNS = 60;
    const MAX_ITERATIONS = 2000; // Safety limit
    let iterations = 0;
    let lastTurn = 0;
    let turnStuckCount = 0;
    
    while (!game.isOver() && turns < MAX_TURNS && iterations < MAX_ITERATIONS) {
       iterations++;
       
       // Safety check: if turn hasn't changed, increment stuck counter
       const currentTurn = game.getTurn();
       if (currentTurn === lastTurn) {
           turnStuckCount++;
           if (turnStuckCount > 100) {
               console.warn(`[Benchmark] Game stuck at turn ${currentTurn} for ${turnStuckCount} iterations. Breaking.`);
               break;
           }
       } else {
           turnStuckCount = 0;
           lastTurn = currentTurn;
           turns = currentTurn;
       }
       
       // Get current state and determine which bot should act
       const state = game.getState();
       const actingBot = state.priorityPlayer === 0 ? p0Bot : p1Bot;
       
       try {
         // Generic chooseAction check
         let action;
         if ('chooseAction' in actingBot) {
             action = actingBot.chooseAction(state);
         } else if ('getBotAction' in actingBot) {
             // @ts-ignore
             action = await actingBot.getBotAction(state);
         } else {
             action = { type: 'pass', player: state.priorityPlayer };
         }

         const success = game.submitAction(action);
         if (!success) {
             // Fallback to pass if action fails
             game.submitAction({ type: 'pass', player: state.priorityPlayer });
         }
       } catch (e) {
         console.error("Game Error in benchmark:", e);
         break;
       }
    }
    
    if (iterations >= MAX_ITERATIONS) {
        console.warn(`[Benchmark] Game hit iteration limit (${MAX_ITERATIONS}). Game may have been stuck.`);
    }
    
    totalTurns += turns;
    
    const winner = game.getWinner();
    if (winner === undefined || winner === null) {
        draws++;
    } else {
        // If mlStarts (P0) and winner is 0 -> ML win
        // If !mlStarts (P1) and winner is 1 -> ML win
        const mlIndex = mlStarts ? 0 : 1;
        if (winner === mlIndex) wins++;
        else losses++;
    }
  }

  return {
    gamesPlayed: games,
    wins,
    losses,
    draws,
    winRate: wins / games,
    avgTurns: totalTurns / games
  };
}

// Simple Mono White Aggro deck for benchmark consistency
function createBenchmarkDeck(owner: 0 | 1): any[] {
    const cards = [];
    // 20 Plains
    for (let i = 0; i < 20; i++) {
        cards.push(createSimpleCard('Plains', 'Basic Land — Plains', '', owner, {
            oracleText: '{T}: Add {W}.', colors: [], colorIdentity: ['W']
        }));
    }
    // 40 Bears (2/2 for 2)
    for (let i = 0; i < 40; i++) {
        cards.push(createSimpleCard(`Bear ${i}`, 'Creature — Bear', '{1}{W}', owner, {
            power: '2', toughness: '2', colors: ['W'], colorIdentity: ['W']
        }));
    }
    return cards;
}
