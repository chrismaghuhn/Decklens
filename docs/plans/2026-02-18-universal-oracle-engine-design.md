# Phase 5: Universal Oracle Engine

## Goal
Transform DeckLens from ~30% card playability to ~75%+ by building a universal ability execution system that automatically makes any MTG card playable from its Oracle text alone.

## Problem Statement
The engine can **parse** abilities (mana, activated, loyalty, static) via `parseAbilities()` in `abilities.ts`, but cannot **execute** them. Players see abilities on permanents but can only interact via manual resolution. This makes 70% of cards effectively non-functional during gameplay.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Oracle Text (Scryfall)              │
└─────────────────┬───────────────────────────────────┘
                  │ parseAbilities() [EXISTS]
                  ▼
┌─────────────────────────────────────────────────────┐
│              Ability[] on Permanent                  │
│  { type: 'mana'|'activated'|'static', cost, text }  │
└─────────────────┬───────────────────────────────────┘
                  │
      ┌───────────┼───────────┐
      ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│   Cost   │ │  Target  │ │  Effect  │
│  Parser  │ │  Parser  │ │ Resolver │
│   [NEW]  │ │   [NEW]  │ │ [EXISTS] │
└────┬─────┘ └────┬─────┘ └────┬─────┘
     │            │            │
     └────────────┴────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────┐
