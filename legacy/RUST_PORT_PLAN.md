# Rust Port Migration Plan

Dieses Dokument beschreibt den detaillierten Plan zur Portierung des MTG Bot Projekts von TypeScript nach Rust. Ziel ist eine massive Performance-Steigerung (Ziel: >10.000 Simulationen/Sekunde) und verbesserte Stabilität.

## 1. Architektur-Übersicht

Das Projekt wird in eine Hybrid-Architektur überführt:
- **Rust Core**: Enthält die komplette Game Engine, Regel-Validierung und den schnellen Simulations-Loop.
- **TypeScript/Node.js**: Bleibt (vorerst) für das Training der Neural Networks (TensorFlow.js) und als "Kleber" für die CLI.
- **Schnittstelle**: N-API (via `napi-rs`) verbindet Node.js und Rust effizient.

## 2. Phasenplan

### Phase 1: Core Engine (Status: Abgeschlossen ✅)
Ziel: Eine vollständige Game Engine in Rust, die denselben State wie die TS-Engine verwalten kann.

- [x] **Datenstrukturen (`state.rs`)**: Definition von `GameState`, `Player`, `Card`, `Permanent` in Rust structs.
- [x] **Basic Actions (`engine.rs`)**: Implementierung von `apply_action` für einfache Aktionen (Pass, Play Land).
- [x] **Action Validation (`validation.rs`)**: Portierung von `validateAction` (TS) nach Rust.
- [x] **Stack & Priority (`engine.rs`)**: Implementierung des MTG Stacks und Priority-Systems.
- [x] **Combat System (`engine.rs`)**: Angreifer deklarieren, Blocker (Basis), Schaden berechnen.

### Phase 2: Game Logic Erweiterung (Status: In Arbeit 🚧)
Ziel: Unterstützung komplexer Magic-Regeln.

- [ ] **State-Based Actions**: Automatische Checks (z.B. Spieler tot bei 0 Leben, Kreaturen sterben bei Schaden).
- [ ] **Mana System**: Mana Pool Verwaltung, Auto-Tapping Algorithmus in Rust.
- [ ] **Card Factory/Parsing**: Schnelles Erstellen von Karten aus statischen Daten.

### Phase 3: Bot Integration (Hybrid) (Status: Vorbereitet 🚧)
Ziel: Der TypeScript-Bot nutzt die Rust-Engine für State-Updates.

- [x] **N-API Bindings**: Expose von `validate_action`, `apply_action` an Node.js.
- [x] **TS Bridge**: `rust-bridge.ts` erstellt.
- [ ] **Feature Extraction**: Portierung der Feature-Extraktion (v2/v3) nach Rust.

### Phase 4: High-Performance Training Loop
Ziel: Verlagerung des Self-Play Loops nach Rust.

- [ ] **Rust Simulation Loop**: Der gesamte Loop `while !game_over { ... }` läuft in Rust.
- [ ] **Batch Inference**: Rust sammelt States von vielen parallelen Spielen und sendet sie als Batch an das TensorFlow Model (in Node/Python) oder nutzt `tract` (Rust ONNX Runtime) für Inference direkt in Rust.
- [ ] **MCTS (Monte Carlo Tree Search)**: Implementierung eines echten MCTS in Rust für übermenschliche Spielstärke.

## 3. Detail-Aufgaben & Reihenfolge

1.  **Validation Engine**: Erstelle `packages/rust-core/src/validation.rs`.
    *   Muss alle Regeln aus `packages/game-engine/src/engine/validation.ts` abdecken.
2.  **Stack System**: Erweitere `engine.rs` um Stack-Resolution Logic.
3.  **Bot Helper**: Erstelle `packages/rust-core/src/bot_utils.rs` für Feature Extraction.
4.  **Benchmarking**: Vergleiche TS vs. Rust Implementation regelmäßig.

## 4. Technische Risiken

- **Daten-Synchronisation**: Kopieren von großen State-Objekten zwischen JS und Rust ist teuer.
  *   *Lösung:* State bleibt so lange wie möglich in Rust (Pointer/Reference), JS erhält nur Views oder Resultate.
- **ML Integration**: TensorFlow.js läuft in Node/GPU. Die Kommunikation muss effizient sein.
  *   *Lösung:* Batched Calls oder Umstieg auf Rust-native ML Runtimes (z.B. `tch-rs` oder `tract`) in Phase 5.

## 5. Nächste Schritte

Starten mit **Phase 1: Action Validation**, da dies die Voraussetzung für einen korrekten Simulations-Loop ist.
