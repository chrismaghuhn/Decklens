# DeckLens Production Architecture Audit

Audit date: 2026-09-24  
Repository: `https://github.com/chrismaghuhn/Decklens`  
Evidence boundary: checked-out repository at `ebc198a7a283fd62bc3b30d08fb632a365787ab1`; no Cloudflare, Vercel, DNS, database, or live service was contacted. This report describes repository intent and configuration, not verified live deployment state.

## 1. Executive summary

The strongest repository evidence points to a multi-page Root Vite frontend built from root HTML files and `src/`, with internal packages (especially `packages/game-engine`) and a Cloudflare Worker backend from `worker/`. The root project explicitly builds those HTML entrypoints; frontends hard-code `https://decklens-api.chrisgarkisch.workers.dev`; `worker/wrangler.toml` names `decklens-api` and binds D1, KV, Analytics Engine and Durable Objects. Root/Worker code also received changes through 2026-05-01.

This is **strong production evidence, not confirmation of what is currently serving users**. The repository carries contradictory frontend deployment contracts: the Vite `_redirects` is under `infra/`, the deploy scripts target generic or stale names/output folders, `infra/wrangler-frontend.toml` configures a Workers Assets deployment named `decklens`, and HTML links identify `decklens.pages.dev`. `worker/README.md` instead mentions `decklens.chrisgarkisch.workers.dev` and `decklens.app`. Actual Cloudflare account state, Pages project state, domains, and deploy automation are outside this repository evidence.

`apps/web` (Next.js) and `apps/api` (NestJS/Vercel) are real candidate applications, not safe-to-delete dead code. `apps/web` has Next routes and a Cloudflare OpenNext config but sparse historic activity and mock data; `apps/api` has a Vercel route config but only the initial commit and a mock DB implementation. The repository does not show root frontend clients using the Nest API. Treat both as migration/alternative architecture candidates pending deployment/account evidence.

**Likely architecture from source:** Root Vite browser app → Cloudflare `decklens-api` Worker → D1/KV/Analytics Engine/DOs; game logic and bot/rules packages are bundled into browser pages, while the Worker imports selected recommendation/report modules. **Unknown:** which frontend origin currently serves, whether all declared bindings exist in production, and whether this precise checked-out commit is live.

## 2. Repository identity

| Field | Value |
|---|---|
| Remote | `https://github.com/chrismaghuhn/Decklens.git` |
| Branch | `main` |
| BASE_HEAD | `ebc198a7a283fd62bc3b30d08fb632a365787ab1` |
| Initial status | clean (no `git status --short` entries) |
| Latest commit | `ebc198a`, 2026-05-01, `security: Fix XSS in Deck Hub HTML injection paths and tighten Worker CORS` |
| Previous history | 2026-02-20 game-engine and multiplayer work; initial commit 2026-02-13 |

No repository `AGENTS.md` was found. No GitHub Actions deployment workflow was found in the checkout. Audit adds only this report; `FINAL_HEAD` is therefore expected to remain the same (Git HEAD is not advanced by an uncommitted file).

## 3. Candidate systems

