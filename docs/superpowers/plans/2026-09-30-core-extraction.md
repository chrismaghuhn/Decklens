# DeckLens Core Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce DeckLens to a backend-free Vite browser app with four core surfaces (deckbuilder + manual Goldfish, MTG analyzer, YGO analyzer) and remove bot/ML/Rust/multiplayer/collab/social/backend code.

**Architecture:** Replace the three Worker-backed Scryfall calls with a direct browser Scryfall client first, then sever removed features from the two mixed entrypoints (`editor-main.ts`, `goldfish.ts`, `mtg/app.ts`), then delete whole dead subtrees, then shrink config/tests. Cloudflare deploy + resource teardown is last and separately confirmed.

**Tech Stack:** Vite 6, TypeScript 5, Vitest, pnpm workspace, Cloudflare Workers Assets (static hosting only).

**Spec:** `docs/superpowers/specs/2026-09-30-core-extraction-design.md`

## Global Constraints

- Branch: `cleanup/core-extraction`. One commit per task minimum. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Decision rule for mixed feature modules:** keep a deckbuilder/mtg module if it works fully locally or talks directly to Scryfall/YGOProDeck; remove it if it requires the Worker (`apiPath('/api/...')` / `API_ORIGIN` in `src/shared/api.ts`), auth, collab, multiplayer, coach, community, telemetry, or Deck Git.
- Never delete a mixed file wholesale to remove one feature; extract feature-by-feature (`editor-main.ts`, `goldfish.ts`, `mtg/app.ts`).
- No remote Cloudflare mutation before Task 10, and there only per-resource after a verified backup and owner confirmation.
- No production imports from `legacy/`.
- Scryfall API etiquette: identify via existing fetch helper, keep existing debounce; `/cards/collection` accepts max **75 identifiers per request**.
- Build gate per task: `npx tsc --noEmit` (frontend scope) and `npx vite build` pass; Vitest suite passes where touched.

## Review Focus

1. Scryfall search with zero hits returns HTTP **404** — UI must show "no results", not an error toast. → test in Task 1.
2. `resolveDeckbuilderCards` with >75 names must chunk `/cards/collection` requests. → test in Task 1.
3. HTTP 429 from Scryfall (rate limit) → existing retry/backoff path, friendly error, no crash. → test in Task 1.
4. Decks saved before cleanup (localStorage with fields from removed features, e.g. collab/version metadata) must still open in the editor. → test in Task 2.
5. Deep links `/decks/id/<id>`, `/mtg`, `/yugioh` must still resolve after redirect trimming, in dev server and on the deployed host. → verified in Task 8 (dev) and Task 10 (prod).

---

### Task 1: Direct Scryfall browser client (P1)

**Files:**
- Create: `src/shared/scryfall-client.ts`
- Create: `tests/unit/scryfall-client.test.ts`
- Modify: importers of the three functions (`git grep -l "fetchDeckbuilderAutocomplete\|searchDeckbuilderCards\|resolveDeckbuilderCards" -- src` — at least `src/deckbuilder/editor-main.ts`, `src/deckbuilder/card-autocomplete.ts`, `src/deckbuilder/import-resolver.ts`) to import from `../shared/scryfall-client.js`.

