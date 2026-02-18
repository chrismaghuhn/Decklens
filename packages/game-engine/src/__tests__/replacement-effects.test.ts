import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkReplacementEffects,
  applyDeathReplacement,
  applyDrawReplacement,
  applyDamageReplacement,
  applyLifeGainReplacement,
  applyGraveyardReplacement,
} from '../rules/replacement-effects.ts';
import type { ReplacementEvent } from '../rules/replacement-effects.ts';
import { checkStateBasedActions } from '../rules/state-based.ts';
import { createPlayerState, emptyManaPool } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import { cardToPermanent } from '../types/permanent.ts';
import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
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

function createCreaturePermanent(
  name: string,
  controller: 0 | 1,
  power: number,
  toughness: number,
  oracleText: string = '',
): Permanent {
  const card = createSimpleCard(name, 'Creature', '{2}', controller);
  card.power = String(power);
  card.toughness = String(toughness);
  card.oracleText = oracleText;
  return cardToPermanent(card, controller, 1);
}

function createEnchantmentPermanent(
  name: string,
  controller: 0 | 1,
  oracleText: string,
): Permanent {
  const card = createSimpleCard(name, 'Enchantment', '{2}', controller);
  card.oracleText = oracleText;
  const perm = cardToPermanent(card, controller, 1);
  return { ...perm, currentPower: undefined, currentToughness: undefined };
}

beforeEach(() => {
  resetIdCounter();
});

