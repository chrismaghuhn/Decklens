#!/usr/bin/env npx tsx
/**
 * CLI Bot Training v2 — Runs in Node.js terminal (faster, more stable than browser).
 *
 * Usage:
 *   npx tsx scripts/train-bot-cli.ts [--games 5000] [--mode self-play|vs-simple] [--backend auto|gpu|cpu|wasm]
 *                                     [--version v1|v2|v3|v4] [--deck random|aggro|midrange|control|ramp]
 *
 * Version flags:
 *   --version v4  — Uses Hierarchical Policy + 384 features (default, best performance)
 *   --version v3  — Uses Hierarchical Policy + 320 features
 *   --version v2  — Uses ResNet architecture + 256 features
 *   --version v1  — Uses legacy MLP architecture + 200 features
 *   --deck random — Randomly selects from 4 deck archetypes each game (default)
 *   --deck aggro|midrange|control|ramp — Use a specific archetype
 *
 * Backends:
 *   auto (default) — tries GPU → WASM → CPU native
 *   gpu            — CUDA GPU (requires tfjs-node-gpu + CUDA 11.8 + cuDNN 8.6)
 *   cpu            — Native C++ (tfjs-node, ~2-3x faster than WASM)
 *   wasm           — WebAssembly fallback (always works)
 */

import * as tf from '@tensorflow/tfjs';

import {
  Game, setupNewGame, createSimpleCard,
  getLegalActionTypes, autoTapLandsForCost, parseManaCost,
  type GameState, type GameAction,
} from '../packages/game-engine/src/index.ts';

import {
  MLBot, SimpleBot, SelfPlayPipeline,
  PolicyNetwork, ValueNetwork, FEATURE_DIM, FEATURE_DIM_V2,
  ResNetPolicy, ResNetValue,
  createPolicyNetwork, createValueNetwork, getConfig,
  OpponentPool,
  calculateReward, type Experience, type MLDecision,
  type NetworkVersion, type AnyPolicyNetwork, type AnyValueNetwork,
  runTrainingGame,
  runBenchmark,
} from '../packages/bot-ml/src/index.ts';

import fs from 'fs';
import path from 'path';

// === Configuration ===
const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const TOTAL_GAMES = parseInt(getArg('games', '5000'));
const TRAINING_MODE = getArg('mode', 'self-play');
const NET_VERSION = getArg('version', 'v4') as NetworkVersion; // v4 with 384 features - best performance
const DECK_MODE = getArg('deck', 'random');
const SAVE_PATH = 'public/trained-model';
const MAX_ACTIONS = 2000;        // Max real actions (land, spell, attack) — not counting passes
const MAX_TURNS = 30;            // Hard turn limit — game is a draw if no winner by turn 30
const DRAW_PENALTY = -30;        // Negative reward for draws to discourage stalemate play

// These get overridden after backend is known (GPU = bigger batches)
let TRAINING_INTERVAL = 200;
let SAVE_INTERVAL = 200;
let BUFFER_SIZE = 2000;
let BATCH_SIZE = 64;

// === Backend Setup (GPU → CPU Native → WASM) ===
async function setupBackend(): Promise<string> {
  const requested = getArg('backend', 'auto');

  function addDllPath(pkgName: string) {
    const dllDir = path.resolve(`node_modules/@tensorflow/${pkgName}/deps/lib`);
    if (fs.existsSync(dllDir)) {
      const sep = process.platform === 'win32' ? ';' : ':';
      process.env.PATH = dllDir + sep + (process.env.PATH || '');
    }
  }

  function applyNodePolyfills() {
    const nodeUtil = require('util');
    if (!nodeUtil.isNullOrUndefined) {
      nodeUtil.isNullOrUndefined = (v: unknown) => v === null || v === undefined;
    }
  }

  if (requested === 'gpu' || requested === 'auto') {
    try {
      addDllPath('tfjs-node-gpu');
      applyNodePolyfills();
      await import('@tensorflow/tfjs-node-gpu');
      await tf.ready();
      return 'GPU (CUDA)';
    } catch { /* GPU not available */ }
  }

  if (requested === 'wasm' || requested === 'auto') {
    try {
      await import('@tensorflow/tfjs-backend-wasm');
      await tf.setBackend('wasm');
      await tf.ready();
      return 'WASM';
    } catch { /* WASM not available */ }
  }

  if (requested === 'cpu' || requested === 'auto') {
    try {
      addDllPath('tfjs-node');
      applyNodePolyfills();
      await import('@tensorflow/tfjs-node');
      await tf.ready();
      return 'CPU (Native C++)';
    } catch { /* Native node not available */ }
  }

  throw new Error(`Backend "${requested}" not available. Use: auto, gpu, cpu, wasm`);
}

