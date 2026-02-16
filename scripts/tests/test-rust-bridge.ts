import { isRustAvailable, applyActionRust, validateActionRust } from '../packages/bot-ml/src/rust-bridge.ts';

console.log('Testing Rust Bridge (Minimal State)...');

if (!isRustAvailable()) {
    console.error('❌ Rust core not available!');
    process.exit(1);
}

// 1. Create Minimal State manually to match Rust struct EXACTLY
const minimalState = {
    players: [
        {
            id: 0,
            name: "P1",
            life: 20,
            poisonCounters: 0,
            manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, S: 0, generic: 0 },
            hand: [],
            library: [],
            graveyard: [],
            exile: [],
            battlefield: [],
            commandZone: [],
            commanderTax: 0,
            commanderDamage: undefined, // Explicit undefined
            landPlayedThisTurn: false,
            landsPlayedThisTurn: 0,
            maxLandPlays: 1,
            hasDrawnThisGame: false
        },
        {
            id: 1,
            name: "P2",
            life: 20,
            poisonCounters: 0,
            manaPool: { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0, S: 0, generic: 0 },
            hand: [],
            library: [],
            graveyard: [],
            exile: [],
            battlefield: [],
            commandZone: [],
            commanderTax: 0,
            commanderDamage: undefined,
            landPlayedThisTurn: false,
            landsPlayedThisTurn: 0,
            maxLandPlays: 1,
            hasDrawnThisGame: false
        }
    ],
    activePlayer: 0,
    priorityPlayer: 0,
    turn: 1,
    phase: "precombat-main",
    step: "main", // Note: Rust expects specific step names for logic, but for mapping test any string works
    stack: [],
    bothPlayersPassed: false,
    gameOver: false,
    winner: undefined, // Explicit undefined
    mulliganPhase: false,
    mulliganCount: [0, 0],
    log: [], // Empty array
    actionHistory: undefined,
    combat: undefined
};

const passAction = { 
    type: 'pass', 
    player: 0,
    cardId: undefined,
    sourceId: undefined,
    abilityIndex: undefined,
    targets: undefined
};

try {
    console.log('Testing Validation with Minimal State...');
    const isValid = validateActionRust(minimalState as any, passAction as any);
    console.log(`Validation: ${isValid ? '✅ Valid' : '❌ Invalid'}`);
    
    console.log('Testing Apply Action...');
    const nextState = applyActionRust(minimalState as any, passAction as any);
    console.log(`Next State Priority: ${nextState.priorityPlayer}`);
    
} catch (e) {
    console.error('❌ Error:', e);
}