**Interfaces:**
- Produces (signatures identical to the current `src/shared/api.ts` versions, so call sites only change the import path):
  - `fetchDeckbuilderAutocomplete(query: string, options?: { signal?: AbortSignal }): Promise<string[]>` → GET `https://api.scryfall.com/cards/autocomplete?q=`
  - `searchDeckbuilderCards(params: DeckbuilderSearchParams, options?: { signal?: AbortSignal }): Promise<{ items: DeckbuilderSearchCard[]; hasMore: boolean; totalCards: number | null }>` → GET `https://api.scryfall.com/cards/search`; map params into Scryfall syntax: `colorIdentity`→`id:`, `type`→`t:`, `manaValue`→`mv:`, `oracleText`→`o:`, `keyword`→`keyword:`, `legality:'commander'`→`legal:commander`; `sort` maps `name`→`order=name`, `mv`→`order=cmc`, `price`→`order=eur`.
  - `resolveDeckbuilderCards(names: string[]): Promise<{ resolved: Record<string, DeckbuilderSearchCard>; missing: string[] }>` → POST `https://api.scryfall.com/cards/collection` with `{ identifiers: [{ name }] }`, chunked at 75; keys of `resolved` use the same `normalizeNameKey` scheme as today.
  - Move (don't duplicate) `DeckbuilderSearchCard` + `DeckbuilderSearchParams` types here; map Scryfall card JSON (incl. `card_faces[0]` fallback for faces without top-level `image_uris`/`oracle_text`) to `DeckbuilderSearchCard` exactly as the Worker did (compare `worker/src/` scryfall handler for field mapping).
- Consumes: `fetchRobust` from `src/shared/fetch.ts`.

- [ ] **Step 1: Write failing tests** in `tests/unit/scryfall-client.test.ts` with a mocked `fetch`: `test_autocomplete_returns_names`, `test_search_builds_scryfall_query` (asserts URL contains `id%3A` etc.), `test_search_404_returns_empty` (404 → `{ items: [], hasMore: false, totalCards: 0 }`), `test_resolve_chunks_at_75` (80 names → 2 POSTs), `test_resolve_reports_missing` (Scryfall `not_found` array → `missing`).
- [ ] **Step 2: Run** `npx vitest run tests/unit/scryfall-client.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `src/shared/scryfall-client.ts` per Interfaces.
- [ ] **Step 4: Run** the test file — expect PASS.
- [ ] **Step 5: Re-point importers** to `scryfall-client.js`; leave the old `api.ts` functions in place (deleted in Task 5).
- [ ] **Step 6: Verify** `npx tsc --noEmit && npx vite build` pass; `npx vite` + browser smoke: editor autocomplete + search + paste-import resolve work with DevTools network showing `api.scryfall.com`, no `/api/scryfall/*`.
- [ ] **Step 7: Commit** `feat: direct Scryfall browser client replaces Worker card search`

### Task 2: Editor boundary — sever non-core wiring from `editor-main.ts` (P2)

**Files:**
- Modify: `src/deckbuilder/editor-main.ts`, `deck-editor.html`
- Test: `tests/unit/deckbuilder-storage-compat.test.ts` (new)

**Interfaces:** Consumes Task 1 client. Produces an `editor-main.ts` whose import list contains no module from the removal list below.

- [ ] **Step 1: Remove imports + their call sites/UI wiring** (delete dead handlers, buttons, panels in `deck-editor.html` too) for: `collab-manager`, `collab-ui`, `collab-cursors`, `collab-drawing`, `collab-chat`, `collab-tools`, `collab-presence`, `collab-locking`, `goldfish-mp-launch`, `repo-panel`, `version-panel`, `commander-stats-widget`, `edhrec-panel`, `activation-funnel`, `premium-usage`, `rec-history-panel`, `optimization-wizard`, `matchup-strategy-widget`, `deck-solver-widget`, `cut-suggestions-widget`, `simulation-widget`, `../shared/analytics.js`, `../mtg/recommendation-history.js`, and from `../shared/api.js`: `createCommunityDeck`, `createDeckbuilderShareSnapshot`, `fetchRecommendations`, `fetchSpellbookCombos`, `syncDeckToCloud` (type `DeckbuilderSearchCard` now comes from `scryfall-client.js`).
- [ ] **Step 2: Apply the decision rule** to the remaining optional panels (`matchup-panel`, `meta-badges`, `smart-recs`, `synergy-map`, `budget-optimizer`, `budget-alternatives`, `pricing`/`price-adapter`, `deck-fingerprint`, `bracket-calc`): grep each module for `shared/api` / `apiPath` / `fetchRobust(` to Worker origins; keep fully-local ones, remove Worker-dependent ones (and their UI). Record keep/remove per module in the commit message body.
- [ ] **Step 3: Write compatibility test** `test_open_deck_with_unknown_fields`: a stored deck JSON containing extra keys (e.g. `collabSession`, `versionMeta`) loads via `getDeckById` without throwing and preserves cards.
- [ ] **Step 4: Verify** `npx vitest run tests/unit`, `npx tsc --noEmit`, `npx vite build` pass; browser smoke: create deck, add/remove card, drag/drop, undo, import paste, export, save/reopen.
- [ ] **Step 5: Commit** `refactor: trim deck editor to local core features`

### Task 3: Goldfish boundary + delete severed deckbuilder modules (P2)

**Files:**
- Modify: `src/deckbuilder/goldfish.ts` (drop imports/uses of `collab-goldfish.js`, `goldfish-coach.js`, `goldfish-coach-ui.js`, `goldfish-coach-widget.js`; type `DeckbuilderSearchCard` from `scryfall-client.js`)
- Delete: `src/deckbuilder/collab-*.ts`, `goldfish-mp*.ts`, `goldfish-coach*.ts`, `draft-sealed.ts`, `repo-panel.ts`, `repo-api.ts`, `version-panel.ts`, `version-api.ts`, plus every module removed in Task 2 that `git grep` shows has no remaining importer.

**Interfaces:** Goldfish keeps its exported `openGoldfishPlaytest` used by `editor-main.ts`; its local `GoldfishState` is unchanged.

- [ ] **Step 1: Sever** the four imports in `goldfish.ts` and delete their call sites (broadcast hooks, coach panel/widget rendering, coach prefs).
- [ ] **Step 2: Delete files** listed above after `git grep -l <module>` shows zero remaining importers each.
- [ ] **Step 3: Verify** `npx tsc --noEmit && npx vite build`; browser smoke Goldfish: open playtest, draw, play to battlefield, tap, move to graveyard, next turn, undo, reset.
- [ ] **Step 4: Commit** `refactor: manual goldfish without coach/collab; delete severed editor modules`

### Task 4: MTG analyzer boundary (P2)

**Files:**
- Modify: `src/mtg/app.ts` (remove report-share, analytics/telemetry, Worker rec-enrichment calls; keep local `recommendation-v1` static fallback), delete `src/mtg/ml-recommendation.ts`, `src/mtg/user-feedback.ts` and their wiring; keep `src/workers/` only if the local recommendation Web Workers are still imported (grep) — otherwise delete.

**Interfaces:** `mtg.html → src/mtg/main.ts → app.ts` unchanged externally; card collection fetch stays direct-Scryfall as today.

- [ ] **Step 1: Remove** Worker-backed calls/imports in `app.ts` per decision rule (grep `shared/api`, `analytics`, `report-card`, `deck-sharing` usage); keep local stats/curve/legality/archetypes; keep `public/combos.json` combo view (static file).
- [ ] **Step 2: Verify** `npx vitest run tests/unit/mtg-engine.test.ts tests/unit/recommendation-engine-v1.test.ts`, tsc, vite build; browser smoke: paste a deck on `/mtg`, stats render.
- [ ] **Step 3: Commit** `refactor: MTG analyzer runs fully local`

### Task 5: Shared layer slimming (P2)

**Files:**
- Delete: `src/shared/analytics.ts`, `auth.ts`, `commander-stats-api.ts`, `commander-stats-types.ts`, `deck-sharing.ts`, `report-card.ts`, `discord-popup.ts` — each only after `git grep -l` shows no remaining importer; otherwise remove the importer's usage first (it is a leftover from Tasks 2–4).
- Modify: `src/shared/api.ts` — delete it entirely if nothing imports it anymore; if a few local helpers survive, move them next to their consumer and then delete it.

- [ ] **Step 1: Delete/shrink** per file with grep-guard.
- [ ] **Step 2: Verify** tsc + vite build + full `npx vitest run tests/unit` (worker-* tests may now fail — they are deleted in Task 8; skip them via the run list, don't edit them).
- [ ] **Step 3: Commit** `refactor: remove backend API layer from shared code`

### Task 6: Rust archive + bots/ML/training/simulator removal (P3)

**Files:**
- Create: `legacy/first-rust-engine/` ← move `packages/rust-core/src/*.rs`, `Cargo.toml`, `Cargo.lock`, `package.json`, `package-lock.json`, `README.md`; add `legacy/README.md` + `legacy/first-rust-engine/README.md` (2–4 sentences: experimental N-API port, Feb 2026, incomplete, never a production dependency — see `docs/cleanup/rust-retirement-audit.md`).
- Delete: rest of `packages/rust-core/` (incl. `target/**`, `index.js`, `index.d.ts`, `*.node`, `build_log.txt`, the four empty stray files), `packages/bot-core/`, `packages/bot-ml/`, `src/play-vs-bot/`, `src/rules-engine/`, `src/train-bot.ts`, `src/train-bot-ui.ts`, `play-vs-bot.html`, `train-bot.html`, `rules-engine.html`, `data/`, `scripts/tests/`, `scripts/benchmarks/benchmark-cloning.js`, `docs/RUST_PORT_PLAN.md` → move to `legacy/`.

- [ ] **Step 1: Archive** authored Rust files into `legacy/first-rust-engine/` (git mv), write the two READMEs.
- [ ] **Step 2: Delete** the listed paths.
- [ ] **Step 3: Grep-guard** `git grep -l "bot-ml\|bot-core\|rust-core\|rust-bridge\|play-vs-bot\|rules-engine\|train-bot" -- src packages tests scripts *.html vite.config.ts tsconfig.json package.json` → only hits in `docs/` and `legacy/` allowed; fix any source hit.
- [ ] **Step 4: Verify** tsc + vite build.
- [ ] **Step 5: Commit** `chore: retire bot/ML/Rust experiments and rules simulator (Rust source archived in legacy/)`

### Task 7: Alt-stacks, Worker backend, social surfaces (P4)

**Files:**
- Delete: `apps/` (web + api), `packages/db/`, `worker/` (entire, incl. `.wrangler`), `src/dashboard/`, `src/community/`, `src/deckhub/`, `community.html`, `deckhub.html`, `dashboard-hub.html`, `executive-dashboard.html`, `growth-dashboard.html`, `technical-dashboard.html`, `community-dashboard.html`, `public-dashboard.html`, `decks-public.html`, `deck-public.html`, `public/deckhub-sw.js`, `infra/docker-compose.yml`, `build_output*.txt`, `scripts/deploy/deploy-api-to-cloudflare.sh`, `scripts/deploy/deploy-to-cloudflare.sh`, `scripts/seed-all-commanders.js`.
- Conditional delete after grep shows zero importers from `src/`: `packages/game-engine/`, `packages/card-data/`.

- [ ] **Step 1: Grep-check** `git grep -l "game-engine\|card-data" -- src *.html` → expect zero after Tasks 3–6; then delete both packages. If a hit remains, it is a leftover to remove first (type-only imports get local type copies only if genuinely still used).
- [ ] **Step 2: Delete** all listed paths.
- [ ] **Step 3: Verify** tsc + vite build.
- [ ] **Step 4: Commit** `chore: remove alternative stacks, Worker backend, dashboards and social surfaces`

### Task 8: Configuration, routing, tests, docs (P5)

**Files:**
- Modify: `vite.config.ts` (inputs: index, mtg, yugioh, decks, deckEditor only; SPA rewrites: keep only `/decks/id/*`; drop deck-proxy env block if Worker-only), `package.json` (remove `train:*`/`eval:cli` scripts; drop deps `@tensorflow/*`, `wrangler` root dep if only used for deleted deploys — keep whatever `infra/wrangler-frontend.toml` deploy still needs), `pnpm-workspace.yaml` (remove `apps/*`; remove `packages/*` if `packages/` is now empty), `tsconfig.json` (drop dead path aliases), `infra/_redirects` + `infra/frontend-worker.ts` + `infra/wrangler-frontend.toml` (routes only for index/mtg/yugioh/decks/deck-editor; keep Assets serving), `index.html` (+ `src/landing` if that's its source): remove links to deleted pages, `public/sitemap.xml` (core URLs only).
- Delete tests: `tests/unit/worker-*.test.ts`, `tests/unit/analytics-client.test.ts`, `tests/unit/recommendation-history.test.ts`, `tests/perf/dd403-worker-load.test.ts`, plus any test of a deleted module (run suite, delete only tests whose subject was removed by spec — never weaken a core test to make it pass).

- [ ] **Step 1: Apply** config edits.
- [ ] **Step 2: Run** `npx vitest run` (full) — expect PASS with only core suites remaining.
- [ ] **Step 3: Run** `pnpm install` (lockfile refresh after dep removal), then `npx tsc --noEmit && npx vite build`.
- [ ] **Step 4: Dev-server check:** `/decks/id/test`, `/mtg`, `/yugioh`, `/decks` all resolve (Review Focus 5, dev half).
- [ ] **Step 5: Commit** `chore: reduce build config, routes, deps and tests to core product`

### Task 9: Full validation sweep (P6)

- [ ] **Step 1: Grep invariants** (all must be empty outside `docs/`, `legacy/`): `git grep -il "collab\|multiplayer\|goldfish-mp\|coach\|deckhub\|dashboard\|community\|repo-api\|api/scryfall\|API_ORIGIN\|trackAnalyticsEvent" -- src *.html`
- [ ] **Step 2: Build + tests:** `pnpm install && npx tsc --noEmit && npx vite build && npx vitest run`.
- [ ] **Step 3: Browser smoke (all four surfaces):** deck create/save/reopen; search + autocomplete + import/export; Goldfish draw/play/tap/turn/undo/reset; `/mtg` analyze pasted deck; `/yugioh` card lookup + parse + YDKE export. Confirm zero network calls to `decklens-api`/`/api/*` in DevTools.
- [ ] **Step 4: File count:** `git ls-files | wc -l` — expect roughly 300–450 (spec estimate); large deviation → investigate before commit.
- [ ] **Step 5: Commit** any fixes; then final `chore: core extraction validation` commit if changes were made.

### Task 10: Deploy + Cloudflare backup/teardown (P7 — owner-gated)

**Order is fixed: deploy → backup → confirm → retire.** Nothing remote is deleted before its backup exists and the owner confirmed that specific resource in chat.

- [ ] **Step 1: Deploy** slim site: `npx vite build`, then `npx wrangler deploy --config infra/wrangler-frontend.toml` (existing `decklens` Assets Worker). Verify live `/`, `/mtg`, `/yugioh`, `/decks`, `/decks/id/*` (Review Focus 5, prod half) and that card search hits Scryfall directly.
- [ ] **Step 2: Backups** into `backups/` (git-ignored) + copy offered to owner: D1 `decklens-community` via `npx wrangler d1 export decklens-community --remote --output backups/decklens-community.sql`; KV namespaces `COMMUNITY_KV`, `CACHE_KV` key dumps; note Analytics Engine datasets are not exportable via wrangler — record that limitation.
- [ ] **Step 3: Per-resource owner confirmation, then retire:** Worker `decklens-api` deployment/routes; D1 database; both KV namespaces; Durable Object namespaces (CollabSession already has a delete migration; GameSession per audit drain guidance — since multiplayer is removed and site no longer references it, confirm no active sessions, then delete); Sunday cron trigger.
- [ ] **Step 4: Report** final state: live URL, what was retired, where backups live.