describe('Replacement Effects (CR 614)', () => {
  describe('applyDeathReplacement', () => {
    it('should return graveyard when no replacement effects exist', () => {
      const state = createTestState();
      const creature = createCreaturePermanent('Bear', 0, 2, 2);

      const result = applyDeathReplacement(state, creature);
      expect(result.zone).toBe('graveyard');
      expect(result.description).toBeUndefined();
    });

    it('should exile creature when "exile instead of die" effect is on battlefield', () => {
      const state = createTestState();
      const restInPeace = createEnchantmentPermanent(
        'Rest in Peace',
        0,
        'If a card would be put into a graveyard from anywhere, exile it instead.'
      );
      const creature = createCreaturePermanent('Bear', 0, 2, 2);

      // Place the enchantment on the battlefield
      const stateWithRIP: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [restInPeace] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = applyDeathReplacement(stateWithRIP, creature);
      expect(result.zone).toBe('exile');
      expect(result.description).toContain('exiled');
    });

    it('should exile when self-exile replacement exists on the dying permanent', () => {
      const state = createTestState();
      // Create a creature with "If ~ would die, exile it instead"
      const phoenix = createCreaturePermanent(
        'Immortal Phoenix',
        0,
        3,
        2,
        'Flying. If ~ would die, exile it instead.'
      );

      const stateWithPhoenix: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [phoenix] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = applyDeathReplacement(stateWithPhoenix, phoenix);
      expect(result.zone).toBe('exile');
      expect(result.description).toContain('exiled');
    });

    it('should shuffle into library for Eldrazi-style replacement', () => {
      const state = createTestState();
      const eldrazi = createCreaturePermanent(
        'Ulamog',
        0,
        10,
        10,
        "If ~ would be put into a graveyard from anywhere, shuffle it into its owner's library instead."
      );

      const stateWithEldrazi: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [eldrazi] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = applyDeathReplacement(stateWithEldrazi, eldrazi);
      expect(result.zone).toBe('library');
      expect(result.description).toContain('shuffled into library');
    });
  });

  describe('applyDrawReplacement', () => {
    it('should allow draw when no replacement effects exist', () => {
      const state = createTestState();
      const result = applyDrawReplacement(state, 0);
      expect(result.shouldDraw).toBe(true);
    });

    it('should replace draw with reveal-and-choose effect', () => {
      const state = createTestState();
      const underrealm = createCreaturePermanent(
        'Underrealm Lich',
        0,
        4,
        3,
        'If you would draw a card, instead look at the top 3 cards of your library. Put one into your hand and the rest on the bottom.'
      );

      const stateWithLich: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [underrealm] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = applyDrawReplacement(stateWithLich, 0);
      expect(result.shouldDraw).toBe(false);
      expect(result.description).toContain('Underrealm Lich');
      // State should have been modified (card put in hand)
      if (result.state) {
        expect(result.state.players[0].hand.length).toBeGreaterThanOrEqual(
          state.players[0].hand.length + 1
        );
      }
    });

    it('should not replace opponent draw with controller-only effect', () => {
      const state = createTestState();
      const underrealm = createCreaturePermanent(
        'Underrealm Lich',
        0,
        4,
        3,
        'If you would draw a card, instead look at the top 3 cards of your library.'
      );

      const stateWithLich: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [underrealm] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      // Opponent's draw should not be affected
      const result = applyDrawReplacement(stateWithLich, 1);
      expect(result.shouldDraw).toBe(true);
    });
  });

  describe('applyDamageReplacement', () => {
    it('should not prevent damage when no replacement effects exist', () => {
      const state = createTestState();
      const result = applyDamageReplacement(state, null, 0, 5);
      expect(result.amount).toBe(5);
    });

    it('should prevent damage with "prevent all damage" effect (Fog)', () => {
      const state = createTestState();
      const fogEffect = createEnchantmentPermanent(
        'Fog Bank',
        0,
        'Prevent all combat damage that would be dealt this turn.'
      );

      const stateWithFog: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [fogEffect] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = applyDamageReplacement(stateWithFog, null, 0, 5);
      expect(result.amount).toBe(0);
      expect(result.description).toContain('prevented');
    });

    it('should double damage with damage doubling effect', () => {
      const state = createTestState();
      const furnace = createEnchantmentPermanent(
        'Furnace of Rath',
        0,
        'If a source would deal damage to a permanent or player, it deals double that damage instead.'
      );

      const stateWithFurnace: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [furnace] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = applyDamageReplacement(stateWithFurnace, null, 0, 3);
      expect(result.amount).toBe(6);
      expect(result.description).toContain('doubled');
    });
  });

  describe('applyLifeGainReplacement', () => {
    it('should not modify life gain when no replacement effects exist', () => {
      const state = createTestState();
      const result = applyLifeGainReplacement(state, 0, 5);
      expect(result.amount).toBe(5);
    });

    it('should double life gain with doubling effect', () => {
      const state = createTestState();
      const boon = createEnchantmentPermanent(
        'Boon Reflection',
        0,
        'If you would gain life, you gain twice that much life instead.'
      );

      const stateWithBoon: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [boon] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = applyLifeGainReplacement(stateWithBoon, 0, 5);
      expect(result.amount).toBe(10);
      expect(result.description).toContain('doubled');
    });

    it('should add extra life with bonus effect', () => {
      const state = createTestState();
      const extra = createEnchantmentPermanent(
        'Life Bonus',
        0,
        'If you would gain life, you gain that much life plus 2.'
      );

      const stateWithExtra: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [extra] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = applyLifeGainReplacement(stateWithExtra, 0, 3);
      expect(result.amount).toBe(5);
    });

    it('should not double opponent life gain with controller-only effect', () => {
      const state = createTestState();
      const boon = createEnchantmentPermanent(
        'Boon Reflection',
        0,
        'If you would gain life, you gain twice that much life instead.'
      );

      const stateWithBoon: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [boon] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      // Opponent gaining life should NOT be doubled
      const result = applyLifeGainReplacement(stateWithBoon, 1, 5);
      expect(result.amount).toBe(5);
    });
  });

  describe('applyGraveyardReplacement', () => {
    it('should return graveyard when no replacement effects exist', () => {
      const state = createTestState();
      const card = createSimpleCard('Lightning Bolt', 'Instant', '{R}', 0);

      const result = applyGraveyardReplacement(state, card, 'stack', 0);
      expect(result.zone).toBe('graveyard');
    });

    it('should exile card with Rest in Peace effect', () => {
      const state = createTestState();
      const rip = createEnchantmentPermanent(
        'Rest in Peace',
        0,
        'If a card would be put into a graveyard from anywhere, exile it instead.'
      );

      const stateWithRIP: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [rip] },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const card = createSimpleCard('Lightning Bolt', 'Instant', '{R}', 0);
      const result = applyGraveyardReplacement(stateWithRIP, card, 'stack', 0);
      expect(result.zone).toBe('exile');
      expect(result.description).toContain('exiled');
    });
  });

  describe('checkReplacementEffects', () => {
    it('should check controller permanents first', () => {
      const state = createTestState();
      const creature = createCreaturePermanent('Bear', 0, 2, 2);

      // Controller has exile effect, opponent has shuffle effect
      const controllerEffect = createEnchantmentPermanent(
        'Controller Exile',
        0,
        'If a creature you control would die, exile it instead.'
      );
      const opponentEffect = createEnchantmentPermanent(
        'Opponent Shuffle',
        1,
        'If a creature you control would die, exile it instead.'
      );

      const stateWithBoth: GameState = {
        ...state,
        players: [
          { ...state.players[0], battlefield: [controllerEffect, creature] },
          { ...state.players[1], battlefield: [opponentEffect] },
        ] as [PlayerState, PlayerState],
      };

      const event: ReplacementEvent = {
        type: 'die',
        source: creature,
        affectedPlayer: 0,
        fromZone: 'battlefield',
        toZone: 'graveyard',
      };

      const result = checkReplacementEffects(stateWithBoth, event);
      expect(result.replaced).toBe(true);
      // Controller's effect should be applied first
      expect(result.description).toContain('exiled');
    });

    it('should not apply when no matching permanents', () => {
      const state = createTestState();

      const event: ReplacementEvent = {
        type: 'die',
        source: createCreaturePermanent('Bear', 0, 2, 2),
        affectedPlayer: 0,
      };

      const result = checkReplacementEffects(state, event);
      expect(result.replaced).toBe(false);
    });
  });

  describe('Integration: SBA + Replacement Effects', () => {
    it('should exile creature with lethal damage when exile effect exists', () => {
      const state = createTestState();
      const rip = createEnchantmentPermanent(
        'Rest in Peace',
        0,
        'If a card would be put into a graveyard from anywhere, exile it instead.'
      );
      const creature = createCreaturePermanent('Bear', 0, 2, 2);
      // Mark creature with lethal damage
      const damagedCreature = { ...creature, damage: 3 };

      const stateWithDamaged: GameState = {
        ...state,
        players: [
          {
            ...state.players[0],
            battlefield: [rip, damagedCreature],
          },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = checkStateBasedActions(stateWithDamaged);

      // Bear should NOT be in graveyard
      expect(result.players[0].graveyard.some(c => c.name === 'Bear')).toBe(false);
      // Bear SHOULD be in exile
      expect(result.players[0].exile.some(c => c.name === 'Bear')).toBe(true);
      // Rest in Peace should still be on battlefield
      expect(result.players[0].battlefield.some(p => p.name === 'Rest in Peace')).toBe(true);
    });

    it('should still send creature to graveyard when no replacement effect', () => {
      const state = createTestState();
      const creature = createCreaturePermanent('Bear', 0, 2, 2);
      const damagedCreature = { ...creature, damage: 3 };

      const stateWithDamaged: GameState = {
        ...state,
        players: [
          {
            ...state.players[0],
            battlefield: [damagedCreature],
          },
          state.players[1],
        ] as [PlayerState, PlayerState],
      };

      const result = checkStateBasedActions(stateWithDamaged);

      // Bear should be in graveyard
      expect(result.players[0].graveyard.some(c => c.name === 'Bear')).toBe(true);
      // Bear should NOT be in exile
      expect(result.players[0].exile.some(c => c.name === 'Bear')).toBe(false);
    });
  });
});
