# First Rust Engine (archived)

Experimental Node/N-API port of the MTG game engine, written in February
2026 to speed up bot self-play simulations (target: >10,000 sims/second).
The port stayed incomplete (simplified combat/validation, no Rust tests)
and never became a production dependency — the TypeScript engine remained
authoritative, and the bridge in `packages/bot-ml` had a load-order defect
that made the Rust path unusable. Details:
`docs/cleanup/rust-retirement-audit.md`.

Preserved here: the five authored Rust sources, `Cargo.toml`, the
dependency locks and the original `README.md`. Build artifacts
(`target/`, the generated N-API loader and the `.node` binary) were
deleted and are recoverable from git history if ever needed.
