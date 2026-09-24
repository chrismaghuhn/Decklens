# DeckLens Live Deployment Inventory

Inventory date: 2026-09-24  
Repository: `https://github.com/chrismaghuhn/Decklens`  
Repository HEAD inspected: `ebc198a7a283fd62bc3b30d08fb632a365787ab1` (`main`)  
Related evidence: [production architecture audit](production-architecture-audit.md)

## Scope and method

Read-only authenticated Wrangler access was confirmed with `pnpm exec wrangler whoami`. The account listing and deployment/version inspection used Wrangler 4.65.0. Commands were read-only: `pages project list`, `pages deployment list`, `deployments status/list`, `versions view`, `d1 list/info`, and `kv namespace list`. No deployment, upload, route/domain update, migration, SQL/application-row query, secret read, or other platform mutation was run. Secret values were not requested or printed.

The account is the authenticated account named in Wrangler, account ID `852b795df3fe7451ad026e39044121ad`; full ID and personal email are omitted here. The `decklens.pages.dev` Pages project and the Workers tested have matching account metadata. Vercel access is not available: no Vercel CLI executable or Vercel account connector was present, so that platform remains unknown.

## 1. Cloudflare account inventory

### Workers

| Worker/service | Live metadata | Host, routes and current bindings |
|---|---|---|
| `decklens-api` | Exists. Production deployment ID `5743b698-c2bc-43b8-97d3-a7bbf3391320`, 100% to version `493786a0-f2a5-4f32-bb13-7ee145a3b219` (version 148). Deployment time `2026-05-01T17:34:36Z`; version created `2026-05-01T17:34:33Z`. Source `wrangler`, latest visible deployment. | Actual workers.dev hostname, custom domains and route patterns were not exposed by the read-only Wrangler commands used: **UNKNOWN**. Version compatibility date `2024-01-01`, usage model `standard`, migration tag `v2`; `fetch` and `scheduled` handlers exist. Bindings are detailed below. |
| `decklens` | Exists. Production deployment ID `d60c5f11-9f40-4149-9587-451f05bc084d`, 100% to version `f18ecea7-17c8-449e-9c15-8688d3e30252` (version 269). Deployment time `2026-05-01T17:36:46Z`; version created `2026-05-01T17:36:43Z`. Source `wrangler`, latest visible deployment. | Version has `fetch`, an `ASSETS` binding, compatibility date `2026-02-09`, standard usage model, and migration tag `v1-migration-cleanup`. Public hostname, routes and custom domains remain **UNKNOWN**. |
| `decklens-frontend` | No Worker with this exact name was found: Wrangler returned Cloudflare “This Worker does not exist on your account” for deployment status/list. | No direct Worker resource with this name in the inspected account. This does not rule out `apps/web` being deployed under another project/service. |

Both active Workers have production deployment traffic at 100%. The source/version metadata contains no repository commit SHA. The timestamps align with the repository's May 1 latest commit, but timestamp alignment is not proof that the deployed bits equal HEAD.

### Pages

Wrangler listed two Pages projects in the account:

| Project | Domains | Git provider | Last modified / latest deployment |
|---|---|---|---|
| `decklens` | `decklens.pages.dev` | No | Production deployment ID `ed2a637b-1344-4030-afae-310edcdfe611`, branch `main`, source commit `5bd2857`, deployment URL `https://ed2a637b.decklens.pages.dev`; Wrangler reports it as 7 months ago. |
| `marathonlens` | `marathonlens.pages.dev`, `marathonlens.app` | No | 6 months ago; appears unrelated to DeckLens and is not treated as a DeckLens candidate. |

No Pages project named `decklens-frontend` was listed. For `decklens`, the production deployment metadata shows branch/source and immutable deployment URL. Build command, output directory, source repository URL, precise deployment timestamp, and whether the primary domain `decklens.pages.dev` is still the user-facing frontend could not be retrieved by these Wrangler listing commands. The project list displayed only `decklens.pages.dev` for the DeckLens Pages project; no custom domain was shown there.

### Workers Assets frontend evidence

