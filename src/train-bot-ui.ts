/**
 * Bot Training UI — Browser-based training interface.
 * 
 * Runs headless games and updates UI with real-time progress.
 * OPTIMIZED: Inline experience recording, no state storage, reduced yielding.
 */

import { 
  Game, setupNewGame, createSimpleCard, 
  getLegalActionTypes, parseManaCost, calculateCMC, autoTapLandsForCost,
  type GameState, type GameAction 
} from '@mtg/game-engine';
import { MLBot, SimpleBot, SelfPlayPipeline, PolicyNetwork, ValueNetwork, FEATURE_DIM, calculateReward, type Experience, type MLDecision } from '@mtg/bot-ml';
import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-webgl';



interface TrainingState {
  running: boolean;
  paused: boolean;
  gamesPlayed: number;
  wins: number;
  losses: number;
  draws: number;
  startTime: number;
  lastUpdateTime: number;
  currentPhase: 1 | 2 | 3;
  phaseGames: number;
}

const state: TrainingState = {
  running: false,
  paused: false,
  gamesPlayed: 0,
  wins: 0,
  losses: 0,
  draws: 0,
  startTime: 0,
  lastUpdateTime: 0,
  currentPhase: 1,
  phaseGames: 0,
};

let pipeline: SelfPlayPipeline;
let policyNet: PolicyNetwork;
let valueNet: ValueNetwork;
let mlBot0: MLBot;   // ML player 0
let mlBot1: MLBot;   // ML player 1 (for self-play)
let simpleBot: SimpleBot; // Player 1
let simpleBot0: SimpleBot; // Player 0 (for Imitation/Benchmark)

// UI Elements
const btnStart = document.getElementById('btn-start') as HTMLButtonElement;
const btnPause = document.getElementById('btn-pause') as HTMLButtonElement;
const btnStop = document.getElementById('btn-stop') as HTMLButtonElement;
const totalGamesInput = document.getElementById('total-games') as HTMLInputElement;
const trainingModeSelect = document.getElementById('training-mode') as HTMLSelectElement;
const gameSpeedSelect = document.getElementById('game-speed') as HTMLSelectElement;
const progressFill = document.getElementById('progress-fill') as HTMLDivElement;
const progressText = document.getElementById('progress-text') as HTMLElement;
const statGames = document.getElementById('stat-games') as HTMLDivElement;
const statWinrate = document.getElementById('stat-winrate') as HTMLDivElement;
const statPolicyLoss = document.getElementById('stat-policy-loss') as HTMLDivElement;
const statValueLoss = document.getElementById('stat-value-loss') as HTMLDivElement;
const statSpeed = document.getElementById('stat-speed') as HTMLDivElement;
const statEta = document.getElementById('stat-eta') as HTMLDivElement;
const logContainer = document.getElementById('log-container') as HTMLDivElement;

// Create sample deck
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
  
  // Ramp
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
  
  // Creatures
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

/** Game result with inline-recorded experiences */
interface GameResult {
  p0Experiences: Experience[];
  p1Experiences: Experience[];
  winner: 0 | 1 | null;
  turns: number;
}
/**
 * Play one game with INLINE experience recording.
 * OPTIMIZED: Single getState() per step, skip recording for pass actions.
 */
