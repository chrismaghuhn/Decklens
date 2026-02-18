# Phase 5: Universal Oracle Engine — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make ~75% of MTG cards fully playable by upgrading the ability execution pipeline with a universal cost parser, enhanced mana system, and smarter bot ability activation.

**Architecture:** The engine already has `parseAbilities()` (extracts abilities from Oracle text), `executeActivateAbility()` (pays tap+mana costs and puts on stack), `executeTapForMana()` (all permanents), `executeActivateLoyalty()` (planeswalker), and a full equipment/aura system. The gap is: (1) non-mana costs in activated abilities (sacrifice, life, discard, exile, counters), (2) the bot never activates abilities, (3) the UI doesn't show ability activation options, and (4) ~50 common effect patterns are missing.

**Tech Stack:** TypeScript, Vitest, Vite, pnpm monorepo

---

## Current State (Post Phase 4)

**Already working:**
- `parseAbilities()` → extracts mana, activated, loyalty, static abilities from Oracle text
- `executeActivateAbility()` → pays {T} + mana costs, pushes to stack
- `executeTapForMana()` → works for ALL permanents (Sol Ring, dorks, etc.)
- `executeActivateLoyalty()` → full loyalty ability pipeline with stack
- `equipment.ts` → full equip/detach/aura/cleanup system
- `resolveEffect()` → 166 effect patterns for auto-resolution
- 259 passing tests, 0 failures

**Gaps (what this plan fixes):**
1. **Cost Parser**: Sacrifice, pay life, discard, exile-from-GY, remove-counters costs not supported
2. **Bot Ability Activation**: Bot never activates abilities on its permanents
3. **UI Ability Picker**: No UI to click a permanent and see its activatable abilities
4. **Missing Effect Patterns**: ~30 common ability effects not yet matched
5. **Aura ETB Targeting**: Auras don't prompt for target selection on cast

---

## Task 1: Cost Parser Module

**Files:**
- Create: `packages/game-engine/src/rules/cost-parser.ts`
- Test: `packages/game-engine/src/__tests__/cost-parser.test.ts`

**Step 1: Write the failing tests**

```typescript
// cost-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseCost, type AbilityCost } from '../rules/cost-parser.ts';

describe('parseCost', () => {
  it('should parse tap-only cost', () => {
    const cost = parseCost('{T}');
    expect(cost.tap).toBe(true);
    expect(cost.mana).toBeUndefined();
  });

  it('should parse mana + tap cost', () => {
    const cost = parseCost('{2}{B}, {T}');
    expect(cost.tap).toBe(true);
    expect(cost.mana).toBe('{2}{B}');
  });

  it('should parse sacrifice self cost', () => {
    const cost = parseCost('{T}, Sacrifice ~');
    expect(cost.tap).toBe(true);
    expect(cost.sacrificeSelf).toBe(true);
  });

  it('should parse sacrifice a creature cost', () => {
    const cost = parseCost('Sacrifice a creature');
    expect(cost.sacrificeType).toBe('creature');
    expect(cost.sacrificeCount).toBe(1);
  });

  it('should parse pay life cost', () => {
    const cost = parseCost('Pay 3 life');
    expect(cost.payLife).toBe(3);
  });

  it('should parse discard cost', () => {
    const cost = parseCost('Discard a card');
    expect(cost.discardCount).toBe(1);
  });

  it('should parse exile from graveyard cost', () => {
    const cost = parseCost('Exile three cards from your graveyard');
    expect(cost.exileFromGY).toBe(3);
  });

  it('should parse remove counters cost', () => {
    const cost = parseCost('Remove a +1/+1 counter from ~');
    expect(cost.removeCounters).toEqual({ type: '+1/+1', count: 1 });
  });

  it('should parse complex multi-part cost', () => {
    const cost = parseCost('{1}{B}, {T}, Sacrifice a creature');
    expect(cost.mana).toBe('{1}{B}');
    expect(cost.tap).toBe(true);
    expect(cost.sacrificeType).toBe('creature');
  });

  it('should parse Phyrexian mana cost', () => {
    const cost = parseCost('{W/P}');
    expect(cost.phyrexianMana).toBe('{W/P}');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd packages/game-engine && npx vitest run src/__tests__/cost-parser.test.ts`
