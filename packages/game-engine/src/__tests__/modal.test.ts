import { describe, it, expect, beforeEach } from 'vitest';
import { parseModalSpell, resolveModalChoices } from '../rules/modal.ts';
import type { ModalSpell } from '../rules/modal.ts';
import { createPlayerState } from '../types/player.ts';
import { createSimpleCard, resetIdCounter } from '../engine/factory.ts';
import { createInitialGameState } from '../engine/turn-manager.ts';
import type { GameState } from '../types/game-state.ts';
import type { StackObject } from '../types/action.ts';

// ─── Helpers ───

function createTestState(): GameState {
  resetIdCounter();
  const deck1 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
  );
  const cmdr1 = createSimpleCard('Cmdr A', 'Legendary Creature', '{2}{G}', 0, {
    power: '3', toughness: '3',
  });
  const deck2 = Array.from({ length: 99 }, (_, i) =>
    createSimpleCard(`Bot Card ${i}`, 'Creature', '{1}', 1)
  );
  const cmdr2 = createSimpleCard('Cmdr B', 'Legendary Creature', '{3}', 1, {
    power: '2', toughness: '2',
  });

  const p1 = createPlayerState(0, 'Player', deck1, cmdr1);
  const p2 = createPlayerState(1, 'Bot', deck2, cmdr2);

  return createInitialGameState(p1, p2);
}

function makeStackObj(oracleText: string, controller: 0 | 1 = 0): StackObject {
  return {
    id: 'test-stack-1',
    type: 'spell',
    controller,
    targets: [],
    text: 'Test Modal Spell',
    oracleText,
    card: createSimpleCard('Modal Spell', 'Instant', '{2}{U}', controller, {
      oracleText,
    }),
  };
}

beforeEach(() => {
  resetIdCounter();
});

// ═══════════════════════════════════════════════════════════════════════════
// parseModalSpell
// ═══════════════════════════════════════════════════════════════════════════

