import { describe, it, expect, beforeEach } from 'vitest';
import { setupNewGameN, createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { Game } from '../engine/game.ts';
import { passPriority } from '../rules/priority.ts';
import { checkStateBasedActions } from '../rules/state-based.ts';
import type { Card } from '../types/card.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeDeck(owner: number, size = 98): Card[] {
  return Array.from({ length: size }, (_, i) =>
    createSimpleCard(`Card ${i}`, 'Creature', '{1}', owner)
  );
}

function makeCommander(owner: number, name = `Commander ${owner}`): Card {
  return createSimpleCard(name, 'Legendary Creature', '{3}{G}', owner);
}

/** Build a 3-player GameState via setupNewGameN */
function make3PlayerState() {
  return setupNewGameN([
    { name: 'Alice', deck: makeDeck(0), commander: makeCommander(0, 'Cmdr A') },
    { name: 'Bob',   deck: makeDeck(1), commander: makeCommander(1, 'Cmdr B') },
    { name: 'Carol', deck: makeDeck(2), commander: makeCommander(2, 'Cmdr C') },
  ]);
}

beforeEach(() => {
  resetIdCounter();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('N-Player Support', () => {
  it('setupNewGameN creates 3-player game correctly', () => {
    const state = make3PlayerState();

    // Correct number of players
    expect(state.players.length).toBe(3);

    // Names assigned properly
    expect(state.players[0].name).toBe('Alice');
    expect(state.players[1].name).toBe('Bob');
    expect(state.players[2].name).toBe('Carol');

    // Player ids match index
    expect(state.players[0].id).toBe(0);
    expect(state.players[1].id).toBe(1);
    expect(state.players[2].id).toBe(2);

    // Turn starts with player 0
    expect(state.activePlayer).toBe(0);
    expect(state.priorityPlayer).toBe(0);

    // mulliganCount has 3 slots, all zero
    expect(state.mulliganCount.length).toBe(3);
    expect(state.mulliganCount.every(c => c === 0)).toBe(true);

    // Opening hands dealt (7 cards each)
    expect(state.players[0].hand.length).toBe(7);
    expect(state.players[1].hand.length).toBe(7);
    expect(state.players[2].hand.length).toBe(7);

    // Each player has their commander in the command zone
    expect(state.players[0].commandZone[0].name).toBe('Cmdr A');
    expect(state.players[1].commandZone[0].name).toBe('Cmdr B');
    expect(state.players[2].commandZone[0].name).toBe('Cmdr C');

    // Starting life totals
    expect(state.players.every(p => p.life === 40)).toBe(true);

    // No eliminated players
    expect(state.players.every(p => !p.eliminated)).toBe(true);
  });

  it('3-player turn rotation: 0 → 1 → 2 → 0, turn increments on full round', () => {
    // Start after mulligan so real turns can progress
    const rawState = make3PlayerState();
    const game = new Game({ ...rawState, mulliganPhase: false });

    // Turn 1, player 0 active
    expect(game.getActivePlayer()).toBe(0);
    expect(game.getTurn()).toBe(1);

    // Pass all priority so the step/phase advances until a new turn starts
    // We'll pass through enough steps to end turn 1 for player 0
    // autoPassIfNeeded handles untap/cleanup; we pass manually through main etc.
    // Use submitAction('pass') enough times to cycle through all steps and start player 1's turn
    let iterations = 0;
    const MAX = 200;
    while (game.getActivePlayer() === 0 && iterations < MAX) {
      game.autoPassIfNeeded();
      if (!game.isOver() && game.getActivePlayer() === 0) {
        game.submitAction({ type: 'pass', player: game.getState().priorityPlayer });
      }
      iterations++;
    }

    expect(game.getActivePlayer()).toBe(1);
    expect(game.getTurn()).toBe(1); // Turn doesn't increment until we complete a full round

    // Now advance through player 1's turn
    iterations = 0;
    while (game.getActivePlayer() === 1 && iterations < MAX) {
      game.autoPassIfNeeded();
      if (!game.isOver() && game.getActivePlayer() === 1) {
        game.submitAction({ type: 'pass', player: game.getState().priorityPlayer });
      }
      iterations++;
    }

    expect(game.getActivePlayer()).toBe(2);
    expect(game.getTurn()).toBe(1); // Still turn 1

    // Advance through player 2's turn — turn should then increment to 2
    iterations = 0;
    while (game.getActivePlayer() === 2 && iterations < MAX) {
      game.autoPassIfNeeded();
      if (!game.isOver() && game.getActivePlayer() === 2) {
        game.submitAction({ type: 'pass', player: game.getState().priorityPlayer });
      }
      iterations++;
    }

    // After completing the full round, turn 2 begins with player 0
    expect(game.getActivePlayer()).toBe(0);
    expect(game.getTurn()).toBe(2);
  });

  it('3-player priority: all 3 must pass before step advances', () => {
    const rawState = make3PlayerState();
    // Put state into main phase where priority passes are meaningful
    const state = {
      ...rawState,
      mulliganPhase: false,
      phase: 'precombat-main' as const,
      step: 'main' as const,
      activePlayer: 0,
      priorityPlayer: 0,
      playersPassed: new Set<number>(),
    };

    // Pass 1: player 0 passes → priority goes to player 1
    const after0 = passPriority(state);
    expect(after0.priorityPlayer).toBe(1);
    expect(after0.playersPassed.has(0)).toBe(true);
    expect(after0.playersPassed.size).toBe(1);
    // Step should NOT have advanced yet
    expect(after0.step).toBe('main');
    expect(after0.phase).toBe('precombat-main');

    // Pass 2: player 1 passes → priority goes to player 2
    const after1 = passPriority(after0);
    expect(after1.priorityPlayer).toBe(2);
    expect(after1.playersPassed.has(1)).toBe(true);
    expect(after1.playersPassed.size).toBe(2);
    // Still in main
    expect(after1.step).toBe('main');

    // Pass 3: player 2 passes → all 3 passed with empty stack → step advances
    const after2 = passPriority(after1);
    // Step should have advanced (from main in precombat-main → combat phase begins)
    // playersPassed should be cleared
    expect(after2.playersPassed.size).toBe(0);
    // The step advanced past 'main' (precombat-main has only one step 'main', so we move to combat)
    expect(after2.phase).toBe('combat');
  });

  it('player elimination: game continues with 2 of 3, turn rotation skips eliminated', () => {
    const rawState = make3PlayerState();

    // Manually set player 1's life to 0 to trigger elimination
    const stateWithDeadPlayer = {
      ...rawState,
      mulliganPhase: false,
      phase: 'precombat-main' as const,
      step: 'main' as const,
      players: rawState.players.map((p, i) =>
        i === 1 ? { ...p, life: 0 } : p
      ),
    };

    // Run state-based actions → player 1 should be eliminated
    const afterSBA = checkStateBasedActions(stateWithDeadPlayer);

    // Player 1 is eliminated
    expect(afterSBA.players[1].eliminated).toBe(true);

    // Game is NOT over — 2 players (Alice and Carol) remain
    expect(afterSBA.gameOver).toBe(false);
    expect(afterSBA.winner).toBeNull();

    // Alice and Carol are still alive
    expect(afterSBA.players[0].eliminated).toBeFalsy();
    expect(afterSBA.players[2].eliminated).toBeFalsy();

    // Now verify turn rotation skips player 1
    const game = new Game(afterSBA);
    // Current active player is 0 (Alice)
    expect(game.getActivePlayer()).toBe(0);

    let iterations = 0;
    const MAX = 200;
    while (game.getActivePlayer() === 0 && iterations < MAX) {
      game.autoPassIfNeeded();
      if (!game.isOver() && game.getActivePlayer() === 0) {
        game.submitAction({ type: 'pass', player: game.getState().priorityPlayer });
      }
      iterations++;
    }

    // Turn should skip eliminated player 1 and go to player 2 (Carol)
    expect(game.getActivePlayer()).toBe(2);
    // Game should still be ongoing
    expect(game.isOver()).toBe(false);
  });
});
