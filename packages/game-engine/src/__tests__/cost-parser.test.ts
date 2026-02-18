import { describe, it, expect, beforeEach } from 'vitest';
import { parseCost, canPayAbilityCost, payAbilityCost } from '../rules/cost-parser.ts';
import type { AbilityCost } from '../rules/cost-parser.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import { createPlayerState } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { cardToPermanent } from '../types/permanent.ts';

function createTestDeck(owner: 0 | 1) {
  return Array.from({ length: 10 }, (_, i) =>
    createSimpleCard(`Card ${i}`, 'Creature', `{${(i % 5) + 1}}`, owner, {
      power: '1',
      toughness: '1',
    }),
  );
}

function makeTestState() {
  const deck1 = createTestDeck(0);
  const cmd1 = createSimpleCard(
    'Commander A',
    'Legendary Creature',
    '{3}{W}',
    0,
  );
  const deck2 = createTestDeck(1);
  const cmd2 = createSimpleCard(
    'Commander B',
    'Legendary Creature',
    '{3}{B}',
    1,
  );
  const p1 = createPlayerState(0, 'Player 1', deck1, cmd1);
  const p2 = createPlayerState(1, 'Bot', deck2, cmd2);
  let state = createInitialGameState(p1, p2);
  state = { ...state, mulliganPhase: false };
  return state;
}

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

  it('should parse sacrifice two creatures', () => {
    const cost = parseCost('Sacrifice two creatures');
    expect(cost.sacrificeType).toBe('creature');
    expect(cost.sacrificeCount).toBe(2);
  });

  it('should parse pay life cost', () => {
    const cost = parseCost('Pay 3 life');
    expect(cost.payLife).toBe(3);
  });

  it('should parse pay 1 life cost', () => {
    const cost = parseCost('Pay 1 life');
    expect(cost.payLife).toBe(1);
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
    expect(cost.sacrificeCount).toBe(1);
  });

  it('should parse Phyrexian mana cost', () => {
    const cost = parseCost('{W/P}');
    expect(cost.phyrexianMana).toBe('{W/P}');
  });

  it('should parse empty cost', () => {
    const cost = parseCost('');
    expect(cost).toEqual({});
  });

  it('should parse untap cost', () => {
    const cost = parseCost('{Q}');
    expect(cost.untap).toBe(true);
  });

  it('should parse mana-only cost', () => {
    const cost = parseCost('{3}{R}');
    expect(cost.mana).toBe('{3}{R}');
    expect(cost.tap).toBeUndefined();
  });
});