│             Ability Executor [NEW]                   │
│  1. Validate: Can player afford cost?               │
│  2. Pay: Tap, sacrifice, spend mana, pay life       │
│  3. Stack: Push activated ability onto stack         │
│  4. Resolve: Run effect through resolveEffect()     │
└─────────────────────────────────────────────────────┘
```

## Five Pillars

### Pillar 1: Cost Parser & Payment System
**File**: `packages/game-engine/src/rules/cost-parser.ts` (NEW, ~400 LOC)

Parses cost strings like `{2}{B}, {T}, Sacrifice a creature` into a structured `AbilityCost`:

```typescript
interface AbilityCost {
  mana?: string;           // "{2}{B}" — parsed mana cost
  tap?: boolean;           // {T} — tap this permanent
  untap?: boolean;         // {Q} — untap this permanent
  sacrificeSelf?: boolean; // "Sacrifice ~"
  sacrificeType?: string;  // "Sacrifice a creature" → "creature"
  sacrificeCount?: number; // "Sacrifice two creatures" → 2
  payLife?: number;        // "Pay 3 life" → 3
  discardCount?: number;   // "Discard a card" → 1
  discardType?: string;    // "Discard a land card" → "land"
  exileFromGY?: number;    // "Exile three cards from your graveyard" → 3
  removeCounters?: { type: string; count: number }; // "Remove a +1/+1 counter"
  loyalty?: number;        // Planeswalker: +1, -3, etc.
}
```

**Functions**:
- `parseCost(costString: string): AbilityCost` — Parse raw cost text
- `canPayCost(state: GameState, player: 0|1, permanentId: string, cost: AbilityCost): boolean` — Validate
- `payCost(state: GameState, player: 0|1, permanentId: string, cost: AbilityCost): GameState` — Execute payment

### Pillar 2: Ability Executor
**File**: `packages/game-engine/src/rules/ability-executor.ts` (NEW, ~500 LOC)

Orchestrates cost payment → stack push → effect resolution.

**Functions**:
- `getActivatableAbilities(state: GameState, player: 0|1): ActivatableAbility[]` — List all abilities the player can currently activate (affordability + timing checks)
- `executeActivatedAbility(state: GameState, player: 0|1, permanentId: string, abilityId: string, targets?: Target[]): GameState` — Full execution pipeline
- `executeManaAbility(state: GameState, player: 0|1, permanentId: string, abilityId: string): GameState` — Instant mana (no stack)

**Stack integration**: Activated abilities go on the stack as a `StackObject` with:
- `source: permanentId`
- `oracleText: ability.text` (the effect portion)
- `controller: player`
Then resolved by existing `resolveEffect()`.

### Pillar 3: Mana System Upgrade
**File**: Modify `packages/game-engine/src/engine/actions.ts` (~300 LOC changes)

Currently `tap-for-mana` only works for lands. Upgrade to work for ANY permanent with `type: 'mana'` abilities.

**Changes**:
- `executeTapForMana()` — Check permanent's `abilities` array for mana abilities, produce the correct colors
- `getAutoTapPlan()` — Include non-land mana sources (Sol Ring, Arcane Signet, mana dorks) in auto-tap logic
- `validation.ts` — Allow `tap-for-mana` for any permanent with mana abilities

**Effect**: Sol Ring, Arcane Signet, Llanowar Elves, Chromatic Lantern, etc. all work automatically.

### Pillar 4: Equipment & Aura System
**File**: `packages/game-engine/src/rules/attachment.ts` (NEW, ~350 LOC)

**Equipment**:
- Parse equip cost from Oracle text (`Equip {2}`, `Equip—Pay 3 life`)
- `executeEquip()` already exists — enhance to use cost parser
- On equip: apply stat bonuses and keywords as continuous effects
- On equipped creature death: equipment remains, detached
- On equipment destruction: remove bonuses

**Auras**:
- On cast: require target selection (creature/permanent/player)
- On ETB: attach to target
- Grant continuous effects while attached
- On attached permanent leaving: aura goes to graveyard (CR 704.5m)
- `enchantedPermanentId` field on Permanent type

**Continuous Effects** integration:
- `getStaticBonuses()` already exists — extend to check attached equipment/auras
- Parse "+2/+2" and keyword grants from attachment Oracle text

### Pillar 5: Planeswalker Execution
**File**: Modify `packages/game-engine/src/engine/actions.ts` (~250 LOC changes)

Loyalty abilities are already parsed by `parseAbilities()`. Missing: execution.

**Changes**:
- `executeActivateLoyalty()` — enhanced to:
  1. Find the selected loyalty ability by index
  2. Adjust loyalty counters (add for +N, remove for -N)
  3. Extract effect text from ability
  4. Create StackObject with effect text
  5. Push onto stack for resolution via `resolveEffect()`
- `validation.ts` — Validate loyalty ability activation (once per turn, enough loyalty)

## Files Modified

| File | Action | Est. LOC |
|------|--------|----------|
| `rules/cost-parser.ts` | **NEW** | ~400 |
| `rules/ability-executor.ts` | **NEW** | ~500 |
| `rules/attachment.ts` | **NEW** | ~350 |
| `rules/abilities.ts` | MODIFY — enhance parsing | ~100 |
| `engine/actions.ts` | MODIFY — mana + loyalty + equip | ~400 |
| `engine/validation.ts` | MODIFY — ability activation legality | ~150 |
| `types/permanent.ts` | MODIFY — attachment fields | ~30 |
| `types/action.ts` | MODIFY — ability action data | ~20 |
| `rules/continuous.ts` | MODIFY — equipment/aura bonuses | ~100 |
| `rules/effects.ts` | MODIFY — new patterns for common abilities | ~200 |
| `bot-core/decision-tree.ts` | MODIFY — ability activation decisions | ~100 |
| `bot-core/play-policy.ts` | MODIFY — evaluate ability activation | ~80 |
| `play-vs-bot/game-loop.ts` | MODIFY — UI for ability activation | ~150 |
| Tests | **NEW** | ~300 |
| **Total** | | **~2,880** |

## Implementation Waves

### Wave 1: Foundation (No Dependencies)
- **Step 1**: Cost Parser (`cost-parser.ts`)
- **Step 2**: Target Parser enhancement
- **Step 3**: Permanent type extensions (attachment fields)
- **Step 4**: New effect patterns for common activated ability effects

### Wave 2: Core Systems (Depends on Wave 1)
- **Step 5**: Mana System Upgrade (all permanents produce mana)
- **Step 6**: Ability Executor (cost → stack → resolve pipeline)
- **Step 7**: Validation upgrades (ability activation legality)

### Wave 3: Attachment & Planeswalker (Depends on Wave 2)
- **Step 8**: Equipment system
- **Step 9**: Aura system
- **Step 10**: Planeswalker loyalty execution
- **Step 11**: Continuous effects for attachments

### Wave 4: Bot & UI (Depends on Wave 3)
- **Step 12**: Bot ability activation (decision tree + play policy)
- **Step 13**: UI ability activation (click permanent → show abilities)
- **Step 14**: Integration tests

## Success Criteria

1. **Sol Ring** produces {C}{C} when tapped → player can cast 3-drop turn 1
2. **Sakura-Tribe Elder** can be sacrificed to search for a basic land
3. **Lightning Greaves** can be equipped, grants haste + shroud
4. **Jace, the Mind Sculptor** can activate all 4 loyalty abilities
5. **Rhystic Study** triggers on opponent spell cast, offers draw
6. **Swords to Plowshares** exiles target creature, gains life
7. Bot activates abilities intelligently (mana abilities before casting, removal at right time)
8. **259 existing tests still pass** + 30+ new tests

## Risk Mitigation

- **Complex cards**: Cards with unusual abilities fall back to manual resolution (existing system)
- **Ambiguous costs**: Cost parser returns `unparseable: true` → manual activation
- **Pattern coverage**: New patterns added only for top-100 ability effects; the rest use closest match or manual
- **No breaking changes**: All new code is additive; existing pattern matching remains primary resolver

## Competitive Position After Phase 5

| Feature | DeckLens (Post-P5) | Forge | Moxfield |
|---------|:-:|:-:|:-:|
| Card Playability | ~75% | 99% | 0% (goldfish) |
| Web-Native | ✅ | ❌ (Java) | ✅ |
| ML Bot | ✅ | ❌ | ❌ |
| Deck Analytics | ✅ | ❌ | ✅ |
| Setup Required | None | JRE install | None |
| Auto-resolution | Pattern-based | Card-specific | N/A |
