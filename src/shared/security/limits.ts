// ==================== Input Limits (Audit Report Â§4 - Score 24) ====================
// Prevents Client-DoS via unbounded input sizes.
// Source: decklens-audit-report-v4.3.md L429-462

/**
 * Centralized input limits - MUST be enforced at all import entry points.
 * 
 * Policy: All import channels (Paste / File / URL / Share-Link) MUST use the same validator stack:
 * validateInput() â†’ parse() â†’ validateDeckSize() â†’ fetch() â†’ render()
 */
export const INPUT_LIMITS = {
  /** Maximum characters in paste textarea (~200KB text) */
  PASTE_MAX_CHARS: 200_000,
  
  /** Maximum file upload size (2MB) */
  FILE_MAX_BYTES: 2 * 1024 * 1024,
  
  /** Maximum total cards in deck (including copies) */
  DECK_MAX_CARDS_TOTAL: 1000,
  
  /** Maximum unique card names in deck */
  DECK_MAX_CARDS_UNIQUE: 750,
  
  /** Maximum URL input length (user-entered import URLs) */
  URL_INPUT_MAX_LENGTH: 2000,
  
  /** Maximum generated share URL length (longer Base64 payloads) */
  SHARE_URL_MAX_LENGTH: 8000,
  
  /** Maximum API batches per import (prevents 134-batch cascades) */
  MAX_API_BATCHES: 10,
  
  /** Maximum deck name length */
  DECK_NAME_MAX_LENGTH: 100,
  
  /** Maximum card name length (for validation) */
  CARD_NAME_MAX_LENGTH: 200,
} as const;

export type InputLimits = typeof INPUT_LIMITS;

/**
 * Validate paste/text input length.
 * @throws Error if input exceeds limit
 */
export function validatePasteInput(text: string): void {
  if (text.length > INPUT_LIMITS.PASTE_MAX_CHARS) {
    throw new Error(
      `Input too large (max ${INPUT_LIMITS.PASTE_MAX_CHARS.toLocaleString()} characters)`
    );
  }
}

/**
 * Validate file size before processing.
 * @throws Error if file exceeds limit
 */
export function validateFileSize(file: File): void {
  if (file.size > INPUT_LIMITS.FILE_MAX_BYTES) {
    throw new Error(
      `File too large (max ${INPUT_LIMITS.FILE_MAX_BYTES / 1024 / 1024}MB)`
    );
  }
}

/**
 * Validate URL input length.
 * @throws Error if URL exceeds limit
 */
export function validateUrlInput(url: string): void {
  if (url.length > INPUT_LIMITS.URL_INPUT_MAX_LENGTH) {
    throw new Error(
      `URL too long (max ${INPUT_LIMITS.URL_INPUT_MAX_LENGTH} characters)`
    );
  }
}

/**
 * Deck entry type for validation
 */
export interface DeckEntry {
  name: string;
  qty: number;
}

/**
 * Deck structure for validation
 */
export interface DeckForValidation {
  main: DeckEntry[];
  sideboard: DeckEntry[];
  commander: DeckEntry[];
}

/**
 * Validate deck size limits.
 * @throws Error if deck exceeds limits
 */
export function validateDeckSize(deck: DeckForValidation): void {
  const allEntries = [...deck.main, ...deck.sideboard, ...deck.commander];
  const total = allEntries.reduce((sum, e) => sum + e.qty, 0);
  const uniqueNames = new Set(allEntries.map((e) => e.name.toLowerCase()));

  if (total > INPUT_LIMITS.DECK_MAX_CARDS_TOTAL) {
    throw new Error(
      `Deck too large (max ${INPUT_LIMITS.DECK_MAX_CARDS_TOTAL} cards, got ${total})`
    );
  }

  if (uniqueNames.size > INPUT_LIMITS.DECK_MAX_CARDS_UNIQUE) {
    throw new Error(
      `Too many unique cards (max ${INPUT_LIMITS.DECK_MAX_CARDS_UNIQUE}, got ${uniqueNames.size})`
    );
  }
}

/**
 * Validate share URL length (after encoding).
 * @throws Error if URL exceeds browser-safe limit
 */
export function validateShareUrlLength(fullUrl: string): void {
  if (fullUrl.length > INPUT_LIMITS.SHARE_URL_MAX_LENGTH) {
    throw new Error('Deck too large to share. Export as file instead.');
  }
}

/**
 * Check if API batch count would exceed limit.
 * @param uniqueCardCount Number of unique cards to fetch
 * @param batchSize Cards per API batch (default 75 for Scryfall)
 * @throws Error if too many batches would be required
 */
export function validateBatchCount(uniqueCardCount: number, batchSize: number = 75): void {
  const requiredBatches = Math.ceil(uniqueCardCount / batchSize);
  if (requiredBatches > INPUT_LIMITS.MAX_API_BATCHES) {
    throw new Error(
      `Too many unique cards (${uniqueCardCount}). Max ${INPUT_LIMITS.MAX_API_BATCHES * batchSize} unique cards supported.`
    );
  }
}
