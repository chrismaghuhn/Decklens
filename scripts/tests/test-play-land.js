const rustCore = require('./packages/rust-core/index.js');

console.log("⛰️ Testing Rust Play Land...");

// 1. Create State & Setup Hand
let state = rustCore.createEmptyState();
state.log = [];

// Give Player 0 a land in hand
state.players[0].hand = [{
    id: "land1",
    oracleId: "oid-land",
    name: "Forest",
    typeLine: "Basic Land - Forest",
    manaCost: "",
    cmc: 0,
    oracleText: "{T}: Add {G}",
    colors: [],
    colorIdentity: ["G"],
    imageUrl: "",
    owner: 0,
    tags: []
}];

console.log("Hand before:", state.players[0].hand.length);

// 2. Execute Play Land Action
const action = {
    type: "play-land",
    player: 0,
    cardId: "land1",
    targets: []
};

state = rustCore.nativeApplyAction(state, action);

console.log("\n📜 Log:");
state.log.forEach(l => console.log(l));

// 3. Verify
console.log("\nHand after:", state.players[0].hand.length);
console.log("Battlefield:", state.players[0].battlefield.length);

if (state.players[0].battlefield.length === 1 && state.players[0].hand.length === 0) {
    console.log("✅ Land played successfully!");
} else {
    console.error("❌ Failed to play land.");
}
