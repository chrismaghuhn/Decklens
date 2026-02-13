/**
 * CLI Evaluation Script
 * 
 * Benchmarks the trained ML bot against SimpleBot (heuristic bot).
 * 
 * Usage:
 *   npx tsx scripts/eval-bot-cli.ts --games 100 --model trained-model/
 */

import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-wasm';

import {
  Game, setupNewGame, createSimpleCard,
  getLegalActionTypes, autoTapLandsForCost, parseManaCost, calculateCMC,
  type GameState, type GameAction,
} from '../packages/game-engine/src/index.ts';

import {
  MLBot, SimpleBot, PolicyNetwork, ValueNetwork, FEATURE_DIM,
  type MLDecision
} from '../packages/bot-ml/src/index.ts';

import fs from 'fs';
import path from 'path';

// === Configuration ===
const args = process.argv.slice(2);
const help = args.includes('--help');

if (help) {
  console.log(`
Usage:
  npx tsx scripts/eval-bot-cli.ts [options]

Options:
  --games <number>   Number of games to evaluate (default: 100)
  --model <path>     Path to model directory (default: trained-model/)
  --verbose          Log individual game results
`);
  process.exit(0);
}

function getArg(name: string, defaultVal: string | number): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : String(defaultVal);
}

const TOTAL_GAMES = parseInt(getArg('games', '100'));
const MODEL_PATH = getArg('model', 'public/trained-model');
const MAX_ITERATIONS = 500;
const BATCH_SIZE = 1; // Eval runs one game at a time usually, but we batch if needed
const VERBOSE = args.includes('--verbose');

// === Helper Functions ===

function createSampleDeck(owner: 0 | 1) {
  const cards = [];
  
  // Commander
  cards.push(createSimpleCard('Commander', 'Legendary Creature', '{2}{W}{U}', owner, {
    power: '3', toughness: '3', colors: ['W', 'U'], colorIdentity: ['W', 'U']
  }));
  
  // Lands (15 Island, 15 Plains)
  for (let i = 0; i < 15; i++) {
    cards.push(createSimpleCard('Island', 'Basic Land — Island', '', owner, {
      oracleText: '{T}: Add {U}.', colors: [], colorIdentity: ['U']
    }));
  }
  for (let i = 0; i < 15; i++) {
    cards.push(createSimpleCard('Plains', 'Basic Land — Plains', '', owner, {
      oracleText: '{T}: Add {W}.', colors: [], colorIdentity: ['W']
    }));
  }
  
  // Ramp (5 Sol Ring, 5 Arcane Signet)
  for (let i = 0; i < 5; i++) {
    cards.push(createSimpleCard('Sol Ring', 'Artifact', '{1}', owner, {
      oracleText: '{T}: Add {C}{C}.', colors: [], colorIdentity: []
    }));
  }
  for (let i = 0; i < 5; i++) {
    cards.push(createSimpleCard('Arcane Signet', 'Artifact', '{2}', owner, {
      oracleText: '{T}: Add one mana of any color in your commander\'s color identity.', colors: [], colorIdentity: []
    }));
  }
  
  // Creatures (30 soldiers)
  for (let i = 0; i < 30; i++) {
    cards.push(createSimpleCard(`Creature ${i}`, 'Creature — Soldier', '{2}{W}', owner, {
      power: '2', toughness: '2', colors: ['W'], colorIdentity: ['W']
    }));
  }
  
  // Spells
  for (let i = 0; i < 10; i++) {
    cards.push(createSimpleCard('Counterspell', 'Instant', '{U}{U}', owner, {
      oracleText: 'Counter target spell.', colors: ['U'], colorIdentity: ['U']
    }));
  }
  for (let i = 0; i < 9; i++) {
    cards.push(createSimpleCard('Path to Exile', 'Instant', '{W}', owner, {
      oracleText: 'Exile target creature.', colors: ['W'], colorIdentity: ['W']
    }));
  }
  
  return cards;
}

