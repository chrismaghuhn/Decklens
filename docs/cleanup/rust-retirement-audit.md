# Rust Core Retirement Audit

Audit date: 2026-09-24  
Repository HEAD inspected: 08d9af935b58716ecd79a9be60b16cc33eefcfe8 (main, production audit checkpoint)  
Scope: repository/history/live-deployment evidence only. No code, configuration, build artifact or dependency was changed. No tests/builds were run.

## Executive finding

packages/rust-core is not a production frontend, Worker, or game-engine dependency. The deployed Root Vite/Workers Assets frontend and Cloudflare Worker use TypeScript. packages/game-engine has no Rust import. The live Worker inventory exposes no Node/N-API runtime dependency.

Rust remains in an optional bot/training experiment. There are two different training paths: src/train-bot.ts and src/train-bot-ui.ts simulate with the TypeScript Game and can run without Rust; packages/bot-ml's self-play path calls a Rust-only GameSession and throws if it is unavailable. That Rust path appears broken even when Rust is installed: rust-bridge starts an asynchronous load but exports GameSession from an immediate null snapshot; training-game-loop imports that snapshot instead of awaiting getGameSession().

Recommendation: retire Rust from the active production graph, but do not simply move the directory while leaving Rust training exports/callers in place. Decide whether packages/bot-ml self-play is supported. If so, replace its Rust game loop with a TypeScript Game implementation and validate it. If not, archive/remove the experimental loop and its callers while preserving the existing TypeScript training paths. Then preserve authored Rust inputs under legacy/first-rust-engine/ and remove Cargo outputs/generated N-API artifacts. Status: REQUIRES_MIGRATION; this is not an implementation authorization.

## 1. Tracked-file inventory: packages/rust-core

git ls-files reports 1,160 tracked files: 18 outside target/ and 1,142 inside target/. The table classifies every tracked path by exact file or wildcard.