Expected: FAIL — module not found

**Step 3: Implement cost-parser.ts**

```typescript
// cost-parser.ts
export interface AbilityCost {
  mana?: string;
  tap?: boolean;
  untap?: boolean;
  sacrificeSelf?: boolean;
  sacrificeType?: string;
  sacrificeCount?: number;
  payLife?: number;
  discardCount?: number;
  discardType?: string;
  exileFromGY?: number;
  removeCounters?: { type: string; count: number };
  loyalty?: number;
  phyrexianMana?: string;
  unparseable?: boolean;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
};

function parseNumber(s: string): number {
  const lower = s.toLowerCase().trim();
  return NUMBER_WORDS[lower] ?? parseInt(lower, 10) || 1;
}

export function parseCost(costString: string): AbilityCost {
  const cost: AbilityCost = {};
  // Normalize: split by comma, process each segment
  const segments = costString.split(',').map(s => s.trim());

  for (const seg of segments) {
    const lower = seg.toLowerCase();

    // {T} — tap
    if (/\{t\}/i.test(seg)) cost.tap = true;
    // {Q} — untap
    if (/\{q\}/i.test(seg)) cost.untap = true;

    // Sacrifice self: "Sacrifice ~" or "Sacrifice CARDNAME"
    if (/sacrifice\s+(~|this|CARDNAME)/i.test(seg)) {
      cost.sacrificeSelf = true;
    }
    // Sacrifice type: "Sacrifice a/an/two creature(s)"
    else if (/sacrifice\s+(a|an|one|two|three|\d+)\s+(\w+)/i.test(seg)) {
      const m = seg.match(/sacrifice\s+(a|an|one|two|three|\d+)\s+(\w+)/i);
      if (m) {
        cost.sacrificeCount = parseNumber(m[1]);
        cost.sacrificeType = m[2].replace(/s$/, '').toLowerCase();
      }
    }

    // Pay life: "Pay N life"
    const lifeMatch = seg.match(/pay\s+(\d+)\s+life/i);
    if (lifeMatch) cost.payLife = parseInt(lifeMatch[1], 10);

    // Discard: "Discard a/N card(s)"
    const discardMatch = seg.match(/discard\s+(a|an|one|two|three|\d+)\s+(\w+)/i);
    if (discardMatch) {
      cost.discardCount = parseNumber(discardMatch[1]);
      const type = discardMatch[2].replace(/s$/, '').toLowerCase();
      if (type !== 'card') cost.discardType = type;
    }

    // Exile from graveyard: "Exile N cards from your graveyard"
    const exileMatch = seg.match(/exile\s+(a|an|one|two|three|four|five|\d+)\s+cards?\s+from\s+your\s+graveyard/i);
    if (exileMatch) cost.exileFromGY = parseNumber(exileMatch[1]);

    // Remove counters: "Remove a +1/+1 counter from ~"
    const counterMatch = seg.match(/remove\s+(a|an|one|two|three|\d+)\s+([+\-\d/]+)\s+counter/i);
    if (counterMatch) {
      cost.removeCounters = {
        count: parseNumber(counterMatch[1]),
        type: counterMatch[2],
      };
    }

    // Phyrexian mana: {W/P}, {U/P}, etc.
    const phyrexMatch = seg.match(/\{[WUBRG]\/P\}/i);
    if (phyrexMatch) cost.phyrexianMana = phyrexMatch[0];

    // Mana symbols (extract all {N}, {W}, {U}, etc. but not {T}/{Q})
    const manaSymbols = seg.match(/\{[0-9WUBRGCXS]+\}/gi);
    if (manaSymbols) {
      const filtered = manaSymbols.filter(s => !/^\{[TQ]\}$/i.test(s));
      if (filtered.length > 0) cost.mana = filtered.join('');
    }
  }

  return cost;
}
```

