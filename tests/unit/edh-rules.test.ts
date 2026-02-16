import { describe, expect, it } from 'vitest';
import { evaluateEdhRules } from '../../src/deckbuilder/edh-rules.js';
import type { DeckbuilderDeck } from '../../src/deckbuilder/types.js';

function createDeck(overrides?: Partial<DeckbuilderDeck>): DeckbuilderDeck {
  return {
    id: 'deck_test',
    name: 'Test Deck',
    visibility: 'private',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    boards: {
      commander: [{ name: 'Atraxa, Praetors\' Voice', qty: 1, set: null, collectorNumber: null, tags: [] }],
      mainboard: [{ name: 'Island', qty: 99, set: null, collectorNumber: null, tags: [] }],
      sideboard: [],
      maybeboard: [],
    },
    ...overrides,
  };
}

describe('edh-rules', () => {
  it('enforces singleton except basic lands', () => {
    const deck = createDeck({
      boards: {
        commander: [{ name: 'Atraxa, Praetors\' Voice', qty: 1, set: null, collectorNumber: null, tags: [] }],
        mainboard: [
          { name: 'Arcane Signet', qty: 2, set: null, collectorNumber: null, tags: [] },
          { name: 'Plains', qty: 98, set: null, collectorNumber: null, tags: [] },
        ],
        sideboard: [],
        maybeboard: [],
      },
    });

    const rules = evaluateEdhRules(deck, {
      'atraxa, praetors\' voice': {
        id: 'cmdr',
        name: 'Atraxa, Praetors\' Voice',
        cmc: 4,
        type_line: 'Legendary Creature',
        color_identity: ['W', 'U', 'B', 'G'],
        legalities: { commander: 'legal' },
      },
      'arcane signet': {
        id: 'signet',
        name: 'Arcane Signet',
        cmc: 2,
        type_line: 'Artifact',
        color_identity: [],
      },
      plains: {
        id: 'plains',
        name: 'Plains',
        cmc: 0,
        type_line: 'Basic Land - Plains',
        color_identity: ['W'],
      },
    });

    const singleton = rules.issues.find((issue) => issue.code === 'singleton_violation');
    expect(singleton).toBeDefined();
    expect(singleton?.cards?.some((card) => card.includes('Arcane Signet'))).toBe(true);
    expect(singleton?.cards?.some((card) => card.includes('Plains'))).toBe(false);
  });

  it('reports size and color identity/partner edge cases', () => {
    const deck = createDeck({
      boards: {
        commander: [
          { name: 'Thrasios, Triton Hero', qty: 1, set: null, collectorNumber: null, tags: [] },
          { name: 'Random Non-Partner Commander', qty: 1, set: null, collectorNumber: null, tags: [] },
        ],
        mainboard: [{ name: 'Lightning Bolt', qty: 95, set: null, collectorNumber: null, tags: [] }],
        sideboard: [],
        maybeboard: [],
      },
    });

    const rules = evaluateEdhRules(deck, {
      'thrasios, triton hero': {
        id: 'thrasios',
        name: 'Thrasios, Triton Hero',
        cmc: 2,
        type_line: 'Legendary Creature',
        keywords: ['Partner'],
        color_identity: ['U', 'G'],
        legalities: { commander: 'legal' },
      },
      'random non-partner commander': {
        id: 'other',
        name: 'Random Non-Partner Commander',
        cmc: 3,
        type_line: 'Legendary Creature',
        color_identity: ['B'],
        legalities: { commander: 'legal' },
      },
      'lightning bolt': {
        id: 'bolt',
        name: 'Lightning Bolt',
        cmc: 1,
        type_line: 'Instant',
        color_identity: ['R'],
      },
    });

    expect(rules.issues.some((issue) => issue.code === 'commander_partner_invalid')).toBe(true);
    expect(rules.issues.some((issue) => issue.code === 'deck_size_under')).toBe(true);
    expect(rules.issues.some((issue) => issue.code === 'color_identity_violation')).toBe(true);
  });
});