| Candidate | What is present | Classification | Evidence and limits |
|---|---|---|---|
| Root Vite multi-page frontend | Root `*.html`, `src/`, root `vite.config.ts`, root `package.json` | **STRONG_PRODUCTION_EVIDENCE** | Explicit Vite inputs, production URL references, root app changes through May 1, Pages/Worker route artifacts. Live host and deployed revision unverified. |
| `worker/` Cloudflare API | Worker router, `wrangler.toml`, D1/KV/Analytics/DO bindings, frontend API URLs | **STRONG_PRODUCTION_EVIDENCE** | `decklens-api` matches the hard-coded API host; client and worker implement many matching features; Worker changed May 1. Production binding availability unverified. |
| `packages/game-engine` | Rules engine, tests, workspace package | **STRONG_PRODUCTION_EVIDENCE** | Root Vite aliases `@mtg/game-engine`; `rules-engine.html` / play entry and game source; commits through Feb 20. |
| `packages/bot-core`, `packages/bot-ml`, `packages/card-data`, `packages/rust-core`, `packages/rules-engine` | Bot/training, card data, Rust and rules packages | **POSSIBLE_PRODUCTION** | In workspace and some aliased/imported by root build/training scripts, but individual shipped/runtime role varies. No inference of inactivity from age. |
| `apps/web` Next.js | App Router pages `/`, `/deck/[id]`, `/collection`, `/scanner`; Cloudflare OpenNext build script/config | **MIGRATION_OR_EXPERIMENT** | Real implementation and deploy-capable config. Only commits Feb 13 and Feb 16; mock data is present; no evidence in this repository that it is the frontend linked by root app. Could still be separately deployed. |
| `apps/api` NestJS | Cards, decks, collection, scan and Scryfall modules; `vercel.json` | **MIGRATION_OR_EXPERIMENT** | Deploy-capable Vercel config. Only initial commit Feb 13; its DB provider explicitly returns in-memory mock data and says PostgreSQL is future work; no observed root frontend clients. Could still have external deployment. |
| `packages/db` + `infra/docker-compose.yml` | PostgreSQL Drizzle schema/config; Postgres + Redis + Adminer compose | **POSSIBLE_PRODUCTION** for migration/dev; **UNKNOWN** operational usage | Nest API references workspace DB package; compose and PostgreSQL config exist, but API's injected DB is a mock. No production connection state is represented here. |
| `scripts/deploy/*` | Three Cloudflare shell scripts | **LIKELY_INACTIVE** as current deployment mechanism | Scripts contain placeholder project/repository/output names, mismatch current build paths, and no deployment-history evidence. Preserve until external pipeline/account evidence is checked. |
| `data/trained-model`, `data/training-logs`, `scripts/train*` | Bot model assets and training data/scripts | **POSSIBLE_PRODUCTION** | Root scripts invoke training/evaluation; some model files may be runtime inputs. The audit did not trace every model load. Never classify as disposable solely by location. |

## 4. Production frontend evidence

### A. Root Vite frontend

`package.json` defines `dev: vite`, `build: tsc && vite build`, and `preview: vite preview`. `vite.config.ts` sets `root: '.'`, `publicDir: 'public'`, `base: '/'`, `outDir: 'dist'`, and an explicit multi-page Rollup input. Its aliases link root code to `packages/game-engine`, `bot-core`, `bot-ml`, `card-data`, and `src/mtg`.

Current Vite HTML build entrypoints (16):

1. `index.html`
2. `mtg.html`
3. `yugioh.html`
4. `community.html`
5. `decks.html`
6. `deck-editor.html`
7. `decks-public.html`
8. `deck-public.html`
9. `dashboard-hub.html`
10. `executive-dashboard.html`
11. `growth-dashboard.html`
12. `technical-dashboard.html`
13. `community-dashboard.html`
14. `public-dashboard.html`
15. `deckhub.html`
16. `rules-engine.html`

Correction: the list is **16 entrypoints**; the numbering above includes entries 1–16. `play-vs-bot.html` and `train-bot.html` exist in the root but are explicitly commented out as WIP in Vite input. (The source list otherwise contains 15 names before `rulesEngine`; including `rulesEngine` makes 16.)

Additional production clues: root HTML and TypeScript include direct references to `decklens-api.chrisgarkisch.workers.dev`; `dashboard-hub.html` hard-codes `decklens.pages.dev/mtg`, `/community`, and `/yugioh`; `infra/frontend-worker.ts` serves `dist` with SPA rewrites. `src/` and Worker code were both modified by the last security commit. Root `vite.config.ts`, `src`, and `worker` were created in the Feb 16 project-structure commit; root app development continued through Feb 18 and Worker/game work through Feb 20, then May 1 security changes touched `src/deckhub` and `worker`.

### B. `apps/web` Next.js frontend