**Step 4: Run test to verify it passes**

Run: `cd packages/game-engine && npx vitest run src/__tests__/cost-parser.test.ts`
Expected: PASS all 11 tests

**Step 5: Commit**

```bash
git add packages/game-engine/src/rules/cost-parser.ts packages/game-engine/src/__tests__/cost-parser.test.ts
git commit -m "feat(engine): add universal cost parser for activated abilities"
```

---

## Task 2: Cost Validation & Payment

**Files:**
- Modify: `packages/game-engine/src/rules/cost-parser.ts` (add canPayCost + payCost)
- Test: `packages/game-engine/src/__tests__/cost-parser.test.ts` (extend)

**Step 1: Write the failing tests**

```typescript
// Add to cost-parser.test.ts
import { canPayAbilityCost, payAbilityCost } from '../rules/cost-parser.ts';
import { createTestState, createSimpleCard, cardToPermanent } from '../engine/factory.ts';

describe('canPayAbilityCost', () => {
  it('should return true for affordable tap cost', () => {
    const state = createTestState();
    const perm = state.players[0].battlefield[0]; // untapped land
    const cost = parseCost('{T}');
    expect(canPayAbilityCost(state, 0, perm.id, cost)).toBe(true);
  });

  it('should return false for tapped permanent', () => {
    const state = createTestState();
    const bf = [...state.players[0].battlefield];
    bf[0] = { ...bf[0], tapped: true };
    const newState = { ...state, players: [{ ...state.players[0], battlefield: bf }, state.players[1]] };
    const cost = parseCost('{T}');
    expect(canPayAbilityCost(newState, 0, bf[0].id, cost)).toBe(false);
  });

  it('should validate sacrifice cost against battlefield', () => {
    const state = createTestState();
    const cost = parseCost('Sacrifice a creature');
    // Player needs at least 1 creature
    const hasCreature = state.players[0].battlefield.some(p => p.typeLine.toLowerCase().includes('creature'));
    expect(canPayAbilityCost(state, 0, '', cost)).toBe(hasCreature);
  });

  it('should validate pay life cost', () => {
    const state = createTestState();
    const cost = parseCost('Pay 3 life');
    expect(canPayAbilityCost(state, 0, '', cost)).toBe(state.players[0].life >= 3);
  });
});
```

**Step 2: Implement canPayAbilityCost and payAbilityCost**

Add to `cost-parser.ts`:

