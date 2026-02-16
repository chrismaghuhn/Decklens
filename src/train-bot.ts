/**
 * Bot Training Script — Automated self-play training for ML bot.
 * 
 * Runs 15,000 games and trains the bot using PPO.
 * 
 * Usage:
 *   npx tsx src/train-bot.ts              # Start fresh training
 *   npx tsx src/train-bot.ts --resume     # Resume from checkpoint
 *   npx tsx src/train-bot.ts --quick      # Quick test (100 games)
 */

import { Game, setupNewGame, createSimpleCard, type GameState, type GameAction } from '@mtg/game-engine';
import { MLBot, SelfPlayPipeline, PolicyNetwork, ValueNetwork, FEATURE_DIM, SimpleBot } from '@mtg/bot-ml';
import * as fs from 'fs';
import * as path from 'path';

const MODEL_DIR = './trained-models';
const POLICY_PATH = path.join(MODEL_DIR, 'bot-policy.bin');
const VALUE_PATH = path.join(MODEL_DIR, 'bot-value.bin');
const PROGRESS_PATH = path.join(MODEL_DIR, 'training-progress.json');

interface TrainingProgress {
  gamesPlayed: number;
  winRate: number;
  avgReward: number;
  recentLosses: { policy: number; value: number }[];
  timestamp: number;
}

// Parse command line args
const args = process.argv.slice(2);
const RESUME = args.includes('--resume');
const QUICK_TEST = args.includes('--quick');
const TOTAL_GAMES = QUICK_TEST ? 100 : 15000;
const TRAINING_INTERVAL = 50;
const SAVE_INTERVAL = 1000;

console.log('🤖 MTG Bot Training Pipeline');
console.log('============================');
console.log(`Mode: ${QUICK_TEST ? 'Quick Test (100 games)' : 'Full Training (15k games)'}`);
console.log(`Resume: ${RESUME}`);
console.log('');

// Create sample deck for both players
function createSampleDeck(owner: 0 | 1) {
  const cards = [];
  
  // Commander
  cards.push(createSimpleCard('Commander', 'Legendary Creature', '{2}{W}{U}', owner, {
    power: '3', toughness: '3', colors: ['W', 'U'], colorIdentity: ['W', 'U']
  }));
  
  // Lands (40)
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
  for (let i = 0; i < 10; i++) {
    cards.push(createSimpleCard('Forest', 'Basic Land — Forest', '', owner, {
      oracleText: '{T}: Add {G}.', colors: [], colorIdentity: ['G']
    }));
  }
  
  // Ramp (10)
  for (let i = 0; i < 5; i++) {
    cards.push(createSimpleCard('Sol Ring', 'Artifact', '{1}', owner, {
      oracleText: '{T}: Add {C}{C}.', colors: [], colorIdentity: []
    }));
  }
  for (let i = 0; i < 5; i++) {
    cards.push(createSimpleCard('Arcane Signet', 'Artifact', '{2}', owner, {
      oracleText: '{T}: Add one mana of any color in your commander\'s color identity.',
      colors: [], colorIdentity: []
    }));
  }
  
  // Creatures (30)
  for (let i = 0; i < 30; i++) {
    cards.push(createSimpleCard(`Creature ${i}`, 'Creature — Soldier', '{2}{W}', owner, {
      power: '2', toughness: '2', colors: ['W'], colorIdentity: ['W']
    }));
  }
  
  // Spells (19)
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

// Initialize or load networks
async function initializeNetworks(): Promise<{ policy: PolicyNetwork; value: ValueNetwork }> {
  if (RESUME && fs.existsSync(POLICY_PATH) && fs.existsSync(VALUE_PATH)) {
    console.log('📥 Loading existing models...');
    const policyBuffer = fs.readFileSync(POLICY_PATH).buffer as ArrayBuffer;
    const valueBuffer = fs.readFileSync(VALUE_PATH).buffer as ArrayBuffer;
    
    return {
      policy: await PolicyNetwork.deserialize(policyBuffer),
      value: await ValueNetwork.deserialize(valueBuffer)
    };
  } else {
    console.log('🆕 Creating new neural networks...');
    return {
      policy: new PolicyNetwork(FEATURE_DIM),
      value: new ValueNetwork(FEATURE_DIM)
    };
  }
}

// Load training progress
function loadProgress(): TrainingProgress {
  if (RESUME && fs.existsSync(PROGRESS_PATH)) {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
  }
  return {
    gamesPlayed: 0,
    winRate: 0,
    avgReward: 0,
    recentLosses: [],
    timestamp: Date.now()
  };
}

// Save models and progress
async function saveCheckpoint(pipeline: SelfPlayPipeline, progress: TrainingProgress) {
  if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true });
  }
  
  const policy = await pipeline.getPolicyNetwork().serialize();
  const value = await pipeline.getValueNetwork().serialize();
  
  fs.writeFileSync(POLICY_PATH, Buffer.from(policy));
  fs.writeFileSync(VALUE_PATH, Buffer.from(value));
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2));
  
  console.log(`💾 Checkpoint saved (${progress.gamesPlayed} games)`);
}

