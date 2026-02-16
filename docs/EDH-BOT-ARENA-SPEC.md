# DeckLens EDH Bot Arena - Complete Architecture Specification

> **Project:** Play vs Bot Feature for MTG Commander Deckbuilder  
> **Version:** 1.0  
> **Last Updated:** 2026-02-13  
> **Status:** Ready for Implementation

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Current Codebase Context](#current-codebase-context)
3. [Architecture Design](#architecture-design)
4. [Game Engine Specification](#game-engine-specification)
5. [Bot Intelligence System](#bot-intelligence-system)
6. [Reward System (ML Training)](#reward-system-ml-training)
7. [Card Data Pipeline](#card-data-pipeline)
8. [UI Design](#ui-design)
9. [Implementation Timeline](#implementation-timeline)
10. [Technical Stack](#technical-stack)
11. [Testing Strategy](#testing-strategy)
12. [Performance Targets](#performance-targets)

---

## Project Overview

### Vision
Build a full-featured "Play vs Bot" mode where players can test their Commander/EDH decks against an AI opponent that plays optimally using machine learning.

### Core Requirements
- ✅ **Format:** 100-card EDH (Commander)
- ✅ **Separate Page:** New Vite entry point (not in deck editor)
- ✅ **Bot Strategy:** Plays optimally with perfect information (sees opponent's hand)
- ✅ **Card Database:** All 30k+ MTG cards from Scryfall
- ✅ **Mana System:** Full complexity (WUBRG + Phyrexian + Hybrid + X + Snow)
- ✅ **Stack & Priority:** Full instant-speed interaction
- ✅ **UI Style:** Vanilla TypeScript, consistent with existing codebase (functional & fast)
- ✅ **Auto-Parser:** Regex-based Oracle text → card tags
- ✅ **Hardware:** RTX 4060 (8GB VRAM) for ML training
- ✅ **Deck Generation:** Random deck builder for bot

### Non-Goals (Phase 1)
- ❌ Multiplayer (3-4 players) — future phase
- ❌ Online multiplayer — future phase
- ❌ Mobile support — desktop-first
- ❌ Full rules engine (handle edge cases manually)
- ❌ Animation/VFX — functional UI only

---

## Current Codebase Context

### Project Structure
```
C:\Users\chris\Documents\Desk\Am arbeiten\Neuer Ordner\
├── apps/
│   ├── api/                    # NestJS API (mock DB currently)
│   └── web/                    # Next.js (deprecated, user said "abolished")
├── packages/
│   └── db/                     # Drizzle ORM schemas
├── src/                        # MAIN FRONTEND (Vanilla TS + Vite)
│   ├── deckbuilder/           # Existing goldfish code
│   ├── mtg/engine/            # Archetype detection, Scryfall client
│   └── [other features]/
├── worker/                     # Cloudflare Workers backend
└── dist/                      # Vite build output
```

### Tech Stack (Existing)
- **Frontend:** Vanilla TypeScript + Vite (multi-page app)
- **Backend:** Cloudflare Workers (D1, KV, Durable Objects)
- **Database:** PostgreSQL (not connected), using in-memory mock
- **Package Manager:** pnpm workspaces
- **Build:** Vite, target ES2022
- **Testing:** Vitest (frontend), Jest (API)

### Existing Game Code to Reuse

| File | Lines | Purpose |
|------|-------|---------|
| `src/deckbuilder/goldfish.ts` | ~2100 | Interactive goldfish playtester with drag-drop zones, turns, phases, commander zone, tokens, permanents |
| `src/deckbuilder/simulation-runner.ts` | ~300 | Headless goldfish sim — DOM-free, runs N iterations, aggregates stats |
| `src/deckbuilder/goldfish-coach.ts` | ~500+ | AI coach with card role classification, combo detection, gameplan summary, hints |
| `src/deckbuilder/goldfish-coach-ui.ts` | - | Coach UI rendering |
| `src/deckbuilder/hand-tester.ts` | - | Opening hand tester with mulligan stats |
| `src/deckbuilder/lines-library.ts` | - | Named combo lines with ordered steps |
| `src/mtg/engine/archetype-detector.ts` | - | Deck archetype classification |
| `src/mtg/engine/archetype-catalog.ts` | - | Archetype definitions catalog |
| `src/deckbuilder/monte-carlo-heatmap.ts` | - | Monte Carlo mana probability |
| `src/deckbuilder/collab-goldfish.ts` | - | Collaborative goldfish broadcasting |
| `src/mtg/engine/scryfall-client.ts` | - | Scryfall API integration |

---

## Architecture Design

### New Package Structure

```
packages/
├── game-engine/              # Core 2-player EDH game state & rules
│   ├── src/
│   │   ├── types/
│   │   │   ├── game-state.ts
│   │   │   ├── player.ts
│   │   │   ├── card.ts
│   │   │   ├── permanent.ts
│   │   │   ├── action.ts
│   │   │   └── index.ts
│   │   ├── rules/
│   │   │   ├── priority.ts        # Priority system
│   │   │   ├── stack.ts           # Spell/ability stack
│   │   │   ├── combat.ts          # Combat rules
│   │   │   ├── state-based.ts     # State-based actions
│   │   │   ├── commander.ts       # Commander-specific rules
│   │   │   └── mana.ts            # Mana system
│   │   ├── engine/
│   │   │   ├── game.ts            # Main game loop
│   │   │   ├── actions.ts         # Action execution
│   │   │   └── validation.ts     # Legal action validation
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
│
├── bot-core/                 # Heuristic baseline bot
│   ├── src/
│   │   ├── bot.ts                 # Main bot interface
│   │   ├── decision-tree.ts       # Heuristic decision logic
│   │   ├── evaluators/
│   │   │   ├── board-evaluator.ts
│   │   │   ├── hand-evaluator.ts
│   │   │   ├── threat-evaluator.ts
│   │   │   └── combo-evaluator.ts
│   │   ├── policies/
│   │   │   ├── mulligan-policy.ts
│   │   │   ├── play-policy.ts
│   │   │   ├── combat-policy.ts
│   │   │   └── stack-policy.ts
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
│
├── bot-ml/                   # ML bot with PPO training
│   ├── src/
│   │   ├── bot-ml.ts              # ML bot interface
│   │   ├── networks/
│   │   │   ├── policy-network.ts  # Actor network
│   │   │   ├── value-network.ts   # Critic network
│   │   │   └── feature-extractor.ts
│   │   ├── training/
│   │   │   ├── ppo-trainer.ts     # PPO algorithm
│   │   │   ├── replay-buffer.ts   # Experience buffer
│   │   │   ├── self-play.ts       # Self-play orchestration
│   │   │   └── imitation.ts       # Imitation learning
│   │   ├── rewards/
│   │   │   ├── reward-calculator.ts
│   │   │   ├── reward-config.ts
│   │   │   ├── archetype-modifiers.ts
│   │   │   ├── temporal-scaling.ts
│   │   │   ├── combo-detector.ts
│   │   │   ├── pattern-detector.ts
│   │   │   ├── reward-stats.ts
│   │   │   └── types.ts
│   │   └── index.ts
│   ├── package.json
│   └── tsconfig.json
│
└── card-data/                # Scryfall data + auto-parser
    ├── src/
    │   ├── scryfall-loader.ts     # Bulk data download
    │   ├── oracle-parser.ts       # Regex-based tag parser
    │   ├── card-index.ts          # Fast card lookup
    │   ├── mana-parser.ts         # Mana cost parsing
    │   └── index.ts
    ├── data/
    │   ├── scryfall-bulk.json     # Downloaded card data (gitignored)
    │   └── card-tags.json         # Parsed tags (committed)
    ├── package.json
    └── tsconfig.json
```

### New Frontend Page

```
src/
├── play-vs-bot/              # New Vite entry page
│   ├── index.html            # Entry HTML
│   ├── main.ts               # Main app entry
│   ├── game-board.ts         # Board rendering
│   ├── game-ui.ts            # UI controls
│   ├── zone-renderer.ts      # Zone rendering (hand, battlefield, etc.)
│   ├── stack-renderer.ts     # Stack visualization
│   ├── combat-ui.ts          # Combat phase UI
│   ├── deck-selector.ts      # Deck selection screen
│   └── styles.css            # Styles
```

Update `vite.config.ts`:
```typescript
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        // ... existing entries ...
        playVsBot: resolve(__dirname, 'src/play-vs-bot/index.html')
      }
    }
  }
})
```

---

## Game Engine Specification

### Core Types

#### GameState
```typescript
interface GameState {
  // Players
  players: [PlayerState, PlayerState];  // Player 0 (human), Player 1 (bot)
  activePlayer: 0 | 1;
  priorityPlayer: 0 | 1;
  
  // Turn structure
  turn: number;
  phase: Phase;
  step: Step;
  
  // Stack
  stack: StackObject[];
  
  // Combat
  combat: CombatState | null;
  
  // Game status
  winner: 0 | 1 | null;
  gameOver: boolean;
  
  // History
  log: GameLogEntry[];
  actionHistory: GameAction[];
}

type Phase = 'beginning' | 'precombat-main' | 'combat' | 'postcombat-main' | 'ending';
type Step = 'untap' | 'upkeep' | 'draw' | 'main' | 
            'begin-combat' | 'declare-attackers' | 'declare-blockers' | 
            'combat-damage' | 'end-combat' | 
            'end' | 'cleanup';

interface PlayerState {
  id: 0 | 1;
  name: string;
  
  // Zones
  library: Card[];
  hand: Card[];
  battlefield: Permanent[];
  graveyard: Card[];
  exile: Card[];
  commandZone: Card[];
  
  // Resources
  life: number;
  manaPool: ManaPool;
  poisonCounters: number;
  commanderDamage: Record<string, number>;  // Damage from each opposing commander
  
  // Commander
  commanderTax: number;
  
  // Turn state
  landPlayedThisTurn: boolean;
  landsPlayedThisTurn: number;
  maxLandPlays: number;
  
  // Metadata
  hasDrawnThisGame: boolean;  // For first draw rule
}
```

#### Card & Permanent
```typescript
interface Card {
  id: string;                    // Unique instance ID
  oracleId: string;              // Scryfall oracle ID
  name: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors: Color[];
  colorIdentity: Color[];
  
  // Parsed metadata
  tags: CardTag[];               // From oracle-parser
  
  // Images
  imageUrl: string;
  
  // Owner
  owner: 0 | 1;
}

interface Permanent extends Card {
  controller: 0 | 1;
  tapped: boolean;
  flipped: boolean;
  faceDown: boolean;
  
  // Creature stats
  currentPower?: number;
  currentToughness?: number;
  damage: number;
  
  // Planeswalker
  currentLoyalty?: number;
  
  // Counters
  counters: Record<string, number>;  // +1/+1, -1/-1, charge, etc.
  
  // Status
  summonningSick: boolean;
  attacking: boolean;
  blocking: string | null;       // ID of permanent being blocked
  
  // Abilities
  abilities: Ability[];
  
  // Position (for UI)
  x: number;
  y: number;
}

type Color = 'W' | 'U' | 'B' | 'R' | 'G';
type CardTag = 'ramp' | 'draw' | 'removal' | 'counter' | 'tutor' | 'wipe' | 
               'engine' | 'payoff' | 'combo-piece' | 'protection' | 
               'recursion' | 'reanimation' | 'token-generator' | 'sacrifice-outlet' |
               'mana-dork' | 'fast-mana' | 'land-fetch' | 'card-selection' |
               'win-condition' | 'finisher';
```

#### Mana System
```typescript
interface ManaPool {
  W: number;  // White
  U: number;  // Blue
  B: number;  // Black
  R: number;  // Red
  G: number;  // Green
  C: number;  // Colorless
  S: number;  // Snow (tracked separately)
  
  // Special
  generic: number;  // Any color
}

interface ManaCost {
  W: number;
  U: number;
  B: number;
  R: number;
  G: number;
  C: number;      // Colorless specifically
  generic: number; // Any color/colorless
  X: number;      // Variable
  snow: number;   // Snow mana
  phyrexian: { color: Color; count: number }[];  // Can pay 2 life instead
  hybrid: { colors: [Color, Color]; count: number }[];
}

function parseManaCost(costString: string): ManaCost;
function canPayCost(pool: ManaPool, cost: ManaCost, lifeTotal: number): boolean;
function payCost(pool: ManaPool, cost: ManaCost, chosenPayment: ManaPayment): ManaPool;
```

#### Stack & Priority
```typescript
interface StackObject {
  id: string;
  type: 'spell' | 'ability';
  card?: Card;                   // If spell
  source?: Permanent;            // If ability
  controller: 0 | 1;
  targets: Target[];
  text: string;
  resolve: () => void;
}

interface Target {
  type: 'permanent' | 'player' | 'card-in-zone';
  id: string;
  zone?: Zone;
}

type Zone = 'library' | 'hand' | 'battlefield' | 'graveyard' | 'exile' | 'commandZone' | 'stack';

// Priority system
function passPriority(state: GameState): GameState;
function resolveTopOfStack(state: GameState): GameState;
function advancePhase(state: GameState): GameState;
```

#### Combat
```typescript
interface CombatState {
  attackers: AttackingCreature[];
  blockers: BlockingCreature[];
  currentStep: 'begin' | 'declare-attackers' | 'declare-blockers' | 'first-strike-damage' | 'damage' | 'end';
}

interface AttackingCreature {
  permanentId: string;
  defenderId: 0 | 1;  // Always the opponent in 1v1
}

interface BlockingCreature {
  permanentId: string;
  blockingId: string;  // Attacking creature being blocked
  damageAssignment?: number;  // For multi-blockers
}

function declareAttackers(state: GameState, attackers: string[]): GameState;
function declareBlockers(state: GameState, blocks: { blocker: string; attacker: string }[]): GameState;
function resolveCombatDamage(state: GameState): GameState;
```

#### Actions
```typescript
type GameAction = 
  | { type: 'pass'; player: 0 | 1 }
  | { type: 'play-land'; player: 0 | 1; cardId: string }
  | { type: 'cast-spell'; player: 0 | 1; cardId: string; targets: Target[]; manaPayment: ManaPayment }
  | { type: 'activate-ability'; player: 0 | 1; sourceId: string; abilityIndex: number; targets: Target[] }
  | { type: 'declare-attackers'; player: 0 | 1; attackers: string[] }
  | { type: 'declare-blockers'; player: 0 | 1; blocks: { blocker: string; attacker: string }[] }
  | { type: 'mulligan'; player: 0 | 1; toBottom: string[] }
  | { type: 'concede'; player: 0 | 1 };

interface ManaPayment {
  from: ManaPool;
  phyrexianLife: number;  // Life paid for phyrexian mana
  hybridChoices: Color[]; // Chosen colors for hybrid mana
}
```

### Priority System

```typescript
class PriorityManager {
  // Who has priority?
  getCurrentPriorityPlayer(state: GameState): 0 | 1;
  
  // Legal actions for priority player
  getLegalActions(state: GameState): GameAction[];
  
  // Execute action and pass priority
  executeAction(state: GameState, action: GameAction): GameState;
  
  // Pass priority
  pass(state: GameState): GameState;
  
  // Resolve stack
  private resolveStack(state: GameState): GameState;
  
  // Advance turn structure
  private advancePhase(state: GameState): GameState;
  private advanceStep(state: GameState): GameState;
}
```

**Priority Rules:**
1. Active player gets priority first in each phase/step
2. After stack resolves, active player gets priority again
3. If both players pass on empty stack → advance phase/step
4. If both players pass with stack → resolve top of stack
5. Player who just acted keeps priority (can respond to own spells)

### State-Based Actions

Run after every action, before priority:
```typescript
function checkStateBasedActions(state: GameState): GameState {
  let changed = true;
  while (changed) {
    changed = false;
    
    // Check each rule
    changed ||= checkCreatureDeath(state);
    changed ||= checkPlaneswalkerLoyalty(state);
    changed ||= checkZeroToughness(state);
    changed ||= checkLegendRule(state);
    changed ||= checkPlayerLoss(state);
    // ... more SBAs
  }
  return state;
}
```

**Key SBAs:**
- Creatures with damage ≥ toughness → graveyard
- Creatures with 0 toughness → graveyard
- Planeswalkers with 0 loyalty → graveyard
- Player with ≤0 life loses
- Player with ≥10 poison counters loses
- Player with ≥21 commander damage from one commander loses
- Player drawing from empty library loses
- Legend rule (multiple same legendary)

### Commander Rules

```typescript
interface CommanderRules {
  // Commander tax
  getCommanderCost(commander: Card, tax: number): ManaCost;
  
  // Commander damage
  trackCommanderDamage(state: GameState, commanderId: string, damage: number, defenderId: 0 | 1): GameState;
  
  // Replacement effect: commander to command zone instead of grave/exile
  handleCommanderZoneChange(state: GameState, commander: Card, destination: Zone): GameState;
  
  // Color identity validation (deck building - not runtime)
  validateColorIdentity(deck: Card[], commander: Card): boolean;
}
```

---

## Bot Intelligence System

### Two-Tier Bot Architecture

#### 1. Heuristic Bot (Baseline + Teacher)

**Purpose:** 
- Baseline opponent for human players
- Teacher for ML bot's imitation learning phase
- Fallback if ML bot fails

**Components:**
```typescript
class HeuristicBot {
  // Main decision function
  chooseAction(state: GameState): GameAction;
  
  // Sub-policies
  private mulliganPolicy: MulliganPolicy;
  private playPolicy: PlayPolicy;
  private combatPolicy: CombatPolicy;
  private stackPolicy: StackPolicy;
  
  // Evaluators
  private boardEval: BoardEvaluator;
  private handEval: HandEvaluator;
  private threatEval: ThreatEvaluator;
  private comboEval: ComboEvaluator;
}
```

**Decision Tree:**
```typescript
function chooseAction(state: GameState): GameAction {
  const legalActions = getLegalActions(state);
  
  // 1. Check for winning moves
  const winningAction = findWinningAction(state, legalActions);
  if (winningAction) return winningAction;
  
  // 2. Check for must-answer threats
  const mustAnswer = findMustAnswerThreat(state);
  if (mustAnswer) return chooseBestAnswer(state, mustAnswer);
  
  // 3. Check for combo opportunity
  const comboAction = findComboAction(state, legalActions);
  if (comboAction && isSafeToCombo(state)) return comboAction;
  
  // 4. Develop board by phase
  if (state.phase === 'precombat-main') {
    return chooseDevelopmentAction(state, legalActions);
  }
  
  // 5. Combat decisions
  if (state.phase === 'combat') {
    return chooseCombatAction(state, legalActions);
  }
  
  // 6. Stack interactions
  if (state.stack.length > 0) {
    return chooseStackAction(state, legalActions);
  }
  
  // 7. Default: pass
  return { type: 'pass', player: state.priorityPlayer };
}
```

#### 2. ML Bot (Advanced)

**Architecture:**
```typescript
class MLBot {
  // Neural networks
  private policyNetwork: PolicyNetwork;
  private valueNetwork: ValueNetwork;
  
  // Feature extraction
  private featureExtractor: FeatureExtractor;
  
  // Main decision (inference)
  async chooseAction(state: GameState): Promise<GameAction> {
    const features = this.featureExtractor.extract(state);
    const actionProbs = await this.policyNetwork.predict(features);
    return this.sampleAction(actionProbs);
  }
  
  // Training
  async train(trainingData: Experience[]): Promise<void>;
}
```

**Neural Network Architecture:**

```typescript
// Policy Network (Actor)
class PolicyNetwork {
  // Input: 200-dim feature vector
  // Architecture: 200 → 256 → 256 → 128 → 20 actions
  // Output: Softmax probabilities over action types
  
  private model: tf.LayersModel;
  
  async predict(features: Float32Array): Promise<ActionProbabilities> {
    const input = tf.tensor2d([features], [1, 200]);
    const output = this.model.predict(input) as tf.Tensor;
    const probs = await output.data();
    return this.mapToActions(probs);
  }
}

// Value Network (Critic)
class ValueNetwork {
  // Input: 200-dim feature vector
  // Architecture: 200 → 128 → 128 → 64 → 1
  // Output: Sigmoid (win probability)
  
  private model: tf.LayersModel;
  
  async predict(features: Float32Array): Promise<number> {
    const input = tf.tensor2d([features], [1, 200]);
    const output = this.model.predict(input) as tf.Tensor;
    return (await output.data())[0];
  }
}
```

**Training: PPO Algorithm**

```typescript
class PPOTrainer {
  private policyNetwork: PolicyNetwork;
  private valueNetwork: ValueNetwork;
  private replayBuffer: ReplayBuffer;
  
  // Hyperparameters
  private learningRate = 0.0003;
  private gamma = 0.99;           // Discount factor
  private lambda = 0.95;          // GAE parameter
  private epsilon = 0.2;          // PPO clip range
  private epochs = 4;             // Training epochs per batch
  private batchSize = 64;
  
  async train(experiences: Experience[]): Promise<TrainingStats> {
    // 1. Compute advantages using GAE
    const advantages = this.computeGAE(experiences);
    
    // 2. Normalize advantages
    const normalizedAdvantages = this.normalize(advantages);
    
    // 3. Train for multiple epochs
    for (let epoch = 0; epoch < this.epochs; epoch++) {
      const batches = this.createBatches(experiences, this.batchSize);
      
      for (const batch of batches) {
        // Policy loss (PPO clip)
        const policyLoss = await this.computePolicyLoss(batch, normalizedAdvantages);
        
        // Value loss (MSE)
        const valueLoss = await this.computeValueLoss(batch);
        
        // Update networks
        await this.updatePolicy(policyLoss);
        await this.updateValue(valueLoss);
      }
    }
    
    return this.getTrainingStats();
  }
}
```

**Training Pipeline:**

```typescript
class TrainingPipeline {
  async runTraining(): Promise<void> {
    console.log('🚀 Starting ML Bot Training Pipeline');
    
    // Phase 1: Imitation Learning (5k games)
    console.log('📚 Phase 1: Imitation Learning');
    await this.imitationLearning(5000);
    
    // Phase 2: Self-Play vs Heuristic (15k games)
    console.log('🤖 Phase 2: Self-Play vs Heuristic');
    await this.selfPlayVsHeuristic(15000);
    
    // Phase 3: Pure Self-Play (50k games)
    console.log('🎮 Phase 3: Pure Self-Play');
    await this.pureSelfPlay(50000);
    
    console.log('✅ Training Complete!');
  }
}
```

---

## Reward System (ML Training)

### Configuration
```typescript
interface RewardConfig {
  granularity: 'per-action';      // Immediate feedback after each action
  penaltyScale: 0.65;             // Penalties are 65% of equivalent positives
  comboDetection: 'hybrid';       // lines-library.ts + dynamic patterns
  opponentModeling: false;        // Focus on own decisions only
  
  // Scaling
  archetypeModifiers: ArchetypeModifiers;
  temporalScaling: TemporalScaling;
  
  // Normalization
  maxStepReward: 30;
  minStepReward: -20;
  scaleFactor: 0.1;               // Divide by 10 for neural network
}
```

### Reward Categories

#### 1. Game Outcome (Terminal Rewards)
```typescript
const OUTCOME_REWARDS = {
  // Wins
  baseWin: 100,
  fastWinBonus: 50,              // Turn ≤ 7
  comebackWinBonus: 30,          // Won from <10 life
  commanderDamageWin: 20,        // Additional
  infiniteComboWin: 15,          // Additional
  
  // Losses
  baseLoss: -100,
  earlyScoopPenalty: -30         // Conceded before turn 5
};
```

#### 2. Resource Management (Per Turn)
```typescript
const RESOURCE_REWARDS = {
  // Mana efficiency
  perfectManaUsage: 5,           // Used all mana
  goodManaUsage: 3,              // 90%+ mana used
  wasted3Mana: -2,
  wasted5Mana: -5,
  
  // Card advantage
  drewExtraCard: 3,              // Per card beyond mandatory
  tutored: 4,
  discarded: -2,                 // Not to cost
  milledImportantCard: -3,       // Combo piece/win con
  
  // Hand management
  goodHandSize: 1,               // 5-7 cards at end step
  hellbent: -4,                  // 0 cards (unless archetype)
  overdraw: -2                   // 8+ cards
};
```

#### 3. Board Development (Per Turn)
```typescript
const BOARD_REWARDS = {
  // Ramp
  playedRamp: 4,
  fixedMana: 2,                  // Dual land, fetch
  missedLandDrop: -3,            // Turns 1-4 only
  
  // Board presence
  playedCreature: 2,
  playedEngine: 5,               // Rhystic Study, etc.
  playedPayoff: 4,               // Win condition
  boardWiped: -10,               // Lost 3+ permanents
  rebuiltAfterWipe: 8,           // 2+ permanents same/next turn
  
  // Synergy
  triggeredSynergy: 3,           // Landfall, etc.
  activatedAbility: 2
};
```

#### 4. Interaction & Answers (Per Action)
```typescript
const INTERACTION_REWARDS = {
  // Removal
  removedKeyThreat: 8,           // Opponent's engine/combo
  removedCreature: 4,
  removedArtifactEnchantment: 4,
  profitableBoardWipe: 12,       // Cleared 5+ opp, lost <3 own
  unprofitableBoardWipe: -6,
  
  // Counterspells
  counteredWinCon: 10,
  counteredKeySpell: 6,          // Engine, tutor, ramp
  counteredMediumSpell: 4,
  counteredWeakSpell: -2,        // <3 CMC non-threat
  
  // Protection
  protectedKeyPermanent: 5,
  protectedFromWipe: 8
};
```

#### 5. Combat & Damage (Per Combat)
```typescript
const COMBAT_REWARDS = {
  // Attacking
  dealtCombatDamage: 0.5,        // Per damage (capped at +10)
  reducedOppTo10Life: 8,
  lethalAttack: 15,
  badAttack: -4,                 // Lost creature for no damage
  
  // Blocking
  favorableBlock: 3,             // Killed attacker, saved creature
  tradedInBlock: 1,              // Both died, valuable trade
  badBlock: -3,
  
  // Life total
  gainedLife5Plus: 2,
  lostLife5Plus: -1,
  droppedBelow20: -2,
  droppedBelow10: -5,
  droppedTo5OrLess: -8
};
```

#### 6. Combo & Win Conditions (Per Turn)
```typescript
const COMBO_REWARDS = {
  // Combo progress
  assembled1of3: 4,
  assembled2of3: 10,
  assembledFullCombo: 25,
  lostComboPiece: -8,
  protectedComboPiece: 6,
  
  // Win conditions
  commanderOutOnCurve: 6,        // Turn 3-5
  commanderEquipped: 5,
  altWinConOnBoard: 12,          // Thassa's Oracle, etc.
  infiniteManaReady: 20,
  infiniteDrawReady: 20
};
```

#### 7. Strategic Positioning (Per Turn)
```typescript
const STRATEGIC_REWARDS = {
  // Threat assessment
  notBiggestThreat: 2,           // Low profile while developing
  answeredBiggestThreat: 6,
  becameArchenemy: -4,
  
  // Card quality
  drewBomb: 5,                   // Top 10 cards in deck
  playedBombOnCurve: 8,
  topdeckedAnswer: 6,
  deadCardInHand: -1,            // Per uncastable card
  
  // Tempo
  curvedOutT1to4: 6,             // On-curve every turn
  tempoPlay: 5,                  // Bounce/counter efficiently
  tempoLoss: -5                  // Opponent resolved game-changer
};
```

#### 8. Commander-Specific (Per Action)
```typescript
const COMMANDER_REWARDS = {
  // Casting
  castCommanderFirst: 6,
  castCommanderSecond: 3,        // With tax
  castCommanderThirdPlus: 1,     // Diminishing returns
  commanderTaxOver6: -3,         // Too expensive
  
  // Value
  commanderDealtDamage: 1,       // Per damage
  commanderDealt10Plus: 8,       // Close to commander damage win
  commanderKilled: -4,
  commanderDied3Plus: -8,        // Protect better
  protectedCommander: 4,
  commanderStuckT6Plus: -2       // Per turn stuck after T6
};
```

#### 9. Graveyard & Exile (Per Action)
```typescript
const GRAVEYARD_REWARDS = {
  // Graveyard synergy
  filledGraveyardForStrategy: 3, // If recursion/reanimator deck
  reanimatedCreature: 6,
  recursionSpell: 4,
  graveyardExiled: -6,           // RIP, Bojuka Bog
  
  // Exile zone
  exiledOppKeyCard: 5,
  ownCardExiled: -2,
  castFromExile: 3               // Adventure, impulse
};
```

#### 10. Mulligan (Game Start)
```typescript
const MULLIGAN_REWARDS = {
  keptGoodHand: 5,               // 3-4 lands
  keptRiskyHand: -3,             // 1-2 lands (if didn't work)
  mulliganTo6: -2,
  mulliganTo5OrLess: -5
};
```

#### 11. Mistakes & Misplays
```typescript
const MISPLAY_PENALTIES = {
  playedIntoOpenMana: -5,        // Walked into counterspell
  overextendedIntoWipe: -8,
  wrongTutorTarget: -4,
  missedLethal: -15,
  unnecessaryRisk: -3
};
```

### Temporal Scaling

Adjust rewards based on game stage:
```typescript
interface TemporalScaling {
  // Early game (turns 1-4)
  earlyGame: {
    ramp: 1.5,                   // +50% bonus
    missedLandDrop: 2.0,         // Double penalty
    interaction: 0.7             // Less important
  },
  
  // Mid game (turns 5-8)
  midGame: {
    engines: 1.3,                // +30% bonus
    cardDraw: 1.3,
    ramp: 1.0                    // Normal
  },
  
  // Late game (turns 9+)
  lateGame: {
    comboRewards: 2.0,           // Double combo rewards
    interactionRewards: 2.0,     // Double interaction
    winConditions: 3.0,          // Triple win con rewards
    ramp: 0.5                    // Half ramp rewards
  }
}
```

### Archetype-Specific Modifiers

```typescript
const ARCHETYPE_MODIFIERS: Record<string, ArchetypeModifier> = {
  'Aggro/Voltron': {
    combatDamage: 1.5,
    ramp: 0.7,
    lateGame: 0.8
  },
  
  'Control': {
    interaction: 1.5,
    cardDraw: 1.3,
    earlyCreatures: 0.6
  },
  
  'Combo': {
    comboProgress: 2.0,
    tutors: 1.5,
    protection: 1.4
  },
  
  'Midrange': {
    // All 1.0 (balanced)
  },
  
  'Ramp/Big-Mana': {
    ramp: 1.6,
    bigSpells: 1.4,              // 7+ CMC
    earlyInteraction: 0.7
  },
  
  'Reanimator': {
    graveyardFill: 1.8,
    reanimation: 2.0,
    creatureCasts: 0.5           // Prefer cheating
  }
};
```

### Expected Reward Ranges

| Outcome | Reward Range | Notes |
|---------|-------------|-------|
| **Dominant Win (T5-7)** | +150 to +200 | Win + fast win + perfect gameplay |
| **Standard Win (T8-12)** | +100 to +150 | Win + good gameplay |
| **Close Win** | +80 to +120 | Win but made mistakes |
| **Close Loss** | -50 to -80 | Loss but played well |
| **Bad Loss** | -100 to -130 | Loss + many mistakes |
| **Early Scoop** | -130 to -150 | Loss + scoop penalty |

---

## Card Data Pipeline

### Scryfall Bulk Data

```typescript
// packages/card-data/src/scryfall-loader.ts

class ScryfallLoader {
  private bulkDataUrl = 'https://api.scryfall.com/bulk-data';
  
  async downloadBulkData(): Promise<void> {
    console.log('📥 Downloading Scryfall bulk data...');
    
    // 1. Get bulk data list
    const bulkData = await fetch(this.bulkDataUrl).then(r => r.json());
    const oracleCards = bulkData.data.find(d => d.type === 'oracle_cards');
    
    // 2. Download full card database (~80MB JSON)
    const cards = await fetch(oracleCards.download_uri).then(r => r.json());
    
    // 3. Save locally
    await fs.writeFile(
      path.join(__dirname, '../data/scryfall-bulk.json'),
      JSON.stringify(cards, null, 2)
    );
    
    console.log(`✅ Downloaded ${cards.length} cards`);
  }
}
```

### Oracle Text Auto-Parser

Regex-based parser to automatically tag all cards:

```typescript
// packages/card-data/src/oracle-parser.ts

interface ParsingRule {
  tag: CardTag;
  patterns: RegExp[];
  exclusions?: RegExp[];  // Don't tag if these match
}

const PARSING_RULES: ParsingRule[] = [
  // Ramp
  {
    tag: 'ramp',
    patterns: [
      /add \{[WUBRGC]\}/i,           // "add {G}"
      /search your library for.*land/i,
      /you may put.*land.*onto the battlefield/i
    ],
    exclusions: [
      /^[^—]*Land —/i                // Exclude lands themselves
    ]
  },
  
  // Card Draw
  {
    tag: 'draw',
    patterns: [
      /draw (a|one|\d+) card/i,
      /draws? (a|one|\d+) card/i
    ]
  },
  
  // Removal
  {
    tag: 'removal',
    patterns: [
      /destroy target/i,
      /exile target/i,
      /return target.*to.*hand/i,
      /-X\/-X/i
    ],
    exclusions: [
      /destroy target land/i         // Land destruction is different
    ]
  },
  
  // Counterspells
  {
    tag: 'counter',
    patterns: [
      /counter target spell/i,
      /counter target.*unless/i
    ]
  },
  
  // Tutors
  {
    tag: 'tutor',
    patterns: [
      /search your library for/i
    ],
    exclusions: [
      /search your library for.*basic land/i  // Basic land fetch not tutor
    ]
  },
  
  // Board Wipes
  {
    tag: 'wipe',
    patterns: [
      /destroy all creatures/i,
      /exile all creatures/i,
      /-X\/-X to all creatures/i,
      /each creature gets -/i
    ]
  }
  // ... more rules
];

class OracleParser {
  parseCard(card: Card): CardTag[] {
    const tags = new Set<CardTag>();
    const oracleText = card.oracleText.toLowerCase();
    const typeLine = card.typeLine.toLowerCase();
    
    for (const rule of PARSING_RULES) {
      // Check exclusions first
      if (rule.exclusions?.some(ex => ex.test(typeLine) || ex.test(oracleText))) {
        continue;
      }
      
      // Check patterns
      if (rule.patterns.some(p => p.test(oracleText) || p.test(typeLine))) {
        tags.add(rule.tag);
      }
    }
    
    return Array.from(tags);
  }
}
```

---

## UI Design

### Page Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  DeckLens - Play vs Bot                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐                                       │
│  │  Opponent (Bot)      │                                       │
│  │  Life: 40  ☠️ 0      │                                       │
│  │  Hand: 🂠 🂠 🂠 🂠     │  (visible cards - perfect info)     │
│  │  Commander: Atraxa   │                                       │
│  └──────────────────────┘                                       │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Battlefield                                              │  │
│  │  ╔════╗ ╔════╗ ╔════╗                                    │  │
│  │  ║ 🌲 ║ ║ 🗻 ║ ║ 👤 ║  (Bot's permanents)               │  │
│  │  ╚════╝ ╚════╝ ╚════╝                                    │  │
│  │  ─────────────────────────                               │  │
│  │  ╔════╗ ╔════╗ ╔════╗ ╔════╗                            │  │
│  │  ║ 🌊 ║ ║ 🏔️ ║ ║ ⚔️  ║ ║ 🛡️ ║  (Your permanents)       │  │
│  │  ╚════╝ ╚════╝ ╚════╝ ╚════╝                            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                  │
│  [Pass Priority]  [Play Land]  [Cast Spell]  [End Turn]       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Timeline

### 10-Week Plan

| Week | Focus | Deliverables |
|------|-------|--------------|
| **W1** | Game Engine Types | `packages/game-engine/` with GameState, Player, Card, Permanent types |
| **W2** | Priority & Stack | Priority system, Stack resolution, Phase/step advancement |
| **W3** | Combat & SBAs | Combat system, State-based actions, Commander rules |
| **W4** | Card Data | Scryfall bulk download, Oracle text parser, Card index |
| **W5** | Heuristic Bot | Baseline bot with decision tree, evaluators, policies |
| **W6** | ML Infrastructure | Feature extractor, Networks, PPO trainer |
| **W7** | ML Training | Run training pipeline on RTX 4060 |
| **W8** | UI Game Board | Board rendering, Zone rendering, Deck selector |
| **W9** | UI Combat & Stack | Combat UI, Stack visualization, Priority indicators |
| **W10** | Integration & Testing | Connect everything, E2E testing, Bug fixes |

---

## Performance Targets

| Metric | Target | Notes |
|--------|--------|-------|
| **Game State Update** | <16ms | 60 FPS for smooth UI |
| **Bot Decision Time** | <500ms | Fast enough to feel responsive |
| **ML Bot Inference** | <200ms | GPU-accelerated |
| **Card Lookup** | <1ms | Indexed for O(1) lookup |
| **Full Game (headless)** | <30 sec | For training simulations |
| **Training Throughput** | ~50 games/min | With GPU parallelization |

---

## Next Steps

### Immediate Actions
1. ✅ **Finalize this spec** (you're reading it!)
2. 🔨 **Create package structure**
3. 🔨 **Week 1: Start game engine**

---

**Document Generated:** 2026-02-13  
**Last Updated:** Ready for Implementation