The active `decklens` Worker version has a live `ASSETS` binding and the same compatibility date and migration tag declared by `infra/wrangler-frontend.toml`. That repository file names the service `decklens`, serves `../dist`, and uses `infra/frontend-worker.ts`. The version reports `migration_tag: v1-migration-cleanup` and deployed headers matching the repository's frontend asset headers. This strongly ties the active Worker Assets service to the repository's frontend Worker configuration. The platform metadata does not expose the asset manifest or a build commit, so exact uploaded HTML/source and public routing remain unverified.

## 2. Frontend production identification

```text
FRONTEND_PLATFORM = Cloudflare Workers Assets and Cloudflare Pages both exist for decklens
FRONTEND_PROJECT = decklens (same name used by Pages project and Worker service)
FRONTEND_HOST = decklens.pages.dev exists for Pages; active Worker public hostname/domain UNKNOWN
LATEST_DEPLOY_TIME = 2026-05-01T17:36:46Z for Worker decklens; Pages deployment shown as 7 months old
SOURCE_REPOSITORY = UNKNOWN for active Worker; Pages project Git Provider = No
SOURCE_BRANCH = UNKNOWN for active Worker; Pages production deployment branch = main
BUILD_COMMAND = UNKNOWN from provider metadata
BUILD_OUTPUT = UNKNOWN from provider metadata; repository Worker config points at ../dist
DEPLOYED_REVISION = UNKNOWN for active Worker; Pages deployment source is 5bd2857
```

**LIVE_FRONTEND_ARCHITECTURE = ROOT_VITE** (strong live/repository match). Evidence: the active production Worker named `decklens` has an `ASSETS` binding and migration/config metadata matching `infra/wrangler-frontend.toml`; that config serves `../dist`, which is the root Vite build output. Separately, the Pages project `decklens.pages.dev` has a production deployment sourced from commit `5bd2857`, where root Vite, root HTML and `src/` were introduced. No live metadata points to an `apps/web` OpenNext artifact. The exact current public host and Worker route association are still unknown, so this identifies the deployed architecture family rather than proving which endpoint currently receives user traffic.

The Pages deployment at `5bd2857` is stale relative to later root/Worker changes. However, the Worker Assets service `decklens` received a newer production deployment on 2026-05-01, the same date as the repository's latest commit. The account therefore shows both a stale Pages frontend deployment and a later Root-Vite-configured Workers Assets deployment; do not treat the old Pages deployment as the only frontend deployment.

## 3. Backend production identification

```text
BACKEND_EXISTS = YES — Cloudflare Worker decklens-api has an active production deployment
BACKEND_HOST = UNKNOWN live; repository/default client host is decklens-api.chrisgarkisch.workers.dev
LATEST_DEPLOY_TIME = 2026-05-01T17:34:36Z (version created 17:34:33Z)
DEPLOYED_REVISION = UNKNOWN (Wrangler deployment source is shown as wrangler; no Git SHA)
ACTIVE_BINDINGS = D1, two KV, Analytics Engine, CollabSession DO, Environment/Frontend URL vars,
                   ADMIN_SECRET and Google OAuth secrets, plus both Durable Object bindings
ACTIVE_ROUTES = UNKNOWN from Wrangler inventory commands
ACTIVE_CRONS = UNKNOWN; deployed version has scheduled handler, but active cron expression was not exposed
```

The active API deployment is a real live production Worker, not just a Wrangler config. Its current version 148 has runtime migration tag `v2` and compatibility date `2024-01-01`, matching `worker/wrangler.toml`.

### Active API version bindings compared with `worker/wrangler.toml`

