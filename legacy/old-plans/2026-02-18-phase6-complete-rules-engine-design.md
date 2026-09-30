# Phase 6: Complete Rules Engine — Design Document

**Date**: 2026-02-18
**Goal**: Raise card coverage from ~75% to ~90% via 4 subsystems
**Approach**: 4 Waves, single session, parallel agents where possible

---

## Wave 1: Targeting System

### Problem
Target validation is binary — "target creature" or "target player". No property filtering (power ≤ 3, nonblack, noncreature, etc.). ~30% of removal/interaction spells need filtered targeting.

### Solution: `TargetFilter` + `parseTargetFilter()` + `validateTarget()`

**New file**: `packages/game-engine/src/rules/targeting.ts`

```typescript
interface TargetFilter {
  zone: 'battlefield' | 'graveyard' | 'hand' | 'library';
  controller?: 'you' | 'opponent' | 'any';
  cardType?: string[];        // ['creature'], ['artifact', 'enchantment']
  excludeType?: string[];     // ['land'] for "nonland permanent"
  power?: { op: 'leq' | 'geq' | 'eq', value: number };
  toughness?: { op: 'leq' | 'geq' | 'eq', value: number };
  cmc?: { op: 'leq' | 'geq' | 'eq', value: number };
  color?: { includes?: Color[], excludes?: Color[] };
  keyword?: { has?: string[], hasNot?: string[] };
  other?: boolean;            // "another creature" (exclude source)
  nontoken?: boolean;
  tapped?: boolean;
  attacking?: boolean;
}
```

**Functions**:
- `parseTargetFilter(oracleText: string): TargetFilter | null` — Regex parser for target descriptions
- `getValidTargets(state, controller, filter): Target[]` — Returns all legal targets
- `validateTarget(state, target, filter): boolean` — Check if a target is still legal (for stack resolution)

**Integration points**:
- `effects.ts` patterns call `getValidTargets()` instead of iterating battlefield manually
- `stack.ts` calls `validateTarget()` before resolving (fizzle if target illegal)
- Bot uses `getValidTargets()` to pick targets intelligently

---

## Wave 2: Keyword Enforcement

### Problem
15+ keywords are parsed but not mechanically enforced during gameplay.

### Fixes by file:

**`combat.ts`** changes:
- **Vigilance**: Skip tapping attacker if `hasKeyword(attacker, 'vigilance')`
- **Skulk**: Can't be blocked by creatures with greater power
- **Fear**: Can only be blocked by artifact creatures or black creatures
- **Intimidate**: Can only be blocked by artifact creatures or creatures sharing a color
- **Annihilator N**: On attack, defending player sacrifices N permanents

**`turn-manager.ts`** changes:
- **Flash**: Allow casting creature/enchantment/artifact at instant speed if `hasKeyword(card, 'flash')`

**`state-based.ts`** changes:
- **Undying**: When creature without +1/+1 counter dies, return with +1/+1 counter
- **Persist**: When creature without -1/-1 counter dies, return with -1/-1 counter

**`effects.ts`** changes:
- **Ward**: When targeting a permanent with ward, controller must pay additional cost or spell fizzles

**`stack.ts`** changes:
- **Ward enforcement**: Check ward cost before resolution

---

## Wave 3: Response & Counter System

### Problem
Players cannot respond to spells on the stack. The priority system technically works (both players pass → resolve), but:
1. The UI auto-passes for the non-active player
2. No "respond?" prompt for the human player
3. Counter-target-spell pattern exists but can't actually be cast in response

### Solution

**`stack.ts`** changes:
- Add `needsResponse` flag to GameState when spell is added to stack
- After adding spell, give priority to opponent (already happens via `giveActivePlayerPriority`)
- On resolution, verify `counter-target-spell` correctly removes the countered spell

**`game-loop.ts`** changes:
- When opponent has priority and stack is non-empty, show "Respond?" UI
- Options: "Pass" (auto-pass priority) or show castable instants/flash cards
- Timer-based auto-pass (3 second default) if no instant-speed plays available
- Highlight cards in hand that can be cast at instant speed

**`turn-manager.ts`** / `actions.ts` changes:
- `getLegalActionTypes()` during opponent's turn: include `cast-spell` for instants and flash cards
- Allow `activate-ability` during any priority window (already works)

**Bot integration** (`decision-tree.ts`):
- Bot evaluates whether to counter/respond when it has priority on non-empty stack
- Simple heuristic: counter high-value spells (removal, wipes, commanders)

---

## Wave 4: Unified Modal System + Tests

### Problem
40+ hardcoded `choose-one-*` patterns in effects.ts. No unified system for modal spells.

### Solution

**New file**: `packages/game-engine/src/rules/modal.ts`

```typescript
interface ModalSpell {
  minChoices: number;  // 1 for "choose one", 2 for "choose two"
  maxChoices: number;
  modes: ModalMode[];
}

interface ModalMode {
  index: number;
  text: string;        // "Draw two cards"
  oracleText: string;  // For effect resolution
}
```

**Functions**:
- `parseModalSpell(oracleText: string): ModalSpell | null` — Detect "Choose one/two/three —" and extract modes
- `resolveModalChoices(state, stackObj, chosenModes): GameState` — Execute each chosen mode as an effect

**GameState addition**:
```typescript
pendingModalChoice?: {
  stackObjectId: string;
  controller: 0 | 1;
  modal: ModalSpell;
  chosen?: number[];
} | null;
```

**Integration**:
- `stack.ts`: Before resolving, check if spell is modal → set `pendingModalChoice`
- `game-loop.ts`: Show modal choice UI when `pendingModalChoice` is set
- `effects.ts`: Remove hardcoded `choose-one-*` patterns, delegate to modal system
- Bot: Pick highest-value mode based on game state evaluation

---

## Files Changed Summary

| File | Wave | Change |
|------|------|--------|
| `targeting.ts` (NEW) | 1 | Target filter system |
| `modal.ts` (NEW) | 4 | Unified modal system |
| `effects.ts` | 1,2,4 | Use targeting, ward, remove hardcoded modals |
| `combat.ts` | 2 | Vigilance, skulk, fear, intimidate, annihilator |
| `stack.ts` | 1,2,3,4 | Target validation, ward, response, modal |
| `turn-manager.ts` | 2,3 | Flash timing, instant-speed actions |
| `state-based.ts` | 2 | Undying, persist |
| `game-loop.ts` | 3,4 | Response UI, modal choice UI |
| `decision-tree.ts` | 3,4 | Counter evaluation, modal selection |
| `actions.ts` | 3 | Instant-speed casting on opponent turn |
| `game-state.ts` | 4 | `pendingModalChoice` field |

**Expected result**: ~75% → ~90% card coverage