describe('canPayAbilityCost', () => {
  beforeEach(() => resetIdCounter());

  it('should allow tap cost on untapped permanent', () => {
    let state = makeTestState();
    // Add a non-creature permanent (artifact) so summoning sickness doesn't apply
    const artifact = cardToPermanent(
      createSimpleCard('My Artifact', 'Artifact', '{2}', 0),
      0,
      1,
    );
    artifact.summoningSick = false;
    state = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [artifact] },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    expect(canPayAbilityCost(state, 0, artifact.id, parseCost('{T}'))).toBe(
      true,
    );
  });

  it('should reject tap cost on tapped permanent', () => {
    let state = makeTestState();
    const artifact = cardToPermanent(
      createSimpleCard('My Artifact', 'Artifact', '{2}', 0),
      0,
      1,
    );
    artifact.summoningSick = false;
    artifact.tapped = true;
    state = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [artifact] },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    expect(canPayAbilityCost(state, 0, artifact.id, parseCost('{T}'))).toBe(
      false,
    );
  });

  it('should validate pay life cost', () => {
    const state = makeTestState();
    // Player starts at 40 life
    expect(canPayAbilityCost(state, 0, '', parseCost('Pay 3 life'))).toBe(
      true,
    );
    expect(canPayAbilityCost(state, 0, '', parseCost('Pay 50 life'))).toBe(
      false,
    );
  });

  it('should validate discard cost against hand size', () => {
    const state = makeTestState();
    const handSize = state.players[0].hand.length;
    expect(
      canPayAbilityCost(state, 0, '', parseCost('Discard a card')),
    ).toBe(handSize >= 1);
  });

  it('should validate exile from GY cost', () => {
    let state = makeTestState();
    // No cards in GY initially
    expect(
      canPayAbilityCost(
        state,
        0,
        '',
        parseCost('Exile three cards from your graveyard'),
      ),
    ).toBe(false);
    // Add cards to GY
    const gyCards = Array.from({ length: 5 }, (_, i) =>
      createSimpleCard(`GY Card ${i}`, 'Creature', '{1}', 0),
    );
    state = {
      ...state,
      players: [
        { ...state.players[0], graveyard: gyCards },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    expect(
      canPayAbilityCost(
        state,
        0,
        '',
        parseCost('Exile three cards from your graveyard'),
      ),
    ).toBe(true);
  });

  it('should validate remove counters cost', () => {
    let state = makeTestState();
    const creature = cardToPermanent(
      createSimpleCard('Counter Creature', 'Creature', '{2}', 0, {
        power: '2',
        toughness: '2',
      }),
      0,
      1,
    );
    creature.summoningSick = false;
    creature.counters = { '+1/+1': 3 };
    state = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [creature] },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    expect(
      canPayAbilityCost(
        state,
        0,
        creature.id,
        parseCost('Remove a +1/+1 counter from ~'),
      ),
    ).toBe(true);
    state = {
      ...state,
      players: [
        {
          ...state.players[0],
          battlefield: [{ ...creature, counters: { '+1/+1': 0 } }],
        },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    expect(
      canPayAbilityCost(
        state,
        0,
        creature.id,
        parseCost('Remove a +1/+1 counter from ~'),
      ),
    ).toBe(false);
  });
});

describe('payAbilityCost', () => {
  beforeEach(() => resetIdCounter());

  it('should tap permanent when paying tap cost', () => {
    let state = makeTestState();
    const artifact = cardToPermanent(
      createSimpleCard('My Artifact', 'Artifact', '{2}', 0),
      0,
      1,
    );
    artifact.summoningSick = false;
    state = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [artifact] },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    const result = payAbilityCost(state, 0, artifact.id, parseCost('{T}'));
    const updatedArtifact = result.players[0].battlefield.find(
      (p) => p.id === artifact.id,
    );
    expect(updatedArtifact?.tapped).toBe(true);
  });

  it('should sacrifice self and move to graveyard', () => {
    let state = makeTestState();
    const creature = cardToPermanent(
      createSimpleCard('Sacrifice Me', 'Creature', '{1}', 0, {
        power: '1',
        toughness: '1',
      }),
      0,
      1,
    );
    creature.summoningSick = false;
    state = {
      ...state,
      players: [
        {
          ...state.players[0],
          battlefield: [creature],
          graveyard: [],
        },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    const result = payAbilityCost(
      state,
      0,
      creature.id,
      parseCost('{T}, Sacrifice ~'),
    );
    expect(result.players[0].battlefield.length).toBe(0);
    expect(result.players[0].graveyard.length).toBe(1);
    expect(result.players[0].graveyard[0].name).toBe('Sacrifice Me');
  });

  it('should pay life cost', () => {
    const state = makeTestState();
    const startingLife = state.players[0].life;
    const result = payAbilityCost(state, 0, '', parseCost('Pay 3 life'));
    expect(result.players[0].life).toBe(startingLife - 3);
  });

  it('should remove counters', () => {
    let state = makeTestState();
    const creature = cardToPermanent(
      createSimpleCard('Counter Creature', 'Creature', '{2}', 0, {
        power: '2',
        toughness: '2',
      }),
      0,
      1,
    );
    creature.summoningSick = false;
    creature.counters = { '+1/+1': 3 };
    state = {
      ...state,
      players: [
        { ...state.players[0], battlefield: [creature] },
        state.players[1],
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    const result = payAbilityCost(
      state,
      0,
      creature.id,
      parseCost('Remove a +1/+1 counter from ~'),
    );
    const updated = result.players[0].battlefield.find(
      (p) => p.id === creature.id,
    );
    expect(updated?.counters['+1/+1']).toBe(2);
  });
});
