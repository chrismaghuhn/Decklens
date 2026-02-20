/**
 * Tests for five new MTG mechanics:
 * 1. Replicate (CR 702.56)
 * 2. Retrace (CR 702.80)
 * 3. Manifest (CR 702.111)
 * 4. Amass (CR 701.47)
 * 5. Aftermath (CR 702.127)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resolveEffect } from '../rules/effects.ts';
import { addSpellToStack } from '../rules/stack.ts';
import { createPlayerState, emptyManaPool } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import { cardToPermanent } from '../types/permanent.ts';
import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { StackObject, Target } from '../types/action.ts';
import type { Card } from '../types/card.ts';
import type { Permanent } from '../types/permanent.ts';

function createTestState(): GameState {
  resetIdCounter();
  const deck1 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
  );
  const cmdr1 = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0);
  const deck2 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1)
  );
  const cmdr2 = createSimpleCard('Cmdr B', 'Legendary Creature', '{3}', 1);

  const p1 = createPlayerState(0, 'Player', deck1, cmdr1);
  const p2 = createPlayerState(1, 'Bot', deck2, cmdr2);

  return {
    ...createInitialGameState(p1, p2),
    phase: 'precombat-main',
    step: 'main',
    mulliganPhase: false,
  };
}

function createStackObject(
  card: Card,
  controller: 0 | 1,
  targets: Target[] = [],
  opts: Partial<StackObject> = {},
): StackObject {
  return {
    id: 'test-stack-1',
    type: 'spell',
    card,
    controller,
    targets,
    text: card.name,
    oracleText: card.oracleText,
    ...opts,
  };
}

beforeEach(() => {
  resetIdCounter();
});

// ─── Mechanic 1: Replicate (CR 702.56) ───────────────────────────────────────

describe('Mechanic 1: Replicate (CR 702.56)', () => {
  it('should recognize replicate keyword and auto-resolve', () => {
    const state = createTestState();
    const card = createSimpleCard('Shattering Spree', 'Instant', '{R}', 0);
    card.oracleText = 'Replicate {R} (When you cast this spell, copy it for each time you paid its replicate cost. You may choose new targets for the copies.)\nDestroy target artifact.';

    const stack = createStackObject(card, 0);
    const result = resolveEffect(state, stack);
    expect(result.resolved).toBe(true);
  });

  it('should put replicate copies onto the stack when cast with replicateCount', () => {
    const state = createTestState();
    const card = createSimpleCard('Gigadrowse', 'Instant', '{U}', 0);
    card.oracleText = 'Replicate {U}\nTap target permanent.';

    // Simulate adding to hand
    const players = [...state.players] as [PlayerState, PlayerState];
    players[0] = { ...players[0], hand: [...players[0].hand, card] };
    const stateWithCard: GameState = { ...state, players };

    // Cast with replicate x2
    const newState = addSpellToStack(
      stateWithCard,
      card.id,
      0,
      [],
      emptyManaPool(),
      undefined,
      { replicateCount: 2 }
    );

    // Stack should have: original spell + 2 copies = 3 objects
    expect(newState.stack.length).toBe(3);
    // The original spell and its copies
    expect(newState.stack[0].card?.name).toBe('Gigadrowse');
    expect(newState.stack[1].text).toContain('Copy of');
    expect(newState.stack[2].text).toContain('Copy of');
  });

  it('should not put copies when replicateCount is 0', () => {
    const state = createTestState();
    const card = createSimpleCard('Train of Thought', 'Sorcery', '{1}{U}', 0);
    card.oracleText = 'Replicate {1}{U}\nDraw a card.';

    const players = [...state.players] as [PlayerState, PlayerState];
    players[0] = { ...players[0], hand: [...players[0].hand, card] };
    const stateWithCard: GameState = { ...state, players };

    const newState = addSpellToStack(
      stateWithCard,
      card.id,
      0,
      [],
      emptyManaPool(),
      undefined,
      { replicateCount: 0 }
    );

    // Stack should have only the original spell
    expect(newState.stack.length).toBe(1);
  });
});

// ─── Mechanic 2: Retrace (CR 702.80) ─────────────────────────────────────────

describe('Mechanic 2: Retrace (CR 702.80)', () => {
  it('should recognize retrace keyword and auto-resolve', () => {
    const state = createTestState();
    const card = createSimpleCard("Raven's Crime", 'Sorcery', '{B}', 0);
    card.oracleText = "Target opponent discards a card.\nRetrace (You may cast this card from your graveyard by discarding a land card in addition to paying its other costs.)";

    const stack = createStackObject(card, 0);
    const result = resolveEffect(state, stack);
    expect(result.resolved).toBe(true);
  });

  it('should cast from graveyard with retrace flag set', () => {
    const state = createTestState();
    const card = createSimpleCard("Worm Harvest", 'Sorcery', '{2}{B}{G}', 0);
    card.oracleText = "Create a 1/1 black and green Worm creature token for each land card in your graveyard.\nRetrace";

    // Put card in graveyard and a land in hand
    const landCard = createSimpleCard('Forest', 'Basic Land — Forest', '', 0);
    const players = [...state.players] as [PlayerState, PlayerState];
    players[0] = {
      ...players[0],
      graveyard: [...players[0].graveyard, card],
      hand: [...players[0].hand, landCard],
      manaPool: { W: 0, U: 0, B: 2, R: 0, G: 2, C: 2 },
    };
    const stateWithCard: GameState = { ...state, players };

    // Cast with retrace
    const newState = addSpellToStack(
      stateWithCard,
      card.id,
      0,
      [],
      emptyManaPool(),
      undefined,
      { isRetrace: true }
    );

    // Card should be removed from graveyard (taken to stack)
    expect(newState.players[0].graveyard.find(c => c.id === card.id)).toBeUndefined();
    // Stack should have the spell
    expect(newState.stack.length).toBe(1);
    expect(newState.stack[0].isRetrace).toBe(true);
  });
});

// ─── Mechanic 3: Manifest (CR 702.111) ───────────────────────────────────────

describe('Mechanic 3: Manifest (CR 702.111)', () => {
  it('should manifest top card of library as a 2/2 face-down creature', () => {
    const state = createTestState();
    const card = createSimpleCard('Soul Summons', 'Sorcery', '{1}{W}', 0);
    card.oracleText = 'Manifest the top card of your library.';

    // Make sure library has cards
    expect(state.players[0].library.length).toBeGreaterThan(0);
    const topCard = state.players[0].library[0];
    const librarySize = state.players[0].library.length;

    const stack = createStackObject(card, 0);
    const result = resolveEffect(state, stack);

    expect(result.resolved).toBe(true);
    // Library should have one fewer card
    expect(result.state.players[0].library.length).toBe(librarySize - 1);
    // A new permanent should be on the battlefield
    expect(result.state.players[0].battlefield.length).toBe(1);
    const manifested = result.state.players[0].battlefield[0];
    // It should be face-down
    expect(manifested.faceDown).toBe(true);
    // It should be a 2/2
    expect(manifested.currentPower).toBe(2);
    expect(manifested.currentToughness).toBe(2);
    // It should track the original card
    expect(manifested.manifestedCardId).toBe(topCard.id);
  });

  it('should handle manifest with empty library gracefully', () => {
    const state = createTestState();
    const card = createSimpleCard('Cloudform', 'Enchantment', '{1}{U}{U}', 0);
    card.oracleText = 'When Cloudform enters the battlefield, manifest the top card of your library.';

    // Empty the library
    const players = [...state.players] as [PlayerState, PlayerState];
    players[0] = { ...players[0], library: [] };
    const stateEmpty: GameState = { ...state, players };

    const stack = createStackObject(card, 0);
    const result = resolveEffect(stateEmpty, stack);

    expect(result.resolved).toBe(true);
    // No permanent added (library was empty)
    expect(result.state.players[0].battlefield.length).toBe(0);
  });

  it('should manifest multiple cards', () => {
    const state = createTestState();
    const card = createSimpleCard('Whisperwood Elemental', 'Creature', '{3}{G}{G}', 0);
    card.oracleText = 'Manifest the top 2 cards of your library.';
    card.power = '4'; card.toughness = '4';

    const librarySize = state.players[0].library.length;

    const stack = createStackObject(card, 0);
    const result = resolveEffect(state, stack);

    expect(result.resolved).toBe(true);
    expect(result.state.players[0].library.length).toBe(librarySize - 2);
    expect(result.state.players[0].battlefield.length).toBe(2);
    // Both should be face-down 2/2s
    for (const perm of result.state.players[0].battlefield) {
      expect(perm.faceDown).toBe(true);
      expect(perm.currentPower).toBe(2);
      expect(perm.currentToughness).toBe(2);
      expect(perm.manifestedCardId).toBeDefined();
    }
  });
});

// ─── Mechanic 4: Amass (CR 701.47) ───────────────────────────────────────────

describe('Mechanic 4: Amass (CR 701.47)', () => {
  it('should create a Zombie Army token when no army exists', () => {
    const state = createTestState();
    const card = createSimpleCard('Lazotep Reaver', 'Creature', '{1}{B}', 0);
    card.oracleText = 'Amass Zombies 1 (Put a +1/+1 counter on target Army you control. If you don\'t control one, create a 0/0 black Zombie Army creature token first.)';
    card.power = '2'; card.toughness = '1';

    const stack = createStackObject(card, 0);
    const result = resolveEffect(state, stack);

    expect(result.resolved).toBe(true);
    // Should have created an Army token
    const army = result.state.players[0].battlefield.find(
      p => p.typeLine.toLowerCase().includes('army')
    );
    expect(army).toBeDefined();
    expect(army!.counters['+1/+1']).toBe(1);
    expect(army!.currentPower).toBe(1);
    expect(army!.currentToughness).toBe(1);
  });

  it('should add counters to existing Army token', () => {
    const state = createTestState();

    // Put an existing Army token on battlefield
    const armyCard = createSimpleCard('Zombie Army', 'Token Creature — Zombie Army', '', 0);
    const armyPerm = cardToPermanent(armyCard, 0, 1);
    armyPerm.counters['+1/+1'] = 3;
    armyPerm.currentPower = 3;
    armyPerm.currentToughness = 3;

    const players = [...state.players] as [PlayerState, PlayerState];
    players[0] = { ...players[0], battlefield: [...players[0].battlefield, armyPerm] };
    const stateWithArmy: GameState = { ...state, players };

    const card = createSimpleCard('Dreadhorde Invasion', 'Enchantment', '{1}{B}', 0);
    card.oracleText = 'Amass Zombies 1 at the beginning of your upkeep.';

    const stack = createStackObject(card, 0);
    const result = resolveEffect(stateWithArmy, stack);

    expect(result.resolved).toBe(true);
    const army = result.state.players[0].battlefield.find(
      p => p.typeLine.toLowerCase().includes('army')
    );
    expect(army).toBeDefined();
    // Should have gained 1 counter
    expect(army!.counters['+1/+1']).toBe(4);
  });

  it('should match amass with number N', () => {
    const state = createTestState();
    const card = createSimpleCard('Enter the God-Eternals', 'Instant', '{2}{U}{B}', 0);
    card.oracleText = 'Tap target creature and put it on the bottom of its owner\'s library. You gain 4 life. Amass Zombies 4.';

    const stack = createStackObject(card, 0);
    const result = resolveEffect(state, stack);

    expect(result.resolved).toBe(true);
    const army = result.state.players[0].battlefield.find(
      p => p.typeLine.toLowerCase().includes('army')
    );
    expect(army).toBeDefined();
    expect(army!.counters['+1/+1']).toBe(4);
  });
});

// ─── Mechanic 5: Aftermath (CR 702.127) ──────────────────────────────────────

describe('Mechanic 5: Aftermath (CR 702.127)', () => {
  it('should recognize aftermath keyword and auto-resolve', () => {
    const state = createTestState();
    const card = createSimpleCard('Lead', 'Sorcery', '{3}{B}', 0);
    card.oracleText = 'Aftermath (Cast this spell only from your graveyard. Then exile it.)\nDestroy all creatures.';

    const stack = createStackObject(card, 0);
    const result = resolveEffect(state, stack);
    expect(result.resolved).toBe(true);
    expect(result.description).toContain('aftermath');
  });

  it('should exile aftermath card from graveyard when it resolves', () => {
    const state = createTestState();
    const card = createSimpleCard('Memory', 'Sorcery', '{5}{U}', 0);
    card.oracleText = 'Aftermath\nShuffle your graveyard into your library. Draw seven cards.';

    // Put card in graveyard
    const players = [...state.players] as [PlayerState, PlayerState];
    players[0] = { ...players[0], graveyard: [card] };
    const stateWithCard: GameState = { ...state, players };

    // Resolve with aftermath
    const stack = createStackObject(card, 0, [], { source: cardToPermanent(card, 0, 1) });
    const result = resolveEffect(stateWithCard, stack);

    expect(result.resolved).toBe(true);
    // Card should be exiled, not in graveyard
    expect(result.state.players[0].graveyard.find(c => c.id === card.id)).toBeUndefined();
    expect(result.state.players[0].exile.find(c => c.id === card.id)).toBeDefined();
  });

  it('aftermath card data field should be accepted in Card type', () => {
    const card = createSimpleCard('Commit', 'Instant', '{3}{U}', 0);
    card.oracleText = 'Put target spell or nonland permanent into its owner\'s library second from the top.';
    // Add aftermath data
    card.aftermath = {
      name: 'Memory',
      manaCost: '{5}{U}',
      oracleText: 'Aftermath\nShuffle your graveyard into your library. Draw seven cards.',
    };

    expect(card.aftermath).toBeDefined();
    expect(card.aftermath!.name).toBe('Memory');
    expect(card.aftermath!.manaCost).toBe('{5}{U}');
  });
});