// === Main Evaluation Loop ===

async function main() {
  console.log('Initializing networks...');
  
  // Set backend to WASM for speed
  await tf.setBackend('wasm');
  console.log(`Backend: ${tf.getBackend()}`);
  
  const policyNet = new PolicyNetwork(FEATURE_DIM);
  const valueNet = new ValueNetwork(FEATURE_DIM);
  
  // Load weights manually from JSON
  try {
    const policyPath = path.resolve(MODEL_PATH, 'policy-weights.json');
    const valuePath = path.resolve(MODEL_PATH, 'value-weights.json');
    
    if (fs.existsSync(policyPath) && fs.existsSync(valuePath)) {
      console.log(`Loading model from ${MODEL_PATH}...`);
      
      const loadWeights = (model: tf.LayersModel, filePath: string) => {
        const json = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const weights = json.map((w: any) => tf.tensor(w.data, w.shape));
        model.setWeights(weights);
        weights.forEach((t: tf.Tensor) => t.dispose()); // Clean up tensors immediately
      };
      
      loadWeights(policyNet.getModel(), policyPath);
      loadWeights(valueNet.getModel(), valuePath);
      console.log('✅ Model loaded successfully!');
    } else {
      console.warn(`⚠️ Model files not found in ${MODEL_PATH}. Using random initialization.`);
    }
  } catch (e) {
    console.error('Failed to load model:', e);
  }
  
  // Initialize bots
  // Eval: Player 0 (ML) vs Player 1 (Simple)
  const mlBot = new MLBot(0, policyNet, valueNet, 0.1); // Low exploration for eval
  const opponent = new SimpleBot(1);
  
  console.log('\n🧠 Evaluation started (ML Bot vs SimpleBot)');
  console.log(`Target: ${TOTAL_GAMES} games`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  let wins = 0;
  let losses = 0;
  let draws = 0;
  const startTime = Date.now();
  
  const progressBarLength = 30;
  
  for (let i = 1; i <= TOTAL_GAMES; i++) {
    const deck1 = createSampleDeck(0);
    const deck2 = createSampleDeck(1);
    
    // Setup game: ML Bot (P0) vs SimpleBot (P1)
    const initialState = setupNewGame(
      'MLBot', deck1, deck1[0],
      'SimpleBot', deck2, deck2[0]
    );
    
    const game = new Game(initialState);
    let iterations = 0;
    const MAX_ITERATIONS = 500;
    
    // Reset land counter on new turn
    let landsPlayedThisTurn = 0;
    
    // Game Loop
    while (!game.isOver() && iterations < MAX_ITERATIONS) {
      let gameState = game.getState();
      
      // Auto-pass untap/cleanup
      if ((gameState.step as string) === 'untap' || gameState.step === 'cleanup') {
        game.submitAction({ type: 'pass', player: gameState.priorityPlayer });
        iterations++;
        continue;
      }
      
      const currentPlayer = gameState.priorityPlayer;
      const me = gameState.players[currentPlayer];
      
      // Reset land counter logic (simplified for eval)
      if (gameState.step === 'untap') landsPlayedThisTurn = 0;
      
      const bot = currentPlayer === 0 ? mlBot : opponent;
      
      let action: GameAction;
      let decision: MLDecision | null = null;
      
      // Determine action
      if (bot instanceof MLBot) {
        decision = bot.chooseActionWithReason(gameState); // Uses fast CPU inference
        action = decision.action;
      } else {
        action = bot.chooseAction(gameState);
      }
      action.player = currentPlayer;
      
      // Heuristic overrides (ONLY for ML Bot)
      if (bot instanceof MLBot) {
        // Block concede/mulligan
        if (action.type === 'concede' || action.type === 'mulligan') {
          action = { type: 'pass', player: currentPlayer };
        }
        
        // 1. Play land override
        if (action.type === 'pass' && 
            (gameState.phase === 'precombat-main' || gameState.phase === 'postcombat-main')) {
          const land = me.hand.find(c => c.typeLine.toLowerCase().includes('land'));
          if (land) {
             // simplified land tracking for eval script
             const landsPlayed = me.battlefield.filter(c => c.typeLine.toLowerCase().includes('land') && !c.tapped).length; // flawed heuristic but ok
             // Better: just check if legal
             if (getLegalActionTypes(gameState).includes('play-land')) {
               action = { type: 'play-land', player: currentPlayer, cardId: land.id };
             }
          }
        }
        
        // 2. Attack override
        if ((gameState.step as string) === 'declare-attackers') { // Fix type error here too
           // If already attacked, don't do it again
           if (gameState.combat && gameState.combat.attackers.length > 0) {
             // Pass to let opponent block
           } else {
             const attackers = me.battlefield
              .filter(c => c.typeLine.toLowerCase().includes('creature') && !c.summoningSick && !c.tapped)
              .map(c => c.id);
             if (attackers.length > 0) {
               action = { type: 'declare-attackers', player: currentPlayer, attackers };
             }
           }
        }
        
        // 3. Cast spell override (if passed)
        if (action.type === 'pass' && 
            (gameState.phase === 'precombat-main' || gameState.phase === 'postcombat-main')) {
           for (const card of me.hand) {
             if (card.typeLine.toLowerCase().includes('land') || !card.manaCost) continue;
             const tapResult = autoTapLandsForCost(me, parseManaCost(card.manaCost));
             if (tapResult) {
               action = {
                 type: 'cast-spell', player: currentPlayer, cardId: card.id,
                 targets: [], manaPayment: tapResult.payment,
               };
               break;
             }
           }
        }
      }
      
      // Execute
      try {
        if (VERBOSE) {
            console.log(`P${currentPlayer} (${bot.constructor.name}) -> ${action.type}`);
            if (action.type === 'cast-spell' || action.type === 'play-land') {
                const card = me.hand.find(c => c.id === action.cardId);
                if (card) console.log(`  Card: ${card.name}`);
            }
        }
        game.submitAction(action);
      } catch (e) {
         if (VERBOSE) console.error(`  Action failed: ${e}`);
         // Fallback pass on error
         game.submitAction({ type: 'pass', player: currentPlayer });
      }
      iterations++;
    }
    
    const winner = game.getWinner();
    if (winner === 0) wins++;
    else if (winner === 1) losses++;
    else draws++;
    
    // Update progress bar
    if (i % 5 === 0 || i === TOTAL_GAMES) {
      const elapsed = (Date.now() - startTime) / 1000;
      const gamesPerSec = i / elapsed;
      const winRate = (wins / i * 100).toFixed(1);
      
      // Visual progress bar
      const progress = Math.round((i / TOTAL_GAMES) * progressBarLength);
      const bar = '█'.repeat(progress) + '░'.repeat(progressBarLength - progress);
      
      // Clear line & print
      process.stdout.write(`\r[${bar}] ${i}/${TOTAL_GAMES} | WR: ${winRate}% | ${gamesPerSec.toFixed(1)} g/s`);
    }

    if (VERBOSE) {
      const winnerStr = winner === 0 ? 'WIN' : winner === 1 ? 'LOSS' : 'DRAW';
      console.log(`\nGame ${i}: ${winnerStr} (${iterations} turns)`);
    }
    
    // Minimal yield
    await tf.nextFrame();
  }
  
  console.log('\n\n✅ Evaluation complete!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Wins:   ${wins} (${(wins/TOTAL_GAMES*100).toFixed(1)}%)`);
  console.log(`  Losses: ${losses} (${(losses/TOTAL_GAMES*100).toFixed(1)}%)`);
  console.log(`  Draws:  ${draws} (${(draws/TOTAL_GAMES*100).toFixed(1)}%)`);
  console.log(`  Speed:  ${(TOTAL_GAMES / ((Date.now() - startTime)/1000)).toFixed(1)} g/s`);
}

main().catch(console.error);
