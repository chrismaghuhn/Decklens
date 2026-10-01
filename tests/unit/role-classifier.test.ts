import { describe, expect, test } from 'vitest';
import { classifyRole, ROLE_LABELS, type Role } from '../../src/deckbuilder/role-classifier.js';

function card(type_line: string, oracle_text = ''): { type_line: string; oracle_text: string } {
  return { type_line, oracle_text };
}

describe('classifyRole', () => {
  const cases: Array<[string, { type_line: string; oracle_text: string }, Role]> = [
    ['Sol Ring', card('Artifact', '{T}: Add {C}{C}.'), 'ramp'],
    ['Cultivate', card('Sorcery', 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.'), 'ramp'],
    ['Rhystic Study', card('Enchantment', 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.'), 'draw'],
    ['Swords to Plowshares', card('Instant', 'Exile target creature. Its controller gains life equal to its power.'), 'removal'],
    ['Wrath of God', card('Sorcery', 'Destroy all creatures. They can’t be regenerated.'), 'wipe'],
    ['Counterspell', card('Instant', 'Counter target spell.'), 'counter'],
    ['Demonic Tutor', card('Sorcery', 'Search your library for a card, put that card into your hand, then shuffle.'), 'tutor'],
    ['Eternal Witness', card('Creature — Human Shaman', 'When Eternal Witness enters the battlefield, you may return target card from your graveyard to your hand.'), 'recursion'],
    ['Heroic Intervention', card('Instant', 'Permanents you control gain hexproof and indestructible until end of turn.'), 'protection'],
    ["Thassa's Oracle", card('Creature — Merfolk Wizard', 'When Thassa’s Oracle enters the battlefield, look at the top X cards... if X is greater than or equal to the number of cards in your library, you win the game.'), 'wincon'],
    ['Island', card('Basic Land — Island', '({T}: Add {U}.)'), 'land'],
    ['Grizzly Bears', card('Creature — Bear', ''), 'utility'],
  ];

  for (const [name, c, expected] of cases) {
    test(`${name} -> ${expected}`, () => {
      expect(classifyRole(c)).toBe(expected);
    });
  }

  test('priority: wipe beats draw when both match', () => {
    expect(classifyRole(card('Sorcery', 'Destroy all creatures. Draw a card.'))).toBe('wipe');
  });

  test('lands always land even with ramp-ish text', () => {
    expect(classifyRole(card('Land', '{T}: Add one mana of any color.'))).toBe('land');
  });

  test('every role has a German label', () => {
    const roles: Role[] = ['ramp','draw','removal','wipe','counter','tutor','recursion','protection','wincon','utility','land'];
    for (const r of roles) expect(ROLE_LABELS[r]).toBeTruthy();
  });
});

describe('classifyRoles (multi-role)', () => {
  test('a card matching several roles counts for each', async () => {
    const { classifyRoles } = await import('../../src/deckbuilder/role-classifier.js');
    const roles = classifyRoles({ type_line: 'Sorcery', oracle_text: 'Destroy target creature. Draw a card.' });
    expect(roles).toContain('removal');
    expect(roles).toContain('draw');
  });

  test('lands stay single-role and no match falls back to utility', async () => {
    const { classifyRoles } = await import('../../src/deckbuilder/role-classifier.js');
    expect(classifyRoles({ type_line: 'Basic Land — Forest', oracle_text: '' })).toEqual(['land']);
    expect(classifyRoles({ type_line: 'Creature', oracle_text: 'Flying.' })).toEqual(['utility']);
  });
});
