# Linear Dark Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the deck editor's 16.4k-line inline CSS into tokenized files (no visual change), then restyle all five pages to the approved "Linear Dark" look (Mockup Variante A).

**Architecture:** Phase R extracts and tokenizes editor CSS behind a parity gate; Phase D introduces `src/styles/theme.css` as the single source of design tokens and flips pages onto it, with a hand-rebuilt landing hero.

**Tech Stack:** Plain CSS (custom properties), Vite-bundled `<link>` stylesheets, Inter via Google Fonts, Playwright-free visual checks via the in-app browser.

**Spec:** `docs/superpowers/specs/2026-09-30-linear-dark-redesign.md`

## Global Constraints

- Branch `redesign/linear-dark`; one commit per task; commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- New palette (exact values from spec): page `#0b0c10`, card `#111318`, input `#0e1014`, accent `#7c6cf6` / hover `#8f82f8` / soft `#a89cff` / glow `#7c6cf640`, headings `#f4f5f8`, body `#e7e9ee`, secondary `#9aa0ae`, muted `#7d8494`, border `#ffffff12`. Font stack: `Inter, system-ui, sans-serif` (JetBrains Mono stays for code/mana-cost figures).
- Phase R tasks must be **visually identical** before/after: screenshot set S = {editor empty deck, filled board classic view, grid layout mode, search sidebar open with results, Analytics tab, Export tab, goldfish overlay, 375px mobile} compared per task.
- Semantic colors keep their hue family under new token names: ok `#34d399`, danger `#ef4444`, warn `#f59e0b`, info `#60a5fa`. MTG mana colors (W/U/B/R/G pips, color pie segments) are **excluded** from all replacements.
- Gate per task: `npm run build` and `npx vitest run` green.
- The old palette hexes `#c9a84c #e8c84a #8a7230 #e2b340 #b8973f #e8e2d6` must not survive Phase D outside `legacy/` and `docs/`.

## Review Focus

1. Users with `THEME='light'` in localStorage must not get a broken half-light UI once the toggle is gone → verification step in Task 5.
2. Mana-color pips/badges and the color-pie chart must keep W/U/B/R/G colors after the hex migration → screenshot check in Task 3 and Task 10.
3. Card tiles without a loaded Scryfall image must stay readable on the new surfaces (placeholder background/contrast) → check in Task 5.
4. Goldfish overlay (own color world, z-index layers) must remain fully usable after the token flip → dedicated smoke in Task 5.
5. If Google Fonts is blocked/offline, the `system-ui` fallback must render acceptably (no serif fallback) → font stacks verified in Task 4.

---

### Task 1: Extract editor CSS into files (parity)

**Files:**
- Create: `src/styles/editor/editor.css` (only `@import` lines) plus `base.css`, `header.css`, `boards.css`, `search.css`, `panels.css`, `widgets.css`, `goldfish.css`, `modals.css`, `layout-grid.css`, `responsive.css`
- Modify: `deck-editor.html` (lines 25–16488: remove `<style>` block; add `<link rel="stylesheet" href="/src/styles/editor/editor.css">` in `<head>`)

**Interfaces:** Produces the file layout every later task edits. Splitting rule: cut the existing block at its own section comments (`/* ==== ... ==== */`); a rule that fits two files goes to the one matching its primary selector prefix (`.gf-*`→goldfish, `.panel-layout/.layout-grid/.widget-*`→layout-grid, `@media`→responsive). `:root` and element resets go to `base.css`. No rule text changes in this task — move only.

- [ ] **Step 1: Baseline screenshots** — dev server, capture set S (Global Constraints) into scratchpad.
- [ ] **Step 2: Extract** the style block into the files per the splitting rule; wire `editor.css` imports in source order; add the `<link>`.
- [ ] **Step 3: Verify** `npm run build` (vite must emit the CSS) and `npx vitest run` → green; CSP `style-src 'self'` still satisfied (linked CSS is same-origin).
- [ ] **Step 4: Parity** — re-capture set S, compare against Step 1 (visual diff by eye per pair; any difference is a defect in the move).
- [ ] **Step 5: Commit** `refactor: extract deck editor inline CSS into src/styles/editor (no visual change)`

### Task 2: Purge dead editor CSS (parity)

**Files:** Modify: `src/styles/editor/*.css`

- [ ] **Step 1: Candidate list** — for every class prefix among `gf-coach, collab, beta, combo-spellbook, repo, version-panel, community, premium, edhrec, commander-stats, share, cloud-toggle, multiplayer`: grep `deck-editor.html` and `src/deckbuilder/**/*.ts` for the class string; zero hits ⇒ delete its rules. Keep a count of deleted lines in the commit message.
- [ ] **Step 2: Verify** build + tests green; parity re-check of set S (spot-check 4 shots: filled board, search, goldfish, mobile).
- [ ] **Step 3: Commit** `refactor: drop dead editor CSS from removed features`

