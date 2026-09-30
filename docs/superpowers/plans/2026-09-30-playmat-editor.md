# Playmat Deck Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deck editor shell with a playmat: card-image piles on a textured mat, a sort field (type/mana/color/function/tags/free+snap-grid), search results as a bottom hand, and drawers for analyse/share/import — reusing all existing feature modules.

**Architecture:** New `src/playmat/` shell (state + pure pile projection + DOM renderers + one pointer-event drag controller) over the existing `deckbuilder` libraries. `deck-editor.html` is rewritten slim; the old `editor-main.ts` and its orphaned UI modules are deleted at the end after a style carve-out keeps goldfish/modal/preview CSS alive.

**Tech Stack:** Vanilla TS + pointer events (no DnD lib), Vite, Vitest/jsdom, existing theme tokens.

**Spec:** `docs/superpowers/specs/2026-09-30-playmat-editor-design.md`

## Global Constraints

- Branch `feature/playmat-editor`; commit per task; attribution trailer as usual.
- Route stays `/decks/id/*` via `deck-editor.html`; decks.html untouched.
- Reused module APIs are consumed as-is (signatures in each task's Interfaces); no edits to storage/scryfall/goldfish/import/export modules except where a task names them.
- Sort modes and labels exactly per spec; role priority: `wincon > wipe > counter > removal > tutor > ramp > draw > recursion > protection > utility`; lands always `land`.
- Snap grid: cell = 72px at default zoom; `matLayout` stores `{ col, row }` grid coordinates (spec addendum).
- Mobile <900px: piles render as an accordion list, drag disabled, hand becomes a plain results sheet.
- Gates per task: `npm run build` + `npx vitest run` green; browser smoke where the task says so. No deploy before final review.

## Review Focus

1. Old decks (no `matLayout`, legacy fields) and re-saved new decks must round-trip losslessly → tests in Task 3.
2. A 100-card import must stay responsive: only each pile's top card loads an image eagerly → verify in Task 6 smoke with a real 100-card list.
3. Cards matching several roles take the FIRST by priority; cards matching none become `utility` → tests in Task 1.
4. A cancelled drag (Escape / `pointercancel` / drop outside mat) must leave deck data and pile DOM unchanged → test + verify in Task 7.
5. Format `none`/60-card decks: no commander slot is forced and the ring counts against 60/no cap → verify in Task 5.

---

### Task 1: Role classifier

**Files:**
- Create: `src/deckbuilder/role-classifier.ts`
- Test: `tests/unit/role-classifier.test.ts`

**Interfaces:**
- Consumes: `DeckbuilderSearchCard` from `../shared/scryfall-client.js`; regex heuristics may crib from `auto-categories.ts` (`categorizeCard`).
- Produces: `export type Role = 'ramp'|'draw'|'removal'|'wipe'|'counter'|'tutor'|'recursion'|'protection'|'wincon'|'utility'|'land'`; `export function classifyRole(card: Pick<DeckbuilderSearchCard,'type_line'|'oracle_text'>): Role` (single role, priority above); `export const ROLE_LABELS: Record<Role,string>` (German UI labels: Rampe, Kartenzug, Removal, Board Wipes, Counter, Tutoren, Recursion, Schutz, Wincons, Utility, Länder).

- [ ] **Step 1: Write failing tests** — fixtures asserting exact roles: `Sol Ring→ramp`, `Cultivate→ramp`, `Rhystic Study→draw`, `Swords to Plowshares→removal`, `Wrath of God→wipe`, `Counterspell→counter`, `Demonic Tutor→tutor`, `Eternal Witness→recursion`, `Heroic Intervention→protection`, `Thassa's Oracle→wincon`, `Craterhoof Behemoth→wincon` (deals-damage/wins heuristic may be 'wincon' via "each opponent"; if not matched, expected `utility` — pin what the heuristic defines, write the fixture from the implemented rule set, but the 9 above are mandatory), `Island→land`, vanilla creature (`Grizzly Bears`, no text)→`utility`; priority test: a card whose text contains both "destroy all" and "draw a card" → `wipe`.
- [ ] **Step 2: Run** `npx vitest run tests/unit/role-classifier.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** per spec heuristics (regex families over lowercased oracle_text; land check first via type_line).
- [ ] **Step 4: Run** same — PASS. **Step 5: Commit** `feat: MTG role classifier for playmat function sorting`

### Task 2: Pile projection

**Files:**
- Create: `src/playmat/sort.ts`
- Test: `tests/unit/playmat-sort.test.ts`

**Interfaces:**
- Consumes: Task 1 `classifyRole`/`ROLE_LABELS`; `DeckbuilderDeck`, `DeckbuilderCardEntry` from `../deckbuilder/types.js`; card lookup `Record<string, DeckbuilderSearchCard|undefined>`.
- Produces: `export type SortMode = 'type'|'mana'|'color'|'role'|'tags'|'free'`; `export interface Pile { id: string; label: string; entries: DeckbuilderCardEntry[]; count: number }`; `export function projectPiles(deck: DeckbuilderDeck, cardByName: Record<string, DeckbuilderSearchCard|undefined>, mode: Exclude<SortMode,'free'>): Pile[]` (commander excluded — it has its own zone; mainboard only; deterministic pile order: type order Creature→Land as in spec, mana 0..7+, WUBRG-Multi-Colorless-Lands, role priority order, tags alphabetical with `Untagged` last). `count` sums qty.

- [ ] **Step 1: Failing tests** — `test_type_mode_groups_and_orders`, `test_mana_mode_7plus_and_lands_pile`, `test_color_mode_multicolor_and_colorless`, `test_role_mode_uses_classifier`, `test_tags_mode_untagged_last`, `test_unresolved_card_lands_in_utility_or_unknown` (entry with no card data → pile `Unbekannt` at the end, never a crash).
- [ ] **Step 2: RED** → **Step 3: implement** → **Step 4: GREEN** (`npx vitest run tests/unit/playmat-sort.test.ts`). **Step 5: Commit** `feat: playmat pile projection for all sort modes`

### Task 3: matLayout model + persistence

**Files:**
- Modify: `src/deckbuilder/types.ts` (add `matLayout?: MatLayout` to `DeckbuilderDeck`; `export interface MatLayout { piles: Array<{ id: string; col: number; row: number }> }`)
- Create: `src/playmat/layout.ts`
- Test: `tests/unit/playmat-layout.test.ts`

**Interfaces:**
- Produces: `export function seedLayout(piles: Pile[]): MatLayout` (left-to-right rows, 2 grid-cols per pile, commander zone reserves cols 0-1); `export function snapToGrid(xPx: number, yPx: number, cell?: number): { col: number; row: number }` (cell default 72); `export function layoutFor(deck: DeckbuilderDeck, piles: Pile[]): MatLayout` (existing layout reconciled: new piles appended, vanished piles dropped).
- Consumes: `Pile` from Task 2; storage round-trip via existing `upsertDeck`/`getDeckById`.

- [ ] **Step 1: Failing tests** — `test_snap_rounds_to_nearest_cell` (100,130 → col 1,row 2), `test_seed_reserves_commander_cols`, `test_reconcile_keeps_existing_positions_appends_new`, `test_storage_roundtrip_preserves_matLayout` (upsert→getDeckById), `test_old_deck_without_matLayout_loads` (extends existing compat pattern).
- [ ] **Step 2: RED** → **Step 3: implement** → **Step 4: GREEN**. **Step 5: Commit** `feat: playmat free-mode layout model with snap grid`

### Task 4: Shell skeleton + style carve-out

**Files:**
- Rewrite: `deck-editor.html` (slim: head w/ CSP+fonts+theme.css+`/src/styles/playmat.css`, body = `#pmHeader #pmSortbar #pmMat #pmHand #pmActions` containers + legal footer script + `<script type="module" src="/src/playmat/main.ts">`)
- Create: `src/playmat/main.ts`, `src/playmat/state.ts`, `src/styles/playmat.css`
- Modify: `src/styles/editor/editor.css` (becomes the OLD bundle, no longer linked) — instead `playmat.css` `@import`s the kept slices: `editor/base.css` (tokens), `editor/goldfish.css`, `editor/modals.css` (toast/confirm/context/detail/hover-preview) — Step 1 verifies those files contain every class the kept modules render (`card-preview`, `context-menu`, `confirm-modal`, `toast`, `goldfish`); any needed rule living in a dying slice (boards/search/panels/misc) is MOVED into `modals.css` first.
- Test: manual smoke (shell has no logic worth unit-testing yet).

**Interfaces:**
- Produces `state.ts`: `export interface PlaymatState { deck: DeckbuilderDeck; cardByName: Record<string, DeckbuilderSearchCard|undefined>; sortMode: SortMode; }`; `export function initState(deckId: string): PlaymatState | null` (getDeckById + setLastOpenedDeckId); `export function mutateDeck(state: PlaymatState, fn: (d: DeckbuilderDeck) => void): void` (pushSnapshot → fn → upsertDeck → emit `'deck-changed'` on `document`); `export function resolveMissing(state: PlaymatState): Promise<void>` (resolveDeckbuilderCards for unresolved names, emits `'cards-resolved'`).
- `main.ts` wires: parse `/decks/id/<id>` (reuse old `parseDeckIdFromPath` logic re-implemented ~10 lines), initToastContainer, initCardPreview, initContextMenu, initUndoStack, Ctrl+Z/Y → undo/redo + re-render, renders header (name input → mutateDeck rename; format chip; progress ring SVG fed by `summarizeDeckCardCounts` + format rules from `live-validation.getFormatRules`; `⋯` menu: duplicate/delete/back).

- [ ] **Step 1: Style carve-out audit** — grep class names used by card-preview/context-menu/confirm-modal/toast/goldfish TS against the kept css slices; move strays; record moved selectors in commit body.
- [ ] **Step 2: Build shell** (html + main/state + css layout shells for the five containers, mat texture per mockup).
- [ ] **Step 3: Verify** `npm run build` + `npx vitest run` green; browser: `/decks/id/<existing>` shows header with correct name + ring count, empty mat, no console errors; goldfish smoke NOT yet wired (button comes in Task 8).
- [ ] **Step 4: Commit** `feat: playmat shell skeleton replaces old editor markup`

### Task 5: Mat rendering

**Files:**
- Create: `src/playmat/mat.ts`
- Modify: `src/playmat/main.ts` (render loop on `deck-changed`/`cards-resolved`/sort change), `src/styles/playmat.css`

**Interfaces:**
- Consumes: Tasks 1–4 (`projectPiles`, `layoutFor`, state), `showDetailModal`, `showContextMenu`, `showHoverPreview/hide`.
- Produces: `export function renderMat(root: HTMLElement, state: PlaymatState): void` — commander zone (filled card or dashed "Commander wählen" CTA that emits `'open-commander-search'`; hidden when `deck.format !== 'commander'`), piles per current mode (free mode positions absolute per `matLayout`, other modes flow layout), pile = label+count+stacked cards (top card `<img loading="eager">` from `image_uris.normal`, lower cards `loading="lazy"`), hover lift (CSS), click → detail modal, contextmenu → existing menu (qty ±, move board, tags), trailing "Neuer Stapel" dashed target (visible in `tags` and `free` modes). Maybeboard/Sideboard docks at right edge: collapsed count chips, click toggles a tray listing entries (reuse `.crow`-style rows) with "→ Mainboard" action.
- Sort bar renders the six modes; switching re-renders; active mode persisted per deck in localStorage key `dl_pm_sort_<deckId>`.

- [ ] **Step 1: Implement** renderMat + sortbar wiring.
- [ ] **Step 2: Verify (browser)** — existing 2-card deck: piles correct in all five sorted modes; format `none` deck shows no commander slot and ring shows `N` without /100 (Review Focus 5); context menu qty ± mutates and re-renders; detail modal opens.
- [ ] **Step 3: Commit** `feat: playmat mat rendering with piles, commander zone and board docks`

### Task 6: Search + hand

**Files:**
- Create: `src/playmat/hand.ts`
- Modify: `src/playmat/main.ts`, `src/styles/playmat.css`

**Interfaces:**
- Consumes: `searchDeckbuilderCards`, `fetchDeckbuilderAutocomplete` (debounce 250ms), state `mutateDeck`.
- Produces: `export function initHand(root: HTMLElement, state: PlaymatState): void` — header input (`/` focuses, Escape clears+collapses), results fan max 7 + `‹ ›` paging, card hover enlarges, `+` or Enter (top hit) adds 1 to mainboard (`mutateDeck` + toast), commander-search mode: listening to `'open-commander-search'` pre-fills query `legal:commander` + `type:legendary creature` filter params and `+` sets the commander board instead.
- 100-card perf check belongs to import (Task 8) but hand adds use the same pile re-render — Step 2 includes a quick 30-add stress by script.

- [ ] **Step 1: Implement**. **Step 2: Verify (browser)** — search "lightning" → fan renders with images; `+` adds (ring + pile update); Enter adds top hit; commander CTA → filtered search → sets commander into zone.
- [ ] **Step 3: Commit** `feat: playmat search hand`

### Task 7: Drag controller + snap grid

**Files:**
- Create: `src/playmat/drag.ts`
- Test: `tests/unit/playmat-drag.test.ts` (logic-level: snap + drop resolution, jsdom)
- Modify: `src/playmat/mat.ts`, `hand.ts` (attach handlers)

**Interfaces:**
- Consumes: `snapToGrid` (Task 3), state.
- Produces: `export function initDrag(matRoot: HTMLElement, state: PlaymatState): void` — single pointer-event controller (pointerdown on `[data-drag]`, threshold 6px, ghost element follows pointer): (a) hand card → mat: drop on a pile assigns to mainboard (+tag in tags-mode), drop on empty mat in free mode creates a loose pile at snapped cell; (b) card → other pile: in tags-mode re-tags, otherwise moves qty 1 between boards only via docks; (c) free mode: dragging a pile header moves the pile, target cell highlighted (`.pm-snap-hint` element), release writes snapped `{col,row}` via `mutateDeck`. Escape or `pointercancel` aborts: ghost removed, NO state mutation (Review Focus 4).
- Produces for tests: `export function resolveDrop(px: number, py: number, mode: SortMode, pilesAt: (c:number,r:number)=>string|null): { kind:'pile';id:string }|{ kind:'cell';col:number;row:number }|null`.

- [ ] **Step 1: Failing tests** — `test_resolveDrop_snaps_free_cell`, `test_resolveDrop_hits_pile`, `test_escape_leaves_layout_untouched` (call abort path, assert matLayout unchanged).
- [ ] **Step 2: RED → implement → GREEN** (`npx vitest run tests/unit/playmat-drag.test.ts`).
- [ ] **Step 3: Verify (browser)** — drag hand→mat adds; free mode: pile snaps to grid with hint, reload keeps position; Escape mid-drag reverts visual and data.
- [ ] **Step 4: Commit** `feat: playmat drag controller with snap-to-grid free placement`

### Task 8: Drawers (Analyse · Teilen · Import) + Goldfish button

**Files:**
- Create: `src/playmat/drawers.ts`
- Modify: `src/playmat/main.ts`, `src/styles/playmat.css`

**Interfaces:**
- Consumes: analyse renderers `renderHealthScore`, `analyzeManaBase`/`renderManaCalc`, `renderSynergyMap`, `renderDrawProbability`, curve/color data via `analyzers.ts` helpers as used by old `computeAnalyticsData` (re-implement the small curve/color tally locally ~30 lines — do NOT import editor-main); export `serializeDeckForExport` + `generateShareUrl` + `downloadDeckImage` + `generatePrintHTML`; import `parseDeckbuilderImportText`/`resolveParsedImportLines`/`toBoardsFromResolvedImport`/`mergeBoards` + `resolveDeckbuilderCards` with the try/catch-toast pattern; goldfish `openGoldfishPlaytest(deck, cardByName)`.
- Produces: `export function initDrawers(root: HTMLElement, state: PlaymatState): void` — four floating buttons; right drawer (420px, Escape closes): **Analyse** = 3 stat cards + curve bars + color dots + health box + collapsed "Mehr" section hosting synergy map & draw probability; **Teilen** = format select + textarea + copy + share-link + image/print buttons; **Import** = textarea + file drop + "Importieren" running the resolver incl. unresolved-select rows (port the old markup minimally). HUD in sortbar: Health (calculateDeckHealth total), Avg MV, Lands, legality line from `evaluateEdhRules`/`getFormatRules` — amber text on issues, green check otherwise, click opens Analyse drawer.

- [ ] **Step 1: Implement** drawers + HUD.
- [ ] **Step 2: Verify (browser)** — import a real 100-card Commander list (Review Focus 2: initial pile render <1s feel, only top images eager), analyse values plausible, export text matches list, share link opens `/mtg?deck=`-style analyzer link, goldfish opens and plays a turn, unresolved-row flow with a fake card name.
- [ ] **Step 3: Commit** `feat: playmat drawers for analyse, share, import and goldfish entry`

### Task 9: Old-shell removal, mobile fallback, validation

**Files:**
- Delete: `src/deckbuilder/editor-main.ts` + orphaned old-shell modules (grep-guarded: view-modes, panel-layout, cmd-palette, search-syntax, deck-doctor, deck-linter, deck-dsl-parser, hand-tester, collection-panel, collection?, budget-*, matchup-panel, smart-recs stack, what-if, recommendation-trust, rec-worker-client, deck-diff?, pricing?, geo-currency?, onboarding, shortcut-help, panel css slices boards/search/panels/widgets/layout-grid/misc/legacy-collab/responsive/controls) — a module dies only when `git grep` shows no importer outside the dead set; `deck-diff`(snapshots), `pricing`, `edh-rules`, `live-validation`, `auto-categories`, `deck-image`, `goldfish*`, `card-autocomplete`? (hand has its own input — autocomplete module dies if unused) are decided by that grep, not by this list.
- Modify: `src/styles/playmat.css` (mobile <900px accordion: piles as stacked lists, drag off, hand as sheet), `vitest`/tests (delete tests of deleted modules ONLY if their subject died).

- [ ] **Step 1: Mobile fallback** CSS + drag-guard (`matchMedia('(max-width: 899px)')` disables initDrag). Verify 375px: accordion list usable, add via `+`.
- [ ] **Step 2: Orphan purge** with per-module grep evidence in commit body; build+tests green after each batch.
- [ ] **Step 3: Full validation** — `npm run build`, `npx vitest run`; browser sweep: create→commander→build 10 cards→all six sort modes→free+snap→reload→import 100→analyse→export→goldfish→undo; emoji/palette greps clean; delete `design-editor-*.html` scratch files.
- [ ] **Step 4: Commit** `feat: playmat editor replaces legacy editor shell` — then final review (fresh reviewer) before merge/deploy.
