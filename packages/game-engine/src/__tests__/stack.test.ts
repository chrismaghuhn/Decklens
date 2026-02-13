import { describe, it, expect, beforeEach } from 'vitest';
import {
  addSpellToStack,
  resolveTopOfStack,
  isStackEmpty,
  getStackSize,
  peekStack,
  resetStackIdCounter,
} from '../rules/stack.ts';
import { createPlayerState, emptyManaPool } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import { drawCards } from '../engine/zone-manager.ts';
import { addMana } from '../rules/mana.ts';
import type { GameState } from '../types/game-state.ts';
import type { ManaPayment } from '../types/mana.ts';

function createTestState(): GameState {
  const deck1 = [];
  for (let i = 0; i < 95; i++) {
    deck1.push(createSimpleCard(`Card ${i}`, 'Creature — Elf', '{G}', 0, {
      power: '1', toughness: '1', colors: ['G'],
    }));
  }
  // Add some instants
  deck1.push(createSimpleCard('Lightning Bolt', 'Instant', '{R}', 0, { colors: ['R'] }));
  deck1.push(createSimpleCard('Counterspell', 'Instant', '{U}{U}', 0, { colors: ['U'] }));
  deck1.push(createSimpleCard('Sol Ring', 'Artifact', '{1}', 0));
  deck1.push(createSimpleCard('Llanowar Elves', 'Creature — Elf Druid', '{G}', 0, {
    power: '1', toughness: '1', colors: ['G'],
  }));

  const cmdr1 = createSimpleCard('Cmdr', 'Legendary Creature', '{2}{G}', 0);

  const deck2 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1)
  );
  const cmdr2 = createSimpleCard('Bot Cmdr', 'Legendary Creature', '{3}', 1);

  const p1 = createPlayerState(0, 'Player', deck1, cmdr1);
  const p2 = createPlayerState(1, 'Bot', deck2, cmdr2);

  let state = createInitialGameState(p1, p2);
  state = drawCards(state, 0, 7);
  state = drawCards(state, 1, 7);
  state = {
    ...state,
    phase: 'precombat-main',
    step: 'main',
    mulliganPhase: false,
  };

  return state;
}

const emptyPayment: ManaPayment = {
  from: emptyManaPool(),
  phyrexianLife: 0,
  hybridChoices: [],
  xValue: 0,
};

beforeEach(() => {
  resetIdCounter();
  resetStackIdCounter();
});

describe('addSpellToStack', () => {
  it('should add spell to stack and remove from hand', () => {
    const state = createTestState();
    const cardId = state.players[0].hand[0].id;
    const handSize = state.players[0].hand.length;

    const after = addSpellToStack(state, cardId, 0, [], emptyPayment);

    expect(after.stack.length).toBe(1);
    expect(after.stack[0].type).toBe('spell');
    expect(after.stack[0].card!.id).toBe(cardId);
    expect(after.stack[0].controller).toBe(0);
    expect(after.players[0].hand.length).toBe(handSize - 1);
  });

  it('should not modify state if card not found', () => {
    const state = createTestState();
    const after = addSpellToStack(state, 'nonexistent', 0, [], emptyPayment);
    expect(after.stack.length).toBe(0);
  });

  it('should add log entry', () => {
    const state = createTestState();
    const cardId = state.players[0].hand[0].id;
    const after = addSpellToStack(state, cardId, 0, [], emptyPayment);
    const lastLog = after.log[after.log.length - 1];
    expect(lastLog.message).toContain('casts');
  });
});

describe('resolveTopOfStack', () => {
  it('should resolve creature spell to battlefield', () => {
    const state = createTestState();
    // Find a creature card in hand
    const creatureCard = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('creature')
    )!;

    let afterCast = addSpellToStack(state, creatureCard.id, 0, [], emptyPayment);
    expect(afterCast.stack.length).toBe(1);

    const afterResolve = resolveTopOfStack(afterCast);
    expect(afterResolve.stack.length).toBe(0);
    // Creature should be on battlefield
    const onBattlefield = afterResolve.players[0].battlefield.find(
      (p) => p.name === creatureCard.name
    );
    expect(onBattlefield).toBeDefined();
    expect(onBattlefield!.summoningSick).toBe(true);
  });

  it('should resolve instant spell to graveyard', () => {
    const state = createTestState();
    const instantCard = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('instant')
    );
    if (!instantCard) return; // Skip if no instant in hand

    let afterCast = addSpellToStack(state, instantCard.id, 0, [], emptyPayment);
    const afterResolve = resolveTopOfStack(afterCast);

    expect(afterResolve.stack.length).toBe(0);
    const inGraveyard = afterResolve.players[0].graveyard.find(
      (c) => c.name === instantCard.name
    );
    expect(inGraveyard).toBeDefined();
  });

  it('should resolve artifact spell to battlefield', () => {
    const state = createTestState();
    const artifactCard = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('artifact')
    );
    if (!artifactCard) return;

    let afterCast = addSpellToStack(state, artifactCard.id, 0, [], emptyPayment);
    const afterResolve = resolveTopOfStack(afterCast);

    expect(afterResolve.stack.length).toBe(0);
    const onBattlefield = afterResolve.players[0].battlefield.find(
      (p) => p.name === artifactCard.name
    );
    expect(onBattlefield).toBeDefined();
  });

  it('should resolve LIFO (last in, first out)', () => {
    const state = createTestState();
    const card1 = state.players[0].hand[0];
    const card2 = state.players[0].hand[1];

    let s = addSpellToStack(state, card1.id, 0, [], emptyPayment);
    s = addSpellToStack(s, card2.id, 0, [], emptyPayment);

    expect(s.stack.length).toBe(2);

    // First resolve = card2 (last in)
    const after1 = resolveTopOfStack(s);
    expect(after1.stack.length).toBe(1);
    expect(after1.stack[0].card!.name).toBe(card1.name);

    // Second resolve = card1
    const after2 = resolveTopOfStack(after1);
    expect(after2.stack.length).toBe(0);
  });

  it('should give active player priority after resolution', () => {
    const state = createTestState();
    const card = state.players[0].hand[0];
    let s = addSpellToStack(state, card.id, 0, [], emptyPayment);

    // Change priority player to not be active
    s = { ...s, priorityPlayer: 1, activePlayer: 0 };

    const after = resolveTopOfStack(s);
    expect(after.priorityPlayer).toBe(0); // Active player gets priority
  });

  it('should do nothing on empty stack', () => {
    const state = createTestState();
    const after = resolveTopOfStack(state);
    expect(after).toBe(state);
  });
});

describe('stack helpers', () => {
  it('isStackEmpty should detect empty stack', () => {
    const state = createTestState();
    expect(isStackEmpty(state)).toBe(true);
  });

  it('getStackSize should return correct count', () => {
    const state = createTestState();
    const card = state.players[0].hand[0];
    const after = addSpellToStack(state, card.id, 0, [], emptyPayment);
    expect(getStackSize(after)).toBe(1);
  });

  it('peekStack should return top without removing', () => {
    const state = createTestState();
    const card = state.players[0].hand[0];
    const after = addSpellToStack(state, card.id, 0, [], emptyPayment);

    const top = peekStack(after);
    expect(top).not.toBeNull();
    expect(top!.card!.name).toBe(card.name);
    expect(after.stack.length).toBe(1);
  });

  it('peekStack should return null for empty stack', () => {
    expect(peekStack(createTestState())).toBeNull();
  });
});
