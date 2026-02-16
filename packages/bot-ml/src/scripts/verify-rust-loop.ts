
import { runTrainingGame } from '../training/training-game-loop.ts';
import { MLBot } from '../bot-ml.ts';
import { Game } from '@mtg/game-engine';

async function main() {
    console.log("Starting Verification of Rust Training Loop...");

    // Mock Game object (it's ignored by runTrainingGame but needed for signature)
    const mockGame = {
        isOver: () => false,
        getTurn: () => 0,
        getState: () => ({}),
        getWinner: () => undefined
    } as unknown as Game;

    // Mock MLBot
    // We need a real MLBot instance or a mock that adheres to the interface
    // MLBot constructor requires networks. We can try to mock the prototype or just pass a dummy object if we are careful.
    // But runTrainingGame checks `instanceof MLBot`.
    // So we need a real MLBot.
    // MLBot requires policyNet and valueNet.
    // We can pass null and mock the methods?
    
    // Actually, let's just make a MockBot class that extends MLBot (or fakes it)
    // But MLBot imports TensorFlow.
    // Maybe we can just partial mock.
    
    // Easier: Just modify runTrainingGame to accept "AnyBot" that has chooseActionFromRust?
    // No, I shouldn't modify source just for test.
    
    // Let's rely on the fact that we can cast.
    const mockPolicy = {
        predict: () => ({ "pass": 1.0 }),
        predictFast: () => ({ "pass": 1.0 })
    };
    const mockValue = {
        predict: () => 0.5
    };
    
    const p0 = new MLBot(0, mockPolicy as any, mockValue as any);
    const p1 = new MLBot(1, mockPolicy as any, mockValue as any);
    
    // Mock Pipeline
    const mockPipeline = {
        addEpisode: async (ep: any) => {
            console.log(`[Pipeline] Received episode with ${ep.length} steps.`);
        }
    };

    console.log("Running game...");
    try {
        const result = await runTrainingGame(mockGame, p0, p1, mockPipeline as any);
        console.log("Game finished successfully!", result);
        console.log("VERIFICATION PASSED: Rust GameSession integration is working.");
    } catch (e) {
        console.error("VERIFICATION FAILED:", e);
        process.exit(1);
    }
}

main();