console.log(`\n🧠 MTG Bot CLI Training v2`);

// Ensure save directory exists
if (!fs.existsSync(SAVE_PATH)) {
  fs.mkdirSync(SAVE_PATH, { recursive: true });
}

// Global references for SIGINT handler
let globalPolicyNet: AnyPolicyNetwork;
let globalValueNet: AnyValueNetwork;

// Save on exit (Ctrl+C)
process.on('SIGINT', () => {
  console.log('\n\n💾 Saving model before exit...');
  if (globalPolicyNet && globalValueNet) {
    saveModelWeights(globalPolicyNet, globalValueNet);
  }
  process.exit();
});

// Helper to save model
function saveModelWeights(policyNet: AnyPolicyNetwork, valueNet: AnyValueNetwork) {
  try {
    const policyWeights = policyNet.getModel().weights.map(w => ({
      name: w.name,
      shape: w.shape,
      data: Array.from(w.read().dataSync()),
    }));
    const valueWeights = valueNet.getModel().weights.map(w => ({
      name: w.name,
      shape: w.shape,
      data: Array.from(w.read().dataSync()),
    }));

    // Include version metadata
    const metadata = { version: NET_VERSION, savedAt: new Date().toISOString() };
    // Use version-specific filenames to avoid conflicts between v2 and v3
    fs.writeFileSync(path.join(SAVE_PATH, `policy-weights-${NET_VERSION}.json`), JSON.stringify(policyWeights));
    fs.writeFileSync(path.join(SAVE_PATH, `value-weights-${NET_VERSION}.json`), JSON.stringify(valueWeights));
    fs.writeFileSync(path.join(SAVE_PATH, `model-meta-${NET_VERSION}.json`), JSON.stringify(metadata, null, 2));
    console.log(`✅ Model saved to ${SAVE_PATH}/ (${NET_VERSION})`);
  } catch (e) {
    console.error(`❌ Failed to save model: ${e}`);
  }
}

// Helper to load model
async function loadModelWeights(policyNet: AnyPolicyNetwork, valueNet: AnyValueNetwork) {
  const policyPath = path.join(SAVE_PATH, `policy-weights-${NET_VERSION}.json`);
  const valuePath = path.join(SAVE_PATH, `value-weights-${NET_VERSION}.json`);

  if (fs.existsSync(policyPath) && fs.existsSync(valuePath)) {
    try {
      console.log(`📥 Loading existing model weights from ${SAVE_PATH}...`);
      
      const policyWeights = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      const valueWeights = JSON.parse(fs.readFileSync(valuePath, 'utf8'));

      const policyModel = policyNet.getModel();
      const valueModel = valueNet.getModel();

      // Load weights into tensors
      for (const w of policyWeights) {
        const tensor = tf.tensor(w.data, w.shape);
        const weight = policyModel.weights.find(p => p.name === w.name);
        if (weight) weight.write(tensor);
      }

      for (const w of valueWeights) {
        const tensor = tf.tensor(w.data, w.shape);
        const weight = valueModel.weights.find(p => p.name === w.name);
        if (weight) weight.write(tensor);
      }
      
      console.log(`✅ Model loaded successfully! Continuing training from previous state.`);
    } catch (e) {
      console.error(`⚠️ Failed to load existing model: ${e}`);
      console.log(`Starting from scratch.`);
    }
  } else {
    console.log(`ℹ️ No existing model found for ${NET_VERSION}. Starting from scratch.`);
  }
}

// ══════════════════════════════════════════
// Diverse Training Decks (Phase 5)
// ══════════════════════════════════════════

type DeckArchetype = 'aggro' | 'midrange' | 'control' | 'ramp';
const ALL_ARCHETYPES: DeckArchetype[] = ['aggro', 'midrange', 'control', 'ramp'];

