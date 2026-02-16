/**
 * Unit tests for deck-sharing module.
 * Tests decoding, validation, and limits enforcement.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  encodeSharedDeck,
  decodeSharedDeck,
  base64ToBase64url,
  base64urlToBase64,
  InvalidShareLinkError,
  DeckTooLargeError,
  SHARE_SCHEMA_VERSION,
  type DeckToShare,
} from '../../src/shared/deck-sharing.js';

describe('deck-sharing', () => {
  // ==================== Base64 URL Encoding ====================
  describe('base64ToBase64url', () => {
    it('converts + to -', () => {
      expect(base64ToBase64url('a+b')).toBe('a-b');
    });

    it('converts / to _', () => {
      expect(base64ToBase64url('a/b')).toBe('a_b');
    });

    it('removes padding', () => {
      expect(base64ToBase64url('abc=')).toBe('abc');
      expect(base64ToBase64url('ab==')).toBe('ab');
    });

    it('handles complex strings', () => {
      expect(base64ToBase64url('a+b/c==')).toBe('a-b_c');
    });
  });

  describe('base64urlToBase64', () => {
    it('converts - to +', () => {
      expect(base64urlToBase64('a-b')).toBe('a+b=');
    });

    it('converts _ to /', () => {
      expect(base64urlToBase64('a_b')).toBe('a/b=');
    });

    it('restores padding', () => {
      expect(base64urlToBase64('abc')).toBe('abc=');
      expect(base64urlToBase64('ab')).toBe('ab==');
      expect(base64urlToBase64('abcd')).toBe('abcd');
    });
  });

  // ==================== Encode/Decode Round Trip ====================
  describe('encodeSharedDeck', () => {
    const validDeck: DeckToShare = {
      name: 'Test Deck',
      main: [
        { name: 'Lightning Bolt', qty: 4 },
        { name: 'Mountain', qty: 20 },
      ],
      sideboard: [{ name: 'Pyroblast', qty: 2 }],
      commander: [],
    };

    it('encodes a valid deck', () => {
      const result = encodeSharedDeck(validDeck);
      expect(result.encoded).toBeTruthy();
      expect(result.jsonSize).toBeGreaterThan(0);
      expect(result.compressedSize).toBeGreaterThan(0);
    });

    it('throws on deck with too many unique cards', () => {
      const largeDeck: DeckToShare = {
        name: 'Too Large',
        main: Array(501).fill(null).map((_, i) => ({ name: `Card ${i}`, qty: 1 })),
        sideboard: [],
      };
      expect(() => encodeSharedDeck(largeDeck)).toThrow(DeckTooLargeError);
    });

    it('truncates deck name to max length', () => {
      const longNameDeck: DeckToShare = {
        name: 'A'.repeat(200),
        main: [{ name: 'Lightning Bolt', qty: 4 }],
        sideboard: [],
      };
      const result = encodeSharedDeck(longNameDeck);
      const decoded = decodeSharedDeck(result.encoded);
      expect(decoded.deckName.length).toBeLessThanOrEqual(100);
    });
  });

  describe('decodeSharedDeck', () => {
    const validDeck: DeckToShare = {
      name: 'Test Deck',
      main: [
        { name: 'Lightning Bolt', qty: 4 },
        { name: 'Mountain', qty: 20 },
      ],
      sideboard: [{ name: 'Pyroblast', qty: 2 }],
      commander: [{ name: 'Purphoros, God of the Forge', qty: 1 }],
    };

    let validEncoded: string;

    beforeEach(() => {
      validEncoded = encodeSharedDeck(validDeck).encoded;
    });

    it('decodes a valid encoded deck', () => {
      const decoded = decodeSharedDeck(validEncoded);
      expect(decoded.deckName).toBe('Test Deck');
      expect(decoded.cardNames.main).toHaveLength(2);
      expect(decoded.cardNames.sideboard).toHaveLength(1);
      expect(decoded.cardNames.commander).toHaveLength(1);
    });

    it('preserves card quantities', () => {
      const decoded = decodeSharedDeck(validEncoded);
      const bolt = decoded.cardNames.main.find(c => c.name === 'Lightning Bolt');
      expect(bolt?.qty).toBe(4);
    });

    it('throws on empty input', () => {
      expect(() => decodeSharedDeck('')).toThrow(InvalidShareLinkError);
    });

    it('throws on null input', () => {
      expect(() => decodeSharedDeck(null as unknown as string)).toThrow(InvalidShareLinkError);
    });

    it('throws on invalid base64', () => {
      expect(() => decodeSharedDeck('not-valid-data!!!')).toThrow(InvalidShareLinkError);
    });

    it('throws on too long input', () => {
      const tooLong = 'a'.repeat(10001);
      expect(() => decodeSharedDeck(tooLong)).toThrow(InvalidShareLinkError);
    });

    it('throws on wrong schema version', () => {
      // Create a manually crafted payload with wrong version
      const wrongVersion = {
        v: 999,
        n: 'Test',
        c: [],
        s: [],
        m: [],
      };
      const json = JSON.stringify(wrongVersion);
      // LZ-String compress
      const LZString = require('lz-string');
      const compressed = LZString.compressToBase64(json);
      const encoded = base64ToBase64url(compressed);
      
      expect(() => decodeSharedDeck(encoded)).toThrow(InvalidShareLinkError);
      expect(() => decodeSharedDeck(encoded)).toThrow(/version/i);
    });
  });

  // ==================== Round Trip ====================
  describe('round trip', () => {
    it('preserves all deck data', () => {
      const original: DeckToShare = {
        name: 'Commander Deck',
        main: [
          { name: 'Sol Ring', qty: 1 },
          { name: 'Lightning Greaves', qty: 1 },
          { name: 'Island', qty: 35 },
        ],
        sideboard: [
          { name: 'Counterspell', qty: 2 },
        ],
        commander: [
          { name: 'Urza, Lord High Artificer', qty: 1 },
        ],
      };

      const encoded = encodeSharedDeck(original).encoded;
      const decoded = decodeSharedDeck(encoded);

      expect(decoded.deckName).toBe(original.name);
      expect(decoded.cardNames.main).toHaveLength(original.main.length);
      expect(decoded.cardNames.sideboard).toHaveLength(original.sideboard!.length);
      expect(decoded.cardNames.commander).toHaveLength(original.commander!.length);

      // Verify specific cards
      const solRing = decoded.cardNames.main.find(c => c.name === 'Sol Ring');
      expect(solRing?.qty).toBe(1);
      
      const urza = decoded.cardNames.commander.find(c => c.name === 'Urza, Lord High Artificer');
      expect(urza?.qty).toBe(1);
    });

    it('handles special characters in card names', () => {
      const original: DeckToShare = {
        name: 'Special Characters',
        main: [
          { name: "Urza's Tower", qty: 4 },
          { name: 'Æther Vial', qty: 4 },
          { name: 'Déjà Vu', qty: 2 },
        ],
        sideboard: [],
      };

      const encoded = encodeSharedDeck(original).encoded;
      const decoded = decodeSharedDeck(encoded);

      expect(decoded.cardNames.main.find(c => c.name === "Urza's Tower")?.qty).toBe(4);
      expect(decoded.cardNames.main.find(c => c.name === 'Æther Vial')?.qty).toBe(4);
    });
  });

  // ==================== Security Validation ====================
  describe('security validation', () => {
    it('limits card quantity to 99', () => {
      const deck: DeckToShare = {
        name: 'Test',
        main: [{ name: 'Card', qty: 150 }],
        sideboard: [],
      };

      const encoded = encodeSharedDeck(deck).encoded;
      const decoded = decodeSharedDeck(encoded);

      expect(decoded.cardNames.main[0].qty).toBeLessThanOrEqual(99);
    });

    it('rejects negative quantities', () => {
      // Try to craft malicious payload with negative qty
      const malicious = {
        v: SHARE_SCHEMA_VERSION,
        n: 'Malicious',
        c: [{ n: 'Card', q: -5 }],
        s: [],
        m: [],
      };
      const json = JSON.stringify(malicious);
      const LZString = require('lz-string');
      const compressed = LZString.compressToBase64(json);
      const encoded = base64ToBase64url(compressed);

      expect(() => decodeSharedDeck(encoded)).toThrow(InvalidShareLinkError);
    });

    it('rejects empty card names', () => {
      const malicious = {
        v: SHARE_SCHEMA_VERSION,
        n: 'Malicious',
        c: [{ n: '', q: 1 }],
        s: [],
        m: [],
      };
      const json = JSON.stringify(malicious);
      const LZString = require('lz-string');
      const compressed = LZString.compressToBase64(json);
      const encoded = base64ToBase64url(compressed);

      expect(() => decodeSharedDeck(encoded)).toThrow(InvalidShareLinkError);
    });
  });
});
