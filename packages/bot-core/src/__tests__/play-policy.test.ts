import { describe, it, expect, beforeEach } from 'vitest';
import {
  chooseLandDrop,
  getCastCandidates,
  choosePlayAction,
  shouldHoldMana,
} from '../policies/play-policy.ts';
import {
  resetIds, makeCreature, makeInstant, makeLand, makeSorcery,
  createMainPhaseState, addToHand, setMana,
} from './test-helpers.ts';

beforeEach(() => resetIds());

describe('chooseLandDrop', () => {
  it('should suggest playing a land from hand', () => {
    let state = createMainPhaseState();
    const land = makeLand('Forest', 0);
    state = addToHand(state, land, 0);

    const result = chooseLandDrop(state, 0);
    expect(result).not.toBeNull();
    expect(result!.action.type).toBe('play-land');
  });

  it('should return null if no lands in hand', () => {
    let state = createMainPhaseState();
    // Replace hand with only spells
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [makeCreature('Bear', '{1}{G}', '2', '2', 0)] },
        state.players[1],
      ],
    };

    expect(chooseLandDrop(state, 0)).toBeNull();
  });

  it('should return null if max lands already played', () => {
    let state = createMainPhaseState();
    state = addToHand(state, makeLand('Forest', 0), 0);
    state = {
      ...state,
      players: [
        { ...state.players[0], landsPlayedThisTurn: 1 },
        state.players[1],
      ],
    };

    expect(chooseLandDrop(state, 0)).toBeNull();
  });

  it('should return null during non-main steps', () => {
    let state = createMainPhaseState();
    state = addToHand(state, makeLand('Forest', 0), 0);
    state = { ...state, step: 'upkeep' };

    expect(chooseLandDrop(state, 0)).toBeNull();
  });
});

describe('getCastCandidates', () => {
  it('should find castable spells sorted by priority', () => {
    let state = createMainPhaseState();
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [] },
        state.players[1],
      ],
    };

    const ramp = makeCreature('Ramp Elf', '{G}', '1', '1', 0, { tags: ['ramp'] });
    const vanilla = makeCreature('Bear', '{1}{G}', '2', '2', 0, { tags: [] });

    state = addToHand(state, ramp, 0);
    state = addToHand(state, vanilla, 0);
    state = setMana(state, 0, { G: 3 });

    const candidates = getCastCandidates(state, 0);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    // Ramp should be higher priority in early game (turn 3)
    if (candidates.length >= 2) {
      expect(candidates[0].card.name).toBe('Ramp Elf');
    }
  });

  it('should not include unaffordable spells', () => {
    let state = createMainPhaseState();
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [] },
        state.players[1],
      ],
    };
    const expensive = makeCreature('Giant', '{5}{G}{G}', '7', '7', 0);
    state = addToHand(state, expensive, 0);
    state = setMana(state, 0, { G: 1 }); // Not enough

    expect(getCastCandidates(state, 0)).toHaveLength(0);
  });

  it('should not include lands', () => {
    let state = createMainPhaseState();
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [makeLand('Forest', 0)] },
        state.players[1],
      ],
    };
    state = setMana(state, 0, { G: 5 });

    expect(getCastCandidates(state, 0)).toHaveLength(0);
  });
});

describe('choosePlayAction', () => {
  it('should prioritize land drops', () => {
    let state = createMainPhaseState();
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [] },
        state.players[1],
      ],
    };
    const land = makeLand('Forest', 0);
    const creature = makeCreature('Bear', '{1}{G}', '2', '2', 0);
    state = addToHand(state, land, 0);
    state = addToHand(state, creature, 0);
    state = setMana(state, 0, { G: 2 });

    const result = choosePlayAction(state, 0);
    expect(result).not.toBeNull();
    expect(result!.action.type).toBe('play-land');
  });

  it('should return null with empty hand and no mana', () => {
    let state = createMainPhaseState();
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [] },
        state.players[1],
      ],
    };

    expect(choosePlayAction(state, 0)).toBeNull();
  });
});

describe('shouldHoldMana', () => {
  it('should hold mana when counterspells are in hand', () => {
    let state = createMainPhaseState();
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [] },
        state.players[1],
      ],
    };
    const counter = makeInstant('Counterspell', '{U}{U}', 0, { tags: ['counter'] });
    state = addToHand(state, counter, 0);
    state = setMana(state, 0, { U: 2 });

    expect(shouldHoldMana(state, 0)).toBe(true);
  });

  it('should not hold mana without instant-speed options', () => {
    let state = createMainPhaseState();
    state = {
      ...state,
      players: [
        { ...state.players[0], hand: [] },
        state.players[1],
      ],
    };
    const sorcery = makeSorcery('Divination', '{2}{U}', 0, { tags: ['draw'] });
    state = addToHand(state, sorcery, 0);
    state = setMana(state, 0, { U: 1, generic: 2 });

    expect(shouldHoldMana(state, 0)).toBe(false);
  });
});
