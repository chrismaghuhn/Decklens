// ==================== MTG API Module ====================
// Extracted from mtg.html lines 1600-1634
// Deck URL import (Moxfield/Archidekt, direct browser calls) + Scryfall client re-exports.

import type { Deck, DeckEntry } from './types';
import { validateDeckUrl } from '../shared/security/url-validator';
import { fetchRobust } from '../shared/fetch';

// ==================== Moxfield API ====================

interface MoxfieldCard {
  quantity?: number;
  card?: {
    set?: string;
    cn?: string;
    name?: string;
  };
}

interface MoxfieldBoard {
  cards?: Record<string, MoxfieldCard>;
}

interface MoxfieldDeck {
  name?: string;
  boards?: {
    mainboard?: MoxfieldBoard;
    sideboard?: MoxfieldBoard;
    commanders?: MoxfieldBoard;
    companions?: MoxfieldBoard;
  };
}

async function fetchDeckJson(endpoints: string[]): Promise<unknown> {
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetchRobust(endpoint, {
        headers: { Accept: 'application/json' },
        timeoutMs: 15000,
        retries: 1,
        backoffMs: 400,
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        lastError = new Error('Non-JSON response');
        continue;
      }

      const raw = await response.text();
      try {
        return JSON.parse(raw);
      } catch {
        lastError = new Error('Invalid JSON response');
        continue;
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error('Request failed');
    }
  }

  throw lastError ?? new Error('Request failed');
}

/**
 * Process Moxfield board into deck entries.
 */
function processMoxfieldBoard(board: MoxfieldBoard | undefined, target: DeckEntry[]): void {
  if (!board?.cards) return;
  for (const [key, info] of Object.entries(board.cards)) {
    const cardName = info.card?.name || key;
    target.push({
      name: cardName,
      qty: info.quantity || 1,
      set: info.card?.set || null,
      num: info.card?.cn || null,
    });
  }
}

/**
 * Fetch deck from Moxfield API.
 * @param deckId - The deck ID from the URL
 * @returns Deck structure and name
 */
export async function fetchMoxfieldDeck(deckId: string, apiUrl: string): Promise<{ deck: Deck; name: string }> {
  let data: MoxfieldDeck;
  try {
    data = await fetchDeckJson([apiUrl]) as MoxfieldDeck;
  } catch (err) {
    throw new Error(
      'Could not fetch from Moxfield (their API blocks browser requests). ' +
      'Use Export -> MTGO on Moxfield and paste the decklist here.'
    );
  }

  const deck: Deck = { main: [], sideboard: [], commander: [] };
  processMoxfieldBoard(data.boards?.mainboard, deck.main);
  processMoxfieldBoard(data.boards?.sideboard, deck.sideboard);
  processMoxfieldBoard(data.boards?.commanders, deck.commander);
  processMoxfieldBoard(data.boards?.companions, deck.sideboard);

  return {
    deck,
    name: data.name || 'Moxfield Deck',
  };
}

// ==================== Archidekt API ====================

interface ArchidektCard {
  card?: {
    oracleCard?: { name?: string };
    name?: string;
  };
  quantity?: number;
  categories?: string[];
}

interface ArchidektDeck {
  name?: string;
  cards?: ArchidektCard[];
}

/**
 * Fetch deck from Archidekt API.
 * @param deckId - The deck ID from the URL
 * @returns Deck structure and name
 */
export async function fetchArchidektDeck(deckId: string, apiUrl: string): Promise<{ deck: Deck; name: string }> {
  let data: ArchidektDeck;
  try {
    data = await fetchDeckJson([apiUrl]) as ArchidektDeck;
  } catch (err) {
    throw new Error(
      'Could not fetch from Archidekt. ' +
      'Try Export -> Copy to Clipboard on Archidekt and paste here.'
    );
  }

  const deck: Deck = { main: [], sideboard: [], commander: [] };

  for (const c of data.cards || []) {
    const name = c.card?.oracleCard?.name || c.card?.name || 'Unknown';
    const qty = c.quantity || 1;
    const cat = (c.categories || [])[0]?.toLowerCase() || '';

    const entry: DeckEntry = { name, qty, set: null, num: null };

    if (cat === 'commander') {
      deck.commander.push(entry);
    } else if (cat === 'sideboard') {
      deck.sideboard.push(entry);
    } else {
      deck.main.push(entry);
    }
  }

  return {
    deck,
    name: data.name || 'Archidekt Deck',
  };
}

// ==================== Unified URL Import ====================

/**
 * Import a deck from a URL (Moxfield or Archidekt).
 * Uses secure URL validation before fetching.
 * 
 * @param url - The deck URL to import
 * @returns Deck structure and name
 * @throws Error with user-friendly message on failure
 */
export async function importDeckFromUrl(url: string): Promise<{ deck: Deck; name: string }> {
  // SECURITY: Validate URL before any fetch
  const validation = validateDeckUrl(url);
  
  if (!validation.valid) {
    throw new Error((validation as { valid: false; error: string }).error);
  }

  // Fetch based on validated site
  if (validation.site === 'Moxfield') {
    return fetchMoxfieldDeck(validation.deckId, validation.apiUrl);
  } else if (validation.site === 'Archidekt') {
    return fetchArchidektDeck(validation.deckId, validation.apiUrl);
  }

  // Should not reach here if validation is correct
  throw new Error('Unsupported deck site. Use Moxfield or Archidekt.');
}

// Card search/autocomplete/resolve now talk to Scryfall directly from the browser.
export {
  fetchDeckbuilderAutocomplete,
  searchDeckbuilderCards,
  resolveDeckbuilderCards,
} from './scryfall-client.js';
export type { DeckbuilderSearchCard, DeckbuilderSearchParams } from './scryfall-client.js';
