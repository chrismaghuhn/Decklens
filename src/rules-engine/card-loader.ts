/**
 * Scryfall Card Loader — Browser-side batch card fetching with localStorage cache.
 *
 * Uses Scryfall's /cards/collection endpoint (up to 75 cards per request)
 * to fetch full card data including oracle text, mana cost, P/T, colors.
 *
 * Cards are cached in localStorage to avoid repeated API calls.
 * This replaces the heuristic guessTypeLine/guessOracleText stubs.
 */

import type { Card, Color } from '@mtg/game-engine';
import { generateCardId } from '@mtg/game-engine';

// ─── Types ───

interface ScryfallCard {
  oracle_id: string;
  name: string;
  mana_cost?: string;
  cmc: number;
  type_line: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors?: string[];
  color_identity?: string[];
  rarity?: string;
  keywords?: string[];
  image_uris?: { normal?: string; small?: string; art_crop?: string };
  card_faces?: ScryfallCardFace[];
  layout?: string;
}

interface ScryfallCardFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors?: string[];
  image_uris?: { normal?: string; small?: string };
}

interface CachedCardData {
  oracle_id: string;
  name: string;
  mana_cost: string;
  cmc: number;
  type_line: string;
  oracle_text: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors: string[];
  color_identity: string[];
  rarity: string;
  image_url: string;
}

// ─── Constants ───

const CACHE_KEY = 'decklens_scryfall_cache';
const CACHE_VERSION = 2;
const SCRYFALL_COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const BATCH_SIZE = 75; // Scryfall limit per request
const REQUEST_DELAY_MS = 100; // Respect Scryfall rate limits (10 req/sec)

// ─── Cache ───

interface CardCache {
  version: number;
  cards: Record<string, CachedCardData>; // keyed by lowercase name
}

function loadCache(): CardCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { version: CACHE_VERSION, cards: {} };
    const cache = JSON.parse(raw) as CardCache;
    if (cache.version !== CACHE_VERSION) return { version: CACHE_VERSION, cards: {} };
    return cache;
  } catch {
    return { version: CACHE_VERSION, cards: {} };
  }
}

function saveCache(cache: CardCache): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage full — clear old entries
    try {
      localStorage.removeItem(CACHE_KEY);
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      // Completely full, skip caching
    }
  }
}

// ─── Scryfall API ───

function transformScryfallToCache(card: ScryfallCard): CachedCardData {
  // Handle double-faced cards
  const face = card.card_faces?.[0];
  const useFace = face && !card.mana_cost;

  const manaCost = (useFace ? face.mana_cost : card.mana_cost) || '';
  const typeLine = (useFace ? face.type_line : card.type_line) || '';
  const oracleText = (useFace ? face.oracle_text : card.oracle_text) || '';
  const power = useFace ? face.power : card.power;
  const toughness = useFace ? face.toughness : card.toughness;
  const loyalty = useFace ? face.loyalty : card.loyalty;
  const colors = (useFace ? face.colors : card.colors) || [];
  const imageUrl = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || '';

  return {
    oracle_id: card.oracle_id || '',
    name: card.name,
    mana_cost: manaCost,
    cmc: card.cmc || 0,
    type_line: typeLine,
    oracle_text: oracleText,
    power,
    toughness,
    loyalty,
    colors: colors.filter(c => ['W', 'U', 'B', 'R', 'G'].includes(c)),
    color_identity: (card.color_identity || []).filter(c => ['W', 'U', 'B', 'R', 'G'].includes(c)),
    rarity: card.rarity || 'common',
    image_url: imageUrl,
  };
}

function cachedToCard(cached: CachedCardData, owner: 0 | 1): Card {
  return {
    id: generateCardId(),
    oracleId: cached.oracle_id,
    name: cached.name,
    manaCost: cached.mana_cost,
    cmc: cached.cmc,
    typeLine: cached.type_line,
    oracleText: cached.oracle_text,
    power: cached.power,
    toughness: cached.toughness,
    loyalty: cached.loyalty,
    colors: cached.colors as Color[],
    colorIdentity: cached.color_identity as Color[],
    rarity: (cached.rarity || 'common') as Card['rarity'],
    tags: [],
    imageUrl: cached.image_url,
    owner,
  };
}

async function fetchCardBatch(names: string[]): Promise<ScryfallCard[]> {
  const identifiers = names.map(name => ({ name }));

  try {
    const response = await fetch(SCRYFALL_COLLECTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers }),
    });

    if (!response.ok) {
      console.warn(`Scryfall batch request failed: ${response.status}`);
      return [];
    }

    const data = await response.json();
    return data.data || [];
  } catch (err) {
    console.warn('Scryfall batch fetch error:', err);
    return [];
  }
}

// ─── Public API ───

export interface LoadProgress {
  loaded: number;
  total: number;
  phase: 'cache' | 'fetching' | 'done';
}

/**
 * Load cards by name, using cache first then Scryfall API for uncached cards.
 *
 * @param cardNames - Array of card names (may contain duplicates for multiple copies)
 * @param owner - Player who owns these cards (0 or 1)
 * @param onProgress - Optional progress callback
 * @returns Array of Card objects with full data
 */