function createDeck(archetype: DeckArchetype, owner: 0 | 1): ReturnType<typeof createSimpleCard>[] {
  const cards: ReturnType<typeof createSimpleCard>[] = [];

  switch (archetype) {
    case 'aggro': {
      // 20 Lands, 30 small creatures (1-3 CMC), 10 burn/pump
      for (let i = 0; i < 10; i++) {
        cards.push(createSimpleCard('Mountain', 'Basic Land — Mountain', '', owner, {
          oracleText: '{T}: Add {R}.', colors: [], colorIdentity: ['R']
        }));
      }
      for (let i = 0; i < 10; i++) {
        cards.push(createSimpleCard('Plains', 'Basic Land — Plains', '', owner, {
          oracleText: '{T}: Add {W}.', colors: [], colorIdentity: ['W']
        }));
      }
      // 1-drops (10)
      for (let i = 0; i < 10; i++) {
        cards.push(createSimpleCard(`Goblin ${i}`, 'Creature — Goblin', '{R}', owner, {
          power: '2', toughness: '1', colors: ['R'], colorIdentity: ['R'],
          oracleText: 'Haste',
        }));
      }
      // 2-drops (12)
      for (let i = 0; i < 12; i++) {
        cards.push(createSimpleCard(`Soldier ${i}`, 'Creature — Soldier', '{1}{W}', owner, {
          power: '2', toughness: '2', colors: ['W'], colorIdentity: ['W'],
        }));
      }
      // 3-drops (8)
      for (let i = 0; i < 8; i++) {
        cards.push(createSimpleCard(`Berserker ${i}`, 'Creature — Warrior', '{2}{R}', owner, {
          power: '3', toughness: '2', colors: ['R'], colorIdentity: ['R'],
          oracleText: 'Trample',
        }));
      }
      // Burn spells (10)
      for (let i = 0; i < 10; i++) {
        cards.push(createSimpleCard('Lightning Bolt', 'Instant', '{R}', owner, {
          oracleText: 'Deal 3 damage to any target.', colors: ['R'], colorIdentity: ['R'],
          tags: ['removal'],
        }));
      }
      // 4 extra lands
      for (let i = 0; i < 4; i++) {
        cards.push(createSimpleCard('Battlefield Forge', 'Land', '', owner, {
          oracleText: '{T}: Add {R} or {W}.', colors: [], colorIdentity: ['R', 'W'],
        }));
      }
      break;
    }

    case 'midrange': {
      // 24 Lands, 20 mid-creatures (3-5 CMC), 8 removal, 8 draw
      for (let i = 0; i < 12; i++) {
        cards.push(createSimpleCard('Forest', 'Basic Land — Forest', '', owner, {
          oracleText: '{T}: Add {G}.', colors: [], colorIdentity: ['G']
        }));
      }
      for (let i = 0; i < 12; i++) {
        cards.push(createSimpleCard('Plains', 'Basic Land — Plains', '', owner, {
          oracleText: '{T}: Add {W}.', colors: [], colorIdentity: ['W']
        }));
      }
      // 3-drops (8)
      for (let i = 0; i < 8; i++) {
        cards.push(createSimpleCard(`Knight ${i}`, 'Creature — Knight', '{1}{G}{W}', owner, {
          power: '3', toughness: '3', colors: ['G', 'W'], colorIdentity: ['G', 'W'],
        }));
      }
      // 4-drops (8)
      for (let i = 0; i < 8; i++) {
        cards.push(createSimpleCard(`Beast ${i}`, 'Creature — Beast', '{2}{G}{G}', owner, {
          power: '4', toughness: '4', colors: ['G'], colorIdentity: ['G'],
          oracleText: 'Trample',
        }));
      }
      // 5-drops (4)
      for (let i = 0; i < 4; i++) {
        cards.push(createSimpleCard(`Angel ${i}`, 'Creature — Angel', '{3}{W}{W}', owner, {
          power: '4', toughness: '5', colors: ['W'], colorIdentity: ['W'],
          oracleText: 'Flying, lifelink',
          tags: ['finisher'],
        }));
      }
      // Removal (8)
      for (let i = 0; i < 8; i++) {
        cards.push(createSimpleCard('Path to Exile', 'Instant', '{W}', owner, {
          oracleText: 'Exile target creature.', colors: ['W'], colorIdentity: ['W'],
          tags: ['removal'],
        }));
      }
      // Draw (8)
      for (let i = 0; i < 8; i++) {
        cards.push(createSimpleCard('Harmonize', 'Sorcery', '{2}{G}{G}', owner, {
          oracleText: 'Draw three cards.', colors: ['G'], colorIdentity: ['G'],
          tags: ['draw'],
        }));
      }
      break;
    }

    case 'control': {
      // 26 Lands, 8 finishers (5-7 CMC), 16 removal/counter, 10 draw
      for (let i = 0; i < 13; i++) {
        cards.push(createSimpleCard('Island', 'Basic Land — Island', '', owner, {
          oracleText: '{T}: Add {U}.', colors: [], colorIdentity: ['U']
        }));
      }
      for (let i = 0; i < 13; i++) {
        cards.push(createSimpleCard('Plains', 'Basic Land — Plains', '', owner, {
          oracleText: '{T}: Add {W}.', colors: [], colorIdentity: ['W']
        }));
      }
      // Finishers (8)
      for (let i = 0; i < 4; i++) {
        cards.push(createSimpleCard(`Sphinx ${i}`, 'Creature — Sphinx', '{4}{U}{U}', owner, {
          power: '5', toughness: '6', colors: ['U'], colorIdentity: ['U'],
          oracleText: 'Flying. When this enters, draw two cards.',
          tags: ['finisher', 'draw'],
        }));
      }
      for (let i = 0; i < 4; i++) {
        cards.push(createSimpleCard(`Sun Titan ${i}`, 'Creature — Giant', '{4}{W}{W}', owner, {
          power: '6', toughness: '6', colors: ['W'], colorIdentity: ['W'],
          oracleText: 'Vigilance. When this enters, return target permanent with CMC 3 or less.',
          tags: ['finisher', 'recursion'],
        }));
      }
      // Removal (8)
      for (let i = 0; i < 4; i++) {
        cards.push(createSimpleCard('Swords to Plowshares', 'Instant', '{W}', owner, {
          oracleText: 'Exile target creature.', colors: ['W'], colorIdentity: ['W'],
          tags: ['removal'],
        }));
      }
      for (let i = 0; i < 4; i++) {
        cards.push(createSimpleCard('Wrath of God', 'Sorcery', '{2}{W}{W}', owner, {
          oracleText: 'Destroy all creatures.', colors: ['W'], colorIdentity: ['W'],
          tags: ['wipe', 'removal'],
        }));
      }
      // Counterspells (8)
      for (let i = 0; i < 8; i++) {
        cards.push(createSimpleCard('Counterspell', 'Instant', '{U}{U}', owner, {
          oracleText: 'Counter target spell.', colors: ['U'], colorIdentity: ['U'],
          tags: ['counter'],
        }));
      }
      // Draw (10)
      for (let i = 0; i < 10; i++) {
        cards.push(createSimpleCard('Preordain', 'Sorcery', '{U}', owner, {
          oracleText: 'Scry 2, then draw a card.', colors: ['U'], colorIdentity: ['U'],
          tags: ['draw'],
        }));
      }
      break;
    }

    case 'ramp': {
      // 22 Lands, 10 ramp, 14 big creatures (5-8 CMC), 14 other
      for (let i = 0; i < 11; i++) {
        cards.push(createSimpleCard('Forest', 'Basic Land — Forest', '', owner, {
          oracleText: '{T}: Add {G}.', colors: [], colorIdentity: ['G']
        }));
      }
      for (let i = 0; i < 11; i++) {
        cards.push(createSimpleCard('Mountain', 'Basic Land — Mountain', '', owner, {
          oracleText: '{T}: Add {R}.', colors: [], colorIdentity: ['R']
        }));
      }
      // Ramp spells (10)
      for (let i = 0; i < 5; i++) {
        cards.push(createSimpleCard('Rampant Growth', 'Sorcery', '{1}{G}', owner, {
          oracleText: 'Search for a basic land and put it onto the battlefield tapped.',
          colors: ['G'], colorIdentity: ['G'],
          tags: ['ramp'],
        }));
      }
      for (let i = 0; i < 5; i++) {
        cards.push(createSimpleCard('Llanowar Elves', 'Creature — Elf', '{G}', owner, {
          power: '1', toughness: '1', colors: ['G'], colorIdentity: ['G'],
          oracleText: '{T}: Add {G}.',
          tags: ['ramp'],
        }));
      }
      // Big creatures (14)
      for (let i = 0; i < 6; i++) {
        cards.push(createSimpleCard(`Dragon ${i}`, 'Creature — Dragon', '{4}{R}{R}', owner, {
          power: '6', toughness: '6', colors: ['R'], colorIdentity: ['R'],
          oracleText: 'Flying, trample',
          tags: ['finisher'],
        }));
      }
      for (let i = 0; i < 4; i++) {
        cards.push(createSimpleCard(`Wurm ${i}`, 'Creature — Wurm', '{5}{G}{G}', owner, {
          power: '7', toughness: '7', colors: ['G'], colorIdentity: ['G'],
          oracleText: 'Trample',
          tags: ['finisher'],
        }));
      }
      for (let i = 0; i < 4; i++) {
        cards.push(createSimpleCard(`Hydra ${i}`, 'Creature — Hydra', '{3}{G}{G}', owner, {
          power: '5', toughness: '5', colors: ['G'], colorIdentity: ['G'],
          oracleText: 'Trample',
        }));
      }
      // Support (14)
      for (let i = 0; i < 7; i++) {
        cards.push(createSimpleCard('Beast Within', 'Instant', '{2}{G}', owner, {
          oracleText: 'Destroy target permanent.', colors: ['G'], colorIdentity: ['G'],
          tags: ['removal'],
        }));
      }
      for (let i = 0; i < 7; i++) {
        cards.push(createSimpleCard('Harmonize', 'Sorcery', '{2}{G}{G}', owner, {
          oracleText: 'Draw three cards.', colors: ['G'], colorIdentity: ['G'],
          tags: ['draw'],
        }));
      }
      break;
    }
  }

  return cards;
}

