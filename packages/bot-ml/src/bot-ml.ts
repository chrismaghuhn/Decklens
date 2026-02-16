/**
 * MLBot — Neural network-based bot using policy + value networks.
 *
 * Uses PolicyNetwork to select actions and ValueNetwork to evaluate positions.
 * Can be trained via imitation learning and PPO self-play.
 *
 * Falls back to legal action filtering + probability sampling for action selection.
 */

import type { GameState, GameAction, Card, PlayerState, Target, Permanent } from '@mtg/game-engine';
import { getLegalActionTypes, autoTapLandsForCost, parseManaCost } from '@mtg/game-engine';
import { PolicyNetwork, ACTION_TYPES, ACTION_COUNT, type ActionProbabilities } from './networks/policy-network.ts';

import { ValueNetwork } from './networks/value-network.ts';
import { extractFeaturesUnified, extractCardFeatures, FEATURE_DIM, FEATURE_DIM_V2, FEATURE_DIM_V3, FEATURE_DIM_V4 } from './networks/feature-extractor.ts';
import { actionToIndex } from './training/imitation.ts';
import { HierarchicalPolicy } from './networks/hierarchical-policy.ts';
import { ResNetPolicy } from './networks/resnet-policy.ts';
import { TargetingSolver } from './targeting/targeting-solver';
import { AbilityEvaluator } from './decisions/ability-evaluator';
import { MulliganPolicy } from './decisions/mulligan-policy';

/** Decision from the ML bot with reasoning */
export interface MLDecision {
  action: GameAction;
  confidence: number;
  actionProbs: ActionProbabilities;
  value: number;
  /** Pre-computed features (avoids duplicate extractFeatures in training) */
  features: Float32Array;
  /** Log probability of the chosen action */
  logProb: number;
  /** Action index for training */
  actionIndex: number;
  
  // v3 Metadata
  cardSelectionIndex?: number;
  cardCandidateFeatures?: Float32Array[];
  cardLogProb?: number;
}

export class MLBot {
  readonly player: 0 | 1;
  private policyNet: PolicyNetwork | ResNetPolicy | HierarchicalPolicy;
  private valueNet: ValueNetwork;
  private temperature: number;
  private featureDim: number;
  private decisionHistory: MLDecision[] = [];
  
  // Feature Cache for performance optimization
  private cachedFeatures: Float32Array | null = null;
  private cachedStateHash: string = '';
  private cacheHits: number = 0;
  private cacheMisses: number = 0;

  constructor(
    player: 0 | 1,
    policyNet?: PolicyNetwork | ResNetPolicy | HierarchicalPolicy,
    valueNet?: ValueNetwork,
    temperature: number = 1.0,
    featureDim?: number, // Auto-detect from policyNet if not provided
  ) {
    this.player = player;
    
    // Auto-detect featureDim from policyNet if not provided
    if (featureDim === undefined) {
      if (policyNet instanceof HierarchicalPolicy) {
        this.featureDim = FEATURE_DIM_V3;
      } else if (policyNet instanceof ResNetPolicy) {
        this.featureDim = FEATURE_DIM_V2;
      } else {
        this.featureDim = FEATURE_DIM; // Default v1
      }
    } else {
      this.featureDim = featureDim;
    }
    
    // Create default networks if not provided, matching featureDim
    this.policyNet = policyNet ?? new PolicyNetwork(this.featureDim);
    this.valueNet = valueNet ?? new ValueNetwork(this.featureDim);
    this.temperature = temperature;
  }
  
  /** Get the policy version (v1, v2, v3, or v4) */
  getPolicyVersion(): 'v1' | 'v2' | 'v3' | 'v4' {
    if (this.policyNet instanceof HierarchicalPolicy) {
      // Distinguish v3 (320 dims) from v4 (384 dims)
      return this.featureDim === FEATURE_DIM_V4 ? 'v4' : 'v3';
    }
    if (this.policyNet instanceof ResNetPolicy) return 'v2';
    return 'v1';
  }

  /**
   * Compute a fast hash of the game state for cache invalidation.
   * Only includes fields that actually affect feature extraction.
   */
  private computeStateHash(state: GameState): string {
    // Fast hash using critical state fields
    const p = state.players[this.player];
    const opp = state.players[1 - this.player];
    // Safety check for undefined arrays from Rust bridge
    const stackLen = state.stack?.length ?? 0;
    const handLen = p.hand?.length ?? 0;
    const bfLen = p.battlefield?.length ?? 0;
    const histLen = state.actionHistory?.length ?? 0;
    
    return `${state.turn}:${state.phase}:${state.step}:${state.priorityPlayer}:${stackLen}:${handLen}:${bfLen}:${p.life}:${opp.life}:${histLen}`;
  }

  /** 
   * Extract features using the unified extractor for maximum performance.
   * Uses caching to avoid recomputation when state hasn't changed.
   * 
   * OPTIMIZED: Uses extractFeaturesUnified() which computes all versions in single pass,
   * avoiding the 3-4x redundancy of nested v4→v3→v2→v1 calls.
   */
  private extractFeaturesByVersion(state: GameState): Float32Array {
    const stateHash = this.computeStateHash(state);
    
    // Check cache
    if (this.cachedFeatures && this.cachedStateHash === stateHash) {
      this.cacheHits++;
      return this.cachedFeatures;
    }
    
    // Cache miss - compute features using unified extractor
    this.cacheMisses++;
    // Unified extractor is 3-4x faster than nested v4→v3→v2→v1 calls
    const features = extractFeaturesUnified(state, this.player, this.featureDim as 200 | 256 | 320 | 384);
    
    // Store in cache
    this.cachedFeatures = features;
    this.cachedStateHash = stateHash;
    
    return features;
  }
  