### Task 3: Tokenize editor colors (parity)

**Files:** Modify: `src/styles/editor/base.css` (token defs), all other `src/styles/editor/*.css` (replacements)

**Interfaces:** Produces the token vocabulary Task 5 flips. New tokens defined in `:root` of `base.css`, initially holding the OLD values: `--surface-0:#08090f  --surface-1:#0c0e16  --surface-2:#12141e  --surface-3:#1a1d2a  --surface-4:#252838  --accent:#c9a84c  --accent-strong:#e8c84a  --accent-dim:#8a7230  --accent-glow:rgba(201,168,76,0.12)  --ok:#34d399  --danger:#ef4444  --warn:#f59e0b  --info:#60a5fa  --text-hi:#e8e2d6  --text-lo:#9a94a8  --text-muted:#706b7f`. The old var names (`--gold`, `--void`, …) become aliases of these tokens during Phase R and are deleted in Task 5.

Replacement table (case-insensitive, longest-first; NOT applied to mana-color rules — exclude any rule whose selector contains `mana-`, `color-pie`, `pip`, `ci-`):
`#c9a84c→var(--accent)`, `#e8c84a|#e2b340→var(--accent-strong)`, `#b8973f|#8a7230→var(--accent-dim)`, `#34d399|#6ee7b7→var(--ok)`, `#ef4444|#f87171|#fca5a5→var(--danger)`, `#f59e0b→var(--warn)`, `#60a5fa→var(--info)`, `#e8e2d6|#e0e0e0|#e2e8f0|#e8e8e8→var(--text-hi)`, `#94a3b8|#9a94a8→var(--text-lo)`, `#64748b|#475569|#6b6580→var(--text-muted)`, surface family `#0a0e17|#0c0e16|#08090f→var(--surface-0/1)` … `#1a1f2e|#1e293b|#1e2a3a|#131a2b|#0f1623→var(--surface-2)`, `#2a2f3e|#252a38|#252838→var(--surface-4)`, `#a78bfa→var(--info)` (violet badge → info family).

- [ ] **Step 1: Scripted replace** per table (python over the css files), print per-hex replacement counts.
- [ ] **Step 2: Audit leftovers** — `grep -o '#[0-9a-f]\{6\}' src/styles/editor/*.css | sort | uniq -c`: every remaining hex is either mana/semantic-excluded or gets a `/* TODO token */`-Kommentar; list them in the commit body.
- [ ] **Step 3: Verify** build + tests + parity spot-check (4 shots) — values are unchanged, only indirection added.
- [ ] **Step 4: Commit** `refactor: tokenize editor colors (values unchanged)`

### Task 4: theme.css design system + fonts (all pages)

**Files:**
- Create: `src/styles/theme.css`
- Modify: `index.html`, `decks.html`, `deck-editor.html`, `mtg.html`, `yugioh.html` (Google-Fonts link → `Inter:wght@400;500;600;700;800` + keep `JetBrains+Mono`; add `<link rel="stylesheet" href="/src/styles/theme.css">` BEFORE page styles)

**Interfaces:** Produces the global tokens Phase D uses everywhere (names shared with Task 3): `--surface-0..4` (new values `#08090a #0b0c10 #111318 #161920 #1c2028`), `--accent:#7c6cf6 --accent-strong:#8f82f8 --accent-soft:#a89cff --accent-glow:#7c6cf640`, text `--text-hi:#f4f5f8 --text-mid:#e7e9ee --text-lo:#9aa0ae --text-muted:#7d8494`, `--border:#ffffff12 --border-strong:#ffffff1f`, semantics unchanged, radii `--r-sm:8px --r-md:10px --r-lg:14px`, `--font-ui:'Inter',system-ui,sans-serif`. Component classes exactly as in design-mockups.html Variante A: `.btn`, `.btn-primary`, `.btn-ghost`, `.input`, `.card`, `.pill`.

