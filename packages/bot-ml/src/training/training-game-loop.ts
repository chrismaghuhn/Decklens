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

// Assuming we have a common Bot interface or we just use union
type Bot = MLBot | HeuristicBot | { chooseAction: (state: any) => Promise<any> | any };

/**
 * Run a single training game between two bots.
 * Captures experiences for the 'learning' bot (or both if self-play).
 */
export async function runTrainingGame(
    game: Game,
    p0: MLBot,
    p1: MLBot | Bot,
    pipeline: SelfPlayPipeline,
    learnP0: boolean = true,
    learnP1: boolean = true
): Promise<{ winner: number | undefined, turns: number }> {
    // game.start() is not needed/doesn't exist. Game starts initialized.

    // Local episode buffers
    const p0Steps: Experience[] = [];
    const p1Steps: Experience[] = [];

    const MAX_TURNS = 100;
    const MAX_ITERATIONS = 5000; 
    const MAX_ACTIONS_PER_TURN = 200; // Allow more actions per turn
    let iterations = 0;
    let lastTurn = game.getTurn();
    let turnStuckCount = 0;
    let actionsThisTurn = 0;
    
    while (!game.isOver() && game.getTurn() < MAX_TURNS && iterations < MAX_ITERATIONS) {
        iterations++;
        // Get fresh state at start of iteration
        let state = game.getState();
        
        // Safety check: if turn hasn't changed in many iterations, break to avoid infinite loop
        const currentTurn = game.getTurn();
        if (currentTurn === lastTurn) {
            turnStuckCount++;
            actionsThisTurn++;
            if (turnStuckCount > 200) {
                console.warn(`[Training] Game stuck at turn ${currentTurn} for ${turnStuckCount} iterations. Breaking.`);
                break;
            }
            if (actionsThisTurn > MAX_ACTIONS_PER_TURN) {
                console.warn(`[Training] Too many actions (${actionsThisTurn}) in turn ${currentTurn}. Breaking.`);
                break;
            }
        } else {
            turnStuckCount = 0;
            actionsThisTurn = 0;
            lastTurn = currentTurn;
        }
        
        // Multi-Action Loop: Allow bot to take multiple actions in sequence if priority is retained
        // e.g. Play Land -> Cast Spell -> Cast another Spell
        let actionsInSequence = 0;
        const MAX_SEQ_ACTIONS = 10;

        while (actionsInSequence < MAX_SEQ_ACTIONS && !game.isOver()) {
            // Auto-pass for steps where no actions are possible (untap, cleanup)
            // This avoids unnecessary bot calls and speeds up training
            if ((game as any).autoPassIfNeeded) {
                (game as any).autoPassIfNeeded();
            }
            
            state = game.getState();
            const actingPlayerIdx = state.priorityPlayer;
            const actingBot = actingPlayerIdx === 0 ? p0 : p1;
            const isLearning = actingPlayerIdx === 0 ? learnP0 : learnP1;
            const currentSteps = actingPlayerIdx === 0 ? p0Steps : p1Steps;

            // 2. Bot chooses action (using internal reasoning)
            let action: GameAction;
            let decision: any = null;

            if (actingBot instanceof MLBot) {
                 decision = actingBot.chooseActionWithReason(state);
                 action = decision.action;
            } else {
                 if ('chooseAction' in actingBot) {
                     action = await actingBot.chooseAction(state);
                 } else if ('getBotAction' in actingBot) {
                     // @ts-ignore
                     action = await actingBot.getBotAction(state);
                 } else {
                     action = { type: 'pass', player: actingPlayerIdx };
                 }
            }
            
            // 3. Execute Action
            const prevState = state; 
            const success = game.submitAction(action); 
            
            if (!success) {
                console.warn(`[Training] Bot ${actingPlayerIdx} submitted illegal action: ${action.type}. Forcing pass.`);
                // Force pass
                const passSuccess = game.submitAction({ type: 'pass', player: actingPlayerIdx });
                if (!passSuccess) {
                    console.error(`[Training] Even pass action failed for player ${actingPlayerIdx}. Breaking game loop.`);
                    break;
                }
                // Break sequence on error
                break;
            }
            
            // 4. Record Experience
            if (isLearning && decision) {
                const nextState = game.getState(); 
                const reward = calculateReward(prevState, action, nextState, actingPlayerIdx);
                
                const experience: Experience = {
                    features: decision.features,
                    actionIndex: decision.actionIndex,
                    reward,
                    value: decision.value,
                    logProb: decision.logProb,
                    done: game.isOver(),
                    player: actingPlayerIdx,
                    // v3 fields
                    cardSelectionIndex: decision.cardSelectionIndex,
                    cardCandidateFeatures: decision.cardCandidateFeatures,
                    cardLogProb: decision.cardLogProb
                };
                currentSteps.push(experience);
            }

            actionsInSequence++;

            // Break inner loop if:
            // 1. Action was 'pass' (yields priority)
            // 2. Turn changed
            // 3. Priority changed to other player
            // 4. Game Over
            if (action.type === 'pass') break;
            if (game.getTurn() !== currentTurn) break;
            if (game.getState().priorityPlayer !== actingPlayerIdx) break;
            
            // If we cast a spell or played a land, we loop again to see if we want to do more.
        }

        // 5. Yield less frequently (every 20 turns) to speed up training
        // In Node.js training, we don't need UI updates, so we can skip most yields
        if (game.getTurn() % 20 === 0) {
            await new Promise(resolve => setImmediate(resolve));
        }
    } // End While
    
    // Safety check: if we hit iteration limit, log warning (only in verbose mode or every 10th time)
    if (iterations >= MAX_ITERATIONS) {
        // Silently continue - this happens occasionally in normal games
    }

    // Finish Episodes
    const turns = game.getTurn();
    const winner = game.getWinner();
    const isDraw = winner === null || winner === undefined;

    // Optional Draw Penalty (can be passed in or constant)
    const DRAW_PENALTY = -30;

    // Submit to pipeline
    if (learnP0) {
        if (p0Steps.length > 0 && isDraw) {
            p0Steps[p0Steps.length - 1].reward += DRAW_PENALTY;
        }
        const won = winner === 0;
        pipeline.finishEpisode(p0Steps, won, turns);
    }
    if (learnP1) {
        if (p1Steps.length > 0 && isDraw) {
            p1Steps[p1Steps.length - 1].reward += DRAW_PENALTY;
        }
        const won = winner === 1;
        pipeline.finishEpisode(p1Steps, won, turns);
    }

    return { winner: winner ?? undefined, turns };
}