| Binding/config | Repository declaration | Active production version | Result |
|---|---|---|---|
| Worker name and entry | `decklens-api`, `src/index.ts` | Active Worker `decklens-api`; deployed source is Wrangler bundle | **MATCH** for service identity; deployed source SHA **UNKNOWN** |
| `COMMUNITY_DB` | D1 `decklens-community`, ID `de7be9e3-f841-40e0-8956-b0543454ac26` | Same database ID and binding name | **MATCH** |
| `COMMUNITY_KV` | ID `1901193fd2da44eabb8d7fdf978df522` | Same namespace ID/name | **MATCH** |
| `CACHE_KV` | ID `03372b77c83e40ca8f063768920d2981` | Same namespace ID/name | **MATCH** |
| `ANALYTICS` | Analytics Engine dataset `decklens_events` | Active version binds `decklens_events` | **MATCH**; dataset is confirmed referenced by the deployed Worker |
| `COLLAB_SESSION` | Class `CollabSession`, migration `v1` | Active namespace binding/class `CollabSession`; live namespace ID is present in provider output | **MATCH** for class/binding; repo does not pin namespace ID |
| `GAME_SESSION` | Class `GameSession`, migration `v2` | Active namespace binding/class `GameSession`; namespace ID `e3b207d2d852422b8ef90b32368bc3ce` | **MATCH** |
| `ENVIRONMENT` | plain text `production` | `production` | **MATCH** |
| `FRONTEND_URL` | `https://decklens.pages.dev` | Same URL | **MATCH** as configured value; whether this is the current public frontend is unknown |
| OAuth secret bindings | comments name GitHub and Google client IDs/secrets | Google client ID/secret bindings exist; GitHub client bindings are absent from version metadata | **DRIFT** relative to documented names; no values were read |
| `ADMIN_SECRET` | Worker code supports it; not listed as a binding in `worker/wrangler.toml` | Active secret binding exists | **DRIFT** / undeclared in checked-in Wrangler config; value not read |
| Cron expression | `0 2 * * SUN` | Version includes `scheduled` handler; actual trigger expression unavailable | **UNKNOWN** |
| Public route/hostname | `workers_dev = true` in repository config | No route or hostname in version response | **UNKNOWN** |

Both Durable Object classes and namespace bindings are present in the active API version. Their namespace IDs are recorded below as stateful identities.

## 4. Stateful resource inventory

### D1

- `decklens-community` exists, ID `de7be9e3-f841-40e0-8956-b0543454ac26`, created `2026-02-09T12:42:19.840Z`.
- Active `decklens-api` version binds that exact ID as `COMMUNITY_DB` (**MATCH**).
- Wrangler metadata reports 53 tables, region `EEUR`, size 3.9 MB, with read and write query activity in the preceding 24 hours. These are provider summary metrics only; no table names or application rows were queried.

### KV

Both repository IDs exist, with matching titles and active `decklens-api` bindings:

- `COMMUNITY_KV` — `1901193fd2da44eabb8d7fdf978df522` (**MATCH**).
- `CACHE_KV` — `03372b77c83e40ca8f063768920d2981` (**MATCH**).

### Analytics Engine

`decklens-api` version 148 actively binds `ANALYTICS` to dataset `decklens_events`, matching the repository declaration. This verifies the dataset is referenced by the deployed Worker, even though Wrangler did not provide a dataset list/existence listing.

### Durable Objects and scheduled events

- `CollabSession`: deployed API version has the binding and handler; class configured and live binding **MATCH**.
- `GameSession`: deployed API version has the binding and handler; namespace ID `e3b207d2d852422b8ef90b32368bc3ce`; class configured and live binding **MATCH**.
- API runtime reports migration tag `v2`; source config has migrations `v1` and `v2`. This confirms the deployed Worker version has reached tag `v2`, though the currently active namespace bindings are still the source of truth for connection status.
- Frontend Worker `decklens` runtime reports migration tag `v1-migration-cleanup`, matching its config's deletion migration for `CollabSession`. This migration tag is on the separate `decklens` Worker; it does not show that API Worker's DO was removed.
- API Worker version has a `scheduled` handler. The active cron expression could not be read; configured Sunday 02:00 UTC is not yet confirmed live.

## 5. Vercel inventory

Vercel account access is unavailable in this environment: there is no Vercel account inventory connector and no installed `vercel` CLI/token. No Vercel API request was made.