This is a substantive Next 14 App Router system with pages for home, collection, deck ID, and scanner, components/hooks/deck logic, plus local tests. `apps/web/package.json` defines Next dev/build and `build:cloudflare` as Next plus OpenNext. `apps/web/wrangler.toml` names `decklens-frontend` and sets `pages_build_output_dir = ".open-next"`; the name/comment does not prove that a Pages project exists or is deployed. `next.config.mjs` selects standalone output. `apps/web/README.md` describes it as the deckbuilder frontend.

Counterevidence to it being the linked primary frontend: its only history is the initial commit and Feb 16 structure commit; it has mock data; root HTML links do not point into it; the checked-in root build does not invoke it. Those observations support a migration/alternative classification, not deletion. Check Cloudflare Pages/Workers and Git deployment history before deciding.

### Routing/deployment disagreement

`infra/_redirects` is not in `public/`, root, or an evident configured Pages output location, and no repository build step copies it. If deployed at its current path unchanged, Cloudflare Pages will not necessarily consume it. `infra/frontend-worker.ts` implements a separate set of rewrites and `infra/wrangler-frontend.toml` points assets at `../dist`, so a Workers Assets deployment could use that routing; no current deploy command does so. `public/_headers` exists, but `_redirects` is specifically under `infra/`.

The Vite dev rewrite plugin maps `/decks/id/*`, `/decks/public`, `/d/*`, dashboard pages, `/deckhub`, and `/simulator`. It explicitly leaves `/play` disabled. Meanwhile `infra/_redirects` and `infra/frontend-worker.ts` enable `/play` and `/train-bot` to HTML files that Vite does not include as build entrypoints; neither file is copied from `public/`. The rewrite rules also disagree for deck routes: dev handles `/decks/id/*`; `_redirects` maps `/decks/*`; Worker maps `/decks/*`. The mapping for a generic `/decks/*` route targets editor, while `/decks` itself is the deck-list page.

## 5. Production backend evidence

### A. Cloudflare `worker/`

`worker/wrangler.toml` configures:

- Worker name: `decklens-api`; entry `src/index.ts`; `workers_dev = true`.
- `FRONTEND_URL = https://decklens.pages.dev` and `ENVIRONMENT = production` vars.
- KV bindings `COMMUNITY_KV`, ID `1901193fd2da44eabb8d7fdf978df522`; `CACHE_KV`, ID `03372b77c83e40ca8f063768920d2981`.
- D1 `COMMUNITY_DB`, database name `decklens-community`, ID `de7be9e3-f841-40e0-8956-b0543454ac26`.
- Analytics Engine binding `ANALYTICS`, dataset `decklens_events`.
- Durable Objects `CollabSession` and `GameSession`; SQLite migrations `v1` and `v2`.
- Cron trigger `0 2 * * SUN` (Sunday 02:00 UTC) for commander-stat refresh per config comment.
- OAuth credentials are named as Wrangler secrets in comments; secret values are not present in this report.

`worker/src/index.ts` implements analytics, community/deck sharing, Scryfall and Spellbook/combo functions, recommendations/reports, authentication, deck collaboration and repo-like deck Git API routes; DOs handle collaboration and multiplayer WebSockets. Worker README gives manual `cd worker && wrangler deploy`, but contains older `decklens.app` / `decklens.chrisgarkisch.workers.dev` examples which conflict with the bound API hostname and frontend config.

The exact endpoint `https://decklens-api.chrisgarkisch.workers.dev` occurs in **46 tracked non-lock, non-log files** (including docs, static pages, scripts, and source). It occurs in **35 runtime source/HTML files** when counting `.ts` source under `src/` and `.html` files at root; several have multiple occurrences. Source-level dependent features include analytics/dashboard, community submission and feed, authentication, public/shared decks and reports, recommendations/commander stats, combo lookup/templates/sync, deck versioning/branches/repository API, collaboration threads/branches/collection/proposals/tasks/etc., draft/sealed, combo lines, share packs, and multiplayer game sessions. This is evidence of intended coupling, not proof each endpoint is currently deployed or used.

`worker/src/index.ts` imports modules from `src/mtg` and `src/shared`, so this service depends on repository root source at build time. Other root modules call direct third-party services such as Scryfall, Moxfield, Archidekt, EDHREC/Spellbook, and YGOProDeck; Worker proxies/cache some of these.