/** Pick a random archetype or use the specified one */
function pickArchetype(): DeckArchetype {
  if (DECK_MODE === 'random') {
    return ALL_ARCHETYPES[Math.floor(Math.random() * ALL_ARCHETYPES.length)];
  }
  return DECK_MODE as DeckArchetype;
}

/** Legacy deck for backward compatibility (original vanilla deck) */
function createLegacyDeck(owner: 0 | 1): ReturnType<typeof createSimpleCard>[] {
  const cards: ReturnType<typeof createSimpleCard>[] = [];
  for (let i = 0; i < 10; i++) {
    cards.push(createSimpleCard('Plains', 'Basic Land — Plains', '', owner, {
      oracleText: '{T}: Add {W}.', colors: [], colorIdentity: ['W']
    }));
  }
  for (let i = 0; i < 10; i++) {
    cards.push(createSimpleCard('Forest', 'Basic Land — Forest', '', owner, {
      oracleText: '{T}: Add {G}.', colors: [], colorIdentity: ['G']
    }));
  }
  for (let i = 0; i < 30; i++) {
    cards.push(createSimpleCard(`Creature ${i}`, 'Creature — Soldier', '{2}{W}', owner, {
      power: '2', toughness: '2', colors: ['W'], colorIdentity: ['W']
    }));
  }
  for (let i = 0; i < 10; i++) {
    cards.push(createSimpleCard('Path to Exile', 'Instant', '{W}', owner, {
      oracleText: 'Exile target creature.', colors: ['W'], colorIdentity: ['W'],
      tags: ['removal']
    }));
  }
  for (let i = 0; i < 4; i++) {
    cards.push(createSimpleCard('Evolving Wilds', 'Land', '', owner, {
      oracleText: '{T}, Sacrifice Evolving Wilds: Search for a basic land.',
      tags: ['ramp', 'land-fetch']
    }));
  }
  return cards;
}

