const rustCore = require('./packages/rust-core/index.js');

console.log("🔄 Testing Rust Turn Structure...");

// 1. Create State
let state = rustCore.createEmptyState();
state.log = []; // Enable Logging

// Add a test card to library to test drawing
state.players = [
    { 
        id: 0, 
        name: "P1", 
        life: 20, 
        library: [{ 
            id: "c1", 
            oracleId: "oid1", 
            name: "Forest", 
            manaCost: "", 
            cmc: 0, 
            typeLine: "Basic Land - Forest", 
            oracleText: "{T}: Add {G}.", 
            power: undefined, 
            toughness: undefined, 
            loyalty: undefined, 
            colors: [], 
            colorIdentity: ["G"], 
            tags: [], 
            imageUrl: "", 
            owner: 0 
        }], 
        hand: [], 
        battlefield: [], 
        graveyard: [], // Add missing fields
        exile: [],
        commandZone: [],
        manaPool: { w:0,u:0,b:0,r:0,g:0,c:0,s:0,generic:0 },
        poisonCounters: 0,
        commanderTax: 0,
        commanderDamageJson: "{}",
        landPlayedThisTurn: false,
        landsPlayedThisTurn: 0,
        maxLandPlays: 1,
        hasDrawnThisGame: false
    },
    { 
        id: 1, 
        name: "P2", 
        life: 20, 
        library: [{ 
            id: "c2", 
            oracleId: "oid2", 
            name: "Mountain", 
            manaCost: "", 
            cmc: 0, 
            typeLine: "Basic Land - Mountain", 
            oracleText: "{T}: Add {R}.", 
            power: undefined, 
            toughness: undefined, 
            loyalty: undefined, 
            colors: [], 
            colorIdentity: ["R"], 
            tags: [], 
            imageUrl: "", 
            owner: 1 
        }], 
        hand: [], 
        battlefield: [], 
        graveyard: [],
        exile: [],
        commandZone: [],
        manaPool: { w:0,u:0,b:0,r:0,g:0,c:0,s:0,generic:0 },
        poisonCounters: 0,
        commanderTax: 0,
        commanderDamageJson: "{}",
        landPlayedThisTurn: false,
        landsPlayedThisTurn: 0,
        maxLandPlays: 1,
        hasDrawnThisGame: false
    }
];

const passAction = {
    type: "pass",
    player: 0, // In real engine, this would be validated against priorityPlayer
    targets: []
};

// Simulate 25 steps...
console.log("Simulating 25 steps...");
try {
    for(let i=0; i<25; i++) {
        passAction.player = state.priorityPlayer;
        // IMPORTANT: Rust returns a NEW state, we must assign it back!
        state = rustCore.nativeApplyAction(state, passAction);
    }
} catch (e) {
    console.error("❌ CRASHED:", e);
    console.error(e.message);
}


// Print Log
console.log("\n📜 Game Log:");
state.log.forEach(entry => console.log(`  ${entry}`));

// Verification
if (state.turn > 1) {
    console.log("\n✅ Turn advanced successfully.");
}
if (state.players[1].hand.length > 0) {
    console.log("✅ Player 2 drew a card (Turn 1 draw for P2).");
} else {
    console.error("❌ Player 2 did NOT draw a card.");
}