### B. `apps/api` NestJS/Vercel

`apps/api/vercel.json` routes every path to `src/main.ts` through `@vercel/node`; Nest listens on port 3002. Modules cover cards, decks, collection, scanner/OCR, Scryfall, and seed. Package dependencies include workspace `@mtg/db`, Drizzle/Postgres and Nest. But `apps/api/src/db/db.module.ts` always returns a hand-written in-memory `MockDatabase`, even when `DATABASE_URL` exists. No frontend references to this Vercel API were found in the root Vite clients. Git history reports only commit `9d829bb` on 2026-02-13. This makes it a credible early API/migration candidate, not conclusively un-deployed.

### API endpoint cross-check

The root client defaults to the Workers URL in `src/shared/api.ts`, `src/shared/auth.ts`, collaboration clients, and related modules. In localhost mode, several clients use relative URLs or `http://localhost:8787`, consistent with local Wrangler Worker development rather than the Nest app's port 3002. `worker/README.md` documents Worker routes; no comparable connection evidence ties root routes to Nest.

## 6. Production dependency graph

```text
Browser
  ├─ Root Vite multi-page build (16 HTML entrypoints)
  │    ├─ root HTML → src/ feature modules
  │    ├─ src/mtg, src/deckbuilder, src/community, src/deckhub,
  │    │  src/ygo, src/dashboard, src/rules-engine
  │    ├─ packages/game-engine + bot-core + bot-ml + card-data
  │    └─ some training/native use → packages/rust-core and data/trained-model
  │
  │  API calls → https://decklens-api.chrisgarkisch.workers.dev
  │                  └─ worker/src/index.ts
  │                      ├─ COMMUNITY_DB (Cloudflare D1)
  │                      ├─ COMMUNITY_KV + CACHE_KV
  │                      ├─ Analytics Engine: decklens_events
  │                      ├─ CollabSession Durable Object (WebSocket)
  │                      ├─ GameSession Durable Object (WebSocket)
  │                      └─ third-party APIs: Scryfall, Moxfield, Archidekt,
  │                         EDHREC/Spellbook and optional configured webhooks
  └─ Alternative frontend candidate: apps/web Next.js
       └─ mock data / internal deck logic; API/runtime relationship unknown

Alternative backend candidate:
  apps/web? → apps/api NestJS/Vercel → packages/db / PostgreSQL (configured schema)
                                         └─ current Nest provider is in-memory mock
  infra/docker-compose.yml provides local Postgres + Redis + Adminer only
```

Solid edges are those visible in import/client/config evidence. Production origins and actual hosted resource connectivity remain unverified.

## 7. Deployment architecture inventory

