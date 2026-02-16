const rustCore = require('./packages/rust-core/index.js');

console.log("🚀 Starting Benchmark: Rust GameState Creation vs JS Object Creation");

const ITERATIONS = 100000;

// 1. Rust Creation
console.time("Rust Create");
for (let i = 0; i < ITERATIONS; i++) {
    rustCore.createEmptyState();
}
console.timeEnd("Rust Create");

// 2. JS Creation (Baseline)
console.time("JS Create");
for (let i = 0; i < ITERATIONS; i++) {
    const jsState = {
        players: [],
        activePlayer: 0,
        turn: 1,
        phase: "beginning",
        step: "untap",
        stack: [],
        gameOver: false
    };
}
console.timeEnd("JS Create");

// 3. Internal Rust Simulation (The Holy Grail)
console.log("\n🔥 Benchmarking Internal Simulation (100,000 moves)...");

const emptyState = rustCore.createEmptyState();

console.time("Rust Internal Loop");
// We run 1 call, but inside Rust it loops 100,000 times
rustCore.benchmarkSimulation(emptyState, ITERATIONS);
console.timeEnd("Rust Internal Loop");

console.timeEnd("Rust Internal Loop");

console.time("JS Loop (Shallow Copy - Unfair)");
let simpleJsState = { turn: 1, activePlayer: 0 };
for (let i = 0; i < ITERATIONS; i++) {
    let _clone = { ...simpleJsState };
    _clone.turn += 1;
}
console.timeEnd("JS Loop (Shallow Copy - Unfair)");

console.time("JS Loop (Deep Copy - structuredClone)");
// Create a JS object that mimics the Rust struct complexity
let complexJsState = {
    players: [],
    activePlayer: 0,
    priorityPlayer: 0,
    turn: 1,
    phase: "beginning",
    step: "untap",
    stack: [],
    bothPlayersPassed: false,
    gameOver: false,
    winner: null,
    mulliganPhase: true,
    mulliganCount: [0, 0],
    log: null
};

for (let i = 0; i < ITERATIONS; i++) {
    // structuredClone is the real equivalent of Rust's .clone()
    let _clone = structuredClone(complexJsState);
    _clone.turn += 1;
}
console.timeEnd("JS Loop (Deep Copy - structuredClone)");

console.log(`\nPerformed ${ITERATIONS} iterations.`);
