import { describe, it, expect, beforeEach } from 'vitest';
import { parseTargetFilter, getValidTargets, validateTarget } from '../rules/targeting.ts';
import type { TargetFilter } from '../rules/targeting.ts';
import { createPlayerState, emptyManaPool } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import { cardToPermanent } from '../types/permanent.ts';
import type { GameState } from '../types/game-state.ts';
import type { Permanent } from '../types/permanent.ts';
import type { Target } from '../types/action.ts';

// ─── Helper: create a minimal game state with permanents ─────────────────

function createTestState(): GameState {
  resetIdCounter();
  const deck1 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
  );
  const cmdr1 = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0, {
    power: '3', toughness: '3',
  });
  const deck2 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1)
  );
  const cmdr2 = createSimpleCard('Cmdr B', 'Legendary Creature', '{3}', 1, {
    power: '2', toughness: '2',
  });

  const p1 = createPlayerState(0, 'Player', deck1, cmdr1);
  const p2 = createPlayerState(1, 'Bot', deck2, cmdr2);

  return createInitialGameState(p1, p2);
}

function addPermanent(
  state: GameState,
  player: 0 | 1,
  name: string,
  typeLine: string,
  opts?: Partial<Permanent> & { power?: string; toughness?: string; oracleText?: string; colors?: any[]; cmc?: number },
): { state: GameState; perm: Permanent } {
  const cardOpts: any = {};
  if (opts?.power) cardOpts.power = opts.power;
  if (opts?.toughness) cardOpts.toughness = opts.toughness;
  if (opts?.oracleText !== undefined) cardOpts.oracleText = opts.oracleText;
  if (opts?.colors) cardOpts.colors = opts.colors;
  if (opts?.cmc !== undefined) cardOpts.cmc = opts.cmc;

  const card = createSimpleCard(name, typeLine, '{1}', player, cardOpts);
  let perm = cardToPermanent(card, player, state.turn);
  perm.summoningSick = false;

  // Apply any Permanent-level overrides
  if (opts?.tapped !== undefined) perm = { ...perm, tapped: opts.tapped };
  if (opts?.attacking !== undefined) perm = { ...perm, attacking: opts.attacking };
  if ((opts as any)?.isToken !== undefined) perm = { ...perm, isToken: (opts as any).isToken } as any;

  const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
  players[player] = {
    ...players[player],
    battlefield: [...players[player].battlefield, perm],
  };

  return { state: { ...state, players }, perm };
}

beforeEach(() => {
  resetIdCounter();
});

// ═══════════════════════════════════════════════════════════════════════════
// parseTargetFilter
// ═══════════════════════════════════════════════════════════════════════════

