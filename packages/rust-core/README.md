# 🦀 Rust Core Engine (Experimental)

This package contains the high-performance Rust implementation of the Magic: The Gathering game engine.
The goal is to replace the slow TypeScript `GameState` cloning and rules processing with native Rust code, linked to Node.js via **N-API**.

## 🚀 Architecture

1.  **Node.js (Frontend/AI):**
    - Handles the Neural Network (TensorFlow.js).
    - Handles the Web Server (WebSocket).
    - Calls into Rust for move validation and state simulation.

2.  **Rust (Backend/Engine):**
    - `struct GameState`: The raw memory representation of the game.
    - `fn apply_action()`: Extremely fast state updates.
    - `fn get_legal_moves()`: Generates valid moves 50x faster than JS.

## 🛠 Setup

To build this package, you need **Rust (Cargo)** installed.

### Windows

```powershell
winget install Rustlang.Rustup
```

_Note: Restart your terminal after installation._

### macOS / Linux

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## 📦 Tech Stack

- **Rust**: System programming language.
- **napi-rs**: The bridge between Rust and Node.js (zero-copy overhead where possible).
- **Rayon**: For parallelizing MCTS (Monte Carlo Tree Search) simulations.
