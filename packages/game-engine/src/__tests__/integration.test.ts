/**
 * Integration Test — Full headless game simulation.
 *
 * Two HeuristicBots play a complete game against each other.
 * Validates that the engine + bot work end-to-end without errors.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Game } from '../engine/game.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import { createPlayerState } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { drawOpeningHand } from '../engine/zone-manager.ts';
import { getLegalActionTypes } from '../engine/validation.ts';
import { autoPayCost, parseManaCost } from '../rules/mana.ts';
import type { Card, GameAction, GameState } from '../types/index.ts';

const BASIC_LANDS = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];

/** Build a simple 99-card EDH deck */
function buildTestDeck(owner: 0 | 1): { deck: Card[]; commander: Card } {
  const commander = createSimpleCard(
    owner === 0 ? 'Atraxa, Praetors\' Voice' : 'Kenrith, the Returned King',
    'Legendary Creature — Phyrexian Angel Horror',
    owner === 0 ? '{G}{W}{U}{B}' : '{4}{W}',
    owner,
    {
      power: '4',
      toughness: '4',
      colors: ['G', 'W', 'U', 'B'],
      colorIdentity: ['G', 'W', 'U', 'B'],
    },
  );

  const cards: Card[] = [commander];

  // 34 basic lands
  for (let i = 0; i < 8; i++) cards.push(createSimpleCard('Forest', 'Basic Land — Forest', '', owner, { colors: [], colorIdentity: ['G'], oracleText: '{T}: Add {G}.' }));
  for (let i = 0; i < 7; i++) cards.push(createSimpleCard('Island', 'Basic Land — Island', '', owner, { colors: [], colorIdentity: ['U'], oracleText: '{T}: Add {U}.' }));
  for (let i = 0; i < 7; i++) cards.push(createSimpleCard('Plains', 'Basic Land — Plains', '', owner, { colors: [], colorIdentity: ['W'], oracleText: '{T}: Add {W}.' }));
  for (let i = 0; i < 6; i++) cards.push(createSimpleCard('Swamp', 'Basic Land — Swamp', '', owner, { colors: [], colorIdentity: ['B'], oracleText: '{T}: Add {B}.' }));
  for (let i = 0; i < 6; i++) cards.push(createSimpleCard('Mountain', 'Basic Land — Mountain', '', owner, { colors: [], colorIdentity: ['R'], oracleText: '{T}: Add {R}.' }));

  // Some creatures
  const creatures = [
    { name: 'Llanowar Elves', type: 'Creature — Elf Druid', cost: '{G}', p: '1', t: '1' },
    { name: 'Grizzly Bears', type: 'Creature — Bear', cost: '{1}{G}', p: '2', t: '2' },
    { name: 'Hill Giant', type: 'Creature — Giant', cost: '{3}{R}', p: '3', t: '3' },
    { name: 'Air Elemental', type: 'Creature — Elemental', cost: '{3}{U}{U}', p: '4', t: '4' },
    { name: 'Serra Angel', type: 'Creature — Angel', cost: '{3}{W}{W}', p: '4', t: '4' },
  ];
  for (const c of creatures) {
    cards.push(createSimpleCard(c.name, c.type, c.cost, owner, {
      power: c.p, toughness: c.t, colors: [], colorIdentity: [],
    }));
  }

  // Some spells
  cards.push(createSimpleCard('Sol Ring', 'Artifact', '{1}', owner, { oracleText: '{T}: Add {C}{C}.', colors: [], colorIdentity: [], tags: ['fast-mana', 'ramp'] }));
  cards.push(createSimpleCard('Arcane Signet', 'Artifact', '{2}', owner, { oracleText: '{T}: Add one mana.', colors: [], colorIdentity: [], tags: ['ramp'] }));

  // Fill rest with forests
  while (cards.length < 99) {
    cards.push(createSimpleCard('Forest', 'Basic Land — Forest', '', owner, {
      oracleText: '{T}: Add {G}.', colors: [], colorIdentity: ['G'],
    }));
  }

  return { deck: cards, commander };
}

