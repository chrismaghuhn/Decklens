# DeckLens Redesign "Linear Dark" — Design Spec

Date: 2026-09-30
Status: Approved direction (chat); spec pending owner review
Chosen direction: Mockup **Variante A — "Linear"** (design-mockups.html, untracked scratch file)

## Goal

Replace the current dark-brown/gold fantasy look (Cinzel/Cormorant serif fonts,
ornamental styling) with a modern, clean dark design across all five pages:

- Neutral dark surfaces: page `#0b0c10`, raised cards `#111318`, inputs `#0e1014`
- Accent: Indigo/Violett `#7c6cf6` (hover `#8f82f8`, soft `#a89cff`, glow `#7c6cf640`)
- Text scale: `#f4f5f8` (headings) / `#e7e9ee` (body) / `#9aa0ae` (secondary) / `#7d8494` (muted)
- Borders: `#ffffff12` default, accent-tinted on hover
- Typography: **Inter** everywhere (400–800); fantasy fonts removed
- Shape: 10–14px radii, subtle shadows, generous spacing; no ornaments/gradient text
  except the hero headline gradient

Owner decision (2026-09-30): **refactor the deck editor's CSS first**, then apply
the redesign. Order of work: Phase R (refactor) → Phase D (redesign).

## Phase R — Deck editor CSS refactoring (prerequisite)

`deck-editor.html` carries ~16,400 lines of inline CSS with 1,330 hardcoded hex
colors and 209 font-family declarations. Before restyling:

1. **Extract** the inline `<style>` block into structured files under
   `src/styles/editor/`, split by domain:
   `base.css` (reset, tokens, typography), `header.css`, `boards.css` (rows,
   views, drag/drop), `search.css` (sidebar, autocomplete, filters),
   `panels.css` (tabs: import/analytics/prices/export/strategy), `widgets.css`
   (charts, health, mana-calc, combos…), `goldfish.css`, `modals.css`
   (toasts, confirm, context menu, onboarding, doctor), `layout-grid.css`
   (panel-layout/grid mode), `responsive.css`. A single `editor.css` imports
   them; deck-editor.html references it via `<link rel="stylesheet">` (Vite
   bundles linked CSS from HTML entries).
2. **Delete dead rules**: selectors whose markup/JS no longer exists after the
   core extraction (known: `gf-coach-*`, `collab-*`, `beta-*`, `combo-spellbook`,
   repo/version-panel, community-share). Verify each via grep against
   deck-editor.html + src/deckbuilder before deletion.
3. **Tokenize colors**: replace hardcoded hexes with CSS variables. The 1,330
   hexes cluster around the old palette (gold tones, brown/near-black surfaces,
   text grays, semantic red/green/blue); build an explicit mapping table
   old-hex → token in the plan. Unmappable one-offs stay as literals with a
   `/* TODO token */` note, listed for review.
4. **No visual change in Phase R**: tokens initially carry the OLD values.
   Gate: before/after screenshots of editor key states (empty deck, filled
   board, search open, analytics tab, goldfish overlay, grid layout, 375px
   mobile) must match apart from sub-pixel noise; build + tests green.

mtg.html (~3,000 CSS lines) is NOT deep-refactored; it gets the lighter
treatment in Phase D. index/decks/yugioh are small enough to edit in place.

## Phase D — Redesign

1. **`src/styles/theme.css`** (loaded by every page, before page CSS):
   `:root` design tokens (colors above, spacing scale, radii `--r-sm/md/lg`,
   shadows, font stack `Inter, system-ui, sans-serif`), base element styles
   (body, headings, links, scrollbars) and shared component classes
   (`.btn`/`.btn-primary`/`.btn-ghost`, `.input`, `.card`, `.pill`, `.tabs`)
   matching Mockup A. Google-Fonts link for Inter replaces Cinzel/Cormorant/
   Outfit/Sora on all pages.
2. **Editor**: flip the Phase-R token values to the new palette; polish
   hotspots by hand (header, board tabs, search sidebar, goldfish overlay,
   toasts). The old light-theme toggle maps to a provisional light token set
   or is hidden if it can't be made presentable within scope (owner call in
   plan review — default: hide toggle, keep dark only for now).
3. **Landing (index.html)**: rebuild hero + game cards + footer in Mockup-A
   style (kicker, gradient headline, primary/ghost CTAs, two game cards with
   pills and stat row). Content stays (links to /decks, /mtg, /yugioh, legal
   footer); marketing/SEO text sections get restyled, not rewritten.
4. **decks.html, yugioh.html**: remap their `:root` vars to theme tokens,
   swap fonts, fix hardcoded hexes (18 / 89) by hand.
5. **mtg.html**: same remap + font swap + targeted pass over its 74 hexes and
   panel/button/tool-drawer styles.
6. **JS-side colors**: grep `src/**` for old palette hexes in inline styles /
   chart colors (`style.cssText`, canvas/chart configs) and migrate to tokens
   via `var(--…)` or a small `getCssVar()` helper.

## Non-goals

- No layout/IA changes beyond the landing hero (boards, tabs, tools stay where
  they are); no new features; no light-theme redesign beyond the owner call in
  D2; no mtg.html deep CSS extraction.

## Validation

- Per step: `npm run build` (tsc + vite) and `npx vitest run` green.
- Phase R gate: visual parity screenshots (states listed above).
- Phase D: screenshots of all five pages desktop + 375px; interactive smoke
  (deck create/edit/search/goldfish, MTG analyze, YGO analyze); contrast check
  of new text/surface pairs (WCAG AA for body text); grep shows no old-palette
  hexes (`#c9a84c`, `#e8c84a`, `#8a7230`, old browns) outside legacy/.
- Final: fresh-context review, then deploy via wrangler and live smoke.

## Risks

- Scripted hex→token replacement may hit unrelated colors (e.g. mana-color
  badges W/U/B/R/G must keep their semantic colors) — the mapping table is
  explicit, semantic game colors are excluded.
- Editor grid/classic layout modes double many selectors; screenshots cover both.
- Third-party-ish visuals (card scans from Scryfall) dominate some views;
  design must hold with and without loaded images.