  /** Get cache statistics for debugging */
  getCacheStats(): { hits: number; misses: number; hitRate: number } {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total > 0 ? this.cacheHits / total : 0
    };
  }

  /** Choose an action for the current game state */
  chooseAction(state: GameState): GameAction {
    const decision = this.chooseActionWithReason(state);
    return decision.action;
  }

  /** Choose an action with full reasoning and probabilities */
  chooseActionWithReason(state: GameState): MLDecision {
    const features = this.extractFeaturesByVersion(state);
    // Use predictFast() (Pure JS) if available for speed, otherwise standard predict()
    // predictFast is ~10x faster than TF.js graph execution
    let actionProbs: ActionProbabilities;
    const hasFastPolicy = (this.policyNet as any).predictFast;
    if (hasFastPolicy) {
      try {
        const fastResult = (this.policyNet as any).predictFast(features);
        if (fastResult && typeof fastResult === 'object' && 'cast-spell' in fastResult) {
          actionProbs = fastResult;
        } else {
          // Fallback to graph execution if fast result is invalid
          actionProbs = this.policyNet.predict(features);
        }
      } catch (e) {
        console.warn('[MLBot] predictFast failed, falling back to graph execution:', e);
        actionProbs = this.policyNet.predict(features);
      }
    } else {
      actionProbs = this.policyNet.predict(features);
    }
    
    // Fast CPU value inference
    let value: number;
    const hasFastValue = (this.valueNet as any).predictFast;
    if (hasFastValue) {
      try {
        const fastValue = (this.valueNet as any).predictFast(features);
        value = typeof fastValue === 'number' ? fastValue : this.valueNet.predict(features);
      } catch (e) {
        value = this.valueNet.predict(features);
      }
    } else {
      value = this.valueNet.predict(features);
    }

    // Get legal action types
    const legalTypes = getLegalActionTypes(state);

    // Filter to legal actions and renormalize
    const filtered = this.filterToLegal(actionProbs, legalTypes);

    // Apply temperature scaling
    const scaled = this.applyTemperature(filtered);

    // Sample from distribution
    const chosenType = this.sampleAction(scaled);

    // Build concrete action (passing decision context for v3)
    // We pass a mutable context object to capture v3 choices
    const v3Context: { selectionIndex?: number, candidateFeatures?: Float32Array[], logProb?: number } = {};
    const action = this.buildAction(chosenType as any, state, features, v3Context);

    // Compute logProb + actionIndex for training (avoids recomputation in recordStep)
    const aidx = actionToIndex(action);
    const prob = scaled[chosenType as keyof ActionProbabilities] ?? 1e-10;
    const logProb = Math.log(prob + 1e-10);

    const decision: MLDecision = {
      action,
      confidence: prob,
      actionProbs: scaled,
      value,
      features,
      logProb,
      actionIndex: aidx,
      // v3
      cardSelectionIndex: v3Context.selectionIndex,
      cardCandidateFeatures: v3Context.candidateFeatures,
      cardLogProb: v3Context.logProb
    };

    // Don't accumulate history during training — features cause massive memory leak
    // Store lightweight decision without features to save memory
    if (this.decisionHistory.length < 10) { // Reduced from 100
      const lightweightDecision = {
        action: decision.action,
        confidence: decision.confidence,
        value: decision.value,
        actionProbs: decision.actionProbs,
        logProb: decision.logProb,
        actionIndex: decision.actionIndex,
        // Omit features, cardCandidateFeatures to save memory
      };
      this.decisionHistory.push(lightweightDecision as MLDecision);
    }
    return decision;
  }

  /**
   * Fast action selection using data from Rust GameSession.
   * circumventing the slow JS State object.
   * Returns full decision metadata needed for PPO training.
   */
  public chooseActionFromRust(features: Float32Array, legalActions: GameAction[]): { 
      action: GameAction; 
      logProb: number; 
      value: number; 
      actionIndex: number;
  } {
      // 1. Policy Inference
      let actionProbs: ActionProbabilities;
      if ((this.policyNet as any).predictFast) {
          try {
              const fastProbs = (this.policyNet as any).predictFast(features);
              // Fallback wenn null zurückgegeben wird (CPU weights noch nicht geladen)
              actionProbs = fastProbs ?? this.policyNet.predict(features);
          } catch(e) {
              actionProbs = this.policyNet.predict(features);
          }
      } else {
          actionProbs = this.policyNet.predict(features);
      }

      // 2. Value Inference
      let value: number;
      if ((this.valueNet as any).predictFast) {
          try {
              const fastValue = (this.valueNet as any).predictFast(features);
              value = typeof fastValue === 'number' ? fastValue : this.valueNet.predict(features);
          } catch(e) {
              value = this.valueNet.predict(features);
          }
      } else {
          value = this.valueNet.predict(features);
      }

      // 3. Score Legal Actions
      // Find best legal action type
      const legalTypes = new Set(legalActions.map(a => a.type));
      let bestType = 'pass';
      let maxProb = -1;
      
      for (const [type, prob] of Object.entries(actionProbs)) {
          if (legalTypes.has(type as any) && (prob as number) > maxProb) {
              maxProb = prob as number;
              bestType = type;
          }
      }
      
      // Filter actions of best type
      const candidates = legalActions.filter(a => a.type === bestType);
      
      let selected: GameAction;
      if (candidates.length === 0) {
          // Fallback (shouldn't happen if legalActions is correct)
          selected = legalActions[0] || { type: 'pass', player: this.player };
      } else {
          // If multiple candidates (e.g. multiple lands to play, multiple spells to cast), pick one.
          // The goal is SPEED.
          selected = candidates[Math.floor(Math.random() * candidates.length)];
      }
      
      // 4. Compute logProb and actionIndex for training
      const prob = actionProbs[bestType as keyof ActionProbabilities] ?? 1e-10;
      const logProb = Math.log(prob + 1e-10);
      const actionIndex = actionToIndex(selected);
      
      return { action: selected, logProb, value, actionIndex };
  }

  /** Predict win probability for the current state */
  predictValue(state: GameState): number {
    const features = this.extractFeaturesByVersion(state);
    return this.valueNet.predict(features);
  }

  /** Get raw features for a state (for training) */
  getFeatures(state: GameState): Float32Array {
    return this.extractFeaturesByVersion(state);
  }

  /** Get policy logits for a state (for training) */
  getLogits(state: GameState): Float32Array {
    const features = this.extractFeaturesByVersion(state);
    return this.policyNet.getLogits(features);
  }

  /** Get the policy network */
  getPolicyNetwork(): any {
    return this.policyNet;
  }

  /** Get the value network */
  getValueNetwork(): any {
    return this.valueNet;
  }

  /** Get decision history */
  getDecisionHistory(): MLDecision[] {
    return [...this.decisionHistory];
  }

  /** Reset decision history */
  resetHistory(): void {
    this.decisionHistory = [];
  }

  /** Clear feature cache between games to prevent stale data */
  clearCache(): void {
    this.cachedFeatures = null;
    this.cachedStateHash = '';
    this.cacheHits = 0;
    this.cacheMisses = 0;
  }

  /** Set temperature for exploration vs exploitation */
  setTemperature(temp: number): void {
    this.temperature = Math.max(0.01, temp);
  }

  /** Serialize both networks for storage */
  async serialize(): Promise<{ policy: ArrayBuffer; value: ArrayBuffer }> {
    const policy = await this.policyNet.serialize();
    const value = await this.valueNet.serialize();
    return { policy, value };
  }

  /** Load weights from serialized data */
  static async deserialize(
    player: 0 | 1,
    data: { policy: ArrayBuffer; value: ArrayBuffer },
    temperature?: number,
  ): Promise<MLBot> {
    const policyNet = await PolicyNetwork.deserialize(data.policy);
    const valueNet = await ValueNetwork.deserialize(data.value);
    return new MLBot(player, policyNet, valueNet, temperature);
  }

  /** Filter action probs to only legal types, renormalize */
  private filterToLegal(
    probs: ActionProbabilities,
    legalTypes: string[],
  ): ActionProbabilities {
    const filtered = { ...probs };
    let sum = 0;

    for (const type of ACTION_TYPES) {
      const key = type as keyof ActionProbabilities;
      // Heuristic fix: Disable concession for training to force game completion
      if (type === 'concede') {
        filtered[key] = 0;
        continue;
      }
      
      if (legalTypes.includes(type)) {
        sum += filtered[key];
      } else {
        filtered[key] = 0;
      }
    }

    // Renormalize
    if (sum > 0) {
      for (const type of ACTION_TYPES) {
        const key = type as keyof ActionProbabilities;
        filtered[key] = filtered[key] / sum;
      }
    } else {
      // Fallback: uniform over legal actions
      // Safety check: prevent division by zero
      const uniformProb = legalTypes.length > 0 ? 1 / legalTypes.length : 1 / ACTION_COUNT;
      for (const type of ACTION_TYPES) {
        const key = type as keyof ActionProbabilities;
        filtered[key] = legalTypes.includes(type) ? uniformProb : 0;
      }
    }

    return filtered;
  }

  /** Apply temperature scaling to probabilities */
  private applyTemperature(probs: ActionProbabilities): ActionProbabilities {
    if (this.temperature === 1.0) return probs;

    const scaled = { ...probs };
    let sum = 0;

    for (const type of ACTION_TYPES) {
      const key = type as keyof ActionProbabilities;
      const s = Math.pow(probs[key], 1 / this.temperature);
      scaled[key] = s;
      sum += s;
    }

    for (const type of ACTION_TYPES) {
      const key = type as keyof ActionProbabilities;
      scaled[key] = sum > 0 ? scaled[key] / sum : 0;
    }

    return scaled;
  }

  /** Sample an action type from the probability distribution */
  private sampleAction(probs: ActionProbabilities): string {
    const rand = Math.random();
    let cumulative = 0;

    for (const type of ACTION_TYPES) {
      cumulative += probs[type as keyof ActionProbabilities];
      if (rand < cumulative) return type;
    }

    return 'pass'; // Fallback
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 4: Smart Action Building
  // ═══════════════════════════════════════════════════════════

  /** Build a concrete GameAction from the chosen type */
  private buildAction(
    actionType: string, 
    state: GameState, 
    features?: Float32Array,
    v3Context?: { selectionIndex?: number, candidateFeatures?: Float32Array[], logProb?: number }
  ): GameAction {
    const me = state.players[this.player];
    const opp = state.players[(1 - this.player) as 0 | 1];
    const policyVersion = this.getPolicyVersion();
    const isV3 = policyVersion === 'v3';
    const isV2OrV3 = policyVersion === 'v2' || policyVersion === 'v3';

    switch (actionType) {
      case 'play-land': {
        // Pick first land in hand
        const land = me.hand.find(c => c.typeLine.toLowerCase().includes('land'));
        if (land) return { type: 'play-land', player: this.player, cardId: land.id };
        return { type: 'pass', player: this.player };
      }

      case 'cast-spell': {
        // v3: Use Hierarchical Policy with Card Selection Head
        if (isV3 && features) {
            const candidates = this.getCastCandidates(state, me);
            if (candidates.length === 0) return { type: 'pass', player: this.player };
            
            // v3: Use Network to select card
            const hp = this.policyNet as unknown as HierarchicalPolicy;
            const embedding = hp.getEmbedding(features);
            
            // Validate embedding
            if (!embedding || embedding.length !== (256 + 32)) { // 256 Backbone + 32 Attention
              // Fallback to v2/v1 heuristic
              console.warn("[v3] Embedding validation failed, falling back to heuristic.");
              const bestSpell = this.selectBestSpell(state, me, opp);
              if (bestSpell) return bestSpell;
              return { type: 'pass', player: this.player };
            }
            
            const cardFeats = candidates.map(c => extractCardFeatures(c.card, state, this.player));
            if (cardFeats.length === 0) return { type: 'pass', player: this.player };
            
            // Pad to 8 or just pass list? Policy supports list.
            const selectedIdx = hp.selectCard(embedding, cardFeats);
            
            if (v3Context) {
                v3Context.selectionIndex = selectedIdx;
                v3Context.candidateFeatures = cardFeats;
            }

            if (selectedIdx >= 0 && selectedIdx < candidates.length) {
                const best = candidates[selectedIdx];
                // Additional safety check
                if (best && best.card && best.tapResult && best.tapResult.payment) {
                  const targets = this.resolveTargets(best.card, state, opp);
                  // If targets required but none found, can't cast
                  if (targets === null) {
                    // Try next best? Or just pass for now. 
                    // For v3 training, if we picked an illegal card, maybe we should just pass to let it learn?
                    // But to prevent 'illegal action' spam, we return pass.
                    return { type: 'pass', player: this.player }; 
                  }
                  
                  return {
                      type: 'cast-spell',
                      player: this.player,
                      cardId: best.card.id,
                      targets: targets,
                      manaPayment: best.tapResult.payment
                  };
                }
            }
            // Explicit fallback if selection fails
        }
        // v2/v1: Score all affordable spells and pick the best one (heuristic)
        // Works for both ResNetPolicy (v2) and PolicyNetwork (v1)
        const bestSpell = this.selectBestSpell(state, me, opp);
        if (bestSpell) return bestSpell;
        return { type: 'pass', player: this.player };
      }

      case 'declare-attackers': {
        // v1/v2/v3: Use heuristic for attackers (v3 Card Selection Head is for single card selection, not multi-creature)
        // v3 Todo: Per-creature selection could use network later, but for now use heuristic
        // Selective attacking — only attack when profitable (works for all versions)
        const attackers = this.selectAttackers(me, opp);
        return { type: 'declare-attackers', player: this.player, attackers };
      }

      case 'declare-blockers': {
         // v1/v2/v3: Smart blocking — assign blockers when profitable (works for all versions)
        const blocks = this.assignBlockers(state, me, opp);
        return { type: 'declare-blockers', player: this.player, blocks };
      }

      case 'mulligan': {

        // Initial hand is 7. If we mulligan once, we draw 7, retain 6.
        // But the mulligan offer happens when?
        // If state.stack is empty and it's start of game.
        // We assume the engine asks us.
        
        // IsOnPlay: state.activePlayer === this.player && state.turn === 1? 
        const isOnPlay = state.activePlayer === this.player; // Heuristic
        
        // Check if we should accept the current hand
        // The action 'mulligan' means "I want to take a mulligan".
        // The action 'pass' (or 'keep-hand'?) means "I keep".
        // Wait, action types usually have 'keep-hand' or 'mulligan'.
        // Check ACTION_TYPES in policy-network.ts or game-engine
        // If actionType 'mulligan' was CHOSEN by the policy, it means the policy WANTS to mulligan?
        // But the policy is just a neural net, it doesn't know mulligan rules well yet.
        // We should OVERRIDE the policy for mulligans in heuristics mode (v1/v2/v3).
        
        // Wait, chooseAction is called. If legal actions include 'mulligan' and 'keep-hand' (or 'pass'?), 
        // we should decide here.
        
        // Actually, London Mulligan mechanics:
        // You draw 7. You decide to Mulligan or Keep.
        // If you keep, you put X cards on bottom.
        // So we need to know if we are DECIDING to mulligan, or RESOLVING a mulligan (putting cards back).
        // See game-engine types.
        
        // Action: { type: 'mulligan', toBottom: ... }
        // If we want to KEEP, we send type: 'pass'? Or type: 'keep'?
        // The engine likely treats 'mulligan' action as "Perform Mulligan" if toBottom is empty?
        // Or maybe 'mulligan' action performs the bottoming?
        
        // Let's assume:
        // If we want to MULLIGAN (draw new hand): Send 'mulligan' with empty toBottom (if allowed) or just a signal?
        // If we want to KEEP: Send 'pass'?
        
        // CHECK types/action.ts:
        // | { type: 'mulligan'; player: 0|1; toBottom: string[] }
        
        // If I provide toBottom, does it mean I kept?
        // Usually: 
        // 1. Draw 7.
        // 2. Action: Mulligan (no args) -> Draw new hand.
        // 3. Action: Keep (args: toBottom) -> Start game.
        
        // BUT the definition has 'toBottom' in 'mulligan' action.
        // This implies the 'mulligan' action handles the London process?
        // Or maybe 'mulligan' means "Resolution of Mulligan Phase"?
        
        // Let's look at factory.ts or engine logic. 
        // Assuming standard London Mulligan:
        // If I want to TAKE A MULLIGAN (reject hand): 
        // I likely send a specific action.
        
        // The heuristic `MulliganPolicy.shouldMulligan` depends on knowing if we CAN mulligan.
        // If the engine offers 'mulligan', we can take it.
        
        // For now, let's implement the logic:
        // For now, let's implement the logic:
        const mulliganCount = state.mulliganCount ? state.mulliganCount[this.player] : 0;
        
        // Hard limit: Don't mulligan more than 3 times (down to 4 cards)
        if (mulliganCount >= 3) {
             return { type: 'pass', player: this.player };
        }

        const should = MulliganPolicy.shouldMulligan(me.hand, mulliganCount, isOnPlay);
        if (should) {
            // We want to draw a NEW hand.
            // How do we signal that?
            // If the 'mulligan' action requires toBottom, maybe we pass empty if we reject?
            // Or maybe there is a 'take-mulligan' action?
            // If 'mulligan' is the ONLY action available (besides pass?), then maybe pass = keep?
            
            // Re-reading game-engine types in Step 122:
            // | { type: 'mulligan'; player: 0 | 1; toBottom: string[]; }
            // | { type: 'pass'; ... }
            
            // If I assume 'pass' means KEEP.
            // And 'mulligan' means MULLIGAN (draw new hand).
            // Then `toBottom` is relevant when?
            // "Cards to put on bottom of library (London mulligan)"
            
            // Hypothesis: 
            // - To Keep: Pass. 
            // - To Mulligan: Mulligan action.
            //   - But why toBottom? Maybe if I mulliganed to 6, I draw 7, then I must put 1 on bottom to finalize?
            //   - So 'mulligan' action is actually "Resolve Mulligan" (Put cards on bottom and start).
            //   - NO. That would be 'keep'.
            
            // Let's assume 'mulligan' = I want a new hand.
            return { type: 'mulligan', player: this.player, toBottom: ['MULLIGAN'] };
        } else {
            // We want to KEEP.
            // If we have excess cards (because we mulliganed before), we must put some on bottom.
            // Hand size = 7. If we mulliganed once, we need to put 1 back.
            // Target hand size should be 7. 
            // London Mulligan: Draw 7. Put X back.
            // Current hand size is 7.
            // Mulligan count tells us X.
            
            // Get mulligan count

            
            if (mulliganCount > 0) {
                // Must put mulliganCount cards on bottom
                // Heuristic: Put mostly lands or high cost spells?
                // For now, random or simple: put highest CMC
                const sortedHand = [...me.hand].sort((a, b) => b.cmc - a.cmc);
                const toBottom = sortedHand.slice(0, mulliganCount).map(c => c.id);
                 return { type: 'mulligan', player: this.player, toBottom };
            }

            // Keep with no bottoming
            return { type: 'pass', player: this.player };
        }

      }

      case 'concede': {
        return { type: 'concede', player: this.player };
      }

      case 'activate-ability': {
        // Score all available abilities
        let bestScore = -Infinity;
        let bestAction: GameAction | null = null;
        
        for (const perm of me.battlefield) {
            if (!perm.abilities) continue;
            for (let i = 0; i < perm.abilities.length; i++) {
                // Check if ability is usable effectively
                // Note: IsLegalAction check is implicit? No, we should rely on getLegalActions if we were iterating actions.
                // But here we are constructing an action. We rely on the engine to reject illegal ones?
                // Better: The 'activate-ability' case in chooseAction is selecting WHICH ability.
                // But chooseAction is called to pick ONE action from all types?
                // No, the method is "buildAction" which implements the decision from the policy.
                // If policy chose 'activate-ability', we must find ONE to activate.
                
                const score = AbilityEvaluator.evaluateAbility(perm, i, state, this.player);
                if (score > bestScore) {
                    bestScore = score;
                    // Resolve targets for ability
                    // We need a dummy card object for TargetingSolver?
                    // Or overload TargetingSolver?
                    // Ability text is in perm.abilities[i].text
                    const ability = perm.abilities[i];
                    
                    // Construct a pseudo-card for targeting
                    const pseudoCard = { 
                        oracleText: ability.text, 
                        tags: [], 
                        typeLine: 'Ability' 
                    } as any as Card;
                    
                    const targets = TargetingSolver.solve(pseudoCard, state, this.player);
                    
                    if (targets) { // Only if valid targets (or none needed and returns [])
                        bestAction = {
                            type: 'activate-ability',
                            player: this.player,
                            sourceId: perm.id,
                            abilityIndex: i,
                            targets: targets
                        };
                    }
                }
            }
        }
        
        if (bestAction && bestScore > 1.0) { // Threshold to avoid useless activations
            return bestAction;
        }
        return { type: 'pass', player: this.player };
      }

      default:
        return { type: 'pass', player: this.player };
    }
  }

  /** Get all castable spells with valid payment options */
  private getCastCandidates(state: GameState, me: typeof state.players[0]) {
      const candidates = [];
      
      // Determine casting permissions
      const isMyTurn = state.activePlayer === this.player;
      const isMainPhase = state.phase === 'precombat-main' || state.phase === 'postcombat-main';
      const isStackEmpty = state.stack.length === 0;
      const canCastSorcerySpeed = isMyTurn && isMainPhase && isStackEmpty;

      for (const card of me.hand) {
          if (card.typeLine.toLowerCase().includes('land')) continue;
          if (!card.manaCost) continue;

          // Check timing restrictions
          const isInstant = card.typeLine.toLowerCase().includes('instant');
          const hasFlash = (card.oracleText || '').toLowerCase().includes('flash');
          
          if (!canCastSorcerySpeed && !isInstant && !hasFlash) {
              continue; // Illegal timing
          }

          const tapResult = autoTapLandsForCost(me, parseManaCost(card.manaCost));
          // Explicit check: tapResult must exist and have payment property
          if (tapResult && tapResult.payment) {
              candidates.push({ card, tapResult });
          }
      }
      return candidates;
  }

  // ─── Scored Spell Selection ───

  /**
   * Score all castable spells and pick the best one.
   * Considers game context: removal priority, ramp timing, creature efficiency.
   * IMPORTANT: Checks MTG timing rules to avoid illegal actions.
   */
  private selectBestSpell(
    state: GameState,
    me: typeof state.players[0],
    opp: typeof state.players[0],
  ): GameAction | null {
    interface ScoredSpell {
      card: typeof me.hand[0];
      tapResult: { payment: any };
      score: number;
    }

    const candidates: ScoredSpell[] = [];
    const oppHasThreats = opp.battlefield.some(p =>
      p.currentPower !== undefined && (p.currentPower ?? 0) >= 3
    );
    const oppCreatureCount = opp.battlefield.filter(p => p.currentPower !== undefined).length;

    // Determine casting permissions (MTG timing rules)
    const isMyTurn = state.activePlayer === this.player;
    const isMainPhase = state.phase === 'precombat-main' || state.phase === 'postcombat-main';
    const isStackEmpty = state.stack.length === 0;
    const canCastSorcerySpeed = isMyTurn && isMainPhase && isStackEmpty;

    // Combat Trick Logic: Should we hold mana?
    let manaReserve = 0;
    if (isMyTurn && state.phase === 'precombat-main' && state.combat && state.combat.currentStep === 'begin') { // Heuristic: Pre-combat
         // Check if we have combat tricks
         // 'pump' is not a standard tag? Use text for now.
         const tricks = me.hand.filter(c => {
             const txt = (c.oracleText || '').toLowerCase();
             const isBuff = txt.includes('gets +') || txt.includes('/+');
             const isRemoval = c.tags.includes('removal');
             return (isBuff || isRemoval) && c.typeLine.toLowerCase().includes('instant');
         });
         
         if (tricks.length > 0 && me.battlefield.some(p => p.currentPower !== undefined && !p.summoningSick)) {
             // We have tricks and creatures to attack with. Reserve mana for cheapest trick?
             // Or most expensive? Heuristic: Reserve 2 mana if possible.
             manaReserve = 2; // Arbitrary simple heuristic
         }
    }

    for (let i = 0; i < me.hand.length; i++) {
      const card = me.hand[i];
      const tl = card.typeLine.toLowerCase();
      if (tl.includes('land') || !card.manaCost) continue;

      // Check timing restrictions - same logic as getCastCandidates
      const isInstant = tl.includes('instant');
      const hasFlash = (card.oracleText || '').toLowerCase().includes('flash');
      
      if (!canCastSorcerySpeed && !isInstant && !hasFlash) {
        continue; // Illegal timing - skip this card
      }

      // Reserve mana check: If we are casting a sorcery/creature, we must leave 'manaReserve' available
      let reserveForThis = 0;
      if (!isInstant && !hasFlash) {
          reserveForThis = manaReserve; // Casting main speed stuff needs to respect reserve
      }
      
      // We pass 'reserve' to autoTap? No, autoTapLandsForCost tries to pay exact cost.
      // We need to check if we have enough Total mana.
      // Available untap - Cost >= Reserve?
      // Approximate:
      const totalAvailable = me.battlefield.filter(p => p.typeLine.includes('Land') && !p.tapped).length; // Rough
      // Accurate mana check is hard without tapping.
      // Let's use autoTap to see if we CAN pay.
      const tapResult = autoTapLandsForCost(me, parseManaCost(card.manaCost));
      
      if (!tapResult) continue; // Can't afford card itself
      
      if (reserveForThis > 0) {
           // Heuristic: Total Untapped Lands - CMC >= Reserve
           // This assumes purely colorless/generic costs for reserve, which is good enough for heuristic
           if (totalAvailable - card.cmc < reserveForThis) {
               continue; // Does not leave enough reserve
           }
      }

      let score = 0;
      const cmc = card.cmc;
      const tags = card.tags || [];

      // Removal is high priority when opponent has threats
      if (tags.includes('removal') && oppHasThreats) score += 6;
      else if (tags.includes('removal') && oppCreatureCount > 0) score += 3;

      // Board wipes when behind on board
      if (tags.includes('wipe') && oppCreatureCount >= 3) score += 7;

      // Draw spells are good mid-game
      if (tags.includes('draw')) score += 3;

      // Ramp is premium early game (turns 1-4)
      if (tags.includes('ramp') && state.turn <= 4) score += 5;
      else if (tags.includes('ramp') && state.turn <= 6) score += 2;

      // Creatures: evaluate by power+toughness / CMC ratio
      if (tl.includes('creature')) {
        const pow = parseInt(card.power || '0', 10);
        const tough = parseInt(card.toughness || '0', 10);
        score += cmc > 0 ? (pow + tough) / cmc : (pow + tough);
        // Finishers are great late game
        if (tags.includes('finisher') && state.turn >= 6) score += 4;
      }

      // Engines and combo pieces
      if (tags.includes('engine')) score += 3;
      if (tags.includes('combo-piece')) score += 2;

      // Protection (hexproof, indestructible spells)
      if (tags.includes('protection')) score += 2;

      // Prefer mana-efficient plays: penalize high CMC slightly
      score -= cmc * 0.3;

      // Prefer playing spells that use available mana efficiently
      // Bonus for using more of our available mana
      const landCount = me.battlefield.filter(p => p.typeLine.toLowerCase().includes('land')).length;
      if (landCount > 0) {
        score += (cmc / landCount) * 1.5; // Prefer using more of our mana
      }

      candidates.push({ card, tapResult, score });
    }

    if (candidates.length === 0) return null;

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];
    // Safety check: ensure best exists and has required properties
    if (!best || !best.card || !best.tapResult || !best.tapResult.payment) {
      return null;
    }

    const targets = this.resolveTargets(best.card, state, opp);
    // If targets required but none found, we can't cast this spell safely
    if (targets === null) {
        // If the best spell is illegal, we should probably look at the 2nd best?
        // For now, just return null (pass)
        return null;
    }

    return {
      type: 'cast-spell',
      player: this.player,
      cardId: best.card.id,
      targets: targets,
      manaPayment: best.tapResult.payment,
    };
  }

  // ─── Selective Attacking ───

  /**
   * Only attack with creatures that can do so profitably.
   * Avoids suicidal attacks into bigger blockers.
   */
  private selectAttackers(
    me: any,
    opp: any,
  ): string[] {
    const eligible = me.battlefield.filter((p: any) =>
      p.currentPower !== undefined &&
      !p.summoningSick &&
      !p.tapped
    );

    if (eligible.length === 0) return [];

    const oppBlockers = opp.battlefield.filter((p: any) =>
      p.currentPower !== undefined &&
      !p.tapped // Tapped creatures can't block
    );

    // If opponent has no blockers, attack with everything
    if (oppBlockers.length === 0) {
      return eligible.map((p: any) => p.id);
    }

    // Calculate total attack power vs opponent life
    const totalPower = eligible.reduce((sum: number, p: any) => sum + (p.currentPower ?? 0), 0);

    // If we can lethal, attack with everything
    if (totalPower >= opp.life) {
      return eligible.map((p: any) => p.id);
    }

    // Otherwise, selectively attack
    const attackers: string[] = [];
    for (const attacker of eligible) {
      const aPow = attacker.currentPower ?? 0;
      const aTough = attacker.currentToughness ?? 0;

      // Flying creatures can only be blocked by flying creatures
      const oracle = (attacker.oracleText || '').toLowerCase();
      const hasFlying = oracle.includes('flying');
      const hasTrample = oracle.includes('trample');

      const relevantBlockers = hasFlying
        ? oppBlockers.filter((b: any) => (b.oracleText || '').toLowerCase().includes('flying'))
        : oppBlockers;

      // If no relevant blocker can kill us, attack
      const canBeKilled = relevantBlockers.some(
        (b: any) => (b.currentPower ?? 0) >= aTough
      );
      const canKillBlocker = relevantBlockers.some(
        (b: any) => aPow >= (b.currentToughness ?? 0)
      );

      if (!canBeKilled) {
        // Safe to attack — nothing can kill us
        attackers.push(attacker.id);
      } else if (canKillBlocker && aPow >= 3) {
        // We can trade, and we're big enough to make it worthwhile
        attackers.push(attacker.id);
      } else if (hasTrample && aPow >= 4) {
        // Trample makes it through even when blocked
        attackers.push(attacker.id);
      } else if (hasFlying && relevantBlockers.length === 0) {
        // Flying with no flying blockers — safe
        attackers.push(attacker.id);
      }
      // Otherwise: don't attack (would just die for nothing)
    }

    return attackers;
  }

  // ─── Smart Blocking ───

  /**
   * Assign blockers when it's profitable. Match our smallest useful blocker
   * against each attacker to minimize losses.
   */
  /**
   * Assign blockers with support for double-blocking and gang-blocking.
   * Matches our blockers against attackers to maximize favorable trades.
   */
  private assignBlockers(
    state: GameState,
    me: typeof state.players[0],
    opp: typeof state.players[0],
  ): { blocker: string; attacker: string }[] {
    // Get attacking creatures from combat state
    const combat = state.combat;
    if (!combat || !combat.attackers || combat.attackers.length === 0) {
      return [];
    }

    const availableBlockers = me.battlefield.filter(p =>
      p.currentPower !== undefined &&
      !p.tapped
    );

    if (availableBlockers.length === 0) return [];

    const blocks: { blocker: string; attacker: string }[] = [];
    const usedBlockerIds = new Set<string>();

    // Sort attackers by prioritization:
    // 1. Lethal threats (high power vs our life)
    // 2. High value creatures (high power/CMC)
    // 3. Small threats
    const attackerPerms = combat.attackers
      .map(a => {
        const perm = opp.battlefield.find(p => p.id === a.permanentId);
        return perm ? { ...a, perm } : null;
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((a, b) => {
          // Prioritize blocking lethal damage
          const aLethal = (a.perm.currentPower || 0) >= me.life;
          const bLethal = (b.perm.currentPower || 0) >= me.life;
          if (aLethal && !bLethal) return -1;
          if (!aLethal && bLethal) return 1;
          // Then by power
          return (b.perm.currentPower ?? 0) - (a.perm.currentPower ?? 0);
      });

    // Helper to estimate trade outcome
    const simulateClash = (attacker: Permanent, blockers: Permanent[]) => {
        const atkPow = attacker.currentPower || 0;
        const atkTough = attacker.currentToughness || 0;
        let blockPow = 0;
        let blockTough = 0;
        
        blockers.forEach(b => {
            blockPow += (b.currentPower || 0);
            blockTough += (b.currentToughness || 0);
        });
        
        const attackerDies = blockPow >= atkTough;
        // Simplified damage assignment: assume attacker distributes damage optimally to kill blockers
        // We calculate how many blockers die.
        let remainingAtkDamage = atkPow;
        let blockersDead = 0;
        let valueLost = 0;
        
        // Sort blockers by value (cmc? power?) to see who dies first?
        // Actually attacker chooses kill order. Attacker wants to kill best stuff.
        // We assume worst case: best blockers die first.
        const sortedBlockers = [...blockers].sort((a,b) => b.cmc - a.cmc);
        
        for (const b of sortedBlockers) {
            const bTough = b.currentToughness || 0;
            if (remainingAtkDamage >= bTough) {
                remainingAtkDamage -= bTough;
                blockersDead++;
                valueLost += b.cmc; // Crude value metric
            } else {
                // creature damaged but survives
            }
        }
        
        return { attackerDies, blockersDead, valueLost };
    };

    for (const atk of attackerPerms) {
      if (!atk || !atk.perm) continue;
      const atkPow = atk.perm.currentPower ?? 0;
      
      // Filter available blockers for this attacker (flying, etc)
      // TODO: check evasion (flying, menace) properly
      const canBlock = (blocker: Permanent) => {
          // Simplified evasion check
          const attackerOracle = (atk.perm.oracleText || '').toLowerCase();
          const blockerOracle = (blocker.oracleText || '').toLowerCase();
          
          if (attackerOracle.includes('flying') && 
              !blockerOracle.includes('flying') && 
              !blockerOracle.includes('reach')) return false;
              
          if (attackerOracle.includes('unblockable')) return false;
          
          return true;
      };

      const eligibleBlockers = availableBlockers.filter(b => 
          !usedBlockerIds.has(b.id) && canBlock(b)
      );
      
      if (eligibleBlockers.length === 0) continue;
      
      // Strategy 1: Find a single blocker that eats it alive (Survives + Kills)
      const eater = eligibleBlockers.find(b => 
          (b.currentToughness || 0) > atkPow && (b.currentPower || 0) >= (atk.perm.currentToughness || 0)
      );
      
      if (eater) {
          blocks.push({ blocker: eater.id, attacker: atk.perm.id });
          usedBlockerIds.add(eater.id);
          continue;
      }
      
      // Strategy 2: Gang Block (Double/Triple block) to kill it
      if (eligibleBlockers.length >= 2) {
          // Identify if we can kill it by combining powers
          const atkTough = atk.perm.currentToughness || 0;
          
          // Form a gang from cheapest blockers first?
          // Or biggest?
          // Let's try key combinations:
          // Try to kill it using minimal value loss.
          
          eligibleBlockers.sort((a,b) => a.cmc - b.cmc); // Use cheap stuff first
          let currentGang: Permanent[] = [];
          let currentPower = 0;
          
          for (const cand of eligibleBlockers) {
              currentGang.push(cand);
              currentPower += (cand.currentPower || 0);
              
              if (currentPower >= atkTough) {
                  // We can kill it! Check if it's worth it.
                  const result = simulateClash(atk.perm, currentGang);
                  if (result.attackerDies) {
                      // Is trade worth? 
                      // If attacker CMC > valueLost, or if attacker is lethal threat
                      const isLethal = atkPow >= me.life;
                      if (isLethal || atk.perm.cmc >= result.valueLost) {
                          // Execute Gang Block
                          for (const b of currentGang) {
                              blocks.push({ blocker: b.id, attacker: atk.perm.id });
                              usedBlockerIds.add(b.id);
                          }
                          break; // Handled this attacker
                      }
                  }
              }
          }
          if (blocks.some(b => b.attacker === atk.perm.id)) continue;
      }
      
      // Strategy 3: Chump block if lethal
      if (atkPow >= me.life) {
          // Must block! Use cheapest eligible
          eligibleBlockers.sort((a,b) => a.cmc - b.cmc);
          const chump = eligibleBlockers[0];
          blocks.push({ blocker: chump.id, attacker: atk.perm.id });
          usedBlockerIds.add(chump.id);
      }
    }

    return blocks;
  }


  /**
   * heuristic to resolve targets for a spell.
   * Returns [] if no targets needed.
   * Returns valid targets array if found.
   * Returns null if targets needed but not found.
   */
  private resolveTargets(card: Card, state: GameState, opp: PlayerState): Target[] | null {
    const text = (card.oracleText || '').toLowerCase();
    
    // Default: If we detected 'target' but didn't match specific logic, 
    // we risk submitting empty targets which fails. 
    // Safest is to return null to avoid illegal action error.
    return TargetingSolver.solve(card, state, this.player); 
  }
}

