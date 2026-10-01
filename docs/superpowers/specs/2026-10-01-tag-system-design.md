# Tag System Upgrade — Design Spec

**Date:** 2026-10-01
**Status:** Draft for review
**Scope:** Playmat "Custom Tags" mode — automatic role tags + managing user tags.

## Problem

The Custom Tags sort mode is useless until the user hand-tags cards: everything
sits in one "Untagged" pile. Research (Moxfield feedback board) shows tagging is
the single most-cited chore ("the most time consuming thing"), while a vocal
minority explicitly does not want tags forced on them. User tags also cannot be
renamed or deleted deck-wide today — a typo lives forever.

## Design

### 1. Auto-tags are VIRTUAL, never stored

When the auto-tags toggle is on, the tags projection buckets every card that has
**no user tags** into its role pile(s) from the role classifier (Ramp, Card
Draw, Removal, Board Wipes, Counterspells, Tutors, Recursion, Protection,
Wincons, Utility, Lands — multi-role cards appear in each matching pile).
Cards **with** user tags are untouched and keep their user piles.

Why virtual instead of writing tags into the deck:

- Zero data pollution — `entry.tags` stays 100% user intent; export, share and
  versions never carry machine guesses.
- Instantly reversible and retroactive: the toggle reshuffles the whole deck,
  on or off, with no migration and no undo noise.
- Classifier improvements apply to old decks automatically.

Trade-off accepted: auto piles are not editable as piles (they are a view).
Converting a guess into a real tag is one drag (see 3.).

### 2. Toggle

- A chip `Auto-tags` in the sortbar, visible only in Custom Tags mode (and Free
  mode with tags base), next to the density/zoom controls.
- Persisted per deck: `dl_pm_autotags_<deckId>`. **Default: ON** — the mode is
  then immediately useful; purists switch it off once and it stays off.
- Off = exact current behavior (user piles + "Untagged").

### 3. Pile semantics in tags mode

| Pile kind | Header style | Drop of a card | Header right-click |
|---|---|---|---|
| User tag | as today | assigns that user tag (today's behavior) | **Rename tag… / Delete tag… /** Collapse |
| Auto pile (role) | dimmed + gear glyph, label e.g. `RAMP · AUTO` | assigns the role name as a **real user tag** (converts guess → intent) | Collapse only |
| Untagged | only exists with auto-tags OFF | clears tags (today) | Collapse only |

- Pile ids for auto piles are namespaced (`pile-auto-<role>`) so free-mode
  layout positions never collide with a user tag that shares the label.

### 4. User tag management (right-click on a user tag pile header)

- **Rename tag…** — prompt; renames the tag on every card in one `mutateDeck`
  (one undo step). Case-insensitive collision with an existing tag merges, with
  a confirm.
- **Delete tag…** — confirm; removes the tag from every card in one
  `mutateDeck`. Cards whose last tag is removed fall back to Untagged/auto.
- Both operate on user tags only.

### 5. Non-goals

- Tag hierarchies / sub-tags (research interest exists, but YAGNI for v1).
- Writing auto-tags into storage, now or on export.
- Scryfall oracle-tags (not available per card via API).
- Any change to the other sort modes or the targets strip (they already use the
  classifier directly).

## Touched code

- `src/playmat/sort.ts` — `projectPiles(..., { autoTags })`: pure extension,
  unit-tested (untagged → role piles incl. multi-role; user piles unchanged;
  off = current output; auto ids namespaced).
- `src/playmat/mat.ts` — toggle chip wiring, auto-pile styling, header
  context menu (rename/delete/collapse), drop-on-auto-pile → user tag,
  `renameTag`/`deleteTag` bulk ops (one undo step each, unit-testable logic
  extracted).
- `src/playmat/drag.ts` — pile label lookup already generic; auto piles pass
  their role label as the assigned tag.
- `src/styles/playmat.css` — auto pile header style, chip.
- Tests: projection cases + rename/merge/delete logic.

## Review focus

1. A deck where every card is user-tagged must render identically with the
   toggle on and off.
2. Multi-role cards appear in several auto piles — the pile counts then sum to
   more than the deck total; the HUD/ring totals must stay card-based.
3. Renaming a tag to an existing tag's name (any case) merges without
   duplicating tags on cards carrying both.
4. Free-mode positions saved for `pile-auto-ramp` must never apply to a user
   tag pile labelled "Ramp" (and vice versa).
5. Dropping on an auto pile with the toggle later switched off leaves a real
   user tag — intended, but the pile the card lands in changes; no data loss.