```typescript
import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import { canPayCost as canPayManaCost, parseManaCost, autoTapLandsForCost } from './mana.ts';

export function canPayAbilityCost(
  state: GameState, player: 0 | 1, permanentId: string, cost: AbilityCost
): boolean {
  const ps = state.players[player];

  // Tap: permanent must be untapped and not summoning sick (for creatures)
  if (cost.tap) {
    const perm = ps.battlefield.find(p => p.id === permanentId);
    if (!perm || perm.tapped) return false;
    if (perm.summoningSick && perm.currentPower !== undefined) return false;
  }

  // Mana: player must be able to pay
  if (cost.mana) {
    const manaCost = parseManaCost(cost.mana);
    if (!canPayManaCost(ps.manaPool, manaCost, ps.life)) {
      const tapResult = autoTapLandsForCost(ps, manaCost);
      if (!tapResult) return false;
    }
  }

  // Sacrifice self
  if (cost.sacrificeSelf) {
    if (!ps.battlefield.some(p => p.id === permanentId)) return false;
  }

  // Sacrifice type
  if (cost.sacrificeType && cost.sacrificeCount) {
    const matching = ps.battlefield.filter(p =>
      p.typeLine.toLowerCase().includes(cost.sacrificeType!) && p.id !== permanentId
    );
    if (matching.length < cost.sacrificeCount) return false;
  }

  // Pay life
  if (cost.payLife && ps.life < cost.payLife) return false;

  // Discard
  if (cost.discardCount && ps.hand.length < cost.discardCount) return false;

  // Exile from graveyard
  if (cost.exileFromGY && ps.graveyard.length < cost.exileFromGY) return false;

  // Remove counters
  if (cost.removeCounters) {
    const perm = ps.battlefield.find(p => p.id === permanentId);
    if (!perm) return false;
    const available = perm.counters[cost.removeCounters.type] || 0;
    if (available < cost.removeCounters.count) return false;
  }

  return true;
}

export function payAbilityCost(
  state: GameState, player: 0 | 1, permanentId: string, cost: AbilityCost
): GameState {
  let ps = state.players[player];
  let bf = [...ps.battlefield];
  const logs: string[] = [];

  // Tap
  if (cost.tap) {
    const idx = bf.findIndex(p => p.id === permanentId);
    if (idx !== -1) bf[idx] = { ...bf[idx], tapped: true };
  }

  // Mana payment
  if (cost.mana) {
    const manaCost = parseManaCost(cost.mana);
    let updatedPlayer = { ...ps, battlefield: bf };
    if (!canPayManaCost(updatedPlayer.manaPool, manaCost, updatedPlayer.life)) {
      const tapResult = autoTapLandsForCost(updatedPlayer, manaCost);
      if (tapResult) updatedPlayer = tapResult.updatedPlayer;
    }
    const payment = autoPayCost(updatedPlayer.manaPool, manaCost, updatedPlayer.life);
    if (payment) {
      const newPool = payCost(updatedPlayer.manaPool, manaCost, payment);
      updatedPlayer = { ...updatedPlayer, manaPool: newPool };
    }
    ps = updatedPlayer;
    bf = ps.battlefield;
  }

  // Sacrifice self
  if (cost.sacrificeSelf) {
    const perm = bf.find(p => p.id === permanentId);
    if (perm) {
      bf = bf.filter(p => p.id !== permanentId);
      ps = { ...ps, graveyard: [...ps.graveyard, permToCard(perm)] };
      logs.push(`Sacrifices ${perm.name}.`);
    }
  }

  // Pay life
  if (cost.payLife) {
    ps = { ...ps, life: ps.life - cost.payLife };
    logs.push(`Pays ${cost.payLife} life.`);
  }

  // Remove counters
  if (cost.removeCounters) {
    const idx = bf.findIndex(p => p.id === permanentId);
    if (idx !== -1) {
      const counters = { ...bf[idx].counters };
      counters[cost.removeCounters.type] = (counters[cost.removeCounters.type] || 0) - cost.removeCounters.count;
      bf[idx] = { ...bf[idx], counters };
    }
  }

  ps = { ...ps, battlefield: bf };
  const players = [...state.players] as [PlayerState, PlayerState];
  players[player] = ps;

  return {
    ...state,
    players,
    log: [...state.log, ...logs.map(message => ({
      timestamp: Date.now(), turn: state.turn, phase: state.phase,
      step: state.step, player, message,
    }))],
  };
}
```

**Step 3: Run tests**

Run: `cd packages/game-engine && npx vitest run src/__tests__/cost-parser.test.ts`

**Step 4: Commit**

```bash
git add packages/game-engine/src/rules/cost-parser.ts packages/game-engine/src/__tests__/cost-parser.test.ts
git commit -m "feat(engine): add cost validation and payment for all cost types"
```

---

## Task 3: Integrate Cost Parser into executeActivateAbility

**Files:**
- Modify: `packages/game-engine/src/engine/actions.ts:430-492` (executeActivateAbility)
- Test: `packages/game-engine/src/__tests__/ability-activation.test.ts` (NEW)

**Step 1: Write the failing test**

