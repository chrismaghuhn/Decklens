import { describe, expect, test, beforeEach } from 'vitest';
import { getDeckById } from '../../src/deckbuilder/storage.js';
import { STORAGE_KEYS } from '../../src/shared/storage.js';

describe('deck storage compatibility', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('opens a deck saved before cleanup that carries fields from removed features', () => {
    const legacyDeck = {
      id: 'deck_legacy_1',
      name: 'Old Deck',
      format: 'commander',
      visibility: 'private',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      boards: {
        commander: [{ name: 'Atraxa, Praetors’ Voice', qty: 1, set: null, collectorNumber: null, tags: [] }],
        mainboard: [{ name: 'Sol Ring', qty: 1, set: null, collectorNumber: null, tags: [] }],
        sideboard: [],
        maybeboard: [],
      },
      // fields written by now-removed features must not break loading
      collabSession: { id: 'sess_123', host: 'someone' },
      versionMeta: { cloudBranch: 'main', lastSyncedAt: 1700000000000 },
      premiumFlags: { coach: true },
    };
    localStorage.setItem(STORAGE_KEYS.DECKBUILDER_DECKS, JSON.stringify([legacyDeck]));

    const loaded = getDeckById('deck_legacy_1');

    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe('Old Deck');
    expect(loaded?.boards.mainboard).toHaveLength(1);
    expect(loaded?.boards.mainboard[0].name).toBe('Sol Ring');
    expect(loaded?.boards.commander[0].qty).toBe(1);
  });
});