| Deployment | Config file | Source → output | Target / URL | Currentness / confidence |
|---|---|---|---|---|
| Root frontend, Vite build | `package.json`, `vite.config.ts` | root HTML + `src/` + packages → `dist/` | No authoritative target in active build config; HTML links name `https://decklens.pages.dev` | **CURRENT_CONFIG** for build; **STRONG_PRODUCTION_EVIDENCE**, hosted target unconfirmed. |
| Cloudflare Workers Assets frontend | `infra/wrangler-frontend.toml`, `infra/frontend-worker.ts` | `infra/frontend-worker.ts` + `../dist` assets | Worker name `decklens`; inferred workers.dev host would be account-scoped; no URL configured here | **CURRENT_CONFIG** exists but no checked-in deploy command. Target state unknown. |
| Cloudflare Pages rewrites/headers | `infra/_redirects`, `public/_headers` | Intended static output directives; build does not copy `infra/_redirects` | Pages target unclear; hard links use `decklens.pages.dev` | `_redirects` location/config suggests intended mechanism but not wired; **UNKNOWN/POSSIBLY STALE CONFIG**. |
| Cloudflare API Worker | `worker/wrangler.toml` | `worker/src/index.ts` (imports root `src/`) → Wrangler bundle | `decklens-api`; hard-coded URL `decklens-api.chrisgarkisch.workers.dev` | **CURRENT_CONFIG**, strong evidence; do not infer live deploy. |
| Next/OpenNext frontend | `apps/web/package.json`, `apps/web/wrangler.toml`, `apps/web/next.config.mjs` | `apps/web` → `.open-next` via `build:cloudflare` | Name `decklens-frontend`; no verified URL | **CURRENT_CONFIG** for candidate build, deployment unknown; migration/alternative evidence. |
| NestJS API on Vercel | `apps/api/vercel.json`, `apps/api/package.json` | `apps/api/src/main.ts` → Vercel Node function | Vercel project/domain not identified | **CURRENT_CONFIG** for Vercel routing, current production unknown. |
| Docker local services | `infra/docker-compose.yml` | PostgreSQL 16, Redis 7, Adminer | Local ports 5432, 6379, 8080 | Local development/infrastructure config; no production evidence. |
| Generic Pages script | `scripts/deploy/deploy-to-cloudflare.sh` | Says `npm run build` but uploads `public` | placeholder `mtg-deckbuilder`, placeholder URL/repository | **STALE_DEPLOY_SCRIPT**; does not match Vite `dist` or repository identity. |
| Frontend Pages script | `scripts/deploy/deploy-frontend-to-cloudflare.sh` | says `npm install && npm run build`, uploads `build` | `decklens-frontend`, `decklens.chrisgarkisch.workers.dev` | **STALE_DEPLOY_SCRIPT** relative to Vite `dist`; also target type/name disagrees with current configs. |
| API Worker script | `scripts/deploy/deploy-api-to-cloudflare.sh` | `packages/api/worker.js` | `decklens-api` | **STALE_DEPLOY_SCRIPT**: source path absent (`worker/src/index.ts` is configured source); uses old custom-domain invocation. |
| GitHub Actions | `.github/workflows` | None found | None | No repository workflow deployment evidence. |

## 8. Route-to-source map

“Build included” refers to the current Vite production input, not to proof a host serves it. `/mtg`, `/yugioh`, and `/community` do not have explicit entries in `infra/_redirects`; extensionless mapping may depend on hosting behavior/config not established here.

| URL | Target page/source | In Vite build? | Routing evidence / confidence |
|---|---|---:|---|
| `/` | `index.html` → `src/shared/discord-popup.ts` and inline app links | Yes | Direct root static entry. Strong source evidence. |
| `/mtg` | Intended `mtg.html` → `src/mtg/main.ts` | Yes | Hard-coded `decklens.pages.dev/mtg` links; no matching redirect rule. Target behavior/active route **UNKNOWN**. |
| `/yugioh` | Intended `yugioh.html` → `src/ygo/main.ts` | Yes | Hard-coded links; no matching redirect rule. Route behavior **UNKNOWN**. |
| `/community` | Intended `community.html` → `src/community/main.ts` | Yes | Root HTML/build exists; no matching redirect rule. Route behavior **UNKNOWN**. |
| `/decks` | `decks.html` → `src/deckbuilder/decks-main.ts` | Yes | `_redirects` redirects `/decks.html` to `/decks`; Vite dev rewrite does not map `/decks`; extensionless host fallback unknown. |
| `/decks/public` | `decks-public.html` | Yes | Explicit Vite dev, `_redirects`, Worker rewrite. Strong intended route. |
| `/decks/*` | `deck-editor.html` → `src/deckbuilder/editor-main.ts` | Yes | `_redirects` and Worker handle; Vite dev only handles `/decks/id/*`. Route contract disagrees. |
| `/decks/id/*` | `deck-editor.html` | Yes | Vite dev only; covered as `/decks/*` by other rewrite configs. |
| `/d/*` | `deck-public.html` | Yes | Explicit in Vite dev, `_redirects`, Worker. Strong intended route. |
| `/deckhub` and `/deckhub/*` | `deckhub.html` → `src/deckhub/deckhub-main.ts` | Yes | Explicit in all three route implementations. Strong intended route. |
| `/dashboard` | `dashboard-hub.html` | Yes | Explicit in Vite dev, `_redirects`, Worker. |
| `/dashboard/executive` | `executive-dashboard.html` | Yes | Explicit in all configs. |
| `/dashboard/growth` | `growth-dashboard.html` | Yes | Explicit in all configs. |
| `/dashboard/technical` | `technical-dashboard.html` | Yes | Explicit in all configs. |
| `/dashboard/community` | `community-dashboard.html` | Yes | Explicit in all configs. |
| `/dashboard/public` | `public-dashboard.html` | Yes | Explicit in all configs. |
| `/dashboard/*` other | `dashboard-hub.html` | Yes | Explicit fallback in `_redirects` and Worker; Vite handles path only when matching one of explicit cases. |
| `/simulator` and `/simulator/*` | `rules-engine.html` → `src/rules-engine/main.ts` | Yes | Explicit in Vite dev, `_redirects`, Worker. |
| `/play` and `/play/*` | `play-vs-bot.html` → `src/play-vs-bot/*` | **No** | `_redirects` and Worker route it, Vite dev explicitly comments it disabled, Vite input omits target. Likely 404 from current `dist`; runtime path not confirmed. |
| `/train-bot` | `train-bot.html` → `src/train-bot-ui.ts` | **No** | `_redirects` and Worker route it, Vite input omits file. Likely 404 from current `dist`; runtime path not confirmed. |
| `/deck/[id]`, `/collection`, `/scanner` (Next) | `apps/web/src/app/...` | Not in Vite | Next app routes exist; active deployment/host unknown. |