```typescript
// ability-activation.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestGame } from '../engine/factory.ts';
import { resetIdCounter, createSimpleCard, cardToPermanent, generateCardId } from '../engine/factory.ts';

describe('Ability Activation', () => {
  beforeEach(() => resetIdCounter());

  it('should execute sacrifice-self ability (Sakura-Tribe Elder)', () => {
    // Create a creature with "{T}, Sacrifice ~: Search your library for a basic land..."
    // Activate the ability → creature should be sacrificed, land searched
  });

  it('should pay life cost for ability (Necropotence-style)', () => {
    // Create permanent with "Pay 1 life: Draw a card"
    // Activate → life reduced, card drawn
  });

  it('should not activate if cannot pay cost', () => {
    // Create tapped permanent with {T} cost → should fail
  });
});
```

**Step 2: Refactor executeActivateAbility to use cost-parser**

In `actions.ts`, replace the inline cost parsing (lines 443-489) with:

```typescript
import { parseCost, canPayAbilityCost, payAbilityCost } from '../rules/cost-parser.ts';

function executeActivateAbility(state, action) {
  const player = state.players[action.player];
  const source = player.battlefield.find(p => p.id === action.sourceId);
  if (!source) return state;
  const ability = source.abilities[action.abilityIndex];
  if (!ability) return state;

  // Parse and pay cost using universal cost parser
  const cost = parseCost(ability.cost || '');
  if (!canPayAbilityCost(state, action.player, action.sourceId, cost)) return state;
  let newState = payAbilityCost(state, action.player, action.sourceId, cost);

  // If source was sacrificed as part of cost, the ability still goes on stack
  return addAbilityToStack(newState, action.sourceId, action.abilityIndex, action.player, action.targets);
}
```

**Step 3: Run all tests**

Run: `cd packages/game-engine && npx vitest run`
Expected: All 259+ pass

**Step 4: Commit**

```bash
git add packages/game-engine/src/engine/actions.ts packages/game-engine/src/__tests__/ability-activation.test.ts
git commit -m "feat(engine): integrate universal cost parser into ability execution"
```

---

## Task 4: Common Effect Patterns for Abilities (~30 new patterns)

**Files:**
- Modify: `packages/game-engine/src/rules/effects.ts` (add patterns)
- Test: `packages/game-engine/src/__tests__/ability-effects.test.ts` (NEW)

The most common activated ability effects that aren't yet matched:

```
Group A — Protection/Prevention:
- "~ gains hexproof until end of turn"          → already exists
- "~ gains indestructible until end of turn"     → already exists
- "Prevent all combat damage that would be dealt to ~" → new

Group B — Draw/Filter:
- "Look at the top N cards... put one into your hand" → new: 'look-top-put-hand'
- "Scry 1, then draw a card"                     → combo of existing
- "Draw a card, then discard a card"              → already exists

Group C — Removal:
- "Exile target creature with power N or less"    → new: 'exile-creature-power-leq'
- "~ deals N damage to target attacking or blocking creature" → new
- "Destroy target tapped creature"                → already exists

Group D — Tokens:
- "Create a 1/1 white Soldier creature token"     → already exists
- "Create X 1/1 tokens where X is ~'s power"      → new: 'create-tokens-equal-power'

Group E — Counters:
- "Put a +1/+1 counter on each creature you control" → already exists
- "Put a charge counter on ~"                      → new: 'put-charge-counter-self'
- "Remove a charge counter from ~: Add {M}"        → handled by mana

Group F — Graveyard:
- "Return target creature card from your graveyard to your hand" → already exists
- "Exile target card from a graveyard"             → already exists

Group G — Pump:
- "~ gets +X/+X until end of turn where X is..."   → new: 'pump-equal-to-count'
- "Other creatures you control get +1/+1"           → already exists (continuous)

Group H — Tap/Untap:
- "Tap target creature"                            → already exists
- "Untap target creature"                          → already exists
- "Tap target creature. It doesn't untap..."       → new: 'tap-no-untap'
```

**Implementation**: Add ~15-20 new patterns to EFFECT_PATTERNS array. Each pattern is ~15-25 lines.

**Step 1: Write tests for new patterns**
**Step 2: Add patterns to effects.ts**
**Step 3: Run all tests**
**Step 4: Commit**