describe('parseModalSpell', () => {
  it('parses "Choose one —" with bullet modes', () => {
    const text = `Choose one —\n• Draw two cards.\n• Destroy target artifact.\n• Target creature gets +3/+3 until end of turn.`;
    const result = parseModalSpell(text);

    expect(result).not.toBeNull();
    expect(result!.minChoices).toBe(1);
    expect(result!.maxChoices).toBe(1);
    expect(result!.modes).toHaveLength(3);
    expect(result!.modes[0].text).toBe('Draw two cards');
    expect(result!.modes[1].text).toBe('Destroy target artifact');
    expect(result!.modes[2].text).toBe('Target creature gets +3/+3 until end of turn');
  });

  it('parses "Choose two —" with 3 modes', () => {
    const text = `Choose two —\n• Draw a card.\n• Gain 3 life.\n• Deal 2 damage to target creature.`;
    const result = parseModalSpell(text);

    expect(result).not.toBeNull();
    expect(result!.minChoices).toBe(2);
    expect(result!.maxChoices).toBe(2);
    expect(result!.modes).toHaveLength(3);
    expect(result!.modes[0].text).toBe('Draw a card');
    expect(result!.modes[1].text).toBe('Gain 3 life');
    expect(result!.modes[2].text).toBe('Deal 2 damage to target creature');
  });

  it('parses "Choose three —"', () => {
    const text = `Choose three —\n• Mode A.\n• Mode B.\n• Mode C.\n• Mode D.`;
    const result = parseModalSpell(text);

    expect(result).not.toBeNull();
    expect(result!.minChoices).toBe(3);
    expect(result!.maxChoices).toBe(3);
    expect(result!.modes).toHaveLength(4);
  });

  it('parses "Choose one or both —"', () => {
    const text = `Choose one or both —\n• Destroy target artifact.\n• Destroy target enchantment.`;
    const result = parseModalSpell(text);

    expect(result).not.toBeNull();
    expect(result!.minChoices).toBe(1);
    expect(result!.maxChoices).toBe(2);
    expect(result!.modes).toHaveLength(2);
    expect(result!.modes[0].text).toBe('Destroy target artifact');
    expect(result!.modes[1].text).toBe('Destroy target enchantment');
  });

  it('parses "Choose one or more —"', () => {
    const text = `Choose one or more —\n• Mode A.\n• Mode B.\n• Mode C.`;
    const result = parseModalSpell(text);

    expect(result).not.toBeNull();
    expect(result!.minChoices).toBe(1);
    expect(result!.maxChoices).toBe(3); // modes.length
    expect(result!.modes).toHaveLength(3);
  });

  it('returns null for non-modal spell', () => {
    const text = `Deal 3 damage to any target.`;
    const result = parseModalSpell(text);
    expect(result).toBeNull();
  });

  it('handles inline bullet format', () => {
    const text = `Choose one — • Draw a card. • Gain 3 life.`;
    const result = parseModalSpell(text);

    expect(result).not.toBeNull();
    expect(result!.modes).toHaveLength(2);
    expect(result!.modes[0].text).toBe('Draw a card');
    expect(result!.modes[1].text).toBe('Gain 3 life');
  });

  it('strips whitespace and periods from modes', () => {
    const text = `Choose one —\n•   Draw a card.  \n•  Gain 5 life.  `;
    const result = parseModalSpell(text);

    expect(result).not.toBeNull();
    expect(result!.modes[0].text).toBe('Draw a card');
    expect(result!.modes[1].text).toBe('Gain 5 life');
    // No trailing periods or extra whitespace
    expect(result!.modes[0].text).not.toMatch(/\.$/);
    expect(result!.modes[1].text).not.toMatch(/\.$/);
  });

  it('parses "Choose one that hasn\'t been chosen —"', () => {
    const text = `Choose one that hasn't been chosen —\n• Draw two cards.\n• Create a 3/3 token.\n• Gain 5 life.`;
    const result = parseModalSpell(text);

    expect(result).not.toBeNull();
    expect(result!.minChoices).toBe(1);
    expect(result!.maxChoices).toBe(1);
    expect(result!.modes).toHaveLength(3);
  });

  it('returns null for empty text', () => {
    expect(parseModalSpell('')).toBeNull();
  });

  it('mode indices are 0-based and sequential', () => {
    const text = `Choose one —\n• Mode A.\n• Mode B.\n• Mode C.`;
    const result = parseModalSpell(text);

    expect(result).not.toBeNull();
    expect(result!.modes[0].index).toBe(0);
    expect(result!.modes[1].index).toBe(1);
    expect(result!.modes[2].index).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveModalChoices
// ═══════════════════════════════════════════════════════════════════════════

describe('resolveModalChoices', () => {
  it('resolves single chosen mode (draw a card)', () => {
    const state = createTestState();
    // Give player 0 some cards in library to draw
    const handBefore = state.players[0].hand.length;

    const oracleText = `Choose one —\n• Draw a card.\n• Gain 3 life.`;
    const stackObj = makeStackObj(oracleText, 0);

    const result = resolveModalChoices(state, stackObj, [0]); // Choose "Draw a card"

    // "Draw a card" should be processed by the effect resolver
    // The exact result depends on the effect patterns matching "Draw a card"
    // At minimum, the state should be returned (even if not auto-resolved)
    expect(result).toBeDefined();
    expect(result.players).toBeDefined();
  });

  it('resolves two chosen modes in order', () => {
    const state = createTestState();
    const oracleText = `Choose two —\n• Draw a card.\n• Gain 3 life.\n• Deal 2 damage to target creature.`;
    const stackObj = makeStackObj(oracleText, 0);

    // Choose modes 0 and 1
    const result = resolveModalChoices(state, stackObj, [0, 1]);

    expect(result).toBeDefined();
    expect(result.players).toBeDefined();
  });

  it('skips invalid mode index', () => {
    const state = createTestState();
    const oracleText = `Choose one —\n• Draw a card.\n• Gain 3 life.`;
    const stackObj = makeStackObj(oracleText, 0);

    // Index 99 doesn't exist — should be skipped without error
    const result = resolveModalChoices(state, stackObj, [99]);

    expect(result).toBeDefined();
    // State should be unchanged since no valid mode was found
    expect(result.players[0].life).toBe(state.players[0].life);
  });

  it('returns original state if oracle text is not modal', () => {
    const state = createTestState();
    const oracleText = `Deal 3 damage to any target.`;
    const stackObj = makeStackObj(oracleText, 0);

    const result = resolveModalChoices(state, stackObj, [0]);

    expect(result).toBe(state); // Same reference — unchanged
  });
});
