// ==================== Deck Sharing via URL ====================
// Sprint 2 S2-F1: Deck Sharing Implementation
// Source: decklens-audit-report-v4.3.md L1220-1380
//
// Security-first implementation:
// 1. Strict schema validation
// 2. Input limits enforcement
// 3. Base64URL encoding (URL-safe)
// 4. LZ-String compression
// 5. Never trust shared data for display (re-fetch from API)

import LZString from 'lz-string';
import { INPUT_LIMITS, validateDeckSize } from './security/limits.js';
import { escapeHtml } from './utils.js';

/**
 * Share schema version for forward compatibility.
 * Increment when schema changes in incompatible ways.
 */
export const SHARE_SCHEMA_VERSION = 1;

/**
 * Feature flag for deck sharing (can be disabled if needed).
 */
export const ENABLE_DECK_SHARING = true;

/**
 * Card entry in shared deck (minimal, name + quantity only).
 */
export interface SharedCardEntry {
  /** Card name (lookup key, NOT trusted for display) */
  n: string;
  /** Quantity */
  q: number;
}

/**
 * Shared deck payload structure.
 * Compact field names to minimize URL length.
 */
export interface SharedDeckPayload {
  /** Schema version */
  v: number;
  /** Deck name (escaped before display) */
  n: string;
  /** Main deck cards */
  c: SharedCardEntry[];
  /** Sideboard cards */
  s: SharedCardEntry[];
  /** Commander/extra deck cards */
  m: SharedCardEntry[];
}

/**
 * Decoded and validated shared deck data.
 */
export interface DecodedSharedDeck {
  /** Deck name (sanitized) */
  deckName: string;
  /** Card names grouped by zone */
  cardNames: {
    main: Array<{ name: string; qty: number }>;
    sideboard: Array<{ name: string; qty: number }>;
    commander: Array<{ name: string; qty: number }>;
  };
}

/**
 * Result of encoding a deck for sharing.
 */
export interface ShareResult {
  /** Encoded string for URL parameter */
  encoded: string;
  /** Full share URL */
  url: string;
  /** JSON payload size (before compression) */
  jsonSize: number;
  /** Compressed size (after Base64) */
  compressedSize: number;
}

/**
 * Error thrown when deck is too large to share.
 */
export class DeckTooLargeError extends Error {
  constructor(message: string = 'Deck too large to share. Export as file instead.') {
    super(message);
    this.name = 'DeckTooLargeError';
  }
}

/**
 * Error thrown when share link is invalid.
 */
export class InvalidShareLinkError extends Error {
  constructor(message: string = 'Invalid share link') {
    super(message);
    this.name = 'InvalidShareLinkError';
  }
}

// ==================== Base64 URL Encoding ====================

/**
 * Convert standard Base64 to URL-safe Base64url.
 * RFC 4648 Section 5
 */
export function base64ToBase64url(base64: string): string {
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, ''); // Remove trailing padding
}

/**
 * Convert URL-safe Base64url back to standard Base64.
 */
export function base64urlToBase64(base64url: string): string {
  let base64 = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  // Restore padding
  const pad = base64.length % 4;
  if (pad) {
    base64 += '='.repeat(4 - pad);
  }
  return base64;
}

// ==================== Encoding ====================

/**
 * Simple deck entry interface for encoding.
 */
export interface DeckEntry {
  name: string;
  qty: number;
}

/**
 * Deck structure for encoding.
 */
export interface DeckToShare {
  name: string;
  main: DeckEntry[];
  sideboard?: DeckEntry[];
  commander?: DeckEntry[];
}

/**
 * Encode a deck for sharing via URL.
 * 
 * @throws DeckTooLargeError if deck exceeds size limits
 * @returns ShareResult with encoded string and full URL
 * 
 * @example
 * ```ts
 * const result = encodeSharedDeck({
 *   name: 'My Deck',
 *   main: [{ name: 'Lightning Bolt', qty: 4 }],
 *   sideboard: [],
 * });
 * navigator.clipboard.writeText(result.url);
 * ```
 */