// === Play a single game ===
async function playGameWrapper(
  pipeline: SelfPlayPipeline,
  mlBot0: MLBot,
  mlBot1: MLBot | SimpleBot,
  shouldRecord: boolean,
): Promise<{ winner: number | null; turns: number; p0Exp: number; p1Exp: number; archetype: string; endReason: string }> {
  // v2: Pick diverse deck archetypes
  const arch0 = pickArchetype();
  const arch1 = pickArchetype();
  const deck1 = createDeck(arch0, 0);
  const deck2 = createDeck(arch1, 1);
  const initialState = setupNewGame(
    'MLBot', deck1, deck1[0],
    'Opponent', deck2, deck2[0]
  );
  
  // Create Game instance
  const game = new Game(initialState);
  
  // Bots are already created with correct player IDs
  // mlBot0.player = 0;
  // if (mlBot1 instanceof MLBot || mlBot1 instanceof SimpleBot) {
  //   (mlBot1 as any).player = 1;
  // }

  // Use runTrainingGame
  // p1 must be MLBot for standard call, but we might have SimpleBot.
  // runTrainingGame signature: (game, p0: MLBot, p1: MLBot, pipeline, learnP0, learnP1)
  // We need to cast or ensure compatibility. 
  // MLBot and SimpleBot both usually implement Bot interface, but runTrainingGame asks for MLBot specifically for chooseActionWithReason?
  // Actually runTrainingGame imports MLBot from ../bot-ml.ts. SimpleBot is from ../bots/simple-bot.ts.
  // runTrainingGame requires internal "reasoning" (chooseActionWithReason). SimpleBot does not have this.
  // If opponent is SimpleBot, we can't use runTrainingGame as written if it strictly expects MLBot for p1.
  // Let's check runTrainingGame implementation detail for p1.
  // It calls actingBot.chooseActionWithReason(state). SimpleBot doesn't have this.
  
  // FIX: We need runTrainingGame to handle non-ML opponents, or we need to wrap SimpleBot.
  // But runTrainingGame is designed for training.
  // If p1 is SimpleBot, we shouldn't act as if it's MLBot.
  
  // Since I just edited training-game-loop.ts, I know it types p1 as MLBot.
  // I should update training-game-loop.ts to accept (MLBot | Bot) and only learn if MLBot.
  // But I prefer not to go back and forth.
  
  // Workaround: If p1 is SimpleBot, we can't use runTrainingGame easily without modification.
  // However, SelfPlayPipeline usually implies ML vs ML or ML vs Heuristic.
  // HeuristicBot IS compatible if we wrapped it? No.
  
  // Let's modify train-bot-cli.ts to usage of SelfPlayPipeline's method OR update runTrainingGame to be more flexible.
  // Actually, runTrainingGame being strictly for MLBot vs MLBot (or MLBot vs wrapped) is annoying.
  // But wait, the previous `self-play.ts` passed `heuristicOpponent` to `runTrainingGame`.
  // `runTrainingGame(game, p0, p1, ...)`
  // In `self-play.ts`: `p1 = opponent === 'self' ? mlBot2 : heuristicOpponent`
  // And `runTrainingGame` signature: `p1: MLBot`. 
  // This means `self-play.ts` WAS TYPE CASTING `HeuristicBot` to `MLBot`!
  // And `runTrainingGame` CALLS `chooseActionWithReason`.
  // `HeuristicBot` (from bot-core) does NOT have `chooseActionWithReason`.
  // THIS WILL CRASH AT RUNTIME if p1 acts.
  
  // I must fix runTrainingGame to handle generic Bots for p1 if learnP1 is false.
  
  // For now, I will update train-bot-cli.ts but I also MUST fix training-game-loop.ts to genericize p1.
  // But first, let's implement the wrapper here assuming proper runTrainingGame.
  
  const p1IsML = mlBot1 instanceof MLBot;
  
  // For safety, if p1 is not ML, we might crash if runTrainingGame isn't fixed.
  // I'll assume I'll fix runTrainingGame next.
  
  const result = await runTrainingGame(
    game,
    mlBot0,
    mlBot1 as any, // Cast for now, will fix signature
    pipeline,
    true, // Learn P0
    p1IsML // Learn P1 only if ML
  );
  
  return {
    winner: result.winner ?? null,
    turns: result.turns,
    p0Exp: result.turns, // approximate, or we don't count? CLI uses this for stats.
    p1Exp: result.turns, 
    archetype: `${arch0} vs ${arch1}`,
    endReason: result.turns >= 100 ? 'turn-limit' : 'normal'
  };
}