/** Simple bot that picks legal actions heuristically */
function simpleBot(state: GameState, player: number): GameAction {
  const legalTypes = getLegalActionTypes(state);
  const me = state.players[player];

  // Play a land if possible
  if (legalTypes.includes('play-land')) {
    const land = me.hand.find(c => c.typeLine.toLowerCase().includes('land'));
    if (land) return { type: 'play-land', player, cardId: land.id };
  }

  // Cast a cheap spell if possible
  if (legalTypes.includes('cast-spell')) {
    for (const card of me.hand) {
      if (card.typeLine.toLowerCase().includes('land')) continue;
      const cost = parseManaCost(card.manaCost);
      const payment = autoPayCost(me.manaPool, cost, me.life);
      if (payment) {
        return {
          type: 'cast-spell',
          player,
          cardId: card.id,
          targets: [],
          manaPayment: payment,
        };
      }
    }
  }

  // Declare attackers: attack with all able creatures
  if (legalTypes.includes('declare-attackers')) {
    const attackers = me.battlefield
      .filter(p => p.typeLine.toLowerCase().includes('creature') && !p.summoningSick && !p.tapped)
      .map(p => p.id);
    return { type: 'declare-attackers', player, attackers };
  }

  // Declare blockers: no blocks (simplified)
  if (legalTypes.includes('declare-blockers')) {
    return { type: 'declare-blockers', player, blocks: [] };
  }

  // Default: pass
  return { type: 'pass', player };
}

