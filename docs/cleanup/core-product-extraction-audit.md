# DeckLens Core Product Extraction Audit

Audit date: 2026-09-24
Repository: chrismaghuhn/Decklens
BASE_HEAD: 08d9af935b58716ecd79a9be60b16cc33eefcfe8
BRANCH: main
Initial WORKTREE_STATUS: only docs/cleanup/rust-retirement-audit.md was untracked; it is the intentional report from the prior audit. No tracked changes or other user changes were present.

Evidence read first: production-architecture-audit.md, live-deployment-inventory.md and rust-retirement-audit.md. This is analysis only. No source/configuration, test, route, database, Worker or deployment state was changed.

## Executive summary

The smallest evidence-supported product is the Root Vite browser app with four user-facing paths: MTG deckbuilder, its manual Goldfish mode, MTG analyzer, and Yu-Gi-Oh! analyzer. Manual Goldfish is a hand-authored browser state model in src/deckbuilder/goldfish.ts; it is not the full Rules Engine, does not import packages/game-engine, and can operate locally after deck/card data is supplied.

The root/editor's normal card autocomplete and search currently call Cloudflare Worker Scryfall routes, so the shipped implementation has a Worker dependency today. This is replaceable: MTG app code already fetches Scryfall directly, and retained products can use a shared browser-side Scryfall adapter. That migration and direct-API/CORS/rate-limit validation are prerequisites to a backend-free core. D1 is not required for basic local decks or either analyzer.

Deck Git is a separate optional editor feature. Its panel calls /api/repos; the active Worker router stores repo/branch/commit data in live D1 and requires authenticated user context. If retained, keep a minimal Worker + D1 + auth surface. Current Deck Git is much broader than version/history and can shed reviews, CI-like checks, webhooks, issue/release workflows, bots and realtime collaboration.

The Worker inline multiplayer bot and GameSession DO are production code today. The live audit confirms an active Worker deployment and bindings. The target product rejects multiplayer, so these are removal candidates, but D1/Durable Object contents and in-flight sessions must be retained/exported or drained before remote resources are retired.

Important boundary: src/deckbuilder/goldfish.ts has its own local GoldfishState. The full packages/game-engine is not needed for the four scoped products as currently implemented. Its current importers are Rules Simulator, play-vs-bot, training/bots, Worker multiplayer and type-only card-data code. If manual Goldfish is redefined as a rules-enforcing tabletop simulator, reassess.

## 1. Four retained products and actual source graphs

