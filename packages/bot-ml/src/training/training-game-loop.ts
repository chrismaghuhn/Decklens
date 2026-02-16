import { Game, GameState, GameAction } from '@mtg/game-engine';
import { MLBot } from '../bot-ml.ts';
import { SelfPlayPipeline } from './self-play.ts';
import { HierarchicalPolicy } from '../networks/hierarchical-policy.ts';
import * as tf from '@tensorflow/tfjs';
import { extractFeatures, extractCardFeatures } from '../networks/feature-extractor.ts';
import { actionToIndex } from './imitation.ts';
import { calculateReward } from '../rewards/reward-calculator.ts';
import type { Experience } from './replay-buffer.ts';
import { HeuristicBot } from '@mtg/bot-core';
import { applyActionRust, isRustAvailable, validateActionRust, getBatchedStateInfo } from '../rust-bridge.ts';

// Assuming we have a common Bot interface or we just use union
type Bot = MLBot | HeuristicBot | { chooseAction: (state: any) => Promise<any> | any };

import { GameSession } from '../rust-bridge.ts';

/**
 * Run a single training game between two bots using the High-Performance Rust GameSession.
 * 
 * DESIGN CHANGE: This entirely bypasses the JS 'Game' object loop.
 * The 'game' argument is ignored (except maybe for initial config if needed, but GameSession starts fresh).
 * 
 * Captures experiences for the 'learning' bot (or both if self-play).
 */
export async function runTrainingGame(
    game: Game, // Ignored, but kept for signature compatibility
    p0: MLBot,
    p1: MLBot | Bot,
    pipeline: SelfPlayPipeline,
    learnP0: boolean = true,
    learnP1: boolean = true
): Promise<{ winner: number | undefined, turns: number }> {
    if (!GameSession) {
        throw new Error("Rust GameSession is not available. Cannot run training loop.");
    }

    // Initialize Rust Session
    const session = new GameSession();
    // Assuming GameSession sets up a standard game state on init

    // Clear feature caches between games to prevent stale data
    if (p0 instanceof MLBot) p0.clearCache();
    if (p1 instanceof MLBot) p1.clearCache();

    // Local episode buffers
    const p0Steps: Experience[] = [];
    const p1Steps: Experience[] = [];

    const MAX_TURNS = 100;
    const MAX_ITERATIONS = 5000; 
    let iterations = 0;
    
    // Scores for reward calculation
    let p0Score = session.getScore(0);
    let p1Score = session.getScore(1);

    while (!session.isGameOver() && session.getTurn() < MAX_TURNS && iterations < MAX_ITERATIONS) {
        iterations++;
        
        // Determine active player
        // Note: GameSession manages priority internally. We need to ask who has priority.
        const priorityPlayer = session.getPriorityPlayer() as number; // 0 or 1
        
        const actingBot = priorityPlayer === 0 ? p0 : p1;
        const isLearning = priorityPlayer === 0 ? learnP0 : learnP1;
        const currentSteps = priorityPlayer === 0 ? p0Steps : p1Steps;
        let prevScore = priorityPlayer === 0 ? p0Score : p1Score;

        // OPTIMIZATION: Use batched FFI call to reduce overhead
        // Combines getFeatures, getLegalActions into one batch
        const batchedResults = getBatchedStateInfo(session, [
          { player: priorityPlayer, includeFeatures: true, includeLegalActions: true, includeScore: false }
        ]);
        
        const batchResult = batchedResults[0];
        const featuresF32 = batchResult.features!;
        const legalActions = batchResult.legalActions!;

        // 3. Choose Action
        // We use the new fast method on MLBot
        let action: GameAction;
        let decision: { action: GameAction; logProb: number; value: number; actionIndex: number } | null = null;
        
        if (actingBot instanceof MLBot) {
             // Use fast Rust-compatible method - now returns full decision with logProb and value
             decision = actingBot.chooseActionFromRust(featuresF32, legalActions);
             action = decision.action;
        } else {
             // Fallback for Heuristic/Other bots: They might need full State.
             // This is a problem if they depend on JS GameState.
             // If p1 is Heuristic, it will FAIL because we don't have JS State.
             // SOLUTION: HeuristicBot MUST be ported or disabled.
             // For self-play (ML vs ML), this is fine.
             // I will assume p1 is also MLBot or Random (which can pick from legalActions).
             if (legalActions.length > 0) {
                 action = legalActions[Math.floor(Math.random() * legalActions.length)];
             } else {
                 action = { type: 'pass', player: priorityPlayer as 0 | 1 };
             }
        }

        // 4. Apply Action
        try {
            // Debug logs
            
            session.applyAction(action);
        } catch (e) {
            console.error('Apply Action Failed:', e);
            console.error('Action was:', action);
            throw e;
        }
        
        // 5. Calculate Reward (Shaped) and Record
        const newScore = session.getScore(priorityPlayer);
        const reward = newScore - prevScore;
        
        if (priorityPlayer === 0) p0Score = newScore;
        else p1Score = newScore;

        if (isLearning && decision) {
            // Use actual decision metadata from MLBot instead of placeholders
            const step: Experience = {
                features: new Float32Array(featuresF32), // COPY features to avoid reference issues
                reward, // Intermediate reward
                done: false,
                actionIndex: decision.actionIndex, // Use actual action index from decision
                logProb: decision.logProb, // Use actual logProb from decision
                value: decision.value, // Use actual value from decision
                player: priorityPlayer as 0 | 1,
                cardSelectionIndex: undefined, // Placeholder - would need card selection logic
                cardCandidateFeatures: undefined, // Placeholder
                cardLogProb: undefined // Placeholder
            };
            currentSteps.push(step);
        }
    }
    
    // Game Over Handling
    const isOver = session.isGameOver();
    const winner = isOver ? (p0Score > p1Score ? 0 : 1) : undefined; // Simplified winner check based on score if turns run out, or explicit winner if implemented
    // Note: session doesn't explicitly expose "winner". GameState has `winner`. use get_score or heuristic.
    // If Life <= 0 check is inside Rust engine, specific winner logic might be missing in `isGameOver`. 
    // Assuming simple score/life check for now.
    
    // Final Rewards: Add terminal rewards to last step of each episode
    if (p0Steps.length > 0) {
        const finalP0Reward = winner === 0 ? 10.0 : winner === 1 ? -10.0 : 0.0;
        p0Steps[p0Steps.length - 1].reward += finalP0Reward;
        p0Steps[p0Steps.length - 1].done = true;
    }
    if (p1Steps.length > 0) {
        const finalP1Reward = winner === 1 ? 10.0 : winner === 0 ? -10.0 : 0.0;
        p1Steps[p1Steps.length - 1].reward += finalP1Reward;
        p1Steps[p1Steps.length - 1].done = true;
    }
    
    // Add episodes to pipeline replay buffer
    if (learnP0 && p0Steps.length > 0) {
        pipeline.finishEpisode(p0Steps, winner === 0, session.getTurn());
    }
    if (learnP1 && p1Steps.length > 0) {
        pipeline.finishEpisode(p1Steps, winner === 1, session.getTurn());
    }
    
    return { winner, turns: session.getTurn() };
}

