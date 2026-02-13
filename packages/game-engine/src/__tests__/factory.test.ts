import { describe, it, expect, beforeEach } from 'vitest';
import {
  createCard,
  createSimpleCard,
  setupNewGame,
  performLondonMulligan,
  startMulligan,
  keepHand,
  resetIdCounter,
} from '../engine/factory.ts';
import { drawOpeningHand } from '../engine/zone-manager.ts';

beforeEach(() => {
  resetIdCounter();
});

describe('createCard', () => {
  it('should create card from Scryfall data', () => {
    const card = createCard(
      {
        oracle_id: 'abc123',
        name: 'Sol Ring',
        mana_cost: '{1}',
        cmc: 1,
        type_line: 'Artifact',
        oracle_text: '{T}: Add {C}{C}.',
        colors: [],
        color_identity: [],
        image_uris: { normal: 'https://example.com/sol-ring.jpg' },
      },
      0
    );

    expect(card.name).toBe('Sol Ring');
    expect(card.oracleId).toBe('abc123');
    expect(card.manaCost).toBe('{1}');
    expect(card.typeLine).toBe('Artifact');
    expect(card.owner).toBe(0);
    expect(card.id).toBeTruthy();
  });

  it('should generate unique IDs', () => {
    const card1 = createCard({ name: 'A' }, 0);
    const card2 = createCard({ name: 'B' }, 0);
    expect(card1.id).not.toBe(card2.id);
  });
});

describe('createSimpleCard', () => {
  it('should create minimal card', () => {
    const card = createSimpleCard('Forest', 'Basic Land — Forest', '', 0);
    expect(card.name).toBe('Forest');
    expect(card.typeLine).toBe('Basic Land — Forest');
    expect(card.owner).toBe(0);
  });

  it('should accept optional overrides', () => {
    const card = createSimpleCard('Lightning Bolt', 'Instant', '{R}', 0, {
      oracleText: 'Lightning Bolt deals 3 damage to any target.',
      colors: ['R'],
    });
    expect(card.oracleText).toBe('Lightning Bolt deals 3 damage to any target.');
    expect(card.colors).toEqual(['R']);
  });
});

describe('setupNewGame', () => {
  it('should create a valid game state', () => {
    const deck1 = Array.from({ length: 99 }, (_, i) =>
      createSimpleCard(`P1 Card ${i}`, 'Creature', '{1}', 0)
    );
    const cmdr1 = createSimpleCard('Cmdr 1', 'Legendary Creature', '{3}', 0);
    const deck2 = Array.from({ length: 99 }, (_, i) =>
      createSimpleCard(`P2 Card ${i}`, 'Creature', '{1}', 1)
    );
    const cmdr2 = createSimpleCard('Cmdr 2', 'Legendary Creature', '{3}', 1);

    const state = setupNewGame('Human', deck1, cmdr1, 'Bot', deck2, cmdr2);

    // Both players should have 7 cards in hand
    expect(state.players[0].hand.length).toBe(7);
    expect(state.players[1].hand.length).toBe(7);

    // Commanders in command zone
    expect(state.players[0].commandZone.length).toBe(1);
    expect(state.players[0].commandZone[0].name).toBe('Cmdr 1');
    expect(state.players[1].commandZone.length).toBe(1);
    expect(state.players[1].commandZone[0].name).toBe('Cmdr 2');

    // Libraries = 99 - 7 = 92
    expect(state.players[0].library.length).toBe(92);
    expect(state.players[1].library.length).toBe(92);

    // Game state
    expect(state.mulliganPhase).toBe(true);
    expect(state.turn).toBe(1);
    expect(state.players[0].life).toBe(40);
    expect(state.players[1].life).toBe(40);
  });
});

describe('London Mulligan', () => {
  it('startMulligan should shuffle hand back and draw 7 new cards', () => {
    const deck = Array.from({ length: 99 }, (_, i) =>
      createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
    );
    const cmdr = createSimpleCard('Cmdr', 'Legendary Creature', '{3}', 0);
    const deck2 = Array.from({ length: 99 }, (_, i) =>
      createSimpleCard(`Bot ${i}`, 'Creature', '{1}', 1)
    );
    const cmdr2 = createSimpleCard('Bot Cmdr', 'Legendary Creature', '{3}', 1);

    const state = setupNewGame('Human', deck, cmdr, 'Bot', deck2, cmdr2);
    const oldHand = state.players[0].hand.map((c) => c.id);

    const afterMulligan = startMulligan(state, 0);

    // Still 7 cards in hand
    expect(afterMulligan.players[0].hand.length).toBe(7);
    // Mulligan count incremented
    expect(afterMulligan.mulliganCount[0]).toBe(1);
    // Total cards preserved (99 library + 7 hand = 99 library + 7 hand)
    const totalCards =
      afterMulligan.players[0].library.length +
      afterMulligan.players[0].hand.length;
    expect(totalCards).toBe(99);
  });

  it('performLondonMulligan should put chosen cards on bottom', () => {
    const deck = Array.from({ length: 99 }, (_, i) =>
      createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
    );
    const cmdr = createSimpleCard('Cmdr', 'Legendary Creature', '{3}', 0);
    const deck2 = Array.from({ length: 99 }, (_, i) =>
      createSimpleCard(`Bot ${i}`, 'Creature', '{1}', 1)
    );
    const cmdr2 = createSimpleCard('Bot Cmdr', 'Legendary Creature', '{3}', 1);

    let state = setupNewGame('Human', deck, cmdr, 'Bot', deck2, cmdr2);
    state = startMulligan(state, 0);

    // Pick first card to put on bottom
    const bottomCardId = state.players[0].hand[0].id;
    const afterBottom = performLondonMulligan(state, 0, [bottomCardId]);

    expect(afterBottom.players[0].hand.length).toBe(6);
    // Card should be at bottom of library
    const lib = afterBottom.players[0].library;
    expect(lib[lib.length - 1].id).toBe(bottomCardId);
  });
});

describe('keepHand', () => {
  it('should add log entry', () => {
    const deck = Array.from({ length: 99 }, (_, i) =>
      createSimpleCard(`Card ${i}`, 'Creature', '{1}', 0)
    );
    const cmdr = createSimpleCard('Cmdr', 'Legendary Creature', '{3}', 0);
    const deck2 = Array.from({ length: 99 }, (_, i) =>
      createSimpleCard(`Bot ${i}`, 'Creature', '{1}', 1)
    );
    const cmdr2 = createSimpleCard('Bot Cmdr', 'Legendary Creature', '{3}', 1);

    const state = setupNewGame('Human', deck, cmdr, 'Bot', deck2, cmdr2);
    const kept = keepHand(state, 0);

    const lastLog = kept.log[kept.log.length - 1];
    expect(lastLog.message).toContain('keeps their hand');
  });
});