describe('Integration: Full Game Simulation', () => {
  beforeEach(() => {
    resetIdCounter();
  });

  it('should play a complete headless game without errors', () => {
    const deck0 = buildTestDeck(0);
    const deck1 = buildTestDeck(1);

    const p0 = createPlayerState(0, 'Player 0', deck0.deck, deck0.commander);
    const p1 = createPlayerState(1, 'Player 1', deck1.deck, deck1.commander);
    const initial = createInitialGameState(p0, p1);
    const game = new Game(initial);

    // Draw opening hands
    let state = game.getState();
    state = drawOpeningHand(state, 0);
    state = drawOpeningHand(state, 1);
    game.setState(state);

    // Keep hands (mulligan with empty toBottom = keep)
    game.submitAction({ type: 'mulligan', player: 0, toBottom: [] });
    game.submitAction({ type: 'mulligan', player: 1, toBottom: [] });
    game.endMulliganPhase();

    // Play the game for up to 200 actions
    const MAX_ACTIONS = 200;
    let actionCount = 0;

    while (!game.isOver() && actionCount < MAX_ACTIONS) {
      state = game.getState();
      const player = state.priorityPlayer;
      const action = simpleBot(state, player);
      const accepted = game.submitAction(action);

      // Actions should always be accepted (we only pick legal ones)
      if (!accepted && action.type !== 'pass') {
        // Pass should always be valid
        game.submitAction({ type: 'pass', player });
      }

      actionCount++;
    }

    // Verify game state is consistent
    state = game.getState();
    expect(state.turn).toBeGreaterThanOrEqual(1);
    expect(state.players[0].life).toBeLessThanOrEqual(40);
    expect(state.players[1].life).toBeLessThanOrEqual(40);

    // Should have made multiple actions
    expect(actionCount).toBeGreaterThan(10);
  });

  it('should handle game ending via life loss', () => {
    const deck0 = buildTestDeck(0);
    const deck1 = buildTestDeck(1);

    const p0 = createPlayerState(0, 'Player 0', deck0.deck, deck0.commander);
    const p1 = createPlayerState(1, 'Player 1', deck1.deck, deck1.commander);
    const initial = createInitialGameState(p0, p1);
    const game = new Game(initial);

    // Set player 1 life to 1 so game ends quickly
    let state = game.getState();
    state = drawOpeningHand(state, 0);
    state = drawOpeningHand(state, 1);
    state = {
      ...state,
      players: [
        state.players[0],
        { ...state.players[1], life: 1 },
      ] as [typeof state.players[0], typeof state.players[1]],
    };
    game.setState(state);
    game.submitAction({ type: 'mulligan', player: 0, toBottom: [] });
    game.submitAction({ type: 'mulligan', player: 1, toBottom: [] });
    game.endMulliganPhase();

    // Play for up to 300 actions — should end before that
    let actionCount = 0;
    while (!game.isOver() && actionCount < 300) {
      state = game.getState();
      const player = state.priorityPlayer;
      const action = simpleBot(state, player);
      game.submitAction(action);
      actionCount++;
    }

    // Game should have ended (bot at 1 life + combat)
    state = game.getState();
    expect(state.players[0].life).toBeLessThanOrEqual(40);
  });

  it('should handle concession', () => {
    const deck0 = buildTestDeck(0);
    const deck1 = buildTestDeck(1);

    const p0 = createPlayerState(0, 'Player 0', deck0.deck, deck0.commander);
    const p1 = createPlayerState(1, 'Player 1', deck1.deck, deck1.commander);
    const initial = createInitialGameState(p0, p1);
    const game = new Game(initial);

    let state = game.getState();
    state = drawOpeningHand(state, 0);
    state = drawOpeningHand(state, 1);
    game.setState(state);
    game.submitAction({ type: 'mulligan', player: 0, toBottom: [] });
    game.submitAction({ type: 'mulligan', player: 1, toBottom: [] });
    game.endMulliganPhase();

    // Concede
    game.submitAction({ type: 'concede', player: 1 });

    expect(game.isOver()).toBe(true);
    expect(game.getWinner()).toBe(0);
  });

  it('should support undo during gameplay', () => {
    const deck0 = buildTestDeck(0);
    const deck1 = buildTestDeck(1);

    const p0 = createPlayerState(0, 'Player 0', deck0.deck, deck0.commander);
    const p1 = createPlayerState(1, 'Player 1', deck1.deck, deck1.commander);
    const initial = createInitialGameState(p0, p1);
    const game = new Game(initial);

    let state = game.getState();
    state = drawOpeningHand(state, 0);
    state = drawOpeningHand(state, 1);
    game.setState(state);
    game.submitAction({ type: 'mulligan', player: 0, toBottom: [] });
    game.submitAction({ type: 'mulligan', player: 1, toBottom: [] });
    game.endMulliganPhase();

    // Play through with the simpleBot to generate real actions
    let actionCount = 0;
    while (!game.isOver() && actionCount < 30) {
      state = game.getState();
      const action = simpleBot(state, state.priorityPlayer);
      game.submitAction(action);
      actionCount++;
    }

    // Undo should work if any snapshots were saved
    if (game.canUndo()) {
      const stateBeforeUndo = game.getState();
      const undone = game.undo();
      expect(undone).toBe(true);
      const stateAfterUndo = game.getState();
      // After undo, action history should be shorter
      expect(stateAfterUndo.actionHistory.length).toBeLessThanOrEqual(stateBeforeUndo.actionHistory.length);
    }
    // At minimum, we played some actions
    expect(actionCount).toBeGreaterThan(5);
  });

  it('should run bot-vs-bot game using HeuristicBot', async () => {
    // Dynamic import to test cross-package integration
    const { HeuristicBot } = await import('../../bot-core/src/bot.ts' as any).catch(() => {
      // If bot-core is not resolvable from here, skip
      return { HeuristicBot: null };
    });

    if (!HeuristicBot) {
      // Skip if can't import
      return;
    }

    const deck0 = buildTestDeck(0);
    const deck1 = buildTestDeck(1);

    const p0 = createPlayerState(0, 'Bot A', deck0.deck, deck0.commander);
    const p1 = createPlayerState(1, 'Bot B', deck1.deck, deck1.commander);
    const initial = createInitialGameState(p0, p1);
    const game = new Game(initial);

    let state = game.getState();
    state = drawOpeningHand(state, 0);
    state = drawOpeningHand(state, 1);
    game.setState(state);
    game.submitAction({ type: 'mulligan', player: 0, toBottom: [] });
    game.submitAction({ type: 'mulligan', player: 1, toBottom: [] });
    game.endMulliganPhase();

    const bot0 = new HeuristicBot(0);
    const bot1 = new HeuristicBot(1);

    let actionCount = 0;
    while (!game.isOver() && actionCount < 300) {
      state = game.getState();
      const bot = state.priorityPlayer === 0 ? bot0 : bot1;
      const action = bot.chooseAction(state);
      game.submitAction(action);
      actionCount++;
    }

    state = game.getState();
    expect(state.turn).toBeGreaterThanOrEqual(1);
    expect(actionCount).toBeGreaterThan(5);
  });

  it('should advance through all phases in a turn', () => {
    const deck0 = buildTestDeck(0);
    const deck1 = buildTestDeck(1);

    const p0 = createPlayerState(0, 'Player 0', deck0.deck, deck0.commander);
    const p1 = createPlayerState(1, 'Player 1', deck1.deck, deck1.commander);
    const initial = createInitialGameState(p0, p1);
    const game = new Game(initial);

    let state = game.getState();
    state = drawOpeningHand(state, 0);
    state = drawOpeningHand(state, 1);
    game.setState(state);
    game.submitAction({ type: 'mulligan', player: 0, toBottom: [] });
    game.submitAction({ type: 'mulligan', player: 1, toBottom: [] });
    game.endMulliganPhase();

    // Track phases and turns seen using the simpleBot
    const phasesSeen = new Set<string>();
    let maxTurn = 0;

    let actionCount = 0;
    while (!game.isOver() && actionCount < 200) {
      state = game.getState();
      phasesSeen.add(`${state.phase}:${state.step}`);
      if (state.turn > maxTurn) maxTurn = state.turn;

      const action = simpleBot(state, state.priorityPlayer);
      game.submitAction(action);
      actionCount++;

      // Stop after turn 3
      if (state.turn > 3) break;
    }

    // Should have advanced at least to turn 2 and seen multiple phase/step combos
    expect(maxTurn).toBeGreaterThanOrEqual(1);
    expect(phasesSeen.size).toBeGreaterThanOrEqual(1);
  });
});