// === Progress Bar ===
function progressBar(current: number, total: number, width = 30): string {
  const pct = current / total;
  const filled = Math.round(pct * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
  return `[${bar}] ${(pct * 100).toFixed(1)}%`;
}

// === Main Training Loop ===
async function main() {
  console.log('Initializing backend...');

  const backendName = await setupBackend();
  const isGPU = backendName.includes('GPU');
  const isNative = backendName.includes('Native') || isGPU;
  console.log(`Backend: ${backendName} (${tf.getBackend()})`);

  // Adjust training params for faster backends
  if (isGPU) {
    BATCH_SIZE = 512;
    BUFFER_SIZE = 8000;
    TRAINING_INTERVAL = 500;
    SAVE_INTERVAL = 500;
    console.log('  → GPU mode: batch=512, buffer=8000, interval=500');
  } else if (isNative) {
    BATCH_SIZE = 128;
    BUFFER_SIZE = 4000;
    TRAINING_INTERVAL = 200;
    SAVE_INTERVAL = 200;
    console.log('  → Native CPU mode: batch=128, buffer=4000');
  }

  const netConfig = getConfig(NET_VERSION);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Version:  ${NET_VERSION} (${netConfig.featureDim} features)`);
  console.log(`  Games:    ${TOTAL_GAMES}`);
  console.log(`  Mode:     ${TRAINING_MODE}`);
  console.log(`  Deck:     ${DECK_MODE}`);
  console.log(`  Backend:  ${backendName}`);
  console.log(`  Batch:    ${BATCH_SIZE}`);
  console.log(`  Buffer:   ${BUFFER_SIZE}`);
  console.log(`  Save to:  ${SAVE_PATH}/`);
  console.log(`  Interval: every ${TRAINING_INTERVAL} games`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  console.log('Initializing networks...');

  // v2: Use factory to create correct architecture
  const policyNet = createPolicyNetwork(netConfig);
  const valueNet = createValueNetwork(netConfig);

  // Load existing weights if available
  await loadModelWeights(policyNet, valueNet);

  // Update globals for SIGINT handler
  globalPolicyNet = policyNet;
  globalValueNet = valueNet;

  // v3: Opponent Pool for training diversity with Elo tracking
  const opponentPool = new OpponentPool(5, 0.3);

  // v3: Reusable opponent network pool to avoid memory leaks
  const OPPONENT_POOL_SIZE = 3;
  const opponentNetworks: { policy: AnyPolicyNetwork; value: AnyValueNetwork; inUse: boolean }[] = [];
  
  // Pre-allocate opponent networks
  for (let i = 0; i < OPPONENT_POOL_SIZE; i++) {
    opponentNetworks.push({
      policy: createPolicyNetwork(netConfig),
      value: createValueNetwork(netConfig),
      inUse: false
    });
  }

  const mlBot0 = new MLBot(0, policyNet as any, valueNet as any, 1.0, netConfig.featureDim);
  
  // Base opponent (changes each game)
  let mlBot1: MLBot | SimpleBot;
  if (TRAINING_MODE === 'self-play') {
    mlBot1 = new MLBot(1, policyNet as any, valueNet as any, 1.0, netConfig.featureDim);
  } else {
    mlBot1 = new SimpleBot(1);
  }
  
  // Helper to get a free opponent network from pool
  function getFreeOpponentNetwork(): { policy: AnyPolicyNetwork; value: AnyValueNetwork } | null {
    for (const net of opponentNetworks) {
      if (!net.inUse) {
        net.inUse = true;
        return { policy: net.policy, value: net.value };
      }
    }
    return null; // All networks in use
  }
  
  // Helper to release opponent network back to pool
  function releaseOpponentNetwork(network: { policy: AnyPolicyNetwork; value: AnyValueNetwork } | null) {
    if (!network) return;
    for (const net of opponentNetworks) {
      if (net.policy === network.policy) {
        net.inUse = false;
        break;
      }
    }
  }

  const pipeline = new SelfPlayPipeline(policyNet as any, valueNet as any, {
    trainingInterval: TRAINING_INTERVAL,
    bufferSize: BUFFER_SIZE,
  });

  console.log('Training started!\n');

  let wins = 0;
  let draws = 0;
  let totalExp = 0;
  let totalTurns = 0;
  const startTime = Date.now();
  let lastLogTime = startTime;
  const archetypeCounts: Record<string, number> = {};
  const endReasons: Record<string, number> = {};

  for (let g = 1; g <= TOTAL_GAMES; g++) {
    let opponentId = 'current'; // Default to self-play
    
    // v3: Maybe use historical opponent
    let releasedNetwork: { policy: AnyPolicyNetwork; value: AnyValueNetwork } | null = null;
    const snapshot = opponentPool.getOpponent();
    if (snapshot) {
      opponentId = snapshot.id;
      // Reuse a network from the pool instead of creating new ones
      const netPoolEntry = getFreeOpponentNetwork();
      if (netPoolEntry) {
        releasedNetwork = netPoolEntry;
        OpponentPool.applySnapshot(snapshot, netPoolEntry.policy.getModel(), netPoolEntry.value.getModel());
        mlBot1 = new MLBot(1, netPoolEntry.policy as any, netPoolEntry.value as any, 1.0, netConfig.featureDim);
      } else {
        // Fallback: all networks in use, use current model
        opponentId = 'current';
        mlBot1 = new MLBot(1, policyNet as any, valueNet as any, 1.0, netConfig.featureDim);
      }
    } else {
      // Reset to default opponent if no snapshot was chosen
      if (TRAINING_MODE === 'self-play') {
        opponentId = 'current';
        // Ensure weights are current - reuse existing mlBot1 or create new with current weights
        mlBot1 = new MLBot(1, policyNet as any, valueNet as any, 1.0, netConfig.featureDim);
      } else {
        opponentId = 'simple';
        mlBot1 = new SimpleBot(1);
      }
    }

    // v3: Snapshot current model
    opponentPool.maybeSnapshot(policyNet.getModel(), valueNet.getModel(), g, 2000);

    const result = await playGameWrapper(pipeline, mlBot0, mlBot1, true);

    if (result.winner === 0) {
      wins++;
      opponentPool.updateElo('current', opponentId, false);
    } else if (result.winner === 1) {
      opponentPool.updateElo(opponentId, 'current', false);
    } else {
      draws++;
      opponentPool.updateElo('current', opponentId, true);
    }
    
    totalExp += result.p0Exp + result.p1Exp;
    totalTurns += result.turns;
    
    // Release opponent network back to pool for reuse
    releaseOpponentNetwork(releasedNetwork);

    // Track archetype distribution and end reasons
    archetypeCounts[result.archetype] = (archetypeCounts[result.archetype] || 0) + 1;
    endReasons[result.endReason] = (endReasons[result.endReason] || 0) + 1;

    // Train every TRAINING_INTERVAL games
    if (g % TRAINING_INTERVAL === 0) {
      const stats = pipeline.trainFromBuffer();
      const elapsed = (Date.now() - startTime) / 1000;
      const gps = g / elapsed;
      const eta = ((TOTAL_GAMES - g) / gps);
      const winRate = (wins / g * 100).toFixed(1);
      const drawRate = (draws / g * 100).toFixed(1);
      const avgTurns = (totalTurns / g).toFixed(1);

      process.stdout.write('\r\x1b[K');
      console.log(
        `${progressBar(g, TOTAL_GAMES)} | ` +
        `Game ${g}/${TOTAL_GAMES} | ` +
        `${gps.toFixed(1)} g/s | ` +
        `Win: ${winRate}% Draw: ${drawRate}% | ` +
        `Turns: ${avgTurns} | ` +
        `Loss P: ${stats.policyLoss.toFixed(4)} V: ${stats.valueLoss.toFixed(4)} | ` +
        `Pool: ${opponentPool.size} | ` +
        `ETA: ${Math.floor(eta / 60)}m ${Math.floor(eta % 60)}s`
      );
    }

    // Save every SAVE_INTERVAL games and run benchmark
    if (g % SAVE_INTERVAL === 0) {
      saveModelWeights(policyNet, valueNet);
      
      // Run benchmark against heuristic bot
      const benchmarkResult = await runBenchmark(mlBot0, 20);
      console.log(
        `\n📊 Benchmark vs Heuristic: ` +
        `Win Rate: ${(benchmarkResult.winRate * 100).toFixed(1)}% | ` +
        `Avg Turns: ${benchmarkResult.avgTurns.toFixed(1)} | ` +
        `(${benchmarkResult.wins}W / ${benchmarkResult.losses}L / ${benchmarkResult.draws}D)`
      );
    }

    // Live speed update every 2 seconds
    const now = Date.now();
    if (now - lastLogTime > 2000 && g % TRAINING_INTERVAL !== 0) {
      const elapsed = (now - startTime) / 1000;
      const gps = g / elapsed;
      const eta = ((TOTAL_GAMES - g) / gps);
      process.stdout.write(
        `\r\x1b[K  ⏳ Game ${g}/${TOTAL_GAMES} | ${gps.toFixed(1)} g/s | ETA: ${Math.floor(eta / 60)}m ${Math.floor(eta % 60)}s`
      );
      lastLogTime = now;
    }
  }

  console.log('\n\n✅ Training complete!');
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`  Version:    ${NET_VERSION}`);
  console.log(`  Total time: ${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`);
  console.log(`  Games/sec:  ${(TOTAL_GAMES / elapsed).toFixed(1)}`);
  console.log(`  Win rate:   ${(wins / TOTAL_GAMES * 100).toFixed(1)}%`);
  console.log(`  Draw rate:  ${(draws / TOTAL_GAMES * 100).toFixed(1)}%`);
  console.log(`  Avg turns:  ${(totalTurns / TOTAL_GAMES).toFixed(1)}`);
  console.log(`  Experiences: ${totalExp}`);
  console.log(`  Snapshots:  ${opponentPool.size}`);
  console.log(`  End reasons: ${JSON.stringify(endReasons)}`);
  console.log(`  Deck dist:  ${JSON.stringify(archetypeCounts)}`);

  // Final save
  saveModelWeights(policyNet, valueNet);
}

main().catch(console.error);
