# Playmat Deck Editor — Design Spec

Date: 2026-09-30
Status: Direction approved by owner (chat); spec pending owner review
Prior art: docs/cleanup audits; Linear/Editorial redesign specs. Mockup:
`design-editor-playmat.html` (untracked scratch, deleted at the end).

## Goal

Rebuild the deck editor **shell from scratch** around a physical-table
metaphor: the deck lies on a **playmat** as image-card piles; a **sort
field** regroups the mat by different facets; search results arrive as a
fanned **hand** at the bottom edge and are dragged (or clicked) onto the
mat. The current editor (deck-editor.html + editor-main.ts) is replaced at
the same route `/decks/id/*`; the old shell remains recoverable from git.

Owner's driving complaints about the old editor: clunky, not intuitive,
too many competing panels/tabs, features hidden in wrong places.
Owner's two explicit requirements beyond the mockup:
1. **Freedom** — users can place cards/piles anywhere on the mat, not only
   into auto-sorted columns.
2. **Function sorting** — group cards by what they DO (the Magic analogue
   of Yu-Gi-Oh hand traps): Ramp, Card Draw, Removal, Board Wipe, Counter,
   Tutor, Recursion, Protection, Wincon, Utility, Lands.

## What is reused (not rebuilt)

The feature modules survive as libraries; only the shell is new:
`storage.ts` (decks, localStorage), `scryfall-client.ts` (search/resolve/
autocomplete), `deck-parser` / `import-resolver` / `deck-export` /
`deck-sharing` (lz-string links), `goldfish.ts` (overlay, opens over the
mat unchanged), analytics engines (`analyzers`, `recommendation-v1`,
`matchup-guide`, health/mana/bracket/synergy/draw-probability renderers),
`auto-categories.ts` (basis for the Function classifier), `icons.ts`,
`theme.css`, editor token palette. `undo-stack`, `toast`, `confirm-modal`,
`card-preview` (hover zoom) are kept.

Explicitly NOT carried over into the new shell: the Classic/Grid dual
layout system (panel-layout.ts), the five-tab right panel, the Tools
dropdown, view-modes.ts (list/pile/grid view machinery), bulk bar,
command palette, primer/notes editor, hand-tester (superseded by
Goldfish), deck-doctor modal, collection/budget/matchup/smart-recs/
what-if panels as OWN surfaces — their engines stay importable and the
Analyse drawer may re-host them later, but parity for these panels is a
non-goal of this rebuild. Deck list page (decks.html) is untouched.

## Layout (from approved mockup)

- **Header** (one slim row): deck name (inline edit), format chip, ONE
  search input (center-right, `/` focuses, Enter adds top hit to the mat),
  progress ring `N/100` replacing all error banners. Overflow menu `⋯`
  hosts rename/duplicate/delete/back-to-list.
- **Sort bar**: `SORTIEREN NACH  [Kartentyp] [Manakosten] [Farbe]
  [Funktion] [Eigene Tags] [Frei]` + right-aligned HUD: Health, Avg MV,
  Lands, Legality (green check / amber text — never a red banner; details
  on click).
- **Mat**: textured surface. Commander zone pinned top-left (empty state:
  dashed ember slot "Commander wählen" that opens search filtered to
  legendary creatures — this replaces the old scary validation banners).
  Card piles: overlapping card images (Scryfall `normal`), pile label +
  count, hover lifts a card, click opens the existing detail modal,
  right-click opens the existing context menu (qty, move board, tags).
  A trailing dashed "Neuer Stapel" target creates a custom tag pile.
- **Hand**: fixed bottom fan of search results (max 7 visible, paging
  arrows). Drag from hand to mat adds the card (to the pile it lands on —
  in tag/custom modes that assigns the tag); `+` button or Enter adds
  without dragging. Hand collapses when search is empty.
- **Floating actions** bottom-right: `Analyse`, `Goldfish`, `Teilen`
  (share/export), `Import`. Each opens a right-side drawer or overlay:
  - Analyse drawer: the three core stats large, mana curve, colors,
    health breakdown; "Mehr" links re-host existing renderers
    (DNA, synergy, combos, draw probability) inside the drawer.
  - Goldfish: existing overlay as-is.
  - Teilen: export formats (text/Arena/MTGO/CSV), share link, print,
    deck image — from existing modules.
  - Import: paste/file, existing resolver incl. unresolved-row UI.

