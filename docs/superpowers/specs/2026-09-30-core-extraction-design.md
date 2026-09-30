# DeckLens Core Extraction — Design Spec

Date: 2026-09-30
Status: Approved by owner (chat, 2026-09-30)
Basis: docs/cleanup/core-product-extraction-audit.md, docs/cleanup/rust-retirement-audit.md (both at BASE_HEAD 08d9af9)

## Goal

Reduce the repository to the smallest product that keeps the site's core features, with **no application backend** (audit "Variant A"):

- MTG deckbuilder (`decks.html`, `deck-editor.html`)
- Manual Goldfish playtest mode (inside the deck editor, `src/deckbuilder/goldfish.ts`)
- MTG analyzer (`mtg.html`)
- Yu-Gi-Oh! analyzer (`yugioh.html`)
- Optional landing page (`index.html`) linking only to the above

Decks persist in browser storage. Card data comes directly from Scryfall (MTG) and YGOProDeck (YGO). No Worker, no D1, no KV, no Durable Objects, no auth.

## Owner decisions (2026-09-30)

| Decision | Choice |
|---|---|
| Deck Git (versioned deck history, Worker + D1) | **Remove** |
| Public deck sharing (`/d/*`, `decks-public`) and community | **Remove** |
| apps/web (Next.js) and apps/api (NestJS) alternative stacks | **Remove** — owner confirms nothing runs on Vercel |
| Cloudflare resources | **Code first, then teardown**: clean up + deploy slim site, export D1/KV backups, then retire unused resources with per-resource owner confirmation |
| Goldfish scope | Stays a manual state model; no rules enforcement, no game-engine dependency |

## Phases

Each phase ends with a passing build (and tests where applicable) and its own commit.

### P1 — Scryfall browser adapter (prerequisite)

The editor's card autocomplete/search currently call Worker routes (`/api/scryfall/autocomplete`, `/api/scryfall/search`). Replace with a browser-side Scryfall client (Scryfall serves CORS headers; direct calls already exist elsewhere in the codebase). Respect Scryfall rate-limit guidance (simple debounce/backoff). Failure UI: existing error/toast paths.

### P2 — Editor and Goldfish boundary

Trim `src/deckbuilder/editor-main.ts` and `src/deckbuilder/goldfish.ts` to the core graph:

- **Keep:** editing, card rows/zones, local save/open, import/export (paste/file), search/autocomplete (via P1 adapter), card preview, drag/drop, undo, mana calc, local stats/legality/health, collection, image/print, deck-diff, draw probability, categorization, onboarding/toast/modal.
- **Remove imports/wiring:** multiplayer launcher, collab-* (cursors, chat, drawing, proposals, goldfish collab), Coach (goldfish-coach*, widget), Deck Git repo-panel/repo-api/version cloud sync, cloud sync, public share, community hooks, analytics telemetry, draft/sealed, Monte-Carlo simulation.
- Goldfish keeps its own local `GoldfishState`; sever collab/coach imports only.

### P3 — Bots, ML, Rust, Simulator

- Archive authored Rust files to `legacy/first-rust-engine/` (5 `.rs` sources, `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`, `README.md`) with a context README. Do **not** archive `target/**`, generated `index.js`/`index.d.ts`, `.node` binary, `build_log.txt`, or the four empty stray files.
- Delete `packages/rust-core`, `packages/bot-core`, `packages/bot-ml`, `src/play-vs-bot`, `src/rules-engine`, `src/train-bot*.ts`, `data/` training logs + model weights, bot/Rust test & benchmark scripts, `play-vs-bot.html`, `train-bot.html`, `rules-engine.html`.
- bot-ml self-play (Rust-only, statically broken per audit) is deliberately retired, not migrated.

### P4 — Alternative stacks, backend, social surfaces

Delete: `apps/web`, `apps/api`, `packages/db`, `worker/` (entire), `src/dashboard`, `src/community`, `src/deckhub`, dashboard/community/deckhub/public-deck HTML pages, `public/deckhub-sw.js`, `infra/docker-compose.yml`, root `build_output*.txt`, `worker/.wrangler` tracked state. `packages/game-engine` and `packages/card-data` are deleted once P2/P3 leave no importers (verify by grep before delete).

### P5 — Configuration and tests

- `vite.config.ts`: inputs reduced to index, mtg, yugioh, decks, deck-editor.
- `package.json` / `pnpm-workspace.yaml`: drop bot/train/eval/worker scripts and dead workspace members; prune dependencies.
- `tsconfig.json`: remove dead path aliases.
- `infra/_redirects` / frontend routing: only core routes; drop `/play`, `/train-bot`, `/simulator`, `/dashboard/*`, `/community`, `/deckhub`, `/d/*`, `/decks/public`.
- Tests: keep parsing/import/export/analyzer/YGO/Goldfish/storage suites; delete bot/ML/rules/multiplayer/collab/community/backend suites.
- Docs: archive bot/Rust plans under `legacy/`; keep cleanup audits and this spec.

### P6 — Validation

- `pnpm build` (Vite) and configured Vitest suite pass.
- Browser smoke (in-app browser, local preview): create/save/reopen deck; card search + autocomplete (direct Scryfall); import/export; Goldfish draw/play/move/tap/turn/undo/reset; MTG analyzer on a pasted deck; YGO analyzer lookup/parse/export.
- Grep invariants: no imports of bot/ML/Rust/multiplayer/collab/dashboard/community/deckhub/worker-API from the active graph; no production imports from `legacy/`.

### P7 — Deploy and Cloudflare teardown (separately confirmed)

1. Deploy slim static site to the existing Cloudflare Assets project.
2. Export backups: D1 `decklens-community` dump, `COMMUNITY_KV` + `CACHE_KV` keys, analytics dataset if exportable.
3. Then, **with per-resource owner confirmation**: remove Worker routes/deployment `decklens-api`, delete D1/KV/Analytics/DO bindings and resources, remove Sunday cron. Nothing remote is deleted before its backup exists.

## Non-goals

- No rewrite of retained modules beyond severing removed features.
- No new features; no visual redesign.
- No Git-history rewrite (deleted files remain recoverable from history).

## Risk notes

- `editor-main.ts` (121-file mixed subtree) is the highest-risk surface → feature-by-feature extraction, never wholesale directory deletes of mixed code.
- Live D1/DO state: untouched until P7 backup step.
- Extensionless `/mtg`, `/yugioh` routing must be re-verified on the deployed host in P7.