---

## Task 5: Bot Ability Activation

**Files:**
- Modify: `packages/bot-core/src/decision-tree.ts` (add ability activation decision)
- Modify: `packages/bot-core/src/policies/play-policy.ts` (evaluate abilities)
- Create: `packages/bot-core/src/__tests__/ability-activation.test.ts`

**Step 1: Add getActivatableAbilities to play-policy**

```typescript
export function getAbilityActivationCandidates(
  state: GameState, player: 0 | 1
): { permanentId: string; abilityIndex: number; priority: number }[] {
  const candidates = [];
  const ps = state.players[player];

  for (const perm of ps.battlefield) {
    for (let i = 0; i < perm.abilities.length; i++) {
      const ability = perm.abilities[i];
      if (ability.type === 'mana' || ability.type === 'static') continue;

      const cost = parseCost(ability.cost || '');
      if (!canPayAbilityCost(state, player, perm.id, cost)) continue;

      // Timing check: instant-speed or sorcery-speed
      if (!ability.instantSpeed && state.step !== 'main') continue;

      // Score the ability
      let priority = 0;
      const text = ability.text.toLowerCase();
      if (text.includes('draw')) priority += 4;
      if (text.includes('destroy') || text.includes('exile')) priority += 5;
      if (text.includes('search')) priority += 4;
      if (text.includes('token')) priority += 3;
      if (text.includes('+1/+1 counter')) priority += 2;
      if (text.includes('damage')) priority += 3;

      candidates.push({ permanentId: perm.id, abilityIndex: i, priority });
    }
  }

  return candidates.sort((a, b) => b.priority - a.priority);
}
```

**Step 2: Add to decision tree**

In `decision-tree.ts`, after cast-spell attempt and before pass:

```typescript
// Try activating an ability
const abilityCandidates = getAbilityActivationCandidates(state, player);
if (abilityCandidates.length > 0) {
  const best = abilityCandidates[0];
  return {
    action: {
      type: 'activate-ability',
      player,
      sourceId: best.permanentId,
      abilityIndex: best.abilityIndex,
    },
    confidence: 0.5 + best.priority * 0.05,
    reasoning: 'Activate ability on permanent',
  };
}
```

**Step 3: Tests + commit**

---

## Task 6: UI Ability Picker

**Files:**
- Modify: `src/play-vs-bot/game-loop.ts` (add ability picker on permanent click)
- Modify: `play-vs-bot.html` (CSS for ability picker modal)

**Step 1: Add onBattlefieldCardClick handler**

When player clicks a permanent on their battlefield:
1. Check if it has activatable abilities
2. Show a modal with ability options (similar to the existing cost-modal)
3. Each ability shows: cost, effect text, whether it can be activated
4. Clicking an ability: auto-pay cost, submit action

```typescript
function showAbilityPicker(permanent: Permanent, state: GameState) {
  const abilities = permanent.abilities.filter(a =>
    a.type === 'activated' && canPayAbilityCost(state, 0, permanent.id, parseCost(a.cost || ''))
  );

  if (abilities.length === 0) return;

  // Show modal with Arcane Forge styling
  const modal = document.createElement('div');
  modal.id = 'ability-modal';
  // ... (Arcane Forge styled modal, same pattern as cost-modal)
}
```

**Step 2: Add CSS for ability picker**

```css
.ability-option {
  padding: 12px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.2s;
}
.ability-option:hover { border-color: var(--gold); }
.ability-cost { color: var(--gold); font-family: 'JetBrains Mono'; }
.ability-effect { color: var(--text); }
.ability-disabled { opacity: 0.4; pointer-events: none; }
```

**Step 3: Commit**

---

## Task 7: Aura ETB Targeting

**Files:**
- Modify: `packages/game-engine/src/engine/actions.ts` (executeCastSpell section)
- Modify: `packages/game-engine/src/rules/stack.ts` (handle aura resolution)

