# Phase 6: Complete Rules Engine — Implementation Plan

**Waves**: 4 | **Tasks**: 10 | **Approach**: Parallel agents per wave

---

## Wave 1: Targeting System (Tasks 1-2, parallel)

### Task 1: Target Filter Parser + Validator
**File**: `packages/game-engine/src/rules/targeting.ts` (NEW)

**TDD**: Write tests first in `packages/game-engine/src/__tests__/targeting.test.ts`

**Tests** (~20):
- `parseTargetFilter("target creature")` → `{ cardType: ['creature'] }`
- `parseTargetFilter("target nonblack creature")` → `{ cardType: ['creature'], color: { excludes: ['B'] } }`
- `parseTargetFilter("target creature with power 3 or less")` → `{ cardType: ['creature'], power: { op: 'leq', value: 3 } }`
- `parseTargetFilter("target artifact or enchantment")` → `{ cardType: ['artifact', 'enchantment'] }`
- `parseTargetFilter("target creature an opponent controls")` → `{ cardType: ['creature'], controller: 'opponent' }`
- `parseTargetFilter("target noncreature permanent")` → `{ excludeType: ['creature'] }`
- `parseTargetFilter("target tapped creature")` → `{ cardType: ['creature'], tapped: true }`
- `parseTargetFilter("target attacking creature")` → `{ cardType: ['creature'], attacking: true }`
- `parseTargetFilter("another creature you control")` → `{ cardType: ['creature'], controller: 'you', other: true }`
- `getValidTargets()` returns only matching permanents
- `validateTarget()` returns false for illegal targets
- `validateTarget()` handles removed-from-battlefield (fizzle)

**Implementation**:
```typescript
export function parseTargetFilter(text: string): TargetFilter | null
export function getValidTargets(state: GameState, controller: 0|1, filter: TargetFilter, sourceId?: string): Target[]
export function validateTarget(state: GameState, target: Target, filter: TargetFilter): boolean
```

Regex patterns to parse:
- `target (nonblack |nonwhite |nonred |nonblue |nongreen )?creature`
- `target (artifact|enchantment|planeswalker|land|permanent)`
- `target .* (with|without) (power|toughness|cmc) (\d+) or (less|greater)`
- `target .* (you control|an opponent controls)`
- `another (creature|permanent) (you control)?`
- `target (tapped|untapped|attacking|blocking) creature`
- `target non(creature|land|token) permanent`

### Task 2: Integrate Targeting into Effects + Stack
**Files**: `effects.ts`, `stack.ts`

**Changes**:
1. Import `{ parseTargetFilter, getValidTargets, validateTarget }` into both files
2. In `stack.ts` `resolveTopOfStack()`: before calling `resolveEffect()`, validate all targets. If any target is invalid, the spell fizzles (goes to GY without effect)
3. In `effects.ts`: Update ~10 key patterns to use `getValidTargets()` for auto-targeting when target is empty:
   - `destroy-target` → validate target is creature/permanent
   - `exile-target` → validate target exists
   - `bounce-target` → validate target on battlefield
   - `damage-to-creature-only` → validate target is creature
   - `put-counters-on-target` → validate target on battlefield
   - `minus-pt-target` → validate target is creature

---

## Wave 2: Keyword Enforcement (Tasks 3-5, parallel)

### Task 3: Combat Keywords (Vigilance, Skulk, Fear, Intimidate, Annihilator)
**File**: `packages/game-engine/src/rules/combat.ts`

**Tests** in `combat.test.ts` (~10):
- Creature with vigilance doesn't tap when attacking
- Creature with skulk can't be blocked by higher-power creature
- Creature with fear can only be blocked by artifact creatures or black creatures
- Creature with intimidate can only be blocked by artifacts or same-color
- Creature with annihilator N forces defending player to sacrifice N permanents

**Implementation**:
- In `declareAttackers()`: check `hasKeyword(perm, 'vigilance')` before setting `tapped: true`
- In `canBlock()` (or create it): add skulk/fear/intimidate checks
- In `declareBlockers()`: validate blocks against skulk/fear/intimidate
- Add `processAnnihilator()`: when attackers declared, trigger annihilator sacrifice

### Task 4: Flash Timing
**File**: `packages/game-engine/src/engine/turn-manager.ts`

**Tests** (~5):
- Card with flash keyword can be cast during opponent's turn
- Card with flash can be cast during combat
- Non-flash creature can NOT be cast during opponent's turn
- Instant can always be cast at instant speed (already works, verify)

**Implementation**:
- In `getCurrentStepActions()` / `getLegalActionTypes()`: when checking if player can cast spells, if it's not their main phase, still allow cards with `flash` keyword or instant type

### Task 5: Undying + Persist (State-Based)
**File**: `packages/game-engine/src/rules/state-based.ts`

**Tests** (~6):
- Creature with undying and no +1/+1 counter returns to BF with +1/+1 counter when it dies
- Creature with undying and a +1/+1 counter stays dead
- Creature with persist and no -1/-1 counter returns with -1/-1 counter
- Creature with persist and a -1/-1 counter stays dead
- Undying creature returns under owner's control