| Candidate | Result |
|---|---|
| `apps/api` NestJS/Vercel project | **UNKNOWN** — repository has `apps/api/vercel.json`, but project/deployment/domain/Git SHA cannot be inspected. |
| `apps/web` Vercel project | **UNKNOWN** — no project/deployment inventory access. |
| Project names `DeckLens`, `decklens-api`, `apps/api`, `apps/web` | **UNKNOWN** — cannot say whether corresponding Vercel projects exist. |

No Vercel settings, environment variables, or deployments were changed.

## 6. Repository-vs-live comparison

| Component | Repository candidate | Live resource | Status | Evidence | Cleanup implication |
|---|---|---|---|---|---|
| Root Vite frontend | Root HTML + `src/` → `dist/` | Cloudflare Pages `decklens` production deployment at `5bd2857`; active Workers Assets service `decklens` deployed May 1 | **CONFIRMED_PRODUCTION** as a deployed architecture family; exact host/revision on latest Worker unknown | Pages source commit is the root-Vite initial structure commit; active Worker has ASSETS and matches `infra/wrangler-frontend.toml` | **PROTECT**; distinguish stale Pages release from newer Worker. |
| `apps/web` | Next.js App Router/OpenNext | No resource with exact name `decklens-frontend`; generic `decklens` resources are Root-Vite-shaped | **MIGRATION_CANDIDATE**; Vercel state unknown | No OpenNext-specific live build/deployment evidence; exact-name Worker/Pages resource absent | **INVESTIGATE_FURTHER**; absence of named project is not deletion proof. |
| `worker/` | Cloudflare API Worker `decklens-api` | Active production Worker, latest deploy May 1 | **CONFIRMED_PRODUCTION** | Active version and bindings verified; source revision unavailable | **PROTECT**, especially D1/KV/DO/migration bindings. |
| `apps/api` | NestJS/Vercel | Vercel unknown; no Cloudflare Nest deployment identified | **UNKNOWN** | `vercel.json`, initial-only history, mock DB; no Vercel inventory | **INVESTIGATE_FURTHER**. |
| `packages/db` | Drizzle/Postgres package | No corresponding production Postgres resource checked; D1 is active for Worker | **UNKNOWN** | Nest candidate depends on it; provider inventory is Cloudflare only | **INVESTIGATE_FURTHER**. |
| `packages/rust-core` | Rust N-API native package | No live Rust build/runtime linkage identified | **UNKNOWN** | `bot-ml` training bridge and scripts reference it; active Worker metadata does not | **INVESTIGATE_FURTHER**. |
| `packages/game-engine` | Game/rules package | Worker active version contains `GameSession` handler; frontend page bundle not inspected | **CONFIRMED_PRODUCTION** at least for Worker class code; browser bundle unknown | Active API version lists GameSession named handler; repository root Vite aliases package | **PROTECT**. |
| `play-vs-bot` | Root HTML + `src/play-vs-bot`; omitted from Vite input but route artifacts exist | No separate deployed asset/route evidence retrieved | **UNKNOWN** | active API has both multiplayer DO bindings; Worker frontend routes not visible | **INVESTIGATE_FURTHER**; do not equate missing route/asset metadata with zero users. |
| `train-bot` | Root HTML/UI omitted from Vite build input but rewrite configs route it | No separate deployment/asset evidence retrieved | **UNKNOWN** | No asset manifest or route listing | **INVESTIGATE_FURTHER**. |
| `scripts/deploy/*` | Older shell deploy scripts | No account-side evidence of use | **UNKNOWN** | Prior repository audit found stale targets/paths; Pages project reports Git Provider `No` | **INVESTIGATE_FURTHER** before archiving; releases may be manual. |

## 7. Configuration drift

**Confirmed live differences:** the deployed API version contains `ADMIN_SECRET`, which is not declared in the checked-in Wrangler bindings, and Google OAuth secrets are present while GitHub OAuth bindings named in config comments are absent. These are binding-name differences only; no secret values were read.



**Matched live configuration:** Worker name, runtime compatibility date, migration tag `v2`, D1 ID, both KV IDs, Analytics dataset binding, `COLLAB_SESSION`, environment and frontend URL match repository config.