function playGame(): GameResult {
  const deck1 = createSampleDeck(0);
  const deck2 = createSampleDeck(1);
  
  const initialState = setupNewGame(
    'MLBot', deck1, deck1[0],
    'Opponent', deck2, deck2[0]
  );
  
  const game = new Game(initialState);
  const p0Experiences: Experience[] = [];
  const p1Experiences: Experience[] = [];
  
  let iterations = 0;
  const MAX_ITERATIONS = 500;
  
  // Determine bot assignments — MUST use correct player identity!
  const trainingMode = trainingModeSelect.value;
  const phaseConfig = getPhaseConfig(trainingMode);
  
  let bot2: SimpleBot | MLBot;  // Player 1's bot
  if (phaseConfig) {
    bot2 = state.currentPhase === 3 ? mlBot1 : simpleBot;
  } else {
    if (trainingMode === 'benchmark') {
       bot2 = simpleBot;
    } else {
       bot2 = trainingMode === 'self-play' ? mlBot1 : simpleBot;
    }
  }
  
  let player0Bot: SimpleBot | MLBot;  // Player 0's bot
  if (trainingMode === 'benchmark') {
      player0Bot = simpleBot0;
  } else if (phaseConfig && state.currentPhase === 1) {
      player0Bot = simpleBot0;
  } else {
      player0Bot = mlBot0;
  }

  // Track whether we should record experiences (not for benchmark)
  const shouldRecord = trainingMode !== 'benchmark';
  
  // OPTIMIZATION: Only ONE getState() per iteration — reuse from previous
  let gameState = game.getState();
  let consecutivePasses = 0;  // Stalemate detection
  let landsPlayedThisTurn = 0;
  let lastTurn = 0;
  
  while (!game.isOver() && iterations < MAX_ITERATIONS) {
    // Auto-pass untap/cleanup (no experience to record)
    if (gameState.step === 'untap' || gameState.step === 'cleanup') {
      game.submitAction({ type: 'pass', player: gameState.priorityPlayer });
      gameState = game.getState();
      iterations++;
      continue;
    }
    
    const currentPlayer = gameState.priorityPlayer;
    const me = gameState.players[currentPlayer];
    
    // Reset land counter on new turn
    if (gameState.turn !== lastTurn) {
      landsPlayedThisTurn = 0;
      lastTurn = gameState.turn;
    }
    
    // STEP 1: Neural net evaluates the state (always, for training data)
    const bot = currentPlayer === 0 ? player0Bot : bot2;
    let action: GameAction;
    let decision: MLDecision | null = null;
    
    if (bot instanceof MLBot) {
      decision = bot.chooseActionWithReason(gameState);
      action = decision.action;
    } else {
      action = bot.chooseAction(gameState);
    }
    action.player = currentPlayer;
    
    // STEP 2: Heuristic overrides — force good actions during training
    let actionIndex = decision?.actionIndex ?? 0;
    
    // Block concede/mulligan
    if (action.type === 'concede' || action.type === 'mulligan') {
      action = { type: 'pass', player: currentPlayer };
      actionIndex = 0;  // pass index
    }
    
    // Override: Play land if available in main phase
    if (landsPlayedThisTurn === 0 && 
        (gameState.phase === 'precombat-main' || gameState.phase === 'postcombat-main')) {
      const land = me.hand.find(c => c.typeLine.toLowerCase().includes('land'));
      if (land) {
        action = { type: 'play-land', player: currentPlayer, cardId: land.id };
        actionIndex = 1;  // play-land index
      }
    }
    
    // Override: Cast spell if affordable in main phase
    if (action.type === 'pass' && 
        (gameState.phase === 'precombat-main' || gameState.phase === 'postcombat-main')) {
      for (let i = 0; i < me.hand.length; i++) {
        const card = me.hand[i];
        if (card.typeLine.toLowerCase().includes('land') || !card.manaCost) continue;
        const tapResult = autoTapLandsForCost(me, parseManaCost(card.manaCost));
        if (tapResult) {
          action = {
            type: 'cast-spell', player: currentPlayer, cardId: card.id,
            targets: [], manaPayment: tapResult.payment,
          };
          actionIndex = 2;  // cast-spell index
          break;
        }
      }
    }
    
    // Override: Attack with all creatures during combat
    if (gameState.step === 'declare-attackers') {
      const attackers = me.battlefield
        .filter(p => p.typeLine.toLowerCase().includes('creature') && !p.summoningSick && !p.tapped)
        .map(p => p.id);
      if (attackers.length > 0) {
        action = { type: 'declare-attackers', player: currentPlayer, attackers };
        actionIndex = 3;  // declare-attackers index
      }
    }
    
    // Track stalemate
    if (action.type === 'pass') {
      consecutivePasses++;
      if (consecutivePasses >= 100) break;
    } else {
      consecutivePasses = 0;
      if (action.type === 'play-land') landsPlayedThisTurn++;
    }
    
    // STEP 3: Execute action
    try {
      game.submitAction(action);
    } catch (e) {
      game.submitAction({ type: 'pass', player: currentPlayer });
      action = { type: 'pass', player: currentPlayer };
      actionIndex = 0;
    }
    
    const nextState = game.getState();
    
    // STEP 4: Record experience (always, for ALL non-pass actions)
    if (shouldRecord && action.type !== 'pass' && decision) {
      const reward = calculateReward(gameState, action, nextState, currentPlayer);
      const exp: Experience = {
        features: decision.features,
        actionIndex,
        reward,
        value: decision.value,
        logProb: decision.logProb,
        done: false,
        player: currentPlayer,
      };
      if (currentPlayer === 0) p0Experiences.push(exp);
      else p1Experiences.push(exp);
    }
    
    gameState = nextState;  // Reuse — no extra getState() call!
    iterations++;
  }
  
  return {
    p0Experiences,
    p1Experiences,
    winner: game.getWinner(),
    turns: gameState.turn,
  };
}