## Sort modes

All modes operate on the same deck data; piles are a pure projection.
- **Kartentyp**: Creature, Planeswalker, Instant, Sorcery, Enchantment,
  Artifact, Battle, Land (type_line based).
- **Manakosten**: 0,1,2,3,4,5,6,7+ (lands separate pile).
- **Farbe**: W,U,B,R,G, Multicolor, Colorless, Lands (color_identity).
- **Funktion**: role classifier (below).
- **Eigene Tags**: existing per-card `tags` from types.ts; dragging a card
  onto a pile sets the tag; "Neuer Stapel" creates a tag.
- **Frei**: free placement. Every pile (and loose card) has an `{x,y}`
  position on the mat, draggable anywhere; positions persist per deck
  (`deck.matLayout`). Entering Frei the first time seeds positions from
  the last sorted view. Other modes ignore matLayout (non-destructive).
  **Snap-to-grid** (owner requirement): the mat exposes a snap grid
  aligned with its visible texture (cell = half a card width, 72px at
  default zoom); while dragging, the drop target cell highlights and the
  pile snaps to the nearest grid point on release. Stored positions are
  grid coordinates (col/row), so layouts stay aligned across viewport
  sizes.

Boards: the mat shows the mainboard+commander. Maybeboard/Sideboard are
two docked side piles at the mat's right edge (collapsed stacks with
count; click expands to a tray) — no separate board-tab row.

## Function classifier (MTG roles)

`src/deckbuilder/role-classifier.ts`, pure function
`classifyRole(card: DeckbuilderSearchCard): Role[]` with
`Role = 'ramp'|'draw'|'removal'|'wipe'|'counter'|'tutor'|'recursion'|
'protection'|'wincon'|'utility'|'land'`. Heuristics over type_line +
oracle_text (regex families), e.g.: ramp = "add {" mana / "search ...
land" on ≤3 MV permanents; draw = "draw a card/cards"; removal = destroy/
exile target; wipe = "destroy all/each"; counter = "counter target";
tutor = "search your library for" (non-land); recursion = "return ...
from your graveyard"; protection = hexproof/indestructible/phase/counter
protection granting; wincon = "you win the game"/combo staples/
"deals damage to each opponent". A card takes its FIRST matching role by
priority (wincon > wipe > counter > removal > tutor > ramp > draw >
recursion > protection > utility); lands always 'land'. Builds on
`auto-categories.ts` heuristics where they exist. Unit-tested against a
fixture list of ~30 well-known cards.

## Data model changes

`DeckbuilderDeck` gains optional `matLayout?: { mode: 'free';
piles: Array<{ id: string; x: number; y: number; cardKeys: string[] }> }`
and nothing else. Old decks without it load fine (compat test exists).
Custom tags reuse the existing `tags: string[]` on entries.

## Non-goals

- No feature parity for the retired panels listed above (engines stay).
- No mobile drag&drop redesign: below 900px the mat renders piles as a
  scrollable accordion list (same data, no dragging); hand becomes a
  results sheet. Playmat interactions are desktop-first.
- No multiplayer/cloud anything. No change to /mtg, /yugioh, decks.html.

## Validation

- Unit: role-classifier fixtures; matLayout persistence round-trip;
  storage compat (old decks, decks with matLayout).
- Browser smoke: create deck → commander slot → search → hand → drag/+
  → pile updates + ring updates; each sort mode regroups correctly;
  Frei-mode drag + reload persists; maybeboard tray; import a 100-card
  list; export/share; Goldfish opens and plays; undo works for add/remove.
- Gates: `npm run build`, `npx vitest run` green; old-palette/emoji greps
  stay clean; fresh-context review before deploy.

## Risks

- editor-main.ts replacement: the new shell starts small; risk is scope
  creep toward old-panel parity — the Non-goals list is the fence.
- Drag&drop complexity (HTML5 DnD vs pointer events): use pointer events
  with a single drag controller; no library.
- Scryfall image volume on large decks: lazy-load pile images below the
  top card (only top card of each pile needs an image initially).