**Frontend deployment split:** Pages project `decklens` exists with a production deployment sourced from `5bd2857` about seven months ago. Separately, Worker service `decklens` has a production Workers Assets deployment from May 1, matching the repository's `infra/wrangler-frontend.toml` config shape. The latter's uploaded source revision, host and routes are unknown. Do not treat the stale Pages deploy as the only active frontend, and do not assume the Worker is attached to `decklens.pages.dev` without route metadata.

**Build metadata:** Pages reports Git Provider `No`; its build command and output directory were not returned. Worker deployment source is Wrangler, with no source SHA. The repository's stale shell scripts are not live metadata.

## 8. Cleanup conclusions

| Requested target | Classification | Evidence-based rationale |
|---|---|---|
| Root Vite frontend | **PROTECT** | A Pages production deployment at root-Vite commit `5bd2857` exists, and a newer `decklens` Workers Assets production deployment matches the root Vite output configuration. |
| `apps/web` | **INVESTIGATE_FURTHER** | No named `decklens-frontend` Worker/Pages project; Vercel is unknown and a generic host could conceal it. |
| `worker/` | **PROTECT** | Active API Worker, stateful bindings and live D1 usage confirmed. |
| `apps/api` | **INVESTIGATE_FURTHER** | Vercel remains unknown; no account access to prove absent. |
| `packages/db` | **INVESTIGATE_FURTHER** | No live Postgres inventory; D1-backed Worker does not prove no separate consumers. |
| `packages/rust-core` | **INVESTIGATE_FURTHER** | No live native build/deployment evidence; repository bot/training bridge still references it. |
| `packages/game-engine` | **PROTECT** | Deployed Worker version includes game-session handler code and browser-facing root config imports the package. |
| `play-vs-bot` | **INVESTIGATE_FURTHER** | No served asset/routes metadata; multiplayer bindings are present, but no frontend route/asset metadata. |
| `train-bot` | **INVESTIGATE_FURTHER** | No deployed asset/route metadata. |
| Deployment scripts | **INVESTIGATE_FURTHER** | The Pages project says Git Provider No, so manual release may matter; no use history from platform. |

No item is classified `REMOVAL_CANDIDATE`. The live evidence is enough to strengthen the Root-Vite/Worker production hypothesis, but not enough to delete migration candidates or resolve Vercel/external consumers.

### Rust native module specifically

Cloudflare's active API version has no Rust/native binding or native build metadata; its Worker runs on the Workers runtime and is not evidence of native Node addon deployment. The active `decklens` frontend Worker shows only `ASSETS`. Repository references remain in `packages/bot-ml/src/rust-bridge.ts`, training code and CLI/test scripts. `rust-bridge.ts` attempts the N-API require only when running in Node and falls back if unavailable. Thus this platform inventory found **no live Rust native build/deployment/runtime dependency**, but cannot rule out a Vercel app, external training host, or downloaded/static artifact. Keep `packages/rust-core` and generated artifacts unchanged until those paths are checked.

## 9. Remaining unknowns and recommended follow-up

1. Public hostname and route attachment for Worker service `decklens`; confirm whether it serves `decklens.pages.dev` or only a workers.dev preview.
2. Active public API hostname/routes for `decklens-api`; repository host is present in clients but not provider route metadata.
3. Latest Worker deployed source revision/build artifact; Wrangler deployment metadata has no Git SHA. Compare asset manifest/checksum or build provenance if available.
4. Exact Pages deploy timestamp/build command/output/source repository; Wrangler lists a branch and source commit but the Pages project is direct upload (`Git Provider: No`).
5. Whether the Sunday 02:00 UTC cron is attached to the active API Worker.
6. Why GitHub OAuth bindings are absent and `ADMIN_SECRET` is deployed without a Wrangler binding declaration; determine intended use before changing config or deployments.
7. Vercel projects and deployments for `apps/web`/`apps/api` remain uninspected.
8. External users/consumers of Next/Nest/Rust/training routes remain outside Cloudflare metadata.