**Implementation**:
- In creature death handling: check `hasKeyword(perm, 'undying')` and `hasKeyword(perm, 'persist')`
- If undying + no +1/+1 counters: return to battlefield with +1/+1 counter
- If persist + no -1/-1 counters: return to battlefield with -1/-1 counter
- Use existing `cardToPermanent()` + add counters

---

## Wave 3: Response & Counter System (Tasks 6-7, parallel)

### Task 6: Instant-Speed Response Framework
**Files**: `actions.ts`, `turn-manager.ts`, `stack.ts`

**Tests** (~8):
- Player can cast instant during opponent's turn
- Player can cast flash creature during opponent's turn
- Player can activate abilities during opponent's turn (already works)
- When spell is on stack, opponent gets priority
- Casting counter-target-spell removes the countered spell from stack
- Countered spell goes to graveyard, effects don't resolve
- If target of counter leaves stack (already resolved), counter fizzles

**Implementation**:
1. `turn-manager.ts`: In `getLegalActionTypes()`, when `priorityPlayer !== activePlayer`:
   - Allow `cast-spell` for instants and cards with flash
   - Allow `activate-ability` (already allowed)
   - Allow `tap-for-mana` (already allowed)
2. `actions.ts`: In `executeCastSpell()`, validate timing:
   - Main phase + empty stack + active player → any spell
   - Otherwise → only instants and flash
3. `stack.ts`: In `resolveTopOfStack()`, when resolving counter-target-spell:
   - Find the targeted StackObject by target ID
   - Remove it from stack, move card to graveyard
   - Log: "X was countered by Y"

### Task 7: Response UI + Bot Response
**Files**: `src/play-vs-bot/game-loop.ts`, `packages/bot-core/src/decision-tree.ts`

**Implementation (UI)**:
1. When `state.priorityPlayer === 0` (human) and `state.stack.length > 0`:
   - Show "Respond?" floating prompt with countdown
   - List castable instants/flash cards from hand
   - "Pass" button to pass priority
   - Auto-pass after 5 seconds if no instant-speed plays available
2. Highlight hand cards that can be played at instant speed

**Implementation (Bot)**:
1. In `decision-tree.ts` `evaluateMainPhaseActions()`:
   - When bot has priority on non-empty stack:
   - Check for counterspells in hand
   - Evaluate: is the stack spell worth countering? (removal targeting bot's creatures = yes, cantrip = no)
   - Simple heuristic: counter if spell CMC ≥ 3 OR targets bot's creatures
2. Add `evaluateResponseActions()` method

---

## Wave 4: Unified Modal System + Final Tests (Tasks 8-10, parallel)

### Task 8: Modal Parser + Resolver
**File**: `packages/game-engine/src/rules/modal.ts` (NEW)

**Tests** in `modal.test.ts` (~12):
- Parse "Choose one —\n• Draw two cards.\n• Gain 5 life." → 2 modes
- Parse "Choose two —\n• Destroy...\n• Draw...\n• Gain..." → 3 modes, minChoices=2
- Parse "Choose one or both —" → minChoices=1, maxChoices=2
- `resolveModalChoices()` executes each chosen mode
- Single choice resolves correctly
- Two choices both resolve in order

**Implementation**:
```typescript
export function parseModalSpell(oracleText: string): ModalSpell | null
export function resolveModalChoices(state: GameState, stackObj: StackObject, chosenModes: number[]): GameState
```

Parse rules:
- `Choose one —` / `Choose two —` / `Choose three —` → minChoices=maxChoices=N
- `Choose one or both —` → min=1, max=2
- `Choose one or more —` → min=1, max=modes.length
- Modes delimited by `\n•` or `\n—` bullet points

### Task 9: Modal Integration (Stack + UI + Bot)
**Files**: `game-state.ts`, `stack.ts`, `game-loop.ts`, `decision-tree.ts`

**Implementation**:
1. `game-state.ts`: Add `pendingModalChoice` field
2. `stack.ts`: Before resolving, call `parseModalSpell()`. If modal, set `pendingModalChoice` and return (don't resolve yet)
3. `game-loop.ts`: When `pendingModalChoice` is set, show modal choice UI (checkboxes/radio for modes)
4. After human chooses, call `resolveModalChoices()` and clear pending
5. `decision-tree.ts`: Bot selects modes by evaluating each mode's effect and picking best combo

### Task 10: Full Test Suite + Build + Deploy
**All packages**: Run all tests, fix any failures, build, commit, deploy

**Steps**:
1. `cd packages/game-engine && npx vitest run` — target: 300+ pass
2. `cd packages/bot-core && npx vitest run` — target: 66+ pass
3. `cd packages/card-data && npx vitest run` — target: 79 pass
4. `npx vite build --mode production` — verify clean build
5. Commit: `feat: Phase 6 — Complete Rules Engine`
6. Deploy API: `cd worker && npx wrangler deploy`

---

## Wave Dependencies

```
Wave 1 (Tasks 1-2): Targeting — sequential (1 then 2)
Wave 2 (Tasks 3-5): Keywords — all parallel
Wave 3 (Tasks 6-7): Response — sequential (6 then 7)
Wave 4 (Tasks 8-10): Modal — 8 then 9, then 10

Wave 1 ──┐
Wave 2 ──┼── Wave 4 (Task 10: final tests)
Wave 3 ──┘
```

Waves 1, 2, 3 can run in parallel. Wave 4's Task 10 depends on all completing.