export function encodeSharedDeck(deck: DeckToShare, baseUrl: string = ''): ShareResult {
  // Validate deck name
  const deckName = deck.name.slice(0, INPUT_LIMITS.DECK_NAME_MAX_LENGTH);
  
  // Build minimal payload
  const payload: SharedDeckPayload = {
    v: SHARE_SCHEMA_VERSION,
    n: deckName,
    c: deck.main.map(e => ({ n: e.name.slice(0, INPUT_LIMITS.CARD_NAME_MAX_LENGTH), q: Math.min(e.qty, 99) })),
    s: (deck.sideboard || []).map(e => ({ n: e.name.slice(0, INPUT_LIMITS.CARD_NAME_MAX_LENGTH), q: Math.min(e.qty, 99) })),
    m: (deck.commander || []).map(e => ({ n: e.name.slice(0, INPUT_LIMITS.CARD_NAME_MAX_LENGTH), q: Math.min(e.qty, 99) })),
  };
  
  // Check card count limits
  const totalUnique = payload.c.length + payload.s.length + payload.m.length;
  if (totalUnique > 500) {
    throw new DeckTooLargeError('Deck has too many unique cards (max 500 for sharing)');
  }
  
  // Serialize to JSON
  const json = JSON.stringify(payload);
  const jsonSize = json.length;
  
  // Size guard before compression (catches obviously too-large decks)
  if (jsonSize > 15000) {
    throw new DeckTooLargeError('Deck data too large to share');
  }
  
  // Compress with LZ-String → Base64 → Base64url
  const compressed = LZString.compressToBase64(json);
  if (!compressed) {
    throw new Error('Compression failed');
  }
  const encoded = base64ToBase64url(compressed);
  
  // Build full URL and check final length
  const url = baseUrl ? `${baseUrl}?deck=${encoded}` : encoded;
  if (url.length > INPUT_LIMITS.SHARE_URL_MAX_LENGTH) {
    throw new DeckTooLargeError(
      `Share URL too long (${url.length} chars, max ${INPUT_LIMITS.SHARE_URL_MAX_LENGTH}). Export as file instead.`
    );
  }
  
  return {
    encoded,
    url,
    jsonSize,
    compressedSize: encoded.length,
  };
}

// ==================== Decoding ====================

/**
 * Decode and validate a shared deck from URL parameter.
 * 
 * SECURITY: The returned card names are lookup keys only.
 * Always re-fetch card data from the API before rendering.
 * Never display card names directly without escaping.
 * 
 * @throws InvalidShareLinkError if decoding or validation fails
 * @returns DecodedSharedDeck with validated data
 * 
 * @example
 * ```ts
 * const params = new URLSearchParams(window.location.search);
 * const encoded = params.get('deck');
 * if (encoded) {
 *   const { deckName, cardNames } = decodeSharedDeck(encoded);
 *   // Re-fetch card data from API before rendering
 *   const cardData = await fetchCards(cardNames.main.map(e => e.name));
 *   renderDeck(cardData, escapeHtml(deckName), { readOnly: true });
 * }
 * ```
 */