## 9. Git-history evidence

The repository contains 58 commits on `main`. Dates below are commit dates in Git, not deployment dates.

| Path | First relevant commit | Last relevant commit | Recent activity / notable evidence |
|---|---|---|---|
| `vite.config.ts` | `5bd2857` — 2026-02-16, “Update DeckLens: Complete project structure with bot packages and infrastructure” | `bb68bc4` — 2026-02-18, “feat: Complete Rules Engine (Phase 1-6), Deckbuilder enhancements, Commander Stats & DeckHub redesign” | Explicit Vite build/route setup; no later direct config commit. |
| `src/` | `5bd2857` — 2026-02-16 | `ebc198a` — 2026-05-01 security fix | Major app work Feb 18–20; last commit changes `src/deckhub/deckhub-main.ts`. |
| `worker/` | `5bd2857` — 2026-02-16 | `ebc198a` — 2026-05-01 security fix | Multiplayer/GameSession and Worker CORS/security activity Feb 20 and May 1. |
| `apps/web/` | `9d829bb` — 2026-02-13 initial commit | `5bd2857` — 2026-02-16 project structure | Only two commit appearances; history alone does not establish whether separately deployed. |
| `apps/api/` | `9d829bb` — 2026-02-13 initial commit | `9d829bb` — 2026-02-13 initial commit | No later path commits found. This is inactivity evidence, not proof of non-production. |
| `packages/game-engine/` | `9d829bb` — 2026-02-13 initial commit | `64f85f5` — 2026-02-20, “feat: add pendingTriggerOrder with ordering UI for simultaneous ETB triggers” | Active engine evolution, explicit root Vite alias, tests. |
| `deck-editor.html` | `5fd5237` — 2026-02-13, “Add HTML entry points” | `bb68bc4` — 2026-02-18 | Root editor page continued alongside rules/deckbuilder work. |
| `deckhub.html` | `5fd5237` — 2026-02-13 | `bb68bc4` — 2026-02-18 | Its source module `src/deckhub/deckhub-main.ts` was touched May 1; the HTML shell was not. |
| `infra/` | `5bd2857` — 2026-02-16 | `bb68bc4` — 2026-02-18 | Current checked-in frontend worker and routing config predate latest Worker security change. |
| `scripts/deploy/` | `5bd2857` — 2026-02-16 | `5bd2857` — 2026-02-16 | No later deployment script updates. |

Interpretation: Root Vite + Worker is the most recently maintained coherent code path. It is not sufficient to assert runtime production without hosting or CI metadata.

## 10. Infrastructure and data risk