// Play one game headless
async function playGame(
  mlBot: MLBot,
  simpleBot: SimpleBot,
  gameNum: number
): Promise<{ states: GameState[]; actions: GameAction[]; winner: 0 | 1 | null }> {
  const deck1 = createSampleDeck(0);
  const deck2 = createSampleDeck(1);
  
  const initialState = setupNewGame(
    'Player', deck1, deck1[0], 'Bot', deck2, deck2[0]
  );
  
  const game = new Game(initialState);
  const states: GameState[] = [];
  const actions: GameAction[] = [];
  
  let iterations = 0;
  const MAX_ITERATIONS = 2000; // Prevent infinite loops
  
  while (!game.isOver() && iterations < MAX_ITERATIONS) {
    const state = game.getState();
    states.push(state);
    
    // Auto-pass untap/cleanup
    if (state.step === 'untap' || state.step === 'cleanup') {
      const action = { type: 'pass' as const, player: state.priorityPlayer };
      actions.push(action);
      game.submitAction(action);
      iterations++;
      continue;
    }
    
    // Choose action based on which bot has priority
    const action = state.priorityPlayer === 0 
      ? mlBot.chooseAction(state)
      : simpleBot.chooseAction(state);
    
    actions.push(action);
    game.submitAction(action);
    iterations++;
  }
  
  if (iterations >= MAX_ITERATIONS) {
    console.log(`⚠️  Game ${gameNum} hit iteration limit, declaring draw`);
  }
  
  return { states, actions, winner: game.getWinner() };
}

// Main training loop
async function main() {
  const { policy, value } = await initializeNetworks();
  const progress = loadProgress();
  
  const pipeline = new SelfPlayPipeline(
    policy,
    value,
    {
      phase2Games: TOTAL_GAMES,
      trainingInterval: TRAINING_INTERVAL,
      bufferSize: 1000
    }
  );
  
  const mlBot = new MLBot(0, policy, value, 1.0); // Temperature = 1.0 for exploration
  const simpleBot = new SimpleBot(1);
  
  let wins = 0;
  let losses = 0;
  let draws = 0;
  
  const startGame = progress.gamesPlayed;
  const startTime = Date.now();
  
  console.log(`🎮 Starting training from game ${startGame}...\n`);
  
  for (let game = startGame; game < TOTAL_GAMES; game++) {
    const gameNum = game + 1;
    
    // Play one game
    const { states, actions, winner } = await playGame(mlBot, simpleBot, gameNum);
    
    // Track results
    if (winner === 0) wins++;
    else if (winner === 1) losses++;
    else draws++;
    
    const won = winner === 0;
    
    // Record episode for training
    pipeline.recordEpisode(states, actions, 0, won);
    
    // Train every N games
    if (gameNum % TRAINING_INTERVAL === 0) {
      const stats = pipeline.trainFromBuffer();
      progress.recentLosses.push({
        policy: stats.policyLoss,
        value: stats.valueLoss
      });
      if (progress.recentLosses.length > 20) {
        progress.recentLosses = progress.recentLosses.slice(-20);
      }
      
      const winRate = wins / (wins + losses + draws);
      const elapsed = (Date.now() - startTime) / 1000;
      const gamesPerSec = (gameNum - startGame) / elapsed;
      const remaining = (TOTAL_GAMES - gameNum) / gamesPerSec;
      
      console.log(
        `📊 Game ${gameNum}/${TOTAL_GAMES} | ` +
        `Win: ${wins} Loss: ${losses} Draw: ${draws} (${(winRate * 100).toFixed(1)}%) | ` +
        `Policy Loss: ${stats.policyLoss.toFixed(4)} | ` +
        `Value Loss: ${stats.valueLoss.toFixed(4)} | ` +
        `${gamesPerSec.toFixed(1)} games/sec | ` +
        `ETA: ${Math.floor(remaining / 60)}m`
      );
    }
    
    // Save checkpoint every N games
    if (gameNum % SAVE_INTERVAL === 0) {
      progress.gamesPlayed = gameNum;
      progress.winRate = wins / (wins + losses + draws);
      progress.timestamp = Date.now();
      await saveCheckpoint(pipeline, progress);
    }
  }
  
  // Final save
  progress.gamesPlayed = TOTAL_GAMES;
  progress.winRate = wins / (wins + losses + draws);
  progress.timestamp = Date.now();
  saveCheckpoint(pipeline, progress);
  
  const totalTime = (Date.now() - startTime) / 1000;
  
  console.log('\n✅ Training Complete!');
  console.log('====================');
  console.log(`Total Games: ${TOTAL_GAMES}`);
  console.log(`Wins: ${wins} (${((wins / TOTAL_GAMES) * 100).toFixed(1)}%)`);
  console.log(`Losses: ${losses} (${((losses / TOTAL_GAMES) * 100).toFixed(1)}%)`);
  console.log(`Draws: ${draws} (${((draws / TOTAL_GAMES) * 100).toFixed(1)}%)`);
  console.log(`Total Time: ${Math.floor(totalTime / 60)}m ${Math.floor(totalTime % 60)}s`);
  console.log(`\nModel saved to: ${MODEL_DIR}`);
}

main().catch(console.error);