export async function loadCardsByName(
  cardNames: string[],
  owner: 0 | 1,
  onProgress?: (progress: LoadProgress) => void,
): Promise<Card[]> {
  const cache = loadCache();
  const results: Card[] = [];
  const uncachedNames: string[] = [];
  const uniqueNames = new Set<string>();

  // Phase 1: Check cache for each unique name
  for (const name of cardNames) {
    uniqueNames.add(name.toLowerCase());
  }

  for (const nameLower of uniqueNames) {
    if (!cache.cards[nameLower]) {
      uncachedNames.push(nameLower);
    }
  }

  onProgress?.({ loaded: uniqueNames.size - uncachedNames.length, total: uniqueNames.size, phase: 'cache' });

  // Phase 2: Fetch uncached cards from Scryfall in batches
  if (uncachedNames.length > 0) {
    const batches: string[][] = [];
    for (let i = 0; i < uncachedNames.length; i += BATCH_SIZE) {
      batches.push(uncachedNames.slice(i, i + BATCH_SIZE));
    }

    let fetched = 0;
    for (const batch of batches) {
      onProgress?.({
        loaded: uniqueNames.size - uncachedNames.length + fetched,
        total: uniqueNames.size,
        phase: 'fetching',
      });

      const scryfallCards = await fetchCardBatch(batch);

      for (const sc of scryfallCards) {
        const cached = transformScryfallToCache(sc);
        cache.cards[cached.name.toLowerCase()] = cached;
        fetched++;
      }

      // Rate limiting between batches
      if (batches.indexOf(batch) < batches.length - 1) {
        await new Promise(r => setTimeout(r, REQUEST_DELAY_MS));
      }
    }

    // Save updated cache
    saveCache(cache);
  }

  // Phase 3: Build Card objects from cache (preserving duplicates from deck list)
  for (const name of cardNames) {
    const cached = cache.cards[name.toLowerCase()];
    if (cached) {
      results.push(cachedToCard(cached, owner));
    } else {
      // Fallback: create a minimal card for names that couldn't be found
      results.push(createFallbackCard(name, owner));
    }
  }

  onProgress?.({ loaded: uniqueNames.size, total: uniqueNames.size, phase: 'done' });

  return results;
}

/**
 * Create a fallback card when Scryfall lookup fails.
 * Uses basic heuristics for common cards, otherwise creates a generic card.
 */
function createFallbackCard(name: string, owner: 0 | 1): Card {
  const lower = name.toLowerCase();

  // Basic land recognition
  const basicLands: Record<string, { type: string; colors: Color[]; oracle: string }> = {
    plains:   { type: 'Basic Land — Plains',   colors: ['W'], oracle: '({T}: Add {W}.)' },
    island:   { type: 'Basic Land — Island',   colors: ['U'], oracle: '({T}: Add {U}.)' },
    swamp:    { type: 'Basic Land — Swamp',    colors: ['B'], oracle: '({T}: Add {B}.)' },
    mountain: { type: 'Basic Land — Mountain', colors: ['R'], oracle: '({T}: Add {R}.)' },
    forest:   { type: 'Basic Land — Forest',   colors: ['G'], oracle: '({T}: Add {G}.)' },
  };

  if (basicLands[lower]) {
    const land = basicLands[lower];
    return {
      id: generateCardId(),
      oracleId: '',
      name,
      manaCost: '',
      cmc: 0,
      typeLine: land.type,
      oracleText: land.oracle,
      colors: [],
      colorIdentity: land.colors,
      rarity: 'common',
      tags: [],
      imageUrl: '',
      owner,
    };
  }

  // Generic fallback
  return {
    id: generateCardId(),
    oracleId: '',
    name,
    manaCost: '{2}',
    cmc: 2,
    typeLine: 'Unknown',
    oracleText: '',
    colors: [],
    colorIdentity: [],
    rarity: 'common',
    tags: [],
    imageUrl: '',
    owner,
  };
}

/**
 * Parse a deck list text and extract card name + quantity pairs.
 */
export function parseDeckListToNames(text: string): { name: string; count: number }[] {
  const lines = text.trim().split('\n');
  const entries: { name: string; count: number }[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('Sideboard')) continue;

    // Standard formats: "4 Lightning Bolt", "4x Lightning Bolt", "1 Urza's Saga"
    const match = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    if (!match) continue;

    const count = parseInt(match[1], 10);
    const name = match[2].trim()
      // Remove set codes: "Lightning Bolt (M21)" → "Lightning Bolt"
      .replace(/\s*\([A-Z0-9]+\)\s*$/, '')
      // Remove collector number: "Lightning Bolt 123" → "Lightning Bolt"
      .replace(/\s+\d+\s*$/, '');

    if (name && count > 0) {
      entries.push({ name, count });
    }
  }

  return entries;
}

/**
 * Expand deck list entries into flat card name array (respecting quantities).
 */
export function expandDeckList(entries: { name: string; count: number }[]): string[] {
  const names: string[] = [];
  for (const entry of entries) {
    for (let i = 0; i < entry.count; i++) {
      names.push(entry.name);
    }
  }
  return names;
}

/**
 * Clear the Scryfall card cache.
 */
export function clearCardCache(): void {
  localStorage.removeItem(CACHE_KEY);
}

/**
 * Get cache stats for debugging.
 */
export function getCacheStats(): { count: number; sizeKb: number } {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return { count: 0, sizeKb: 0 };
    const cache = JSON.parse(raw) as CardCache;
    return {
      count: Object.keys(cache.cards).length,
      sizeKb: Math.round(raw.length / 1024),
    };
  } catch {
    return { count: 0, sizeKb: 0 };
  }
}