- [ ] **Step 1: Write theme.css** (tokens + base body/heading/scrollbar styles + the 6 component classes; ~150 lines, lifted from the mockup's `.va` rules).
- [ ] **Step 2: Wire links + font swap** on all five pages; delete `Cinzel|Cormorant|Outfit|Sora` from font URLs; CSP font/style sources unchanged (fonts.googleapis already allowed).
- [ ] **Step 3: Verify** build green; open each page — pages still render (their own CSS still wins specificity; visible change so far: font fallbacks). Confirm no serif anywhere (Review Focus 5: DevTools → block fonts.googleapis → reload → sans-serif system font, not Times).
- [ ] **Step 4: Commit** `feat: Linear Dark design tokens (theme.css) and Inter font on all pages`

### Task 5: Flip the editor to the new palette

**Files:** Modify: `src/styles/editor/base.css` (token values → theme's new values; delete old-name aliases), other editor css files (fix spots where old aliases were referenced), `deck-editor.html` (font-family cleanups `Cinzel→var(--font-ui)`), `src/deckbuilder/editor-main.ts` (remove `initThemeToggle` + its call; force-remove `theme-light` class on boot)

- [ ] **Step 1: Flip tokens** in `base.css` to the theme.css values (same names ⇒ one edit site); delete `--gold/--void/...` aliases and fix any remaining references (grep).
- [ ] **Step 2: Remove light mode** — delete `initThemeToggle()` and its `init()` call; add one boot line that removes a persisted `theme-light` class so `THEME='light'` users land on dark (Review Focus 1). Delete `body.theme-light` rule blocks from editor CSS.
- [ ] **Step 3: Hotspot polish** by hand against Mockup A: header bar, board tabs, primary buttons (Fill Lands), search sidebar cards, toasts, goldfish overlay top bar. Check card tiles without images (Review Focus 3) and the full goldfish smoke: draw/play/tap/turn/undo/exit (Review Focus 4).
- [ ] **Step 4: Verify** build + tests; screenshot set S in the NEW look (becomes the new reference); mana pips/color pie unchanged (Review Focus 2).
- [ ] **Step 5: Commit** `feat: deck editor in Linear Dark`

### Task 6: Landing page rebuild

**Files:** Modify: `index.html` (hero + game cards + nav + footer sections and their page CSS; body text/SEO sections restyled in place)

- [ ] **Step 1: Rebuild** hero (kicker, gradient headline on `--accent-soft→--accent`, sub, `.btn-primary` "Deck bauen" → /decks, `.btn-ghost` "Deck analysieren" → /mtg), two game cards with `.pill`s (content from current page), simple top nav (wordmark left, links right), legal footer restyled. Remove Cinzel/ornament rules.
- [ ] **Step 2: Verify** build; screenshots desktop + 375px; links klickbar (/decks, /mtg, /yugioh).
- [ ] **Step 3: Commit** `feat: rebuild landing page in Linear Dark`

### Task 7: decks.html + yugioh.html remap

**Files:** Modify: `decks.html` (26 vars, 18 hexes), `yugioh.html` (26 vars, 89 hexes)

- [ ] **Step 1: Remap** each page's `:root` vars to theme tokens (`var(--…)` indirection), replace hardcoded hexes per the Task-3 table logic, swap font-families, restyle buttons/inputs onto `.btn/.input` equivalents where markup allows.
- [ ] **Step 2: Verify** build + page smokes (create deck on /decks; YGO paste-IDs analyze) + screenshots desktop/mobile.
- [ ] **Step 3: Commit** `feat: decks list and YGO analyzer in Linear Dark`

### Task 8: mtg.html remap

**Files:** Modify: `mtg.html` (23 vars, 74 hexes, ~3k CSS lines — remap in place, no extraction per spec)

- [ ] **Step 1: Remap** vars + hexes + fonts as in Task 7; targeted pass over tool drawer, panels, import flow stepper, export grid.
- [ ] **Step 2: Verify** build; smoke: paste deck → Load → stats render; screenshots desktop/mobile.
- [ ] **Step 3: Commit** `feat: MTG analyzer in Linear Dark`

### Task 9: JS-side colors

**Files:** Modify (grep-driven): `src/shared/legal-footer.ts`, `src/deckbuilder/{editor-main,mana-calc,goldfish,draw-probability,health-score,deck-image,deck-fingerprint,synergy-map}.ts`, `src/shared/features/deck-comparison.ts`

- [ ] **Step 1: Replace** old-palette hexes in TS (inline styles, canvas/chart colors) with `var(--…)` where CSS-applied, or literal new values where a canvas needs a concrete color (deck-image renders to canvas → new literals). Mana-W/U/B/R/G constants stay.
- [ ] **Step 2: Verify** `git grep -in "#c9a84c\|#e8c84a\|#8a7230\|#e2b340\|#b8973f\|#e8e2d6" -- src` → empty; build + tests; deck-image export smoke (downloads a PNG with new colors).
- [ ] **Step 3: Commit** `feat: migrate JS-side colors to Linear Dark`

### Task 10: Validation + deploy

- [ ] **Step 1: Grep gate** — forbidden hexes (Global Constraints) absent outside legacy/docs; `Cinzel|Cormorant|Outfit` absent from active pages.
- [ ] **Step 2: Full gates** — `npm run build`, `npx vitest run`.
- [ ] **Step 3: Visual sweep** — all five pages desktop + 375px screenshots; contrast spot-check body text vs surfaces (AA: `#9aa0ae` on `#111318` ≈ 4.6:1 ok; verify the actual pairs used); mana pips/color pie intact.
- [ ] **Step 4: Delete** the scratch `design-mockups.html`.
- [ ] **Step 5: Deploy** — `npm run build`, `cd infra && npx wrangler deploy --config wrangler-frontend.toml`; live smoke of all routes.
- [ ] **Step 6: Commit** any fixes; final commit `chore: linear dark validation + deploy`.