| Classification | Tracked paths | Count | Retirement treatment |
|---|---|---:|---|
| SOURCE | src/engine.rs, src/features.rs, src/lib.rs, src/state.rs, src/validation.rs | 5 | Human-authored Rust engine/state/features/N-API source; archive as historical source. |
| BUILD_CONFIGURATION | Cargo.toml | 1 | Crate type cdylib and Rust/N-API dependencies; archive. |
| PACKAGE_METADATA | Cargo.lock, package.json, package-lock.json | 3 | Preserve with archived experiment for dependency provenance. Locks are generated snapshots, not compiler outputs. |
| DOCUMENTATION | README.md | 1 | Human-authored experimental architecture/build notes; archive. |
| GENERATED_BUILD_ARTIFACT | target/** | 1,142 | Cargo debug/release cache: 682 debug, 458 release. Includes fingerprints, timestamps, dependency files, .rlib/.rmeta, .dll/.exe/.pdb/.lib/.exp and metadata/build-script outputs. Delete outright later; never archive. |
| GENERATED_BUILD_ARTIFACT | index.js, index.d.ts, mtg-bot-rust-core.win32-x64-msvc.node, build_log.txt | 4 | NAPI-RS marks index.js and index.d.ts auto-generated; .node is a 613,376-byte Windows x64 addon; build_log.txt is captured build output. Do not archive as authored source. |
| UNKNOWN | empty files cd, mtg-bot-rust-core@0.1.0, napi, npm | 4 | Tracked zero-byte files with no source/config role. Do not archive; clarify origin before any eventual deletion. |

The categories sum to all 1,160 tracked files. Generated files that should not have been committed are all target/** contents, the machine-specific .node binary, generated N-API loader/types, and build log. Preserve Cargo.lock/package-lock.json as archived reproducibility metadata, distinct from build outputs.

There is no packages/rust-core/.gitignore, and root .gitignore does not ignore target/. The single commit adding this package added authored source, target output, generated loader/binary/log and the empty files together. This establishes commit contents, not who generated each file.

## 2. Repository references and dependency graph

A tracked-text search covered packages/rust-core, mtg-bot-rust-core, rust-bridge, Cargo, N-API, nativeBinding and bridge callers. Repeated per-platform branches in generated index.js are summarized as one loader row; Cargo references in target/** are generated compiler metadata.

| PATH | REFERENCE / CALL DIRECTION | RUNTIME CONTEXT | REQUIRED OR OPTIONAL | FALLBACK BEHAVIOR | USER-VISIBLE FEATURE |
|---|---|---|---|---|---|
| packages/bot-ml/src/rust-bridge.ts | createRequire(import.meta.url) -> require('../../rust-core/index.js'); exports GameSession, applyActionRust, validateActionRust, getBatchedStateInfo | Attempts only in Node when process.versions.node exists; browser guard skips it | Optional on import; required for Rust operations | Load exception swallowed and rustCore remains null. applyActionRust throws; validateActionRust returns false; getBatchedStateInfo throws on null session. No TS state-transition fallback here. | None directly; consumed by experimental training loop/manual check. |
| packages/bot-ml/src/training/training-game-loop.ts | Imports bridge; new GameSession(), then gets state/features/legal actions and applies actions via session; getBatchedStateInfo used | Node training | Required for this loop | Explicitly throws if GameSession is null. The TypeScript Game argument is documented/used as ignored. No JS Game fallback. applyActionRust/isRustAvailable/validateActionRust imports are unused here. | Self-play experience generation, not normal game play. |
| packages/bot-ml/src/training/self-play.ts | Calls runTrainingGame(...) | Node training | Required by this SelfPlayPipeline route | No alternate TS Game loop at this call. | Internal package self-play. |
| packages/bot-ml/src/index.ts | Publicly exports runTrainingGame | Any bot-ml barrel consumer evaluates the module graph | Optional for general bot/model APIs; Rust loop itself is not optional | The bridge load failure is caught; invoking the exported training loop still throws. | Bot-ML APIs and Rust-only training export. |
| packages/bot-ml/package.json | train script launches src/training/self-play.ts | Node package script | Required for this script | Calls self-play above; no Rust-free runner. | CLI self-play training. |
| scripts/tests/train-bot-cli.ts | Imports runTrainingGame from bot-ml index and calls it | Node CLI source under scripts/tests | Required at the call, if the file is runnable | No TS fallback. Relative ../packages imports resolve under scripts/, not repo root; root package scripts point at nonexistent top-level scripts/train-bot-cli.ts instead. | Intended CLI training; current entry/import paths are stale. |
| packages/bot-ml/src/scripts/verify-rust-loop.ts | Calls runTrainingGame | Manual Node verification | Required for this check | Catches error and exits failure. | Developer smoke check. |
| scripts/tests/test-rust-bridge.ts | Imports bridge functions and checks native availability | Manual Node/tsx script | Requires native success path | Exits if Rust is unavailable; does not cover absent-Rust behavior. Its ../packages path is wrong from scripts/tests/. | Developer bridge test. |
| scripts/tests/test-binding.js, test-play-land.js, test-turns.js | require('./packages/rust-core/index.js') | Manual Node scripts | Requires native package | No fallback. Relative paths point beneath scripts/tests/packages, not root packages. | Developer-only native tests. |
| scripts/benchmarks/benchmark-cloning.js | require('./packages/rust-core/index.js') | Manual benchmark | Requires native package | No fallback; relative path points beneath scripts/benchmarks/packages. | Developer TS-vs-Rust benchmark. |
| src/train-bot.ts | Imports bot-ml, but has its own playGame using TS Game/submitAction; records episodes and trains buffer | Node TypeScript training | Rust import is only a caught module side effect; game loop does not call Rust | Uses TypeScript game engine and SimpleBot. | Training; source documents direct npx tsx src/train-bot.ts entry. |
| src/train-bot-ui.ts | Imports bot-ml but defines its own TypeScript Game play loop and records episodes | Browser training code; its HTML is excluded from current Vite input | Rust not required for this local loop; process guard prevents browser native load | Uses TS game engine; it does not call Rust training loop in inspected code. | Training UI, though not included in current Vite build. |
| src/play-vs-bot/main.ts | Imports bot-ml barrel; play/multiplayer code uses TS/Worker paths, not bridge operations | Browser WIP page excluded from current Vite input | Rust is only an optional module-load attempt; no Rust operation found in page code | Browser guard skips N-API; multiplayer uses Worker client. | Play-vs-bot page; not current Vite production input. |
| scripts/tests/eval-bot-cli.ts | Imports bot-ml barrel (so bridge module is evaluated); evaluator itself creates TypeScript Game and does not call runTrainingGame | Node evaluation CLI | Rust load is optional, not an evaluation requirement | Missing addon is caught; TS Game is used. Its location/import paths and root package command are inconsistent. | Model evaluation. |
| packages/rust-core/index.js | Generated NAPI loader sets nativeBinding and chooses local per-platform .node or platform package | Node only | Required for native calls | Throws if no platform addon can load; bridge catches load error. | Generated loader. |
| package/config/docs files | Cargo/N-API names in Cargo.toml, locks, package.json, README and docs/RUST_PORT_PLAN.md | Build/package/history | No frontend/Worker caller | N/A | Experimental Rust package/history. |

Dependency graph:

    Rust-free TS trainers:
      src/train-bot.ts / src/train-bot-ui.ts
        -> @mtg/bot-ml models and experience pipeline
        -> packages/game-engine TypeScript Game
        -> no runTrainingGame/native Rust call

    Experimental Rust self-play:
      packages/bot-ml package train
        -> training/self-play.ts
        -> runTrainingGame
        -> rust-bridge.GameSession/getBatchedStateInfo
        -> generated rust-core/index.js
        -> platform N-API .node/package

    Current Root Vite production:
      configured HTML entrypoints -> src modules -> TypeScript packages/game-engine
      -> no import edge to bot-ml/rust-bridge from included entries

    Cloudflare production Worker:
      worker/src/index.ts -> TypeScript game-session and packages/game-engine
      -> no rust-core/N-API/native import

Cloudflare also has a TypeScript Durable Object named GameSession. It is not the Rust N-API class. Preserve Worker game-session code and GAME_SESSION binding.

Other repository search facts: root package.json and pnpm-lock.yaml do not declare mtg-bot-rust-core or @napi-rs/cli as root dependencies; packages/bot-ml/package.json lists only TS workspace dependencies. The relative runtime require is not a package-manager dependency edge. @napi-rs/wasm-runtime strings in pnpm-lock.yaml belong to other dependency trees and are not references to this crate.

## 3. Rust bridge behavior

- Module evaluation invokes loadRustCore() without awaiting it.
- It attempts Node createRequire only when process.versions.node is present. Browser code skips the guarded require; Worker has no import of the bridge or package.
- A failed require is silently caught; rustCore stays null.
- isRustAvailable() observes current state. getGameSession() awaits loadRustCore() and could return the class after loading.
- Race/snapshot defect: export const GameSession = rustCore ? rustCore.GameSession : null is evaluated synchronously while the asynchronous loader is suspended at await import('module'). Thus the exported constant is snapshotted as null before rustCore is populated. training-game-loop imports this snapshot rather than awaiting getGameSession(); its null check appears to reject training even if a native addon loads successfully. Static finding, not runtime tested.
- applyActionRust throws when unavailable; otherwise calls nativeApplyAction. No TypeScript action application is performed as fallback.
- validateActionRust returns false when unavailable (so absent addon and invalid action are conflated); after load it calls native validation and rethrows exceptions. No TS validator fallback.
- getBatchedStateInfo is a JS loop around methods on a supplied Rust session; it throws on null and does not switch to packages/game-engine.
- The only bridge smoke script fails fast if native support is absent; it does not test both paths. No automated bot-ml unit test mentioning rust-bridge/Rust/runTrainingGame was found.

    CAN_DECKLENS_FRONTEND_RUN_WITHOUT_RUST = YES — deployed Root Vite inputs do not reach the Rust bridge; training/play pages are excluded.
    CAN_DECKLENS_WORKER_RUN_WITHOUT_RUST = YES — live Worker and repository graph are TypeScript.
    CAN_CURRENT_TRAINING_RUN_WITHOUT_RUST = YES via src/train-bot.ts and src/train-bot-ui.ts; NO via packages/bot-ml self-play train/runTrainingGame.

## 4. Training relationship

There are two distinct training implementations:

1. TypeScript path: src/train-bot.ts has a TS Game playGame(), calls MLBot/SimpleBot with GameState, records episodes, and trains from the replay buffer. src/train-bot-ui.ts also creates a TS Game and records experience. These paths do not call runTrainingGame or Rust; they remain possible without Rust.
2. Rust GameSession path: packages/bot-ml/src/training/self-play.ts calls runTrainingGame. Its package train script launches that module. The loop ignores its JS Game argument, constructs Rust GameSession, reads features/legal actions and applies actions through native session calls. It throws if GameSession is null and has no TS fallback. The static exported GameSession snapshot makes the current integration appear broken even if addon load succeeds. Self-play source also casts heuristic opponents to MLBot and notes that the interface does not fit; the runtime loop expects Rust-compatible action selection.

Root npm scripts train:cli/train:gpu/train:cpu/eval:cli point to scripts/train-bot-cli.ts and scripts/eval-bot-cli.ts, which are absent there. Similar files under scripts/tests/ use ../packages paths that are incorrect from their nested location. Treat that CLI wiring as stale, not evidence the scripts have been validated. The direct src/train-bot.ts command is a TS path and does not use the Rust loop.

Classification: Rust is not an active product runtime dependency. It is an optional training experiment, required only by one package self-play path, which appears broken. It is not a complete replacement engine: the TS engine remains separately implemented and used.

## 5. Historical intent

| Question | Finding |
|---|---|
| ORIGINAL_INTENT | README and docs/RUST_PORT_PLAN.md propose replacing slow TS state cloning/rules processing with high-performance Rust exposed to Node via N-API; target stated as >10,000 simulations/second. Neural-network training was to remain in TS/Node initially. |
| IMPLEMENTED_SCOPE | Five Rust source files implement state/cards, action handling, validation, feature extraction, N-API exports and GameSession. Source includes cast-spell validation placeholders and simplified combat/blocking. Generated bindings/loader and one Windows native binary are present. |
| LAST_MEANINGFUL_RUST_COMMIT | 5bd2857, 2026-02-16, “Update DeckLens: Complete project structure with bot packages and infrastructure.” It introduced rust-core, generated loader/binary/build log and target output. No later rust-core commit exists. Rust bridge/training-loop and the plan were last materially touched in that Feb 16 commit. |
| PORT_COMPLETION_STATE | Incomplete: plan marks basic phase 1 complete, phase 2 “in progress,” phase 3 “prepared,” and phase 4 Rust simulation loop/batch inference/MCTS unchecked. Source simplifications and lack of Rust unit tests reinforce that phase status; file count alone is not completion evidence. |
| WHY_TYPESCRIPT_ENGINE_REMAINED_AUTHORITATIVE | Root Vite aliases/imports packages/game-engine; TS trainers and Worker multiplayer use TS Game; active Worker is a TypeScript runtime without N-API. Rust was loaded only from the bot-ml Node bridge and never became the general frontend/Worker engine. |

## 6. Production dependency proof

| Dependency question | Result | Evidence |
|---|---|---|
| ROOT_VITE_DEPENDS_ON_RUST | NO | 16 Vite inputs reach TS app modules/packages. bot-ml imports are in training/play source files whose HTML pages are not Vite inputs. A Vite alias alone is not a dependency edge. |
| WORKER_DEPENDS_ON_RUST | NO | Worker source imports TypeScript modules; authenticated live inventory found no Rust/native Worker runtime/build binding. |
| GAME_ENGINE_DEPENDS_ON_RUST | NO | Independent TypeScript workspace package with no Rust/N-API import. |
| BOT_CORE_DEPENDS_ON_RUST | NO | TS bots/evaluators, no Rust package import/dependency. |
| BOT_ML_DEPENDS_ON_RUST | OPTIONAL | General bot functions and TS trainers survive missing addon; exported SelfPlayPipeline Rust runner does not. Rust crate is not declared as a package dependency. |
| TRAINING_TOOLS_DEPEND_ON_RUST | OPTIONAL overall; YES for package self-play | src/train-bot.ts/UI use TS Game. packages/bot-ml train/runTrainingGame need Rust GameSession. eval-bot-cli uses TS Game, with only caught optional bridge load from barrel. |

The root pnpm-lock.yaml and root package.json do not declare mtg-bot-rust-core or @napi-rs/cli as root dependencies. packages/bot-ml/package.json also does not declare the native crate as a dependency; the bridge reaches it through a relative runtime string. Workspace glob membership is not a runtime dependency edge.

## 7. Retirement design (not implemented)

Proposed archive layout:

    legacy/
      README.md
      first-rust-engine/
        README.md
        Cargo.toml
        Cargo.lock
        package.json
        package-lock.json
        src/
          engine.rs
          features.rs
          lib.rs
          state.rs
          validation.rs

Archive human-authored Rust source/config/docs and the dependency locks for reproducibility. Add archive context: experimental Node/N-API port from Feb 2026, incomplete and not production engine. Do not copy target/, .node, generated index.js/index.d.ts, or build_log.txt. Do not carry the four empty UNKNOWN files without owner confirmation.

| Reference | Disposition | Reason |
|---|---|---|
| packages/bot-ml/src/rust-bridge.ts | REMOVE if fully retiring; otherwise UPDATE with lazy async load and meaningful TS fallback | Only active bridge; current API has no working absent-Rust training fallback. |
| training-game-loop.ts | UPDATE to TS Game implementation or ARCHIVE with unsupported self-play feature | Rust-only and ignores JS Game parameter. |
| bot-ml/src/training/self-play.ts, bot-ml/src/index.ts, bot-ml/package.json train script | UPDATE to TS runner or remove/archive the experiment | Calls/exports Rust-only loop. |
| scripts/tests/train-bot-cli.ts, bot-ml/src/scripts/verify-rust-loop.ts | UPDATE to TS path or ARCHIVE/REMOVE | Direct Rust loop callers; stale paths/type issues. |
| Rust-only test/benchmark scripts | ARCHIVE or REMOVE after preserving history: scripts/tests/test-rust-bridge.ts, test-binding.js, test-play-land.js, test-turns.js, scripts/benchmarks/benchmark-cloning.js | Native-only and several relative paths are invalid; no absent-Rust coverage. |
| Root package train/eval script paths | UPDATE separately to valid entrypoints | Current scripts name nonexistent top-level paths. |
| src/train-bot.ts, src/train-bot-ui.ts, eval-bot-cli.ts | PRESERVE TS behavior; optionally narrow imports to avoid evaluating bridge through bot-ml barrel | Their game loops use TS Game. |
| src/play-vs-bot/main.ts and Worker multiplayer client | PRESERVE independently; validate page routing/build separately | Uses TS/Worker multiplayer, not native Rust; page is excluded from Vite inputs. |
| worker/src/game-session.ts, worker/src/index.ts, worker/wrangler.toml, packages/game-engine | PRESERVE | Separate production TypeScript DO/game engine and binding. |
| docs/RUST_PORT_PLAN.md and Rust README | ARCHIVE with context or update to link to archive | Retain historical intent without implying parity/completion. |

## 8. Validation after an approved retirement

No tests or builds were run for this analysis-only task. After implementation:

| Validation | Required? | Reason |
|---|---|---|
| Root Vite build | YES | Confirm production graph compiles without bridge/package edges. |
| Root tests | YES | Regression baseline; discover configured runner because root package has no test script. |
| packages/game-engine tests | YES | Protect authoritative TS engine. |
| packages/bot-core tests | YES | Verify bot interfaces consumed by remaining training paths. |
| packages/bot-ml tests | YES | Directly affected bridge/export/training changes; cover with/without Rust if bridge remains. |
| Worker typecheck/build | YES | Protect production Worker and prove independent TS path; do not deploy. |
| Supported TypeScript training CLI | YES | Run src/train-bot.ts path without native addon. Root script aliases currently point at missing files and need deliberate resolution. |
| bot-ml self-play CLI | YES if retained; otherwise verify deliberate retirement | Its train script currently uses Rust-only runTrainingGame. |
| Evaluation CLI | YES | Verify TypeScript evaluator works and import graph does not require Rust. |
| Rust manual smoke scripts | NO as active gate after archive | Archive/remove with old experiment; paths are stale and scripts do not test no-Rust fallback. |

## Final assessment

    RUST_PRODUCTION_DEPENDENCY = NO — no live Vite/Worker/native runtime dependency
    RUST_FRONTEND_DEPENDENCY = NO — Root Vite production inputs exclude Rust-referencing pages
    RUST_WORKER_DEPENDENCY = NO — active Worker is TypeScript; no N-API binding
    RUST_GAME_ENGINE_DEPENDENCY = NO — TypeScript engine is independent
    RUST_BOT_ML_DEPENDENCY = OPTIONAL — only the package self-play runner requires it
    RUST_TRAINING_DEPENDENCY = OPTIONAL overall; YES for bot-ml self-play; NO for src/train-bot.ts/UI TS loops

    RUST_RETIREMENT_STATUS = REQUIRES_MIGRATION — preserve/replace or deliberately retire the declared bot-ml self-play route before moving its native dependency
    HUMAN_AUTHORED_FILES_TO_ARCHIVE = packages/rust-core/src/*.rs; Cargo.toml; package.json; README.md
    GENERATED_FILES_TO_DELETE = target/** (1,142 tracked); root *.node; generated index.js/index.d.ts; build_log.txt
    REFERENCES_TO_REMOVE = Rust-only bridge/generated-loader edges and native-only tests/benchmark if self-play is not migrated
    REFERENCES_TO_PRESERVE = TS Game/game-engine; src/train-bot.ts; src/train-bot-ui.ts; TS evaluation; Worker GameSession/DO and GAME_SESSION binding

    PROPOSED_ARCHIVE_PATH = legacy/first-rust-engine/
    VALIDATION_REQUIRED = root Vite build/tests; game-engine; bot-core; bot-ml; Worker typecheck/build; supported TS training CLI; evaluation CLI; retained self-play or explicit retirement check
    BLOCKERS = product decision on bot-ml self-play; clarify four empty tracked files; fix/confirm stale CLI/import paths; implementation/validation is a later authorized task

Analysis only: no archive, deletion, reference edit, build, or test was performed.
