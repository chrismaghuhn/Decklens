/**
 * Combo Client -- Frontend API for the scalable combo database.
 * Calls /api/combos/lookup with fallback to legacy /api/spellbook/combos.
 */

import { fetchRobust } from '../shared/fetch.js';
import { fetchSpellbookCombos, type SpellbookCombo } from '../shared/api.js';

// ==================== Types ====================

export interface ComboMatch {
  id: string;
  name: string;
  cards: string[];
  optionalCards: string[];
  requires: string[];
  description: string;
  produces: string[];
  resultTags: string[];
  spellbookUrl: string;
  source: 'spellbook' | 'catalog' | 'community';
  matchLevel: 'complete' | 'near-miss' | 'partial';
  hasTemplateReqs: boolean;
  matchedCards: string[];
  missingCards: string[];
}

export interface TemplateMatch {
  templateId: string;
  templateName: string;
  description: string;
  anchorCards: string[];
  slotFills: Array<{ slot: string; cardName: string }>;
  resultTags: string[];
  allCards: string[];
}

interface ComboSuggestionPayload {
  name: string;
  cards: string[];
  description: string;
  prerequisites?: string;
  produces?: string[];
  resultTags?: string[];
}

interface ComboRecord {
  id: string;
  name: string;
  cards: string[];
  optionalCards?: string[];
  requires?: string[];
  description: string;
  produces?: string[];
  resultTags?: string[];
  spellbookUrl?: string;
  source?: 'spellbook' | 'catalog' | 'community';
  hasTemplateReqs?: boolean;
}

// ==================== Helpers ====================

const STORAGE_KEY = 'decklens:combo-suggestions';

