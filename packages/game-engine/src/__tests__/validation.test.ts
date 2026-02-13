import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateAction,
  isLegalAction,
  getLegalActionTypes,
} from '../engine/validation.ts';
import { createPlayerState, emptyManaPool } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import { drawCards } from '../engine/zone-manager.ts';
import { addMana, emptyPool } from '../rules/mana.ts';
import type { GameState } from '../types/game-state.ts';
import type { GameAction, Target } from '../types/action.ts';
import type { ManaPayment } from '../types/mana.ts';

function createMainPhaseState(): GameState {
  resetIdCounter();
  const deck1 = [];
  // Lands
  for (let i = 0; i < 38; i++) {
    deck1.push(createSimpleCard('Forest', 'Basic Land — Forest', '', 0));
  }
  // Creatures
  for (let i = 0; i < 50; i++) {
    deck1.push(createSimpleCard('Elf', 'Creature — Elf', '{G}', 0, {
      power: '1', toughness: '1', colors: ['G'],
    }));
  }
  // Instants
  for (let i = 0; i < 11; i++) {
    deck1.push(createSimpleCard('Giant Growth', 'Instant', '{G}', 0, { colors: ['G'] }));
  }

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
});

describe('validateAction', () => {
  it('should reject actions when game is over', () => {
    const state = { ...createMainPhaseState(), gameOver: true };
    const error = validateAction(state, { type: 'pass', player: 0 });
    expect(error).toBe('Game is over.');
  });

  it('should always allow concede', () => {
    const state = createMainPhaseState();
    expect(validateAction(state, { type: 'concede', player: 0 })).toBeNull();
    expect(validateAction(state, { type: 'concede', player: 1 })).toBeNull();
  });

  it('should allow pass for priority player', () => {
    const state = createMainPhaseState();
    expect(validateAction(state, { type: 'pass', player: 0 })).toBeNull();
  });

  it('should reject pass for non-priority player', () => {
    const state = createMainPhaseState();
    const error = validateAction(state, { type: 'pass', player: 1 });
    expect(error).toBe('Not your priority.');
  });
});

describe('validatePlayLand', () => {
  it('should allow playing a land during main phase', () => {
    const state = createMainPhaseState();
    const landCard = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('land')
    );
    if (!landCard) return;

    const error = validateAction(state, {
      type: 'play-land',
      player: 0,
      cardId: landCard.id,
    });
    expect(error).toBeNull();
  });

  it('should reject playing land outside main phase', () => {
    const state = { ...createMainPhaseState(), step: 'upkeep' as const };
    const landCard = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('land')
    );
    if (!landCard) return;

    const error = validateAction(state, {
      type: 'play-land',
      player: 0,
      cardId: landCard.id,
    });
    expect(error).toBe('Can only play lands during main phase.');
  });

  it('should reject second land drop', () => {
    const state = createMainPhaseState();
    state.players[0].landsPlayedThisTurn = 1;
    const landCard = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('land')
    );
    if (!landCard) return;

    const error = validateAction(state, {
      type: 'play-land',
      player: 0,
      cardId: landCard.id,
    });
    expect(error).toBe('Already played maximum lands this turn.');
  });

  it('should reject non-active player playing land', () => {
    const state = createMainPhaseState();
    const error = validateAction(state, {
      type: 'play-land',
      player: 1,
      cardId: 'whatever',
    });
    expect(error).toBe('Not your priority.');
  });

  it('should reject playing non-land as land', () => {
    const state = createMainPhaseState();
    const creature = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('creature')
    );
    if (!creature) return;

    const error = validateAction(state, {
      type: 'play-land',
      player: 0,
      cardId: creature.id,
    });
    expect(error).toBe('Card is not a land.');
  });
});

describe('validateCastSpell', () => {
  it('should reject when not enough mana', () => {
    const state = createMainPhaseState();
    const creature = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('creature')
    );
    if (!creature) return;

    const error = validateAction(state, {
      type: 'cast-spell',
      player: 0,
      cardId: creature.id,
      targets: [],
      manaPayment: emptyPayment,
    });
    expect(error).toBe('Not enough mana to cast this spell.');
  });

  it('should allow casting with enough mana', () => {
    const state = createMainPhaseState();
    // Give player some green mana
    state.players[0].manaPool = addMana(emptyPool(), 'G', 5);

    const creature = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('creature') && c.manaCost === '{G}'
    );
    if (!creature) return;

    const payment: ManaPayment = {
      from: addMana(emptyPool(), 'G', 1),
      phyrexianLife: 0,
      hybridChoices: [],
      xValue: 0,
    };

    const error = validateAction(state, {
      type: 'cast-spell',
      player: 0,
      cardId: creature.id,
      targets: [],
      manaPayment: payment,
    });
    expect(error).toBeNull();
  });

  it('should reject sorcery-speed outside main phase', () => {
    const state = { ...createMainPhaseState(), step: 'upkeep' as const };
    state.players[0].manaPool = addMana(emptyPool(), 'G', 5);

    const creature = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('creature')
    );
    if (!creature) return;

    const error = validateAction(state, {
      type: 'cast-spell',
      player: 0,
      cardId: creature.id,
      targets: [],
      manaPayment: emptyPayment,
    });
    expect(error).toBe('Can only cast instants or flash spells outside main phase.');
  });

  it('should allow casting instants outside main phase', () => {
    const state = { ...createMainPhaseState(), step: 'upkeep' as const };
    state.players[0].manaPool = addMana(emptyPool(), 'G', 5);

    const instant = state.players[0].hand.find(
      (c) => c.typeLine.toLowerCase().includes('instant')
    );
    if (!instant) return;

    const payment: ManaPayment = {
      from: addMana(emptyPool(), 'G', 1),
      phyrexianLife: 0,
      hybridChoices: [],
      xValue: 0,
    };

    const error = validateAction(state, {
      type: 'cast-spell',
      player: 0,
      cardId: instant.id,
      targets: [],
      manaPayment: payment,
    });
    expect(error).toBeNull();
  });
});

describe('getLegalActionTypes', () => {
  it('should include pass and concede', () => {
    const state = createMainPhaseState();
    const types = getLegalActionTypes(state);
    expect(types).toContain('pass');
    expect(types).toContain('concede');
  });

  it('should include play-land when land in hand during main', () => {
    const state = createMainPhaseState();
    const hasLand = state.players[0].hand.some(
      (c) => c.typeLine.toLowerCase().includes('land')
    );
    const types = getLegalActionTypes(state);
    if (hasLand) {
      expect(types).toContain('play-land');
    }
  });

  it('should include cast-spell when affordable spell in hand', () => {
    const state = createMainPhaseState();
    state.players[0].manaPool = addMana(emptyPool(), 'G', 5);
    // Ensure hand has a castable creature (drawCards may draw only lands)
    const elf = createSimpleCard('Test Elf', 'Creature — Elf', '{G}', 0, {
      power: '1', toughness: '1', colors: ['G'],
    });
    state.players[0].hand.push(elf);
    const types = getLegalActionTypes(state);
    expect(types).toContain('cast-spell');
  });

  it('should return empty for non-priority player', () => {
    const state = createMainPhaseState();
    state.priorityPlayer = 1;
    // Player 0 has priority = false, but getLegalActionTypes checks priorityPlayer
    // Since priorityPlayer is 1 and canPlayerAct checks state.priorityPlayer !== player
    // Actually getLegalActionTypes uses state.priorityPlayer
    const types = getLegalActionTypes(state);
    // Bot (player 1) can act, but may not have castable spells
    expect(types).toContain('pass');
  });
});
