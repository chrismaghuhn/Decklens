/**
 * Tests for the Triggered Abilities System.
 *
 * Covers:
 * - ETB triggers (self and others)
 * - Death triggers (self and others)
 * - Upkeep triggers
 * - Cast triggers
 * - Attack triggers
 * - Trigger effect resolution via pattern matching
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkETBTriggers,
  checkDeathTriggers,
  checkUpkeepTriggers,
  checkCastTriggers,
  checkAttackTriggers,
  checkTriggers,
  resetTriggerIdCounter,
} from '../rules/triggers.ts';
import type { GameState } from '../types/game-state.ts';
import type { Permanent } from '../types/permanent.ts';
import type { Card } from '../types/card.ts';
import type { PlayerState } from '../types/player.ts';
import { emptyManaPool } from '../types/player.ts';

// ─── Helpers ───

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: overrides.id || 'card_1',
    oracleId: overrides.oracleId || 'oracle_1',
    name: overrides.name || 'Test Card',
    manaCost: overrides.manaCost || '{1}',
    cmc: overrides.cmc || 1,
    typeLine: overrides.typeLine || 'Creature',
    oracleText: overrides.oracleText || '',
    colors: overrides.colors || [],
    colorIdentity: overrides.colorIdentity || [],
    rarity: overrides.rarity || 'common',
    tags: overrides.tags || [],
    imageUrl: overrides.imageUrl || '',
    owner: overrides.owner ?? 0,
    power: overrides.power,
    toughness: overrides.toughness,
    loyalty: overrides.loyalty,
  };
}

function makePermanent(overrides: Partial<Permanent> = {}): Permanent {
  return {
    id: overrides.id || 'perm_1',
    oracleId: overrides.oracleId || 'oracle_1',
    name: overrides.name || 'Test Permanent',
    manaCost: overrides.manaCost || '{1}',
    cmc: overrides.cmc || 1,
    typeLine: overrides.typeLine || 'Creature',
    oracleText: overrides.oracleText || '',
    colors: overrides.colors || [],
    colorIdentity: overrides.colorIdentity || [],
    rarity: overrides.rarity || 'common',
    tags: overrides.tags || [],
    imageUrl: overrides.imageUrl || '',
    owner: overrides.owner ?? 0,
    controller: overrides.controller ?? 0,
    tapped: overrides.tapped || false,
    flipped: false,
    faceDown: false,
    currentPower: overrides.currentPower ?? 2,
    currentToughness: overrides.currentToughness ?? 2,
    basePower: overrides.basePower ?? 2,
    baseToughness: overrides.baseToughness ?? 2,
    temporaryPtMods: [],
    damage: overrides.damage || 0,
    counters: overrides.counters || {},
    summoningSick: overrides.summoningSick ?? false,
    attacking: overrides.attacking || false,
    blocking: null,
    abilities: overrides.abilities || [],
    x: 0,
    y: 0,
    enteredBattlefieldTurn: overrides.enteredBattlefieldTurn || 1,
    attachments: [],
    power: overrides.power || '2',
    toughness: overrides.toughness || '2',
  };
}

function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 0,
    name: 'Test Player',
    library: [],
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    commandZone: [],
    life: 40,
    manaPool: emptyManaPool(),
    poisonCounters: 0,
    commanderDamage: {},
    commanderTax: 0,
    landPlayedThisTurn: false,
    landsPlayedThisTurn: 0,
    maxLandPlays: 1,
    hasDrawnThisGame: false,
    ...overrides,
  };
}

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    players: overrides.players || [
      makePlayer({ id: 0, name: 'Player 1' }),
      makePlayer({ id: 1, name: 'Player 2' }),
    ] as [PlayerState, PlayerState],
    activePlayer: overrides.activePlayer ?? 0,
    priorityPlayer: overrides.priorityPlayer ?? 0,
    turn: overrides.turn || 1,
    phase: overrides.phase || 'beginning',
    step: overrides.step || 'upkeep',
    stack: overrides.stack || [],
    combat: overrides.combat || null,
    winner: null,
    gameOver: false,
    log: overrides.log || [],
    actionHistory: [],
    playersPassed: new Set() as Set<number>,
    mulliganPhase: false,
    mulliganCount: [0, 0],
  };
}

// ─── Tests ───

describe('Triggered Abilities', () => {
  beforeEach(() => {
    resetTriggerIdCounter();
  });

  describe('ETB Triggers', () => {
    it('should detect self ETB trigger and add to stack', () => {
      const permanent = makePermanent({
        id: 'etb_creature',
        name: 'Elvish Visionary',
        oracleText: 'When Elvish Visionary enters the battlefield, draw a card.',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [permanent] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkETBTriggers(state, permanent);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].type).toBe('ability');
      expect(result.stack[0].text).toContain('Elvish Visionary');
      expect(result.stack[0].text).toContain('draw a card');
      expect(result.stack[0].controller).toBe(0);
    });

    it('should detect self ETB with ~ replacement', () => {
      const permanent = makePermanent({
        id: 'etb_self',
        name: 'Mulldrifter',
        oracleText: 'When ~ enters the battlefield, draw two cards.',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [permanent] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkETBTriggers(state, permanent);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].oracleText).toContain('draw two cards');
    });

    it('should not trigger self ETB for other permanents entering', () => {
      const existing = makePermanent({
        id: 'existing_etb',
        name: 'Elvish Visionary',
        oracleText: 'When ~ enters the battlefield, draw a card.',
      });

      const newPerm = makePermanent({
        id: 'new_creature',
        name: 'Grizzly Bears',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [existing, newPerm] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkETBTriggers(state, newPerm);

      // Elvish Visionary's ETB should NOT trigger for Grizzly Bears entering
      expect(result.stack.length).toBe(0);
    });

    it('should trigger "whenever a creature enters the battlefield" for any creature', () => {
      const observer = makePermanent({
        id: 'observer',
        name: 'Soul Warden',
        oracleText: 'Whenever a creature enters the battlefield, you gain 1 life.',
      });

      const newCreature = makePermanent({
        id: 'new_creature',
        name: 'Grizzly Bears',
        typeLine: 'Creature',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [observer, newCreature] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkETBTriggers(state, newCreature);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].text).toContain('Soul Warden');
    });

    it('should trigger "whenever another creature enters" but not for self', () => {
      const observer = makePermanent({
        id: 'observer',
        name: 'Mentor of the Meek',
        oracleText: 'Whenever another creature enters the battlefield under your control, draw a card.',
      });

      const newCreature = makePermanent({
        id: 'new_creature',
        name: 'Grizzly Bears',
        controller: 0,
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [observer, newCreature] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      // Another creature entering should trigger
      const result1 = checkETBTriggers(state, newCreature);
      expect(result1.stack.length).toBe(1);

      // Self entering should NOT trigger
      const result2 = checkETBTriggers(state, observer);
      expect(result2.stack.length).toBe(0);
    });

    it('should set oracleText to extracted effect text for pattern matching', () => {
      const permanent = makePermanent({
        id: 'etb_creature',
        name: 'Elvish Visionary',
        oracleText: 'When Elvish Visionary enters the battlefield, draw a card.',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [permanent] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkETBTriggers(state, permanent);

      expect(result.stack[0].oracleText).toBe('draw a card');
    });
  });

  describe('Death Triggers', () => {
    it('should detect self death trigger from dying creature', () => {
      const dying = makePermanent({
        id: 'dying_creature',
        name: 'Blood Artist',
        oracleText: 'When ~ dies, target player loses 1 life.',
        controller: 0,
      });

      const state = makeState();
      const result = checkDeathTriggers(state, [dying], 0);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].text).toContain('Blood Artist');
      expect(result.stack[0].controller).toBe(0);
    });

    it('should detect "whenever a creature dies" from observer', () => {
      const observer = makePermanent({
        id: 'observer',
        name: 'Zulaport Cutthroat',
        oracleText: 'Whenever a creature you control dies, each opponent loses 1 life.',
        controller: 0,
      });

      const dying = makePermanent({
        id: 'dying_creature',
        name: 'Grizzly Bears',
        controller: 0,
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [observer] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkDeathTriggers(state, [dying], 0);

      // Should have observer's trigger + the dying creature's own death trigger (if any)
      expect(result.stack.length).toBeGreaterThanOrEqual(1);
      expect(result.stack.some(s => s.text.includes('Zulaport Cutthroat'))).toBe(true);
    });

    it('should handle multiple dying creatures', () => {
      const dying1 = makePermanent({
        id: 'dying_1',
        name: 'Doomed Dissenter',
        oracleText: 'When ~ dies, create a 2/2 black Zombie creature token.',
        controller: 0,
      });
      const dying2 = makePermanent({
        id: 'dying_2',
        name: 'Festering Goblin',
        oracleText: 'When ~ dies, target creature gets -1/-1 until end of turn.',
        controller: 0,
      });

      const state = makeState();
      const result = checkDeathTriggers(state, [dying1, dying2], 0);

      expect(result.stack.length).toBe(2);
    });
  });

  describe('Upkeep Triggers', () => {
    it('should detect "at the beginning of your upkeep" for active player', () => {
      const permanent = makePermanent({
        id: 'upkeep_perm',
        name: 'Dark Confidant',
        oracleText: 'At the beginning of your upkeep, reveal the top card of your library.',
        controller: 0,
      });

      const state = makeState({
        activePlayer: 0,
        step: 'upkeep',
        players: [
          makePlayer({ battlefield: [permanent] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkUpkeepTriggers(state);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].text).toContain('Dark Confidant');
    });

    it('should NOT trigger "your upkeep" for non-active player', () => {
      const permanent = makePermanent({
        id: 'upkeep_perm',
        name: 'Dark Confidant',
        oracleText: 'At the beginning of your upkeep, reveal the top card of your library.',
        controller: 1,
      });

      const state = makeState({
        activePlayer: 0,
        step: 'upkeep',
        players: [
          makePlayer(),
          makePlayer({ battlefield: [permanent] }),
        ] as [PlayerState, PlayerState],
      });

      const result = checkUpkeepTriggers(state);

      // P2's "your upkeep" shouldn't trigger during P1's upkeep
      expect(result.stack.length).toBe(0);
    });

    it('should trigger "each upkeep" for both players', () => {
      const permanent = makePermanent({
        id: 'each_upkeep',
        name: 'Sulfuric Vortex',
        oracleText: 'At the beginning of each player\'s upkeep, Sulfuric Vortex deals 2 damage to that player.',
        controller: 0,
      });

      const state = makeState({
        activePlayer: 0,
        step: 'upkeep',
        players: [
          makePlayer({ battlefield: [permanent] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkUpkeepTriggers(state);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].text).toContain('Sulfuric Vortex');
    });
  });

  describe('Cast Triggers', () => {
    it('should detect "whenever you cast a spell"', () => {
      const observer = makePermanent({
        id: 'observer',
        name: 'Guttersnipe',
        oracleText: 'Whenever you cast an instant or sorcery spell, Guttersnipe deals 2 damage to each opponent.',
        controller: 0,
      });

      const castCard = makeCard({
        id: 'spell',
        name: 'Lightning Bolt',
        typeLine: 'Instant',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [observer] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkCastTriggers(state, castCard, 0);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].text).toContain('Guttersnipe');
    });

    it('should NOT trigger "cast instant or sorcery" for creature spells', () => {
      const observer = makePermanent({
        id: 'observer',
        name: 'Guttersnipe',
        oracleText: 'Whenever you cast an instant or sorcery spell, Guttersnipe deals 2 damage to each opponent.',
        controller: 0,
      });

      const castCard = makeCard({
        id: 'creature_spell',
        name: 'Grizzly Bears',
        typeLine: 'Creature — Bear',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [observer] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkCastTriggers(state, castCard, 0);

      // Should NOT trigger for a creature spell
      expect(result.stack.length).toBe(0);
    });

    it('should NOT trigger "whenever you cast" for opponent casting', () => {
      const observer = makePermanent({
        id: 'observer',
        name: 'Prowess Creature',
        oracleText: 'Whenever you cast a spell, this creature gets +1/+1 until end of turn.',
        controller: 0,
      });

      const castCard = makeCard({
        id: 'opp_spell',
        name: 'Giant Growth',
        typeLine: 'Instant',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [observer] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      // Player 1 casts — Player 0's trigger should NOT fire
      const result = checkCastTriggers(state, castCard, 1);

      expect(result.stack.length).toBe(0);
    });
  });

  describe('Attack Triggers', () => {
    it('should detect "whenever ~ attacks"', () => {
      const attacker = makePermanent({
        id: 'attacker',
        name: 'Hero of Bladehold',
        oracleText: 'Whenever ~ attacks, create two 1/1 white Soldier creature tokens.',
        controller: 0,
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [attacker] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkAttackTriggers(state, [attacker], 0);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].text).toContain('Hero of Bladehold');
    });

    it('should NOT trigger self attack for other creatures attacking', () => {
      const observer = makePermanent({
        id: 'observer',
        name: 'Attack Trigger Creature',
        oracleText: 'Whenever ~ attacks, draw a card.',
        controller: 0,
      });

      const attacker = makePermanent({
        id: 'actual_attacker',
        name: 'Grizzly Bears',
        controller: 0,
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [observer, attacker] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      // Only Grizzly Bears attacks, not the observer
      const result = checkAttackTriggers(state, [attacker], 0);

      expect(result.stack.length).toBe(0);
    });

    it('should trigger "whenever a creature you control attacks"', () => {
      const observer = makePermanent({
        id: 'observer',
        name: 'Beastmaster Ascension',
        oracleText: 'Whenever a creature you control attacks, put a quest counter on Beastmaster Ascension.',
        controller: 0,
      });

      const attacker = makePermanent({
        id: 'attacker',
        name: 'Grizzly Bears',
        controller: 0,
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [observer, attacker] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkAttackTriggers(state, [attacker], 0);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].text).toContain('Beastmaster Ascension');
    });
  });

  describe('Log Entries', () => {
    it('should log trigger events', () => {
      const permanent = makePermanent({
        id: 'etb_creature',
        name: 'Elvish Visionary',
        oracleText: 'When Elvish Visionary enters the battlefield, draw a card.',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [permanent] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkETBTriggers(state, permanent);

      expect(result.log.length).toBe(1);
      expect(result.log[0].message).toContain('Triggered');
      expect(result.log[0].message).toContain('Elvish Visionary');
    });
  });

  describe('Effect Text Extraction', () => {
    it('should extract effect text correctly from ETB', () => {
      const permanent = makePermanent({
        id: 'etb_creature',
        name: 'Test Card',
        oracleText: 'When Test Card enters the battlefield, destroy target creature.',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [permanent] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkETBTriggers(state, permanent);

      expect(result.stack[0].oracleText).toBe('destroy target creature');
    });

    it('should extract effect text from ~ ETB', () => {
      const permanent = makePermanent({
        id: 'test',
        name: 'Ravenous Chupacabra',
        oracleText: 'When ~ enters the battlefield, destroy target creature an opponent controls.',
      });

      const state = makeState({
        players: [
          makePlayer({ battlefield: [permanent] }),
          makePlayer(),
        ] as [PlayerState, PlayerState],
      });

      const result = checkETBTriggers(state, permanent);

      expect(result.stack[0].oracleText).toBe('destroy target creature an opponent controls');
    });

    it('should extract effect from death trigger', () => {
      const dying = makePermanent({
        id: 'dying',
        name: 'Wurmcoil Engine',
        oracleText: 'When ~ dies, create a 3/3 colorless Wurm token with deathtouch and a 3/3 colorless Wurm token with lifelink.',
        controller: 0,
      });

      const state = makeState();
      const result = checkDeathTriggers(state, [dying], 0);

      expect(result.stack.length).toBe(1);
      expect(result.stack[0].oracleText).toContain('create a 3/3');
    });
  });
});