// Log message
function log(message: string, type: 'info' | 'warn' | 'error' = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// Update UI
function updateUI() {
  const totalGames = parseInt(totalGamesInput.value);
  const progress = (state.gamesPlayed / totalGames) * 100;
  const winRate = state.wins / (state.wins + state.losses + state.draws || 1);
  
  progressFill.style.width = `${progress}%`;
  progressFill.textContent = `${Math.floor(progress)}%`;
  
  let gamesPerSec = 0;
  if (state.gamesPlayed > 0) {
    const elapsed = (Date.now() - state.startTime) / 1000;
    gamesPerSec = state.gamesPlayed / elapsed;
  }
  
  const remaining = totalGames - state.gamesPlayed;
  const etaSeconds = gamesPerSec > 0 ? remaining / gamesPerSec : 0;
  const etaMinutes = Math.floor(etaSeconds / 60);
  const etaSecondsRem = Math.floor(etaSeconds % 60);
  
  statGames.textContent = state.gamesPlayed.toString();
  statWinrate.textContent = `${(winRate * 100).toFixed(1)}%`;
  statSpeed.textContent = gamesPerSec.toFixed(1);
  statEta.textContent = etaSeconds > 0 ? `${etaMinutes}m ${etaSecondsRem}s` : '-';
  
  const phaseStr = state.currentPhase > 1 ? ` | Phase ${state.currentPhase}` : '';
  progressText.textContent = state.running 
    ? `Training... ${state.gamesPlayed}/${totalGames} games | ${state.wins}W ${state.losses}L ${state.draws}D${phaseStr}`
    : state.gamesPlayed > 0 
    ? 'Training paused'
    : 'Ready to start training';
}

// Get phase configuration for 3-phase training
function getPhaseConfig(trainingMode: string) {
  if (trainingMode !== '3-phase') return null;
  
  return {
    phase1Games: 2000,  // Imitation Learning
    phase2Games: 8000,  // vs SimpleBot
    phase3Games: 5000,  // Self-Play
  };
}

// Training loop — OPTIMIZED: batch games, reduced yielding
async function trainingLoop() {
  const totalGames = parseInt(totalGamesInput.value);
  const trainingInterval = 200;
  const gameSpeed = gameSpeedSelect.value;
  const delay = gameSpeed === 'fast' ? 0 : gameSpeed === 'normal' ? 100 : 500;
  const trainingMode = trainingModeSelect.value;
  const phaseConfig = getPhaseConfig(trainingMode);
  
  // How many games to batch before yielding to UI
  const BATCH_SIZE = gameSpeed === 'fast' ? 10 : 1;
  
  while (state.running && state.gamesPlayed < totalGames) {
    if (state.paused) {
      await new Promise(resolve => setTimeout(resolve, 100));
      continue;
    }
    
    // Play a batch of games before yielding
    for (let b = 0; b < BATCH_SIZE && state.running && state.gamesPlayed < totalGames; b++) {
      // Play game with inline recording
      const result = playGame();
      
      // Track results
      if (result.winner === 0) state.wins++;
      else if (result.winner === 1) state.losses++;
      else state.draws++;
      
      state.gamesPlayed++;
      state.phaseGames++;
      
      // Check for phase progression in 3-phase mode
      if (phaseConfig && state.currentPhase < 3) {
        if (state.currentPhase === 1 && state.phaseGames >= phaseConfig.phase1Games) {
          state.currentPhase = 2;
          state.phaseGames = 0;
          log(`📈 Phase 2 started: Training vs SimpleBot`, 'info');
        } else if (state.currentPhase === 2 && state.phaseGames >= phaseConfig.phase2Games) {
          state.currentPhase = 3;
          state.phaseGames = 0;
          log(`🚀 Phase 3 started: Self-Play`, 'info');
        }
      }
      
      // Finish episodes (add to replay buffer)
      const won = result.winner === 0;
      
      if (phaseConfig && state.currentPhase === 1) {
        // Phase 1: Imitation learning — record both players
        pipeline.finishEpisode(result.p0Experiences, result.winner === 0, result.turns);
        pipeline.finishEpisode(result.p1Experiences, result.winner === 1, result.turns);
      } else if (!phaseConfig || state.currentPhase === 2 || trainingMode === 'vs-simple') {
        // Phase 2: vs SimpleBot — only ML bot (player 0) learns
        pipeline.finishEpisode(result.p0Experiences, won, result.turns);
      } else if (trainingMode === 'self-play' || (phaseConfig && state.currentPhase === 3)) {
        // Self-play: both learn
        pipeline.finishEpisode(result.p0Experiences, won, result.turns);
        pipeline.finishEpisode(result.p1Experiences, !won, result.turns);
      }
      
      // Train every N games
      if (state.gamesPlayed % trainingInterval === 0) {
        try {
          const t0 = performance.now();
          const stats = pipeline.trainFromBuffer();
          const tTrain = performance.now() - t0;
          
          const t1 = performance.now();
          await pipeline.getPolicyNetwork().syncWeights();
          await pipeline.getValueNetwork().syncWeights();
          const tSync = performance.now() - t1;
          
          statPolicyLoss.textContent = stats.policyLoss.toFixed(4);
          statValueLoss.textContent = stats.valueLoss.toFixed(4);
          
          const phaseStr2 = phaseConfig ? `Phase ${state.currentPhase}` : trainingMode;
          const currentSpeed = (state.gamesPlayed / ((Date.now() - state.startTime) / 1000));
          log(`[TIMING] Training: ${tTrain.toFixed(0)}ms | Sync: ${tSync.toFixed(0)}ms | Speed: ${currentSpeed.toFixed(1)} g/s`);
          log(`[${phaseStr2}] Game ${state.gamesPlayed}: Loss ${stats.policyLoss.toFixed(4)}/${stats.valueLoss.toFixed(4)}`);
        } catch (err) {
          log(`Error in training step: ${err}`, 'error');
          console.error(err);
        }
      }
      
      // Save every 1000 games
      if (state.gamesPlayed % 1000 === 0) {
        saveModel();
        log(`Checkpoint saved (${state.gamesPlayed} games)`, 'info');
      }
    }
    
    // Update UI after each batch
    updateUI();
    
    // Yield to UI thread once per batch
    await tf.nextFrame();
    
    // Additional delay if set
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  if (state.gamesPlayed >= totalGames) {
    log(`✅ Training complete! ${state.gamesPlayed} games played.`, 'info');
    saveModel();
    stopTraining();
  }
}

// Save model to localStorage
async function saveModel() {
  try {
    await pipeline.getPolicyNetwork().saveToLocalStorage('mlbot-policy');
    await pipeline.getValueNetwork().saveToLocalStorage('mlbot-value');
    localStorage.setItem('mlbot-games', state.gamesPlayed.toString());
  } catch (e) {
    console.error('Failed to save model:', e);
  }
}

// Load model from localStorage
async function loadModel(): Promise<{ policy?: PolicyNetwork; value?: ValueNetwork }> {
  try {
    const policyExists = await tf.io.listModels();
    if (policyExists['localstorage://mlbot-policy']) {
      const policy = await PolicyNetwork.loadFromLocalStorage('mlbot-policy');
      const value = await ValueNetwork.loadFromLocalStorage('mlbot-value');
      return { policy, value };
    }
  } catch (e) {
    console.warn('No saved model found or load failed:', e);
  }
  return {};
}

// Start training
// Start training
async function startTraining() {
  if (state.running) return;
  
  state.running = true;
  state.paused = false;
  state.startTime = Date.now();
  
  // Initialize TensorFlow.js WebGL backend if not already
  try {
    if (tf.getBackend() !== 'webgl') {
      await tf.setBackend('webgl');
      await tf.ready();
    }
  } catch (e) {
    console.warn('WebGL initialization failed', e);
  }
  
  btnStart.style.display = 'none';
  btnPause.style.display = 'inline-block';
  btnStop.style.display = 'inline-block';
  totalGamesInput.disabled = true;
  trainingModeSelect.disabled = true;
  
  log(`Starting training for ${totalGamesInput.value} games...`, 'info');
  
  trainingLoop();
}

// Pause/Resume training
function togglePause() {
  state.paused = !state.paused;
  btnPause.textContent = state.paused ? '▶️ Resume' : '⏸️ Pause';
  log(state.paused ? 'Training paused' : 'Training resumed', 'info');
}

// Stop training
function stopTraining() {
  state.running = false;
  btnStart.style.display = 'inline-block';
  btnPause.style.display = 'none';
  btnStop.style.display = 'none';
  totalGamesInput.disabled = false;
  trainingModeSelect.disabled = false;
  log('Training stopped', 'warn');
  updateUI();
}

// Load CLI Model Handler
document.getElementById('btn-load-model')?.addEventListener('click', async () => {
  const input = document.getElementById('model-upload') as HTMLInputElement;
  if (!input.files || input.files.length === 0) {
    alert('Please select both policy-weights.json and value-weights.json');
    return;
  }
  
  try {
    let policyWeights: any[] = [];
    let valueWeights: any[] = [];
    
    for (const file of Array.from(input.files)) {
      const text = await file.text();
      const json = JSON.parse(text);
      if (file.name.includes('policy')) policyWeights = json;
      else if (file.name.includes('value')) valueWeights = json;
    }
    
    if (policyWeights.length === 0 || valueWeights.length === 0) {
      log('⚠️ Missing files. Filenames must contain "policy" and "value".', 'warn');
      return;
    }
    
    // Helper to convert JSON weights to Tensors
    const toTensors = (weights: any[]) => weights.map(w => tf.tensor(w.data, w.shape));
    
    // Update global networks
    policyNet.getModel().setWeights(toTensors(policyWeights));
    valueNet.getModel().setWeights(toTensors(valueWeights));
    
    log(`✅ Successfully loaded CLI model! Weights updated.`, 'info');
    alert('Model loaded successfully!');
    
  } catch (e) {
    console.error(e);
    log(`❌ Error loading model: ${e}`, 'error');
    alert('Error loading model. Check console.');
  }
});

// Wire up buttons
btnStart.addEventListener('click', startTraining);
btnPause.addEventListener('click', togglePause);
btnStop.addEventListener('click', stopTraining);

// === WATCH LIVE LOGIC ===
let watchLiveMode = false;
const btnWatchLive = document.getElementById('btn-watch-live') as HTMLButtonElement;
const liveStatus = document.getElementById('live-status') as HTMLDivElement;
const lastUpdateSpan = document.getElementById('last-update-time') as HTMLSpanElement;

async function toggleWatchLive() {
  if (watchLiveMode) {
    // Stop watching
    watchLiveMode = false;
    btnWatchLive.textContent = '🛑 Start Live Watch';
    btnWatchLive.style.background = 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)'; // Red
    liveStatus.style.display = 'none';
    log('Stopped live watch.', 'info');
    return;
  }

  // Start watching
  watchLiveMode = true;
  btnWatchLive.textContent = '⏹️ Stop Live Watch';
  btnWatchLive.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)'; // Green
  liveStatus.style.display = 'block';
  
  // Disable other controls
  btnStart.style.display = 'none';
  totalGamesInput.disabled = true;
  
  log('📺 Starting Live Watch...', 'info');
  
  // Start loops concurrently
  pollModelUpdates();
  liveWatchLoop();
}

