import { describe, it, expect, beforeEach } from 'vitest';
import {
  drawCard,
  drawCards,
  moveCard,
  findCard,
  getCardsInZone,
  shuffleLibrary,
  millCards,
  drawOpeningHand,
} from '../engine/zone-manager.ts';
import { createPlayerState } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import type { GameState } from '../types/game-state.ts';

function createTestState(): GameState {
  const cards = [];
  for (let i = 0; i < 99; i++) {
    cards.push(
      createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
    );
  }
  const commander = createSimpleCard('Commander', 'Legendary Creature', '{3}', 0);
  const p1 = createPlayerState(0, 'Player', cards, commander);

  const cards2 = [];
  for (let i = 0; i < 99; i++) {
    cards2.push(
      createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1)
    );
  }
  const commander2 = createSimpleCard('Bot Commander', 'Legendary Creature', '{3}', 1);
  const p2 = createPlayerState(1, 'Bot', cards2, commander2);

  return createInitialGameState(p1, p2);
}

beforeEach(() => {
  resetIdCounter();
});

describe('drawCard', () => {
  it('should move top card from library to hand', () => {
    const state = createTestState();
    const topCard = state.players[0].library[0];
    const next = drawCard(state, 0);
    expect(next.players[0].hand).toContainEqual(topCard);
    expect(next.players[0].library).not.toContainEqual(topCard);
  });

  it('should not mutate original state', () => {
    const state = createTestState();
    const libSizeBefore = state.players[0].library.length;
    drawCard(state, 0);
    expect(state.players[0].library.length).toBe(libSizeBefore);
  });

  it('should do nothing if library is empty', () => {
    const state = createTestState();
    state.players[0].library = [];
    const next = drawCard(state, 0);
    expect(next.players[0].hand.length).toBe(0);
  });

  it('should add log entry', () => {
    const state = createTestState();
    const next = drawCard(state, 0);
    expect(next.log.length).toBeGreaterThan(state.log.length);
  });
});

describe('drawCards', () => {
  it('should draw multiple cards', () => {
    const state = createTestState();
    const next = drawCards(state, 0, 3);
    expect(next.players[0].hand.length).toBe(3);
    expect(next.players[0].library.length).toBe(state.players[0].library.length - 3);
  });

  it('should stop when library runs out', () => {
    const state = createTestState();
    state.players[0].library = state.players[0].library.slice(0, 2);
    const next = drawCards(state, 0, 5);
    expect(next.players[0].hand.length).toBe(2);
    expect(next.players[0].library.length).toBe(0);
  });
});

describe('drawOpeningHand', () => {
  it('should draw 7 cards by default', () => {
    const state = createTestState();
    const next = drawOpeningHand(state, 0);
    expect(next.players[0].hand.length).toBe(7);
  });
});

describe('moveCard', () => {
  it('should move card from hand to battlefield', () => {
    const state = createTestState();
    // Put a card in hand first
    const withHand = drawCard(state, 0);
    const cardId = withHand.players[0].hand[0].id;

    const next = moveCard(withHand, cardId, 'hand', 'battlefield', 0);
    expect(next.players[0].hand.length).toBe(0);
    expect(next.players[0].battlefield.length).toBe(1);
    expect(next.players[0].battlefield[0].id).toBe(cardId);
  });

  it('should create a Permanent when moving to battlefield', () => {
    const state = createTestState();
    const withHand = drawCard(state, 0);
    const cardId = withHand.players[0].hand[0].id;

    const next = moveCard(withHand, cardId, 'hand', 'battlefield', 0);
    const perm = next.players[0].battlefield[0];
    expect(perm).toHaveProperty('tapped');
    expect(perm).toHaveProperty('controller');
    expect(perm.tapped).toBe(false);
    expect(perm.summoningSick).toBe(true);
  });

  it('should move card from battlefield to graveyard', () => {
    const state = createTestState();
    const withHand = drawCard(state, 0);
    const cardId = withHand.players[0].hand[0].id;
    const withPerm = moveCard(withHand, cardId, 'hand', 'battlefield', 0);

    const next = moveCard(withPerm, cardId, 'battlefield', 'graveyard', 0);
    expect(next.players[0].battlefield.length).toBe(0);
    expect(next.players[0].graveyard.length).toBe(1);
  });

  it('should return unchanged state if card not found', () => {
    const state = createTestState();
    const next = moveCard(state, 'nonexistent', 'hand', 'battlefield', 0);
    expect(next).toBe(state);
  });
});

describe('findCard', () => {
  it('should find card in library', () => {
    const state = createTestState();
    const cardId = state.players[0].library[0].id;
    const result = findCard(state, cardId, 0);
    expect(result).not.toBeNull();
    expect(result!.zone).toBe('library');
    expect(result!.index).toBe(0);
  });

  it('should find card in command zone', () => {
    const state = createTestState();
    const commanderId = state.players[0].commandZone[0].id;
    const result = findCard(state, commanderId, 0);
    expect(result).not.toBeNull();
    expect(result!.zone).toBe('commandZone');
  });

  it('should return null for nonexistent card', () => {
    const state = createTestState();
    expect(findCard(state, 'nonexistent', 0)).toBeNull();
  });
});

describe('getCardsInZone', () => {
  it('should return library cards', () => {
    const state = createTestState();
    const cards = getCardsInZone(state, 'library', 0);
    expect(cards.length).toBe(state.players[0].library.length);
  });

  it('should return command zone cards', () => {
    const state = createTestState();
    const cards = getCardsInZone(state, 'commandZone', 0);
    expect(cards.length).toBe(1);
    expect(cards[0].name).toBe('Commander');
  });
});

describe('shuffleLibrary', () => {
  it('should maintain same number of cards', () => {
    const state = createTestState();
    const next = shuffleLibrary(state, 0);
    expect(next.players[0].library.length).toBe(state.players[0].library.length);
  });

  it('should contain same cards (possibly different order)', () => {
    const state = createTestState();
    const originalIds = state.players[0].library.map((c) => c.id).sort();
    const next = shuffleLibrary(state, 0);
    const shuffledIds = next.players[0].library.map((c) => c.id).sort();
    expect(shuffledIds).toEqual(originalIds);
  });
});

describe('millCards', () => {
  it('should move cards from library to graveyard', () => {
    const state = createTestState();
    const next = millCards(state, 0, 3);
    expect(next.players[0].library.length).toBe(state.players[0].library.length - 3);
    expect(next.players[0].graveyard.length).toBe(3);
  });

  it('should not mill more than library size', () => {
    const state = createTestState();
    state.players[0].library = state.players[0].library.slice(0, 2);
    const next = millCards(state, 0, 5);
    expect(next.players[0].library.length).toBe(0);
    expect(next.players[0].graveyard.length).toBe(2);
  });

  it('should add log entry', () => {
    const state = createTestState();
    const next = millCards(state, 0, 3);
    const lastLog = next.log[next.log.length - 1];
    expect(lastLog.message).toContain('mills 3 cards');
  });
});