export function decodeSharedDeck(encoded: string): DecodedSharedDeck {
  // Step 0: Basic input validation
  if (!encoded || typeof encoded !== 'string') {
    throw new InvalidShareLinkError('Missing share data');
  }
  
  // Limit encoded string length
  if (encoded.length > INPUT_LIMITS.SHARE_URL_MAX_LENGTH) {
    throw new InvalidShareLinkError('Share data too large');
  }
  
  // Step 1: Convert base64url to base64
  let base64: string;
  try {
    base64 = base64urlToBase64(encoded);
  } catch {
    throw new InvalidShareLinkError('Invalid encoding');
  }
  
  // Step 2: Decompress
  let json: string | null;
  try {
    json = LZString.decompressFromBase64(base64);
    if (!json) {
      throw new Error('Decompression returned null');
    }
  } catch {
    throw new InvalidShareLinkError('Decompression failed');
  }
  
  // Step 3: Parse JSON
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new InvalidShareLinkError('Invalid share data format');
  }
  
  // Step 4: Validate as SharedDeckPayload
  const payload = data as SharedDeckPayload;
  
  // Version check
  if (payload.v !== SHARE_SCHEMA_VERSION) {
    throw new InvalidShareLinkError(`Incompatible share link version (expected ${SHARE_SCHEMA_VERSION}, got ${payload.v})`);
  }
  
  // Deck name validation
  if (typeof payload.n !== 'string' || payload.n.length > INPUT_LIMITS.DECK_NAME_MAX_LENGTH) {
    throw new InvalidShareLinkError('Invalid deck name');
  }
  
  // Structure validation
  if (!Array.isArray(payload.c) || !Array.isArray(payload.s) || !Array.isArray(payload.m)) {
    throw new InvalidShareLinkError('Invalid deck structure');
  }
  
  // Step 5: Validate each card entry
  const validateEntries = (arr: unknown[]): arr is SharedCardEntry[] => {
    if (arr.length > 500) {
      throw new InvalidShareLinkError('Too many cards in deck');
    }
    return arr.every(e => {
      const entry = e as SharedCardEntry;
      return (
        typeof entry.n === 'string' &&
        entry.n.length > 0 &&
        entry.n.length <= INPUT_LIMITS.CARD_NAME_MAX_LENGTH &&
        typeof entry.q === 'number' &&
        Number.isInteger(entry.q) &&
        entry.q > 0 &&
        entry.q <= 99
      );
    });
  };
  
  if (!validateEntries(payload.c)) {
    throw new InvalidShareLinkError('Invalid main deck data');
  }
  if (!validateEntries(payload.s)) {
    throw new InvalidShareLinkError('Invalid sideboard data');
  }
  if (!validateEntries(payload.m)) {
    throw new InvalidShareLinkError('Invalid commander data');
  }
  
  // Step 6: Apply deck size validation
  const deckSizeInput = {
    main: payload.c.map(e => ({ name: e.n, qty: e.q })),
    sideboard: payload.s.map(e => ({ name: e.n, qty: e.q })),
    commander: payload.m.map(e => ({ name: e.n, qty: e.q })),
  };
  validateDeckSize(deckSizeInput);
  
  // Step 7: Return validated data
  // SECURITY: Card names are lookup keys only, NOT trusted for display
  return {
    deckName: payload.n, // Caller MUST escape before display
    cardNames: deckSizeInput,
  };
}

// ==================== URL Helpers ====================

/**
 * Extract deck parameter from URL.
 * Returns null if no deck parameter found.
 */
export function getDeckFromUrl(urlString?: string): string | null {
  try {
    const url = urlString ? new URL(urlString) : new URL(window.location.href);
    return url.searchParams.get('deck');
  } catch {
    return null;
  }
}

/**
 * Check if current URL has a shared deck.
 */
export function hasSharedDeck(urlString?: string): boolean {
  return getDeckFromUrl(urlString) !== null;
}

/**
 * Generate a share URL for the given deck.
 */
export function generateShareUrl(deck: DeckToShare, game: 'mtg' | 'ygo' = 'mtg'): ShareResult {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://decklens.app';
  const baseUrl = `${origin}/${game === 'mtg' ? 'mtg.html' : 'yugioh.html'}`;
  return encodeSharedDeck(deck, baseUrl);
}

// ==================== Import Flow Integration ====================

/**
 * Import deck from share URL parameter.
 * 
 * SECURITY FLOW:
 * 1. Decode and validate share data
 * 2. Apply deck size limits
 * 3. Return card names for API fetch
 * 4. Caller re-fetches card data from API
 * 5. Caller renders with escaped name and read-only flag
 * 
 * @example
 * ```ts
 * const encoded = getDeckFromUrl();
 * if (encoded) {
 *   try {
 *     const { deckName, cardNames } = importFromShareUrl(encoded);
 *     const allNames = [...cardNames.main, ...cardNames.sideboard, ...cardNames.commander].map(e => e.name);
 *     const cardData = await fetchCardsFromScryfall(allNames);
 *     renderDeck(cardData, escapeHtml(deckName), { readOnly: true });
 *   } catch (e) {
 *     if (e instanceof InvalidShareLinkError) {
 *       showError('Invalid share link');
 *     }
 *   }
 * }
 * ```
 */
export function importFromShareUrl(encoded: string): DecodedSharedDeck {
  // Decode and validate (throws on error)
  const result = decodeSharedDeck(encoded);
  
  // Additional validation could go here
  
  return result;
}

// ==================== Clipboard Helpers ====================

/**
 * Copy share URL to clipboard.
 * Returns true if successful.
 */
export async function copyShareUrl(url: string): Promise<boolean> {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      return true;
    }
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = url;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const success = document.execCommand('copy');
    document.body.removeChild(textarea);
    return success;
  } catch {
    return false;
  }
}