describe('parseTargetFilter', () => {
  it('should parse "target creature"', () => {
    const f = parseTargetFilter('target creature');
    expect(f).toEqual({ cardType: ['creature'] });
  });

  it('should return null for "target player"', () => {
    expect(parseTargetFilter('target player')).toBeNull();
  });

  it('should parse "target nonblack creature"', () => {
    const f = parseTargetFilter('target nonblack creature');
    expect(f).toEqual({ cardType: ['creature'], color: { excludes: ['B'] } });
  });

  it('should parse "target creature with power 3 or less"', () => {
    const f = parseTargetFilter('target creature with power 3 or less');
    expect(f).toEqual({ cardType: ['creature'], power: { op: 'leq', value: 3 } });
  });

  it('should parse "target artifact or enchantment"', () => {
    const f = parseTargetFilter('target artifact or enchantment');
    expect(f).toEqual({ cardType: ['artifact', 'enchantment'] });
  });

  it('should parse "target creature an opponent controls"', () => {
    const f = parseTargetFilter('target creature an opponent controls');
    expect(f).toEqual({ cardType: ['creature'], controller: 'opponent' });
  });

  it('should parse "target noncreature permanent"', () => {
    const f = parseTargetFilter('target noncreature permanent');
    expect(f).toEqual({ excludeType: ['creature'] });
  });

  it('should parse "target nonland permanent"', () => {
    const f = parseTargetFilter('target nonland permanent');
    expect(f).toEqual({ excludeType: ['land'] });
  });

  it('should parse "target tapped creature"', () => {
    const f = parseTargetFilter('target tapped creature');
    expect(f).toEqual({ cardType: ['creature'], tapped: true });
  });

  it('should parse "target attacking creature"', () => {
    const f = parseTargetFilter('target attacking creature');
    expect(f).toEqual({ cardType: ['creature'], attacking: true });
  });

  it('should parse "another creature you control"', () => {
    const f = parseTargetFilter('another creature you control');
    expect(f).toEqual({ cardType: ['creature'], controller: 'you', other: true });
  });

  it('should parse "target creature with flying"', () => {
    const f = parseTargetFilter('target creature with flying');
    expect(f).toEqual({ cardType: ['creature'], keyword: { has: ['flying'] } });
  });

  it('should parse "target creature without flying"', () => {
    const f = parseTargetFilter('target creature without flying');
    expect(f).toEqual({ cardType: ['creature'], keyword: { hasNot: ['flying'] } });
  });

  it('should parse "target planeswalker"', () => {
    const f = parseTargetFilter('target planeswalker');
    expect(f).toEqual({ cardType: ['planeswalker'] });
  });

  it('should parse "target creature or planeswalker"', () => {
    const f = parseTargetFilter('target creature or planeswalker');
    expect(f).toEqual({ cardType: ['creature', 'planeswalker'] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getValidTargets
// ═══════════════════════════════════════════════════════════════════════════

describe('getValidTargets', () => {
  it('should return all creatures on the battlefield', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Grizzly Bears', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r1.state;
    const r2 = addPermanent(state, 1, 'Goblin', 'Creature — Goblin', { power: '1', toughness: '1' });
    state = r2.state;
    // Also add a non-creature
    const r3 = addPermanent(state, 0, 'Sol Ring', 'Artifact', {});
    state = r3.state;

    const filter: TargetFilter = { cardType: ['creature'] };
    const targets = getValidTargets(state, 0, filter);

    expect(targets).toHaveLength(2);
    expect(targets.every(t => t.type === 'permanent')).toBe(true);
    const ids = targets.map(t => t.id);
    expect(ids).toContain(r1.perm.id);
    expect(ids).toContain(r2.perm.id);
  });

  it('should filter by controller "you"', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'My Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r1.state;
    const r2 = addPermanent(state, 1, 'Opp Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r2.state;

    const filter: TargetFilter = { cardType: ['creature'], controller: 'you' };
    const targets = getValidTargets(state, 0, filter);

    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(r1.perm.id);
  });

  it('should filter by controller "opponent"', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'My Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r1.state;
    const r2 = addPermanent(state, 1, 'Opp Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r2.state;

    const filter: TargetFilter = { cardType: ['creature'], controller: 'opponent' };
    const targets = getValidTargets(state, 0, filter);

    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(r2.perm.id);
  });

  it('should filter by power', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Big Bear', 'Creature — Bear', { power: '5', toughness: '5' });
    state = r1.state;
    const r2 = addPermanent(state, 0, 'Small Bear', 'Creature — Bear', { power: '1', toughness: '1' });
    state = r2.state;

    const filter: TargetFilter = { cardType: ['creature'], power: { op: 'leq', value: 3 } };
    const targets = getValidTargets(state, 0, filter);

    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(r2.perm.id);
  });

  it('should filter by tapped state', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Tapped Bear', 'Creature — Bear', { power: '2', toughness: '2', tapped: true });
    state = r1.state;
    const r2 = addPermanent(state, 0, 'Untapped Bear', 'Creature — Bear', { power: '2', toughness: '2', tapped: false });
    state = r2.state;

    const filter: TargetFilter = { cardType: ['creature'], tapped: true };
    const targets = getValidTargets(state, 0, filter);

    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(r1.perm.id);
  });

  it('should filter by excludeType', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r1.state;
    const r2 = addPermanent(state, 0, 'Forest', 'Basic Land — Forest', {});
    state = r2.state;
    const r3 = addPermanent(state, 0, 'Sol Ring', 'Artifact', {});
    state = r3.state;

    const filter: TargetFilter = { excludeType: ['land'] };
    const targets = getValidTargets(state, 0, filter);

    // Should include Bear and Sol Ring, not Forest
    const ids = targets.map(t => t.id);
    expect(ids).toContain(r1.perm.id);
    expect(ids).toContain(r3.perm.id);
    expect(ids).not.toContain(r2.perm.id);
  });

  it('should exclude source when filter.other is true', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Source Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r1.state;
    const r2 = addPermanent(state, 0, 'Other Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r2.state;

    const filter: TargetFilter = { cardType: ['creature'], other: true, controller: 'you' };
    const targets = getValidTargets(state, 0, filter, r1.perm.id);

    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(r2.perm.id);
  });

  it('should filter by color excludes', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Black Cat', 'Creature — Cat', { power: '1', toughness: '1', colors: ['B'] });
    state = r1.state;
    const r2 = addPermanent(state, 0, 'White Cat', 'Creature — Cat', { power: '1', toughness: '1', colors: ['W'] });
    state = r2.state;

    const filter: TargetFilter = { cardType: ['creature'], color: { excludes: ['B'] } };
    const targets = getValidTargets(state, 0, filter);

    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(r2.perm.id);
  });

  it('should filter by attacking', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Attacking Bear', 'Creature — Bear', { power: '2', toughness: '2', attacking: true });
    state = r1.state;
    const r2 = addPermanent(state, 0, 'Chilling Bear', 'Creature — Bear', { power: '2', toughness: '2', attacking: false });
    state = r2.state;

    // Set up combat state
    state = {
      ...state,
      combat: {
        attackers: [{ permanentId: r1.perm.id, defenderId: 1 }],
        blockers: [],
        currentStep: 'declare-attackers',
      },
    };

    const filter: TargetFilter = { cardType: ['creature'], attacking: true };
    const targets = getValidTargets(state, 0, filter);

    expect(targets).toHaveLength(1);
    expect(targets[0].id).toBe(r1.perm.id);
  });

  it('should handle compound types like "artifact or enchantment"', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Sol Ring', 'Artifact', {});
    state = r1.state;
    const r2 = addPermanent(state, 0, 'Rhystic Study', 'Enchantment', {});
    state = r2.state;
    const r3 = addPermanent(state, 0, 'Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r3.state;

    const filter: TargetFilter = { cardType: ['artifact', 'enchantment'] };
    const targets = getValidTargets(state, 0, filter);

    expect(targets).toHaveLength(2);
    const ids = targets.map(t => t.id);
    expect(ids).toContain(r1.perm.id);
    expect(ids).toContain(r2.perm.id);
    expect(ids).not.toContain(r3.perm.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// validateTarget
// ═══════════════════════════════════════════════════════════════════════════

describe('validateTarget', () => {
  it('should return false if the permanent was removed from the battlefield', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r1.state;

    const target: Target = { type: 'permanent', id: r1.perm.id };
    const filter: TargetFilter = { cardType: ['creature'] };

    // Target is valid now
    expect(validateTarget(state, target, filter)).toBe(true);

    // Remove the permanent from the battlefield
    const players = [...state.players] as [typeof state.players[0], typeof state.players[1]];
    players[0] = {
      ...players[0],
      battlefield: players[0].battlefield.filter(p => p.id !== r1.perm.id),
    };
    const stateAfterRemoval = { ...state, players };

    // Target should now be invalid
    expect(validateTarget(stateAfterRemoval, target, filter)).toBe(false);
  });

  it('should return true for a permanent that still matches the filter', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Bear', 'Creature — Bear', { power: '2', toughness: '2' });
    state = r1.state;

    const target: Target = { type: 'permanent', id: r1.perm.id };
    const filter: TargetFilter = { cardType: ['creature'], power: { op: 'leq', value: 3 } };

    expect(validateTarget(state, target, filter)).toBe(true);
  });

  it('should return false if the permanent no longer matches the filter', () => {
    let state = createTestState();
    const r1 = addPermanent(state, 0, 'Big Bear', 'Creature — Bear', { power: '5', toughness: '5' });
    state = r1.state;

    const target: Target = { type: 'permanent', id: r1.perm.id };
    const filter: TargetFilter = { cardType: ['creature'], power: { op: 'leq', value: 3 } };

    // Power 5 is NOT <= 3
    expect(validateTarget(state, target, filter)).toBe(false);
  });

  it('should handle player targets gracefully', () => {
    const state = createTestState();
    const target: Target = { type: 'player', id: '0' };
    const filter: TargetFilter = { cardType: ['creature'] };

    // validateTarget handles player targets by checking life > 0
    expect(validateTarget(state, target, filter)).toBe(true);
  });
});