/** Normalize card name for comparison. */
function norm(n: string): string {
  return n.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * API origin resolution -- mirrors the pattern in shared/api.ts.
 * Uses the same origin for local dev and the Cloudflare Worker for production.
 */
const API_ORIGIN = (() => {
  if (typeof window === 'undefined') return '';
  const w = window as Window & { __DECKLENS_API_ORIGIN?: string };
  if (typeof w.__DECKLENS_API_ORIGIN === 'string' && w.__DECKLENS_API_ORIGIN.trim()) {
    return w.__DECKLENS_API_ORIGIN.trim().replace(/\/$/, '');
  }
  const host = window.location.hostname.toLowerCase();
  const isLocalhost = host === 'localhost' || host === '127.0.0.1';
  return isLocalhost ? '' : 'https://decklens-api.chrisgarkisch.workers.dev';
})();

function apiPath(path: string): string {
  return `${API_ORIGIN}${path}`;
}

/**
 * Compute which cards from a combo are in the deck and which are missing.
 */
function computeMatchSets(
  comboCards: string[],
  deckNormed: Set<string>,
): { matchedCards: string[]; missingCards: string[] } {
  const matchedCards: string[] = [];
  const missingCards: string[] = [];
  for (const card of comboCards) {
    if (deckNormed.has(norm(card))) {
      matchedCards.push(card);
    } else {
      missingCards.push(card);
    }
  }
  return { matchedCards, missingCards };
}

/**
 * Derive match level from matched/missing card counts.
 */
function deriveMatchLevel(
  matchedCount: number,
  totalCards: number,
): 'complete' | 'near-miss' | 'partial' {
  if (matchedCount >= totalCards) return 'complete';
  if (matchedCount >= totalCards - 1) return 'near-miss';
  return 'partial';
}

/**
 * Map a raw ComboRecord from the API to a ComboMatch with deck context.
 */
function mapComboRecord(record: ComboRecord, deckNormed: Set<string>): ComboMatch {
  const { matchedCards, missingCards } = computeMatchSets(record.cards, deckNormed);
  const matchLevel = deriveMatchLevel(matchedCards.length, record.cards.length);

  return {
    id: record.id,
    name: record.name,
    cards: record.cards,
    optionalCards: record.optionalCards ?? [],
    requires: record.requires ?? [],
    description: record.description,
    produces: record.produces ?? [],
    resultTags: record.resultTags ?? [],
    spellbookUrl: record.spellbookUrl ?? '',
    source: record.source ?? 'catalog',
    matchLevel,
    hasTemplateReqs: record.hasTemplateReqs ?? false,
    matchedCards,
    missingCards,
  };
}

/**
 * Map a SpellbookCombo (legacy format) to a ComboMatch.
 */
function mapSpellbookCombo(combo: SpellbookCombo, deckNormed: Set<string>): ComboMatch {
  const { matchedCards, missingCards } = computeMatchSets(combo.cards, deckNormed);
  const matchLevel = deriveMatchLevel(matchedCards.length, combo.cards.length);

  return {
    id: combo.id,
    name: combo.cards.join(' + '),
    cards: combo.cards,
    optionalCards: [],
    requires: combo.prerequisites ? [combo.prerequisites] : [],
    description: combo.description,
    produces: combo.produces,
    resultTags: combo.produces,
    spellbookUrl: combo.spellbookUrl,
    source: 'spellbook',
    matchLevel,
    hasTemplateReqs: false,
    matchedCards,
    missingCards,
  };
}

/**
 * Read pending suggestions from localStorage.
 */
function readPendingSuggestions(): ComboSuggestionPayload[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Write pending suggestions to localStorage.
 */
function writePendingSuggestions(suggestions: ComboSuggestionPayload[]): void {
  try {
    if (suggestions.length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(suggestions));
    }
  } catch {
    // Storage full or unavailable -- silently ignore
  }
}

// ==================== Public API ====================

/**
 * Fetch combos for a deck from the scalable combo database.
 * Falls back to the legacy Spellbook endpoint on error/404.
 *
 * @param allCardNames - All card names in the deck (mainboard + commander + sideboard)
 * @param colorIdentity - Optional color identity filter (e.g. "WUBR")
 * @returns Array of ComboMatch objects sorted by match level
 */
export async function fetchDeckCombos(
  allCardNames: string[],
  colorIdentity?: string,
): Promise<ComboMatch[]> {
  const deckNormed = new Set(allCardNames.map(norm));

  try {
    const response = await fetchRobust(apiPath('/api/combos/lookup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards: allCardNames, colorIdentity }),
      timeoutMs: 20000,
      retries: 1,
      backoffMs: 500,
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('Combo lookup returned non-JSON response.');
    }

    const parsed = await response.json() as {
      ok: boolean;
      data?: {
        complete: ComboRecord[];
        nearMiss: ComboRecord[];
        partial: ComboRecord[];
      };
      error?: string;
    };

    if (!parsed.ok || !parsed.data) {
      throw new Error(parsed.error || 'Combo lookup failed.');
    }

    const results: ComboMatch[] = [];

    for (const record of parsed.data.complete) {
      results.push(mapComboRecord(record, deckNormed));
    }
    for (const record of parsed.data.nearMiss) {
      results.push(mapComboRecord(record, deckNormed));
    }
    for (const record of parsed.data.partial) {
      results.push(mapComboRecord(record, deckNormed));
    }

    return results;
  } catch {
    // Fallback to legacy Spellbook endpoint
    return fetchLegacyCombos(allCardNames, allCardNames, deckNormed);
  }
}

/**
 * Fetch combos from the legacy Commander Spellbook endpoint.
 * Used as a fallback when the new combo database is unavailable.
 *
 * @param commanders - Commander card names
 * @param mainCards - Main deck card names
 * @param deckNormed - Optional pre-computed set of normalized deck card names
 * @returns Array of ComboMatch objects
 */
export async function fetchLegacyCombos(
  commanders: string[],
  mainCards: string[],
  deckNormed?: Set<string>,
): Promise<ComboMatch[]> {
  const normedSet = deckNormed ?? new Set([...commanders, ...mainCards].map(norm));

  try {
    const spellbookResponse = await fetchSpellbookCombos(commanders, mainCards);
    const results: ComboMatch[] = [];

    for (const combo of spellbookResponse.included) {
      results.push(mapSpellbookCombo(combo, normedSet));
    }
    for (const combo of spellbookResponse.almostIncluded) {
      results.push(mapSpellbookCombo(combo, normedSet));
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Fetch template-based combo matches for the deck.
 * Templates match abstract patterns (e.g. "any creature with ETB draw")
 * against specific cards in the deck.
 *
 * @param cards - Card names in the deck
 * @param cardData - Enriched card data with oracle text, type line, etc.
 * @returns Array of TemplateMatch objects
 */
export async function fetchTemplateMatches(
  cards: string[],
  cardData: Array<{
    name: string;
    oracle_text: string;
    type_line: string;
    mana_cost?: string;
  }>,
): Promise<TemplateMatch[]> {
  try {
    const response = await fetchRobust(apiPath('/api/combos/templates/match'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards, cardData }),
      timeoutMs: 15000,
      retries: 1,
      backoffMs: 500,
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return [];
    }

    const parsed = await response.json() as {
      ok: boolean;
      data?: { matches: TemplateMatch[] };
      error?: string;
    };

    if (!parsed.ok || !parsed.data) {
      return [];
    }

    return parsed.data.matches;
  } catch {
    return [];
  }
}

/**
 * Submit a community combo suggestion.
 * On network error, saves to localStorage for later sync.
 *
 * @param suggestion - The combo suggestion payload
 * @returns Success/failure result with optional suggestion ID
 */
export async function submitComboSuggestion(suggestion: {
  name: string;
  cards: string[];
  description: string;
  prerequisites?: string;
  produces?: string[];
  resultTags?: string[];
}): Promise<{ ok: boolean; suggestionId?: string; error?: string }> {
  try {
    const response = await fetchRobust(apiPath('/api/combos/suggest'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(suggestion),
      timeoutMs: 15000,
      retries: 1,
      backoffMs: 500,
    });

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('Suggest endpoint returned non-JSON response.');
    }

    const parsed = await response.json() as {
      ok: boolean;
      data?: { suggestionId: string };
      error?: string;
    };

    if (!parsed.ok) {
      return { ok: false, error: parsed.error || 'Suggestion submission failed.' };
    }

    return { ok: true, suggestionId: parsed.data?.suggestionId };
  } catch {
    // Network error -- save locally for later sync
    const pending = readPendingSuggestions();
    pending.push({
      name: suggestion.name,
      cards: suggestion.cards,
      description: suggestion.description,
      prerequisites: suggestion.prerequisites,
      produces: suggestion.produces,
      resultTags: suggestion.resultTags,
    });
    writePendingSuggestions(pending);

    const localId = 'local-' + Date.now();
    return { ok: true, suggestionId: localId };
  }
}

/**
 * Sync pending locally-saved combo suggestions to the server.
 * Removes successfully synced suggestions from localStorage.
 *
 * @returns Number of suggestions successfully synced
 */
export async function syncPendingSuggestions(): Promise<number> {
  const pending = readPendingSuggestions();
  if (pending.length === 0) return 0;

  let synced = 0;
  const remaining: ComboSuggestionPayload[] = [];

  for (const suggestion of pending) {
    try {
      const response = await fetchRobust(apiPath('/api/combos/suggest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(suggestion),
        timeoutMs: 15000,
        retries: 0,
        backoffMs: 0,
      });

      const parsed = await response.json() as { ok: boolean };
      if (parsed.ok) {
        synced++;
      } else {
        remaining.push(suggestion);
      }
    } catch {
      remaining.push(suggestion);
    }
  }

  writePendingSuggestions(remaining);
  return synced;
}

/**
 * Trigger a server-side combo database sync (import from Commander Spellbook).
 *
 * @returns Import progress with count and completion status
 */
export async function triggerComboSync(): Promise<{ imported: number; done: boolean }> {
  const response = await fetchRobust(apiPath('/api/combos/sync'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: 30000,
    retries: 0,
    backoffMs: 0,
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Combo sync endpoint returned non-JSON response.');
  }

  const parsed = await response.json() as {
    ok: boolean;
    data?: { imported: number; done: boolean };
    error?: string;
  };

  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.error || 'Combo sync failed.');
  }

  return parsed.data;
}

/**
 * Fetch combo database statistics.
 *
 * @returns Total count, breakdown by source, and last sync timestamp
 */
export async function fetchComboStats(): Promise<{
  total: number;
  bySource: Record<string, number>;
  lastSync: string | null;
}> {
  const response = await fetchRobust(apiPath('/api/combos/stats'), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Combo stats endpoint returned non-JSON response.');
  }

  const parsed = await response.json() as {
    ok: boolean;
    data?: {
      total: number;
      bySource: Record<string, number>;
      lastSync: string | null;
    };
    error?: string;
  };

  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.error || 'Failed to fetch combo stats.');
  }

  return parsed.data;
}