| Product | Entry HTML / entry TypeScript | Local dependency graph | Packages | Worker/external/persistence | Routes |
|---|---|---|---|---|---|
| MTG deckbuilder | decks.html -> src/deckbuilder/decks-main.ts; deck-editor.html -> src/deckbuilder/editor-main.ts | decks-main -> local deck storage/listing, shared analytics and dialogs. editor-main -> types, storage, parsing/import/export, search/autocomplete, card-preview, drag/drop, undo, mana, local validation, health/stats, collection, image/print, history/version UI, plus optional rec/meta/price/matchup/EDHREC/Spellbook, Deck Git and collaboration extensions. src/deckbuilder has 121 tracked files and is mixed. | No Bot package for basic editing. No direct packages/game-engine import in src/deckbuilder. packages/card-data has no active retained frontend import found. | Browser storage. Current autocomplete/search call Worker /api/scryfall/autocomplete and /api/scryfall/search. Online Moxfield/Archidekt import, cloud sync, public share, recs and commander stats call more Worker routes. Scryfall is also called directly elsewhere. | /decks, /decks/id/*; /decks/public and /d/* are public-sharing extras. |
| Manual MTG Goldfish | Embedded in deck-editor.html; editor-main opens src/deckbuilder/goldfish.ts | goldfish.ts defines its own GoldfishState and phases/zones; uses deckbuilder types/card preview, but imports collaboration broadcasts plus Coach/Coach UI/widget today. Manual state loop does not import Game, GameSession, MultiplayerClient or packages/game-engine. | No Bot package or packages/game-engine for this module. | Browser state/undo; Scryfall is used directly for token art. Host editor supplies deck/card records and some launch paths use Worker-backed search. No persistent server state is intrinsic to Goldfish. | No separate route; deckbuilder Goldfish modal/playtest. |
| MTG analyzer | mtg.html -> src/mtg/main.ts -> src/mtg/app.ts; src/mtg has 22 files | app.ts -> shared DOM/storage/fetch/errors/parser/export/API/analytics, src/mtg/engine analysis modules and local Web Workers via src/workers/worker-manager. MTG modules include statistics, recommendations, matchup/meta, feedback/personalization, archetypes and fetch helpers. | No direct packages/game-engine, bot-core, bot-ml or card-data import found in retained MTG source. Browser Web Workers are local compute workers, not Cloudflare Workers. | Scryfall direct for card collection/data. Analyzer also requests Worker rec enrichment, report sharing, analytics and other optional services; static/local rec fallback exists. | /mtg (extensionless mapping depends on host; mtg.html is configured input). |
| Yu-Gi-Oh! analyzer | yugioh.html -> src/ygo/main.ts -> app.ts, tools-drawer.ts and tool-registry.ts; src/ygo has 4 files | Local parser/format/tools plus shared errors/storage/UI utilities. | No bot or game-engine dependency. | YGOProDeck API; QRServer for QR rendering. Browser persistence. No Worker dependency found. | /yugioh (extensionless mapping depends on host). |

### Feature-level deckbuilder classification

| Feature group | Classification | Evidence/notes |
|---|---|---|
| Editing, card rows/zones, local save/open, import/export, search, preview, undo | CORE_REQUIRED | editor-main, storage, parser, import/export. |
| Basic card statistics, mana curve/base, color/type counts, local format legality | CORE_REQUIRED or OPTIONAL_USEFUL_FEATURE | Keep selected local TS analysis only. |
| Deck health, DNA/archetype, recommendations, anti-meta, smart-recs | OPTIONAL_USEFUL_FEATURE | Local analysis plus Worker enrichment; keep only if selected. |
| Matchup/sideboard, bracket/salt, EDHREC/Spellbook, prices/budget, commander meta | OPTIONAL_USEFUL_FEATURE | Not prerequisites to editing; some need external services/Worker. |
| Deck Git history panel | OPTIONAL_DECK_GIT | editor-main imports repo-panel. |
| Manual Goldfish | CORE_REQUIRED | Custom browser state; not the Rules Simulator or automated bots. |
| Coach UI/Goldfish Coach | REMOVE_CANDIDATE | Not required for manual draw/play/move/tap/turn/undo. |
| Multiplayer Goldfish, collab broadcasts, draft/sealed | REMOVE_CANDIDATE | Worker WebSockets/Collab DO; outside core. |
| Monte Carlo/automatic simulation | REMOVE_CANDIDATE | Not defined manual Goldfish. |
| Analytics telemetry/internal dashboards | REMOVE_CANDIDATE | Not needed to edit/analyze decks. |

## 2. Deckbuilder minimum

editor-main.ts imports numerous feature groups:

- Basic editor: drag-drop, card-preview, context-menu, undo-stack, card-autocomplete, storage, types, parser/import/export, toast/modal/onboarding.
- Local tools: mana-calc, health-score, edh-rules, bracket-calc, collection, deck-diff, draw-probability, image/print, categorization and search syntax.
- Advanced analysis: synergy, smart-recs, matchup, meta badges, budget optimizer, EDHREC, commander stats, rec history/trust, combo clients.
- Optional Deck Git: repo-panel -> repo-api and PR/repository UI. version-panel/version-api and deck-diff are separate local/cloud history surfaces; decide which remain.
- Non-core extensions: multiplayer launcher, Coach, collab cursors/drawing/chat/Goldfish, draft/sealed and simulation.

A normal local deckbuilder can work without community, public sharing, collaboration or Deck Git. Current Worker-backed card autocomplete/search is a real dependency in source; Core-without-Deck-Git needs a browser Scryfall adapter or deliberately retained slim search endpoint. Moxfield/Archidekt proxy import, public sharing and cloud sync are optional conveniences; local paste/import/export exists.

## 3. Manual Goldfish extraction

Manual Goldfish is separate from src/rules-engine and src/play-vs-bot. goldfish.ts owns local library/hand/battlefield/graveyard/exile/commandZone arrays, turn/phase, tap flags, counters, life, logs, tokens and bounded undo. It opens from deck-editor. It uses Scryfall for token images but does not directly call Cloudflare or GameSession.

The retained path must sever imports to collab-goldfish.ts, goldfish-coach.ts, goldfish-coach-ui.ts and goldfish-coach-widget.ts. goldfish-mp.ts, goldfish-mp-launch.ts, collab-goldfish-mp.ts and draft-sealed.ts are not needed. Map supplied card data into lightweight Goldfish types; no game-engine runtime is needed.

    MANUAL_GOLDFISH_DEPENDS_ON_GAME_ENGINE = NO for current manual state model
    MANUAL_GOLDFISH_DEPENDS_ON_WORKER = NO intrinsically; editor search/data launch currently uses Worker-backed Scryfall routes
    MANUAL_GOLDFISH_DEPENDS_ON_BOT_CODE = NO after removing Coach integration
    MANUAL_GOLDFISH_DEPENDS_ON_COLLAB = NO after removing broadcasts/hooks
    MANUAL_GOLDFISH_DEPENDS_ON_MULTIPLAYER = NO after retaining goldfish.ts and removing goldfish-mp*

## 4. MTG analyzer and Yu-Gi-Oh analyzer

### MTG analyzer

Keep mtg.html, src/mtg/main.ts, src/mtg/app.ts and local analysis/parser/import/export helpers they import. Core output can include deck size, card/type/color counts, mana statistics and basic legality/health. The following are useful but not prerequisites:

- recommendation-v1/local anti-meta: OPTIONAL_USEFUL_FEATURE; no model training required.
- ml-recommendation.ts/user-feedback.ts: experimental preference adaptation; REMOVE_CANDIDATE unless personalization is explicitly selected. This is not MLBot.
- matchup-guide/sideboard plans, archetypes, bracket/salt: OPTIONAL_USEFUL_FEATURE.
- EDHREC/Spellbook, prices, commander meta: OPTIONAL_USEFUL_FEATURE.
- public report share, analytics dashboard, telemetry: REMOVE_CANDIDATE.
- local worker-manager/recommendation workers: optional browser compute, not Cloudflare backend.

Scryfall is core card data. The app already posts card collections directly to Scryfall. Current autocomplete/search is Worker-backed, so core needs the browser adapter migration or a slim Worker endpoint. app.ts also calls analytics/report/recommendation services that should be separated from basic analysis.

### Yu-Gi-Oh analyzer

Keep yugioh.html and src/ygo/main.ts, app.ts, tool-registry.ts and tools-drawer.ts. YGOProDeck is the main card data API; QRServer is only QR rendering for export. Parsing and browser state are local. No Worker, bot or game-engine dependency found.

## 5. Deck Git as optional feature

editor-main calls initRepoPanel/onRepoTabActive from repo-panel.ts. repo-panel calls repo-api.ts, whose API surface includes repos, branches, commits/state/compare/revert and a much wider set of PR, reviews, comments, checks, issues, releases, collaborators, audit, webhook, watch, bisect and CI-like functions.

worker/src/index.ts dispatches /api/repos and related paths to worker/src/deck-git/router.ts. The router takes COMMUNITY_DB and authenticated user context; repo creation requires auth and writes deck_repos/branch/commit state in D1. The router contains the repo SQL handlers/schema setup. Deck Git is authenticated/D1-backed and much broader than simple version history.

| Deck Git slice | Classification | Minimum fit |
|---|---|---|
| Repo/deck metadata, commit history and saved state, restore/revert; branches if required by UX | DECK_GIT_CORE | Keep authenticated Worker/D1 handlers. |
| Compare/fork | OPTIONAL_EXTRA | Retain only if useful to history flow. |
| PR/merge, reviewers, auto-labels, CI checks, issues, releases, webhooks, watch/bisect, audit moderation, smart suggestions | REMOVE_CANDIDATE | Not needed for personal deck history/restore. |
| Realtime cursors/chat/drawing/Goldfish collaboration | UNRELATED | Uses CollabSession, not required for version history. |

    MINIMAL_DECK_GIT_FRONTEND = repo-panel reduced to repo/history/commit/branch/restore UI
    MINIMAL_DECK_GIT_WORKER = authenticated /api/repos plus branch/commit/state/restore handlers; remove PR/CI/issues/release/webhook extras
    MINIMAL_DECK_GIT_STORAGE = deck_repos, branch/commit/state/permission tables actually required; same live D1 identity pending data review
    DECK_GIT_CAN_BE_ISOLATED = YES logically; editor panel, Worker router and D1 are separable; repo router shows no DO/KV requirement

GitHub/Google OAuth is shared Worker identity. Webhooks and GitHub repo sync are optional extras. Keep repo permissions if Git remains. Deck Hub/community is separate from Deck Git.

## 6. Backend and route map

The live audit confirmed production Worker decklens-api (latest visible deploy 2026-05-01), D1 decklens-community (53 tables with read/write activity), COMMUNITY_KV, CACHE_KV, Analytics Engine decklens_events, CollabSession and GameSession DOs. It also confirmed an active decklens Assets Worker. Presence does not mean these services are core.

| Worker routes/subsystem | Product relationship | Target classification |
|---|---|---|
| /api/repos and repo services | Optional Deck Git | REQUIRED_ONLY_FOR_DECK_GIT for minimal repo/history handlers. |
| /api/scryfall/search, autocomplete, resolve and proxies | Current editor card search | REQUIRED_BY_CURRENT_CORE_IMPLEMENTATION; remove dependency after direct Scryfall client migration. |
| /api/deck/moxfield, /api/deck/archidekt, /api/decks/sync, public share | Import convenience/cloud/public sharing | OPTIONAL/OLD_FEATURE; not basic local deckbuilding. |
| /api/recommendations/mtg, commander stats, Spellbook, EDHREC/meta | Advanced analyzer enrichment | OPTIONAL_USEFUL_FEATURE. |
| /api/analytics/*, webhook forwarding, dashboards | Internal/product telemetry | REMOVE_CANDIDATE. |
| /api/community/*, moderation, feed, votes, flags, combo moderation | Social/community | REMOVE_CANDIDATE. |
| /api/auth/*, GitHub/Google OAuth | Deck Git identity and old community features | REQUIRED_ONLY_FOR_DECK_GIT if authenticated repo access remains. |
| /api/collab/* and CollabSession | Realtime editing/Goldfish collaboration | REMOVE_CANDIDATE. |
| /api/game-sessions/* and GameSession | Human multiplayer with inline Bot seats | REMOVE_CANDIDATE by product decision. |

    CORE_PRODUCT_NEEDS_BACKEND = NO in target; current card search must move to direct Scryfall or a slim Worker endpoint first
    CORE_PRODUCT_NEEDS_D1 = NO for local decks/analyzers
    CORE_PRODUCT_NEEDS_KV = NO
    CORE_PRODUCT_NEEDS_ANALYTICS_ENGINE = NO
    CORE_PRODUCT_NEEDS_COLLAB_SESSION = NO
    CORE_PRODUCT_NEEDS_GAME_SESSION = NO

    DECK_GIT_NEEDS_BACKEND = YES
    DECK_GIT_NEEDS_D1 = YES
    DECK_GIT_NEEDS_KV = NO shown by current repo router
    DECK_GIT_NEEDS_DURABLE_OBJECTS = NO

A Worker containing only index.ts + deck-git is not a complete design by itself: Deck Git needs D1 schema/auth and shared CORS/security/ID helpers. Treat that as a later extraction, not literal file deletion.

## 7. Stateful resource safety

| Resource | Core-only variant | Deck Git variant | Data/state concern |
|---|---|---|---|
| D1 decklens-community | INVESTIGATE_DATA_FIRST, then backup/export before retirement | KEEP | Live 53-table DB with read/write traffic; likely mixes repo, account, community and analytics rows. No table rows inspected. Never drop/recreate. |
| COMMUNITY_KV | BACKUP_THEN_RETIRE | RETIRE_AFTER_ROUTE_REMOVAL unless repo proves dependency | Persistent community-feed fallback; export first. |
| CACHE_KV | RETIRE_AFTER_ROUTE_REMOVAL | Retire unless kept card endpoint uses it | Scryfall/Spellbook cache likely regenerable; inspect/export first. |
| Analytics dataset decklens_events | BACKUP/EXPORT_THEN_RETIRE | Same | Historical events may be valuable. |
| CollabSession DO | RETIRE_AFTER_COLLAB_ROUTE_REMOVAL and session drain | Same | Persisted collaborative state. |
| GameSession DO | RETIRE_AFTER_GAME_ROUTE_REMOVAL and session drain | Same | Session/lobby/deck/game state, including possible bot seats. |
| Sunday cron | RETIRE_AFTER_COMMANDER_STATS_ROUTE_REMOVAL | Same unless stats retained | Configured commander-stat refresh; live trigger expression wasn't verified. |

No remote resource changes or data reads are proposed in this audit.

### Multiplayer/bot persisted state

worker/src/game-session.ts client protocol has lobby-add-bot; lobby-state exposes SeatInfo.isBot. onAddBot records Bot N, isBot/ready/connected, and a generated deck under deck_<seat>. persistState stores lobbySeats and gameState; startGame stores the TypeScript GameState JSON; bot turns pass priority after game start, human actions and disconnected-player auto-pass. The game state can itself contain Bot player/deck names.

Safe later compatibility strategy:
1. Reject new lobby-add-bot messages with a clear unsupported response during transition.
2. Parse stored seats tolerantly: missing isBot defaults false; strip this field from the future protocol.
3. In phase=lobby, convert old isBot seats to empty/disconnected seats. Delete only verified generated bot deck_<seat> entries.
4. In phase=game/finished, preserve gameState and deck data; disable bot turns. Drain sessions with a timeout or allow explicit human takeover. Current reconnect is by playerName, so takeover UX needs a deliberate strategy.
5. Retire binding/class only after sessions/data are handled. Do not equate code removal with namespace deletion.

    WORKER_HAS_PRODUCTION_BOT_SUPPORT = YES; active Cloudflare GameSession is a production Multiplayer DO with a separate pass-only inline bot
    BOT_PROTOCOL_MESSAGES = client lobby-add-bot; server lobby-state includes SeatInfo.isBot; no separate bot-added message
    BOT_PERSISTED_FIELDS = lobbySeats[].isBot/playerName/ready/connected; deck_<seat> bot deck; gameState/phase/player state
    BOT_FRONTEND_CALLERS = src/play-vs-bot/mp-client.ts addBot; src/play-vs-bot/main.ts button/isBot UI/seat selection; play-vs-bot.html
    BACKWARD_COMPATIBILITY_REQUIRED = YES until old clients and persisted sessions drain

## 8. Rules Engine and packages/game-engine

src/rules-engine/main.ts defaults selectedMode to vs-bot, imports HeuristicBot, labels player two “Bot” and passes a bot callback to SimulatorLoop. rules-engine.html exposes vs Bot and Hotseat. simulator-loop.ts has BotInterface, optional bot config and [0] vs [0,1] human-player logic. This standalone Simulator is distinct from deckbuilder manual Goldfish.

The four target products do not directly import packages/game-engine. Goldfish has its own simple state. MTG/YGO app source has no import. Deck Git has no import. Current packages/card-data only type-imports Color/CardTag from game-engine and has no retained frontend consumer found; if card-data is kept, extract those shared types rather than retain the complete rules runtime by default.

    A. Manual Goldfish requires packages/game-engine? NO
    B. MTG analyzer requires packages/game-engine? NO
    C. YGO analyzer requires packages/game-engine? NO
    D. Deck Git requires packages/game-engine? NO
    RULES_ENGINE_REQUIRES_BOT_CORE_TODAY = YES for its current vs-bot mode
    RULES_ENGINE_CAN_SURVIVE_WITHOUT_BOTS = YES by removing vs-bot and leaving hotseat; standalone simulator itself is not in core scope
    EXACT_CHANGES_REQUIRED = Remove HeuristicBot import/creation, Bot default/name, vs-bot type/button and simulator-loop BotInterface/auto-action path; target product removes rules-engine.html and src/rules-engine/** entirely.

Classification: low-level game model is not required by core; manual Goldfish does not use it; Rules Simulator is a separate REMOVE_CANDIDATE; bot and multiplayer consumers disappear. If scope changes to a rules-enforcing tabletop simulator, reassess.

## 9. Collaboration, community and dashboards

The deckbuilder imports broad src/deckbuilder/collab-* features: cursors, drawing, chat, proposals/tasks/threads/collection/branches/sideboard. Worker CollabSession and /api/collab/* back realtime editor/Goldfish sync. Not needed for local deck editing, manual Goldfish, analyzers or basic Deck Git history.

    COLLAB_REQUIRED_FOR_DECKBUILDER = NO for local editing
    COLLAB_REQUIRED_FOR_GOLDFISH = NO for manual local Goldfish
    MULTIPLAYER_REQUIRED_FOR_GOLDFISH = NO
    COLLAB_REQUIRED_FOR_DECK_GIT = NO for version/commit/restore; repo permissions are separate D1 data

dashboard-hub and executive/growth/technical/community/public dashboards plus src/dashboard are internal KPI/analytics views. community.html/src/community, public deck pages, deckhub.html/src/deckhub, votes/moderation/feed and analytics dashboards are independent social/internal products. None is required by core or basic Deck Git.

| Surface | Relation to core | Classification |
|---|---|---|
| Business/technical dashboards and dashboard APIs | Internal metrics | REMOVE |
| Community feed/vote/moderation and community page | Social | REMOVE_CANDIDATE |
| Deck Hub and service worker | Separate social/repo discovery surface, not Deck Git | REMOVE |
| Public deck/report sharing | Optional sharing | REMOVE_CANDIDATE |
| Repo history panel | Optional Deck Git | KEEP_IF_DECK_GIT |

## 10. Alternative stacks and package classification

| Area | Evidence/status | Decision |
|---|---|---|
| Root Vite + src | Confirmed production architecture family in live Cloudflare audit | KEEP_CORE and trim. |
| apps/web Next | No named Cloudflare project; current Pages/Worker evidence is Root-Vite-shaped; Vercel not inventoried | MIGRATION_EXPERIMENT/UNKNOWN; no Root Vite dependency, but check Vercel before deleting 92 tracked files. |
| apps/api Nest/Vercel | No root frontend caller; DB provider uses a mock; Vercel state unknown | REMOVE_CANDIDATE/UNKNOWN until Vercel/external consumers checked. |
| packages/db | Nest/Postgres alternative; no core reference/live Postgres evidence | REMOVE_CANDIDATE after app/Vercel check. |
| packages/card-data | 12 files; no retained UI import found | REMOVE_CANDIDATE or keep selective bulk parser only if chosen. |
| packages/game-engine | 60 files; consumers are Rules/play/bot/training/Worker GameSession/card-data types | REMOVE_CANDIDATE after those consumers go; not needed by current Goldfish/analyzers/Deck Git. |
| packages/bot-core, bot-ml, rust-core | 21, 49, 1,160 tracked respectively | REMOVE/ARCHIVE as below. |
| .claude, .idea, .vscode | developer/editor settings | KEEP useful team config or later hygiene; not runtime product. |
| worker/.wrangler | 10 tracked local Wrangler state files | GENERATED_DELETE candidate after content ownership check. |
| public/combos.json | static combo catalog loaded by MTG analyzer | OPTIONAL_USEFUL_FEATURE if combo UX retained. |
| public/deckhub-sw.js | Deck Hub service worker | REMOVE with Deck Hub. |
| infra/docker-compose.yml | local Postgres/Redis/Adminer for alternate API | REMOVE_CANDIDATE with apps/api/packages/db after consumer check. |

## 11. External APIs

| Service | Current use | Target classification |
|---|---|---|
| Scryfall API/images | MTG card data, direct analyzer collection, Goldfish token art; deckbuilder search currently uses Worker proxy | CORE_REQUIRED; prefer browser client, subject to CORS/rate-limit validation. |
| YGOProDeck | YGO card lookup/info | CORE_REQUIRED for current analyzer. |
| QRServer | YDKE QR rendering | OPTIONAL_USEFUL_FEATURE. |
| Moxfield/Archidekt | hosted deck URL import via Worker proxy | OPTIONAL_USEFUL_FEATURE; paste/local import remains. |
| EDHREC/Commander Spellbook | commander/combo/Coach/meta enrichment | OPTIONAL_USEFUL_FEATURE. |
| GitHub/Google OAuth | Worker identity and repo permissions | OPTIONAL_DECK_GIT. |
| GitHub API/webhooks | advanced repo sync/webhooks/release workflows | REMOVE_CANDIDATE for internal deck version history. |
| Cardmarket/TCGplayer links | external pricing/shop links | OPTIONAL. |

## 12. Complete top-level repository classification

Current HEAD has 1,887 tracked files; counts below come from git ls-files.

| Top-level | Count/evidence | Classification |
|---|---:|---|
| .claude/ | instructions | KEEP/REVIEW as developer config. |
| .idea/, .vscode/ | editor state | REMOVE_CANDIDATE if not team-shared. |
| apps/ | web 92, api 26 | INVESTIGATE_BEFORE_REMOVAL due Vercel unknown; no core source dependency. |
| data/ | 72: 2 weights + 70 training logs | GENERATED_DELETE; no core consumer. |
| docs/ | 13 | Keep audit/product evidence; archive bot/Rust/simulator plans/specs. |
| infra/ | 5 | Keep headers/minimal assets config; trim redirects; Docker stack candidate removal. |
| packages/ | 1,309 incl rust-core 1,160 | bot 70 remove; Rust archive/delete; game-engine/card-data candidates; db contingent on Nest. |
| public/ | 5 | Keep security/search assets; combos optional; deckhub SW remove. |
| scripts/ | 12 | Remove train/eval/Rust tests/benchmarks; review deploy/seed scripts individually. |
| src/ | 204 | Mixed: retain deckbuilder/manual Goldfish, MTG analyzer, YGO; trim multiplayer/rules/dashboard/community/deckhub/training and optional recs. |
| tests/ | 38 | Keep core parsing/import/export/analyzer/YGO/Goldfish; remove Bot/ML/Rules/MP/community/backend tests with those features. |
| worker/ | 66 | Optional minimal Deck Git backend. Remove multiplayer/collab/social/dashboard/recs as selected; preserve D1 identity until state handled. |
| root HTML | 18 | Keep index optional, mtg, yugioh, decks, deck-editor. Public/dashboard/community/Deck Hub/rules/play/train pages are extra. |
| root Vite/TS/package/workspace config | mixed | Modify bot deps/scripts/aliases/entrypoints intentionally; no incidental lock/policy changes. |

### Documentation

- ARCHIVE: docs/EDH-BOT-ARENA-SPEC.md, docs/devlogs/devlog-mtg-bot.md, docs/RUST_PORT_PLAN.md.
- ARCHIVE/UPDATE: 2026-02-18 Rules Engine/play-vs-bot plans/designs after removing claims of current/future product support.
- KEEP: cleanup audits as historical evidence; update the Rust retirement status only in an authorized implementation.
- KEEP/REVIEW: competitive-analysis.md and rulebook.txt; Deck Doctor backlog only if analyzer recs are retained.
- Bot mentions in game-engine tests/plans are HISTORICAL/TEST_ONLY, not evidence of runtime dependency.

## 13. Entrypoints and route reduction

Root Vite has 16 configured HTML inputs: index, mtg, yugioh, community, decks, deck-editor, decks-public, deck-public, dashboard-hub, executive/growth/technical/community/public dashboards, deckhub and rules-engine. play-vs-bot.html and train-bot.html exist but are commented out of Vite inputs.

| Current page/route | Classification | Target |
|---|---|---|
| index.html / | KEEP if useful | Landing links only to retained products. |
| mtg.html /mtg | KEEP_CORE | MTG analyzer. |
| yugioh.html /yugioh | KEEP_CORE | YGO analyzer. |
| decks.html /decks | KEEP_CORE | Deck list/editor entry. |
| deck-editor.html /decks/id/* | KEEP_CORE | Deckbuilder + manual Goldfish + optional Deck Git panel. |
| decks-public.html, deck-public.html, /decks/public, /d/* | REMOVE_CANDIDATE | Public/social sharing is not explicitly in core and is not Deck Git. |
| rules-engine.html, /simulator | REMOVE_CANDIDATE | Standalone simulator not in the product list. |
| play-vs-bot.html, /play | REMOVE | Bot/multiplayer page; excluded from Vite build but routed by infra files. |
| train-bot.html, /train-bot | REMOVE | Training UI excluded from Vite build but routed by infra files. |
| community.html, /community | REMOVE_CANDIDATE | Social/community not required. |
| deckhub.html, /deckhub | REMOVE | Deck Hub is not Deck Git. |
| dashboard pages, /dashboard/* | REMOVE | Internal dashboards. |

Vite dev rewrites, infra/_redirects and infra/frontend-worker.ts disagree and contain routes to unbuilt pages. Retained routing should be re-established only for selected core pages; remove /play, /train-bot, /simulator, dashboards, community and deckhub. Extensionless /mtg and /yugioh behavior depends on hosting; verify during implementation.

## 14. Shared code requiring separation

| Shared area | Classification | Why |
|---|---|---|
| src/shared deck parser/export, safe DOM, URL validation, fetch, storage and errors | KEEP_AS_IS or small KEEP_PARTIAL_REFACTOR_REQUIRED | Used by retained products. |
| src/shared/api.ts | KEEP_PARTIAL_REFACTOR_REQUIRED | Bundles core Scryfall search with reports, community, analytics, deck share, EDHREC and collaboration calls. Split/narrow imports so optional services do not define core. |
| src/shared/analytics.ts and feedback telemetry | REMOVE or KEEP_PARTIAL_REFACTOR_REQUIRED | Instrumentation is not a retained product service. |
| src/deckbuilder/editor-main.ts | KEEP_PARTIAL_REFACTOR_REQUIRED | One entrypoint imports core editor plus recs/meta, multiplayer, collaboration, social and Deck Git. |
| src/deckbuilder/goldfish.ts | KEEP_PARTIAL_REFACTOR_REQUIRED | Manual state is useful; Coach/collab integration is not. |
| src/mtg/app.ts | KEEP_PARTIAL_REFACTOR_REQUIRED | Core import/analyzer mixed with recs, reports, analytics, combos and community-derived views. |
| worker/src/index.ts | KEEP_PARTIAL_REFACTOR_REQUIRED if Deck Git remains; otherwise REMOVE | One Worker entry mixes all endpoint families. |
| worker/src/deck-git/router.ts | KEEP_PARTIAL_REFACTOR_REQUIRED if Git remains | Repo/history combined with PR, CI, issue, release, webhook and automation extras. |
| packages/card-data/game-engine type surface | REMOVE or KEEP_PARTIAL_REFACTOR_REQUIRED | No retained UI imports. If data loader later retained, extract only shared card types instead of full simulator. |

## 15. Target architecture variants

VARIANT A — WITHOUT DECK GIT

Root Vite browser app:
- optional landing/home
- MTG analyzer
- Yu-Gi-Oh analyzer
- deck list/editor
- manual Goldfish
- browser storage
- direct Scryfall and YGOProDeck data

No application backend/D1/KV/Analytics/DO is required after moving deckbuilder autocomplete/search off Worker. Static asset hosting remains.

VARIANT B — WITH DECK GIT

Same frontend plus reduced repository/history/commit/branch/restore editor panel. Keep authenticated Cloudflare Worker repo API and existing D1 identity/tables needed for Git data. No KV/DO requirement shown by current repo router. Remove community/dashboard/PR-CI-webhook extras by default.

Neither variant requires Next/Nest from Root Vite imports; check Vercel before removing those stacks.

## 16. Proposed deletion/change manifest (not executed)

| Manifest group | Proposed content |
|---|---|
| DELETE_ENTIRE_DIRECTORY | packages/bot-core; packages/bot-ml; src/play-vs-bot; src/rules-engine; src/dashboard; src/community; src/deckhub; data/trained-model; data/training-logs. packages/game-engine and packages/card-data are candidates after checking final consumers. apps/web/apps/api/packages/db require Vercel/consumer check. |
| DELETE_FILE | play-vs-bot.html, train-bot.html; bot CLI/eval/Rust tests and benchmark; rules-engine.html; dashboards; community/Deck Hub pages; public/deckhub-sw.js; Rust generated loader/types/binary/log. |
| KEEP_ENTIRE_DIRECTORY | src/ygo and retained tests/shared modules after pruning. |
| KEEP_FILE | mtg.html, yugioh.html, decks.html, deck-editor.html, optionally index.html; local deck storage/import/export, analyzer and manual Goldfish state. |
| KEEP_ONLY_SUBTREE | src/deckbuilder core edit/import/export/search/storage/manual Goldfish; src/mtg core analyzer; worker/src/deck-git only if selected. |
| MODIFY_TO_REMOVE_OLD_FEATURE | editor-main.ts, goldfish.ts, mtg app/shared API, Vite/TS/package config, frontend routes, Worker router/config and clients. |
| ARCHIVE_HISTORY | first Rust source/config/locks/docs under legacy/first-rust-engine; selected bot specs/devlogs/plans under legacy/bot-history. |
| INVESTIGATE_BEFORE_REMOVAL | apps/web/apps/api/packages/db; D1/KV/Analytics/DO data; Vercel projects; public deck data; Next generated output ownership; active frontend route mapping. |

Do not delete mixed files wholesale because they contain one unwanted feature. editor-main.ts, mtg/app.ts and worker/index.ts require feature-by-feature extraction.

## 17. Expected size reduction

| Measure | Estimate |
|---|---|
| CURRENT_TRACKED_FILES | 1,887 |
| CORE_ONLY_TRACKED_FILES_ESTIMATE | 300–450 |
| CORE_PLUS_DECK_GIT_TRACKED_FILES_ESTIMATE | 400–600 |
| Known large groups | bot packages 70; Rust 1,160 (about 10 authored/config/lock files archived); training data 72; play-vs-bot 9; rules simulator 4; dashboard 10; community 1; Deck Hub 3. |
| GENERATED_TRACKED_FILES_TO_DELETE | At least 1,218: 1,142 Rust target files + 4 generated N-API/log files + 72 model/log artifacts. Plus worker/.wrangler 10 local-state files and apps/web/.open-next 45 if app ownership decision permits. |
| Removable tracked estimate | About 1,200–1,500 if alternatives and social/backend extras are confirmed removable; not exact until mixed module closure and Vercel/D1 review. |
| LEGACY_FILES_TO_PRESERVE | About 10 authored Rust source/config/docs/lock files plus selected historical bot plans/specs. |

Core estimates are ranges: src/deckbuilder has 121 mixed files and src/mtg has 22. The 1,887 count is tracked HEAD content; cleanup reports are untracked docs and not included.

## 18. Validation plan for later implementation

- Root Vite build and configured Vitest suite.
- MTG analyzer smoke: import deck, card data and local stats.
- YGO analyzer smoke: lookup, parse, local persistence and YDKE export.
- Deckbuilder import/export, local save/load, card search and manual Goldfish draw/play/move/tap/turn/undo/reset.
- Scryfall browser search after Worker adapter removal; validate CORS/rate limits/failure UI.
- Deck Git repo create/history/restore and Worker D1 tests if kept.
- Worker local typecheck/build only if reduced backend remains; no deploy.
- No Bot/ML/training/Rust/multiplayer/collab/dashboard imports/routes in active graph.
- No production imports from legacy/.
- No D1/KV/DO deletion or migration in code cleanup.
- No deployment.

    ACTIVE_BOT_PACKAGES = 0
    ACTIVE_BOT_RUNTIME_CODE = 0
    ACTIVE_TRAINING_CODE = 0
    ACTIVE_RUST_RUNTIME = 0
    ACTIVE_MULTIPLAYER = 0
    ACTIVE_COLLAB = 0 unless explicitly retained
    ACTIVE_DASHBOARDS = 0
    PRODUCTION_IMPORTS_FROM_LEGACY = 0

## 19. Implementation phasing

| PR | Purpose | Risk | Validation | Dependency |
|---|---|---|---|---|
| C1 — Core frontend boundary | Keep four core routes/manual Goldfish; remove unrelated panels; migrate Worker card search to Scryfall browser client or retain one slim endpoint; trim routes. | Medium: editor has 121 mixed modules. | Vite build + four browser smoke paths. | Confirm exact Goldfish scope. |
| C2 — Bots, ML, Rust, Simulator | Remove bot packages, training/pages/assets/Rust; archive authored source; remove vs-bot mode or full Rules Engine. | Low for shipped page graph, medium for package barrel/config. | Grep invariants, Vite/typecheck, Goldfish. | C1 import boundaries. |
| C3 — Multiplayer and collaboration | Remove protocol/DO routes only after session drain/retention plan. | High: live DO state and human multiplayer sessions. | Worker build + compatibility/drain checks. | User data/session decision. |
| C4 — Deck Git decision/isolation | Keep minimal repo/history/restore or remove panel/routes after data export. | High if repo data exists. | D1 repo tests/restore or verified export. | Owner decision. |
| C5 — Community, dashboards, social | Remove Deck Hub/community/public decks/internal panels/analytics. | High due account/community/report/event data. | Exports/retention and route checks. | C1/C4 and data decisions. |
| C6 — Backend/resources | Reduce Worker to Deck Git or none; retire D1/KV/Analytics/DO only separately after backup/approval. | Highest, live stateful resources. | Local tests only; remote retirement separately authorized. | C3/C4/C5 plus data retention. |
| C7 — Alternative apps/docs/generated | Decide Next/Nest/Postgres after Vercel check; archive docs/remove verified generated output. | Medium; external deployment unknown. | Vercel/consumer inventory, final build/install. | Platform evidence. |


## Final classification

    DESIRED_CORE = MTG deckbuilder; manual MTG Goldfish; MTG analyzer; Yu-Gi-Oh analyzer
    MTG_DECKBUILDER_STATUS = KEEP_CORE; trim social/advanced extensions and migrate Worker-backed search if backend removed
    MANUAL_GOLDFISH_STATUS = KEEP_CORE; local browser state; remove Coach/collab/multiplayer imports
    MTG_ANALYZER_STATUS = KEEP_CORE; advanced rec/meta/telemetry optional
    YGO_ANALYZER_STATUS = KEEP_CORE
    DECK_GIT_STATUS = OPTIONAL_DECK_GIT; owner decision open

    CORE_REQUIRES_WORKER = CURRENT SOURCE: YES for deck autocomplete/search; TARGET: NO after direct Scryfall adapter migration
    CORE_REQUIRES_D1 = NO
    CORE_REQUIRES_KV = NO
    CORE_REQUIRES_DURABLE_OBJECTS = NO
    CORE_REQUIRES_GAME_ENGINE = NO for defined manual Goldfish/analyzers; YES only if rules-enforcing Simulator is retained

    DECK_GIT_REQUIRES_WORKER = YES
    DECK_GIT_REQUIRES_D1 = YES
    DECK_GIT_REQUIRES_KV = NO

    BOT_SYSTEM_STATUS = REMOVE
    TRAINING_SYSTEM_STATUS = REMOVE
    PLAY_VS_BOT_STATUS = REMOVE
    RULES_ENGINE_BOT_STATUS = REMOVE vs-bot mode; standalone Simulator REMOVE_CANDIDATE
    WORKER_BOT_STATUS = REMOVE inline Bot and multiplayer GameSession after session drain
    RUST_STATUS = ARCHIVE authored Rust source; delete generated artifacts
    MULTIPLAYER_STATUS = REMOVE
    COLLAB_STATUS = REMOVE unless separately selected
    RULES_SIMULATOR_STATUS = REMOVE_CANDIDATE
    DASHBOARD_STATUS = REMOVE
    COMMUNITY_STATUS = REMOVE_CANDIDATE
    APPS_WEB_STATUS = MIGRATION_EXPERIMENT / UNKNOWN until Vercel inventory
    APPS_API_STATUS = REMOVE_CANDIDATE / UNKNOWN until Vercel inventory

    TARGET_ARCHITECTURE_WITHOUT_DECK_GIT = Root Vite: MTG deckbuilder/manual Goldfish, MTG analyzer, YGO analyzer; local storage + direct Scryfall/YGOProDeck; no application backend after search migration
    TARGET_ARCHITECTURE_WITH_DECK_GIT = Same frontend + minimal authenticated Deck Git Worker API + existing D1; no KV/DO/community dependency

    KEEP_CORE = root Vite; decks/editor; MTG analyzer; YGO analyzer; local manual Goldfish; shared parser/storage/import/export/UI; Scryfall/YGO data adapters
    KEEP_IF_DECK_GIT = repo panel/API; minimal repo/branch/commit/history/restore Worker; D1 identity/tables and auth required by repo permissions
    REMOVE_CANDIDATES = bot-core/bot-ml/Rust; training/ML assets; play-vs-bot; train-bot; Rules Simulator; multiplayer; collaboration; dashboards; community/Deck Hub/public social; analytics; optional rec/Coach/simulation
    LEGACY_ARCHIVE = Rust source/config/locks/docs; selected historical bot specs/devlogs/plans
    GENERATED_DELETE = 1,142 rust-core/target files; generated N-API loader/types/binary/log; 70 training logs + 2 model weights; worker/.wrangler and apps/web/.open-next only after ownership/app decision
    UNKNOWN_OR_BLOCKED = Vercel projects/deployments; D1 table ownership/contents and retention; KV/DO state; active frontend route/host; generated OpenNext ownership; whether Goldfish must enforce MTG rules

    CURRENT_TRACKED_FILES = 1,887
    ESTIMATED_CORE_TRACKED_FILES = 300–450
    ESTIMATED_CORE_PLUS_DECK_GIT_TRACKED_FILES = 400–600

    RECOMMENDED_CLEANUP_SEQUENCE = C1 core frontend/search boundary; C2 bots/ML/Rust/Simulator; C3 multiplayer/collab with DO drain; C4 Deck Git decision; C5 community/dashboards; C6 backend/data; C7 alternate apps/docs/generated files
    FIRST_IMPLEMENTATION_TASK = C1: retain four core routes and manual Goldfish, trim editor wiring, migrate Worker-backed Scryfall search to browser adapter, remove unrelated page links
    BLOCKERS = Decide Deck Git retention; inspect Vercel before removing alternative apps; determine D1/KV/DO data retention; confirm Goldfish stays manual rather than rules-enforcing

No implementation, deletion, deployment, database query or remote mutation was performed.