Recommended next read-only steps: inspect Cloudflare dashboard Worker route/custom-domain and cron panels for `decklens` and `decklens-api`; inspect deployment build settings and asset history for Pages `decklens`; run authenticated Vercel inventory once available. Do not change any config while resolving drift.

## 10. Updated PROD_DO_NOT_TOUCH

- Active API Worker `decklens-api`, deployment/version history, domains/routes, and all source/config until OAuth/admin secret binding differences are resolved.
- Active Workers Assets service `decklens`; Pages project `decklens` and its `decklens.pages.dev` domain, including the old production deployment until traffic routing is understood.
- D1 `decklens-community`, ID `de7be9e3-f841-40e0-8956-b0543454ac26`; it has live query activity and 53 tables.
- KV namespace IDs `1901193fd2da44eabb8d7fdf978df522` and `03372b77c83e40ca8f063768920d2981`.
- Active Analytics Engine binding/dataset reference `decklens_events`.
- DO classes/bindings `CollabSession`, `GameSession`, namespace IDs returned by the live Worker, and migrations `v1`, `v2`, `v1-migration-cleanup`. Do not deploy migration changes.
- Active and configured cron schedules, OAuth/webhook secret names and values, custom domains, DNS and routes.
- Root Vite frontend, root HTML, `src/`, `worker/`, `packages/game-engine`, `packages/bot-ml`, `packages/rust-core`, and other imported packages.
- `apps/web`, `apps/api`, `packages/db`, `play-vs-bot`, `train-bot`, deployment scripts and their manifests until Vercel and external consumers are checked.

## Required summary values

```text
LIVE_FRONTEND_PLATFORM = Cloudflare Workers Assets plus Cloudflare Pages project
LIVE_FRONTEND_PROJECT = decklens (both Worker service and Pages project exist)
LIVE_FRONTEND_ARCHITECTURE = ROOT_VITE (active Worker Assets config matches repository dist output; Pages deployment source is root-Vite commit 5bd2857)
LIVE_FRONTEND_HOST = decklens.pages.dev (Pages project domain); active Worker hostname/routes UNKNOWN
LIVE_FRONTEND_REVISION = UNKNOWN for active Worker; Pages deployment source 5bd2857 (about 7 months old)

LIVE_BACKEND = Cloudflare Worker decklens-api, active production deployment at 100%
LIVE_BACKEND_HOST = UNKNOWN live; repository host is decklens-api.chrisgarkisch.workers.dev
LIVE_BACKEND_REVISION = UNKNOWN (latest version 493786a0-f2a5-4f32-bb13-7ee145a3b219, version 148, 2026-05-01T17:34:33Z; no source SHA)

LIVE_D1 = MATCH — decklens-community, ID de7be9e3-f841-40e0-8956-b0543454ac26; live, 53 tables, 3.9 MB, active queries
LIVE_KV = MATCH — COMMUNITY_KV 1901193fd2da44eabb8d7fdf978df522; CACHE_KV 03372b77c83e40ca8f063768920d2981
LIVE_DURABLE_OBJECTS = MATCH — CollabSession namespace bd6e0b1291d24433bd9d0102ef93d53a; GameSession namespace e3b207d2d852422b8ef90b32368bc3ce
LIVE_ANALYTICS = MATCH — active Worker binds Analytics Engine dataset decklens_events
LIVE_CRON = UNKNOWN — scheduled handler exists; configured 0 2 * * SUN not verified live

APPS_WEB_STATUS = MIGRATION_CANDIDATE / INVESTIGATE_FURTHER (no exact named Cloudflare resource; Vercel unknown)
APPS_API_STATUS = UNKNOWN (Vercel not inventoried)
RUST_CORE_STATUS = UNKNOWN live; no Cloudflare native runtime/build evidence, but repository training references exist

SAFE_NEXT_CLEANUP = NONE; keep PROD_DO_NOT_TOUCH boundary until routes, cron, Vercel and secret-binding differences are resolved
STILL_BLOCKED = YES for complete platform contract: Worker hostname/routes/cron, exact deployed Worker source revision, Pages build settings and Vercel inventory remain unknown
```