The following IDs/names represent stateful production-like identities in checked-in config. Treat them as immutable until Cloudflare inventory, backups, and intended migrations are verified:

- Worker `decklens-api` and its hard-coded public URL.
- Worker `decklens` in `infra/wrangler-frontend.toml`, plus expected `dist` asset binding.
- D1 `decklens-community`, database ID `de7be9e3-f841-40e0-8956-b0543454ac26`.
- KV `COMMUNITY_KV` namespace `1901193fd2da44eabb8d7fdf978df522`.
- KV `CACHE_KV` namespace `03372b77c83e40ca8f063768920d2981`.
- Analytics Engine dataset `decklens_events`.
- Durable Object classes `CollabSession`, `GameSession` and migrations `v1`, `v2`. `infra/wrangler-frontend.toml` separately lists deletion of `CollabSession` in migration `v1-migration-cleanup`; do not apply it without determining which Worker and namespace it targets and verifying the deployed class state.
- Cron `0 2 * * SUN` in the API Worker config.
- OAuth secret names: GitHub/Google client IDs and secrets, plus optional analytics/alert webhook values. Secret values are not exposed here.
- Any Cloudflare Pages/Workers custom domains and Vercel project/environment configuration: identities are not discoverable from this checkout.

## 11. Likely migration/legacy components (do not delete)

| Candidate | Why it may be an earlier/alternate path | Evidence needed before any deletion |
|---|---|---|
| `apps/web/` Next.js | Sparse history, mock data, root Vite is more recently modified; separate OpenNext config. | Cloudflare account Pages/Workers inventory, DNS/domain bindings, deployment history/logs, usage/analytics, independent owner confirmation, and route/data parity review. |
| `apps/api/` NestJS + Vercel | Only initial commit, Vercel config but no observed root clients, mock DB is active provider. | Vercel project list/deployment logs/domains/env vars, external consumers, logs/metrics and confirmation no integrations depend on it. |
| `packages/db/`, Postgres/Redis Compose | DB schema/Drizzle/compose candidate stack but current Nest provider is mock; D1 Worker is stronger evidence for community runtime. | Search all deployment repositories/accounts, database backups/ownership, production connection strings without revealing them, external consumers, and confirmed data migration/retention. |
| `scripts/deploy/*` | Placeholder repo/project/output names and stale paths. | Confirm no human release procedure or copied deployment runbook still relies on scripts; check shell history/team practice and platform logs. |
| `infra/_redirects` vs Worker routes | Redundant and conflicting route definitions; `_redirects` not wired to current output by visible build. | Determine deployed frontend platform and inspect deployed asset manifest/route tests and current dashboard configuration. |
| `play-vs-bot.html`, `train-bot.html` build omission | Routes exist in some configs but build inputs omit targets; Vite says play WIP. | Product owner intent, deployed asset checks, current usage and independent page assets/runtime verification. |
| Root build logs, `.output.txt`, `.idea/`, `worker/.wrangler/` | Potential generated/editor/cache artifacts. | Verify tracked status, whether logs contain unique evidence and any workflow references; do not use “looks generated” as deletion proof. |
| `package-lock.json` alongside `pnpm-lock.yaml` | Multiple lockfiles create package manager ambiguity. | Determine actual clean-install/release process and app-local lockfile usage; verify CI and developer setup. |
| `data/training-logs`, `data/trained-model`, Rust build artifacts | Training input/output or generated state may be operationally needed. | Trace runtime loading, reproduce training/model generation, check deployed artifact dependencies and preserve reproducible provenance. |

## 12. Unknowns