When an Aura spell resolves:
1. Check for "Enchant creature/permanent" in type line
2. Prompt target selection (UI) or auto-select (bot)
3. Attach to target using existing `equipment.ts` attachment logic
4. Apply continuous effects (P/T bonuses, keyword grants)

**Step 1: Modify stack resolution for Auras**

In `resolveStackObject()`:
```typescript
if (isAura(stackObject.card)) {
  // Need a target to attach to
  if (stackObject.targets.length === 0) {
    return { ...state, needsManualResolution: true };
  }
  // Resolve as permanent, then attach
  state = putPermanentOnBattlefield(state, stackObject);
  state = attachAura(state, newPermanent.id, stackObject.targets[0]);
}
```

**Step 2: Tests + commit**

---

## Task 8: Integration Tests — Top 20 Commander Cards

**Files:**
- Create: `packages/game-engine/src/__tests__/top-cards-integration.test.ts`

Test that these cards work end-to-end:

```typescript
const TOP_CARDS = [
  { name: 'Sol Ring', oracle: '{T}: Add {C}{C}', test: 'produces 2 colorless' },
  { name: 'Arcane Signet', oracle: '{T}: Add one mana of any color in your commander\'s color identity', test: 'produces mana' },
  { name: 'Lightning Greaves', oracle: 'Equipped creature has haste and shroud.\nEquip {0}', test: 'grants haste+shroud' },
  { name: 'Sakura-Tribe Elder', oracle: '{T}, Sacrifice Sakura-Tribe Elder: Search...basic land...battlefield tapped', test: 'sac for land' },
  { name: 'Swords to Plowshares', oracle: 'Exile target creature. Its controller gains life equal to its power.', test: 'exile+life' },
  { name: 'Kodama\'s Reach', oracle: 'Search your library for up to two basic land cards...', test: 'search lands' },
  { name: 'Cultivate', oracle: 'Search your library for up to two basic land cards...', test: 'search lands' },
  { name: 'Beast Within', oracle: 'Destroy target permanent. Its controller creates a 3/3...', test: 'destroy+token' },
  { name: 'Counterspell', oracle: 'Counter target spell.', test: 'counter' },
  { name: 'Path to Exile', oracle: 'Exile target creature. Its controller may search...', test: 'exile+search' },
  // ... 10 more
];
```

**Step 1: Write integration tests**
**Step 2: Run and fix any pattern gaps**
**Step 3: Commit**

---

## Task 9: Build & Full Test Suite

**Step 1: Run all package tests**

```bash
cd packages/game-engine && npx vitest run
cd packages/bot-core && npx vitest run
```

**Step 2: Build production**

```bash
npx vite build --mode production
```

**Step 3: Commit all Phase 5**

```bash
git add -A
git commit -m "feat: Phase 5 — Universal Oracle Engine (cost parser, ability execution, bot activation, UI picker)"
```

---

## Wave Execution Order

| Wave | Tasks | Dependencies | Parallelizable |
|------|-------|-------------|---------------|
| **Wave 1** | Task 1 (Cost Parser), Task 4 (Effect Patterns) | None | Yes, fully parallel |
| **Wave 2** | Task 2 (Cost Validation), Task 3 (Integration) | Task 1 | Sequential |
| **Wave 3** | Task 5 (Bot), Task 6 (UI), Task 7 (Aura) | Task 2+3 | Yes, parallel |
| **Wave 4** | Task 8 (Integration Tests), Task 9 (Build) | All | Sequential |

## Expected Outcomes

- **Tests**: 259 → ~300+ (40+ new tests)
- **Effect Patterns**: 166 → ~185
- **Card Playability**: ~30% → ~75%
- **Key cards working**: Sol Ring, Sakura-Tribe Elder, Lightning Greaves, Swords to Plowshares, Counterspell, all Planeswalkers, all Equipment, all Auras
- **Bot**: Activates abilities intelligently (removal, draw, ramp)
- **UI**: Click permanent → see and activate abilities