async function pollModelUpdates() {
  while (watchLiveMode) {
    try {
      const pRes = await fetch('/trained-model/policy-weights.json');
      const vRes = await fetch('/trained-model/value-weights.json');
      
      if (pRes.ok && vRes.ok) {
        const pJson = await pRes.json();
        const vJson = await vRes.json();
        
        // Helper to convert JSON weights to Tensors
        const toTensors = (weights: any[]) => weights.map(w => tf.tensor(w.data, w.shape));

        tf.tidy(() => {
           policyNet.getModel().setWeights(toTensors(pJson));
           valueNet.getModel().setWeights(toTensors(vJson));
        });
        
        const time = new Date().toLocaleTimeString();
        lastUpdateSpan.textContent = time;
        // log(`🔄 Model updated from CLI at ${time}`, 'info');
      }
    } catch (e) {
      console.warn('Failed to poll model:', e);
    }
    
    // Wait 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}

async function liveWatchLoop() {
  log('🎮 Starting visualization matches...', 'info');
  
  while (watchLiveMode) {
    // Play one game at normal speed (to visualize)
    // We use playGame() but maybe we want to visualize it slower?
    // Currently playGame() is headless/fast.
    // For now, we just run it and update stats.
    
    const result = playGame();
    
    // Update stats
    if (result.winner === 0) state.wins++;
    else if (result.winner === 1) state.losses++;
    else state.draws++;
    state.gamesPlayed++;
    
    updateUI();
    
    // Wait a bit to not burn CPU
    await new Promise(resolve => setTimeout(resolve, 100)); // 10 games/sec max
    await tf.nextFrame();
  }
  
  // Cleanup
  btnStart.style.display = 'inline-block';
  totalGamesInput.disabled = false;
}

btnWatchLive?.addEventListener('click', toggleWatchLive);


// Add reset brain button handler
const resetButton = document.createElement('button');
resetButton.textContent = '🧹 Reset Brain';
resetButton.className = 'btn-primary';
resetButton.style.background = '#ef4444';
resetButton.style.marginLeft = '10px';
resetButton.addEventListener('click', () => {
  if (confirm('Reset bot brain? This will delete all trained weights!')) {
    localStorage.removeItem('mlbot-policy');
    localStorage.removeItem('mlbot-value');
    localStorage.removeItem('mlbot-games');
    log('🧹 Bot brain reset! Start fresh training.', 'warn');
    location.reload();
  }
});
document.querySelector('.training-controls')?.appendChild(resetButton);

// Initialize system on load
(async () => {
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    log(`🚀 System Initialized (WebGL enabled)`, 'info');
  } catch (e) {
    console.warn('WebGL init failed, falling back to CPU', e);
  }
  
  // Init networks
  const saved = await loadModel();
  policyNet = saved.policy || new PolicyNetwork(FEATURE_DIM);
  valueNet = saved.value || new ValueNetwork(FEATURE_DIM);
  
  pipeline = new SelfPlayPipeline(policyNet, valueNet, {
    trainingInterval: 200,
    bufferSize: 250
  });
  
  // Create bots
  mlBot0 = new MLBot(0, policyNet, valueNet, 1.0);
  mlBot1 = new MLBot(1, policyNet, valueNet, 1.0);
  
  const modeSelect = document.getElementById('training-mode') as HTMLSelectElement;
  const isBenchmark = modeSelect ? modeSelect.value === 'benchmark' : false;
  simpleBot = new SimpleBot(1, isBenchmark);
  simpleBot0 = new SimpleBot(0, isBenchmark);
  
  // Log status
  if (saved.policy) {
    log('Loaded saved model from browser storage', 'info');
  } else {
    log('Initialized new neural networks', 'info');
  }
  
  log('System ready. Configure settings and click "Start Training".', 'info');
})();