1. Which Cloudflare account currently owns `decklens-api`, `decklens`, `decklens-frontend`, or `decklens.pages.dev` resources, and which commit is deployed.
2. Whether Cloudflare Pages project `decklens` exists and consumes `infra/_redirects`, or whether `infra/frontend-worker.ts` is the actual frontend route handler.
3. Whether `decklens.pages.dev`, `decklens.chrisgarkisch.workers.dev`, `decklens.app`, and any custom domains resolve to active current services. No network calls were made to them.
4. Whether Vercel has an `apps/api` project or any separate app deployment.
5. Whether production D1/KV/Analytics/DO resources match checked-in IDs/bindings and whether either DO migration history was applied.
6. Whether externally deployed code or users depend on Next/Nest, PostgreSQL/Redis, root pages excluded from Vite, or local scripts.
7. Whether public route mappings (`/mtg`, `/yugioh`, `/community`) rely on hosting-specific extension fallback.
8. Whether the current source compiles/deploys reproducibly. No build/tests were run because this was an evidence-only audit and the request prohibited architecture changes; tests were not requested.

## 13. PROD_DO_NOT_TOUCH

Until external state is verified, do not delete, rename, recreate, reset, migrate, or repoint:

- `worker/` API code or Worker name `decklens-api`.
- Root Vite application, root HTML entrypoints, `src/`, or packages imported by these applications.
- `worker/wrangler.toml`, D1 database identity, KV namespace identities, Analytics dataset, Durable Object class/migration history, cron triggers, OAuth or webhook secret configuration.
- `infra/wrangler-frontend.toml`, `infra/frontend-worker.ts`, Pages/Workers target names and custom domains.
- Next.js/NestJS candidates or Vercel config until their live deployment status is checked.
- Database, model, training data, or package lock files before usage and recovery requirements are known.

This is a repository-evidence hold list, not a claim that each item is active production.

## 14. Recommended next investigation

1. Read-only platform inventory with the owner: Cloudflare Pages projects, Workers, custom domains/routes, D1/KV/Analytics/DO bindings and migration status; Vercel projects and deployments. Do not run deploy, migration, delete, or recreation commands.
2. Compare deployed asset manifests and Worker script metadata with the commit SHAs/build outputs; identify actual host for the frontend.
3. Confirm browser route behavior for `/`, `/mtg`, `/yugioh`, `/community`, `/decks/*`, `/play`, `/train-bot`, `/simulator` from platform config or a staging copy. Do not probe production unless separately authorized.
4. Trace configuration values and secret *names* without printing secret values. Confirm D1 backup/restore and Durable Object migration history before any cleanup plan.
5. Then establish a signed-off production contract and only afterward plan reproducible local build and cleanup boundaries.

## 15. Proposed cleanup boundary

For the next step, treat Root Vite + `src/` + imported packages + `worker/` + `infra/` as **protected production candidates**. Treat `apps/web`, `apps/api`, `packages/db`, deployment scripts, conflicting route manifests, logs/caches, and extra lockfiles as **investigation-only candidates**. No candidate in this list is approved for deletion. Boundary can be narrowed only after platform and consumer evidence resolves the unknowns above.

## Required summary values

```text
PRODUCTION_FRONTEND = Root Vite multi-page application (STRONG_PRODUCTION_EVIDENCE); actual serving host UNKNOWN
PRODUCTION_BACKEND = worker/ Cloudflare Worker named decklens-api (STRONG_PRODUCTION_EVIDENCE); live deployment UNKNOWN
PRODUCTION_STORAGE = Cloudflare D1 + KV + Analytics Engine + Durable Objects as configured in worker/wrangler.toml; active state UNKNOWN
PRODUCTION_BUILD = root `npm run build` => TypeScript check + Vite multi-page output in dist/
PRODUCTION_DEPLOYMENT = UNKNOWN; repository contains Worker Assets, Pages, OpenNext and Vercel configurations with conflicting/stale deployment clues
PRODUCTION_CONFIDENCE = STRONG repository evidence for Root Vite + Worker; no live platform confirmation

LIKELY_NON_PRODUCTION = apps/web and apps/api are migration/alternative candidates; scripts/deploy/* are likely stale; no candidate approved for deletion
UNKNOWN = live frontend host/deployed SHA, Cloudflare/Vercel project ownership/state, route activation, current D1/KV/DO use, external consumers
PROD_DO_NOT_TOUCH = decklens-api Worker; D1/KV/Analytics/DO identities and migrations; frontend Worker/Pages names/domains; root HTML/src/packages/worker; all migration candidates pending deployment evidence
```


