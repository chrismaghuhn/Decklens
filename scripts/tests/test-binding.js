const rustCore = require('./packages/rust-core/index.js');

console.log("Testing Rust Core Integration...");
try {
    const result = rustCore.sum(5, 7);
    console.log(`Rust calculated 5 + 7 = ${result}`);
    
    if (result === 12) {
        console.log("✅ Rust binding works correctly!");
    } else {
        console.error("❌ Rust calculation failed.");
    }

    console.log(`Message from Rust: ${rustCore.helloWorld()}`);

    console.log("Testing GameState creation...");
    const state = rustCore.createEmptyState();
    console.log("✅ GameState created successfully:", JSON.stringify(state, null, 2));

} catch (e) {
    console.error("❌ Failed to load or run Rust module:", e);
}
