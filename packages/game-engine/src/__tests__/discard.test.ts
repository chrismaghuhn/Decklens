
import { describe, it, expect } from 'vitest';
import { Game } from '../engine/game';
import { GameState } from '../types/game-state';
import { PlayerState, emptyManaPool } from '../types/player';
import { Card } from '../types/card';

// Mock Card
const mockCard: Card = {
  id: 'card-1',
  oracleId: 'oid-1',
  name: 'Test Card',
  manaCost: '{1}',
  cmc: 1,
  typeLine: 'Instant',
  oracleText: '',
  colors: [],
  colorIdentity: [],
  rarity: 'common',
  tags: [],
  imageUrl: '',
  owner: 0
};

describe('Discard Logic', () => {
  it('should correctly handle discard action via submitAction', () => {
    // Create 8 cards
    const hand: Card[] = [];
    for (let i = 0; i < 8; i++) {
        hand.push({ ...mockCard, id: `card-${i}`, name: `Card ${i}` });
    }

    const initialPlayerState: PlayerState = {
      id: 0,
      name: 'Player',
      life: 20,
      hand: hand,
      library: [],
      graveyard: [],
      exile: [],
      commandZone: [],
      battlefield: [],
      manaPool: emptyManaPool(),
      poisonCounters: 0,
      energyCounters: 0,
      experienceCounters: 0,
      commanderDamage: {},
      commanderTax: 0,
      landPlayedThisTurn: false,
      landsPlayedThisTurn: 0,
      maxLandPlays: 1,
      hasDrawnThisGame: true
    };

    const initialState: GameState = {
      players: [initialPlayerState, initialPlayerState],
      activePlayer: 0,
      priorityPlayer: 0,
      turn: 1,
      phase: 'ending',
      step: 'cleanup',
      stack: [],
      combat: null,
      winner: null,
      gameOver: false,
      log: [],
      actionHistory: [],
      playersPassed: new Set() as Set<number>,
      mulliganPhase: false,
      mulliganCount: [0, 0],
      pendingDiscard: 0,
      pendingDiscardCount: 1
    };

    const game = new Game(initialState);
    
    // Safety check BEFORE
    expect(game.getState().pendingDiscard).toBe(0);
    expect(game.getState().players[0].hand.length).toBe(8);

    // Submit Action
    const success = game.submitAction({
      type: 'discard',
      player: 0,
      cardIds: ['card-0']
    });

    // Verification
    expect(success).toBe(true);
    
    const newState = game.getState();
    expect(newState.pendingDiscard).toBeNull();
    expect(newState.players[0].hand.length).toBe(7);
    expect(newState.players[0].graveyard.length).toBe(1);
    expect(newState.players[0].graveyard[0].id).toBe('card-0');
  });
});
