/**
 * Card Resolver — Fetch real card data from Scryfall and cache in localStorage.
 *
 * Uses the Scryfall Collection API (POST /cards/collection) to resolve
 * card names into full Card objects with oracleText, manaCost, colors, etc.
 *
 * Cache Strategy:
 * - Cards are cached in localStorage under `decklens_card_cache_v1`
 * - TTL: 7 days per card entry
 * - Max ~2000 entries (~2MB)
 * - LRU eviction when over limit
 */

import type { Card, Color, CardTag } from '@mtg/game-engine';
import { generateCardId } from '@mtg/game-engine';

// ─── Cache Constants ───

const CACHE_KEY = 'decklens_card_cache_v1';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CACHE_MAX_ENTRIES = 2000;
const SCRYFALL_COLLECTION_URL = 'https://api.scryfall.com/cards/collection';
const SCRYFALL_BATCH_SIZE = 75; // Max identifiers per request
const SCRYFALL_DELAY_MS = 100; // Rate limit: 100ms between requests

// ─── Types ───

interface ScryfallCard {
  oracle_id?: string;
  name: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors?: string[];
  color_identity?: string[];
  rarity?: string;
  keywords?: string[];
  image_uris?: { normal?: string; small?: string; art_crop?: string };
  // DFC / Multi-face
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

interface CacheEntry {
  data: ScryfallCard;
  cachedAt: number;
}

type CardCache = Record<string, CacheEntry>;

// ─── Progress Callback ───

export type ProgressCallback = (resolved: number, total: number, status: string) => void;

// ─── Cache Management ───

function loadCache(): CardCache {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as CardCache;
  } catch {
    return {};
  }
}

function saveCache(cache: CardCache): void {
  try {
    // Evict expired entries
    const now = Date.now();
    const entries = Object.entries(cache);
    const valid = entries.filter(([, v]) => now - v.cachedAt < CACHE_TTL_MS);

    // LRU eviction if over limit
    if (valid.length > CACHE_MAX_ENTRIES) {
      valid.sort((a, b) => b[1].cachedAt - a[1].cachedAt); // newest first
      valid.length = CACHE_MAX_ENTRIES;
    }

    const cleaned = Object.fromEntries(valid);
    localStorage.setItem(CACHE_KEY, JSON.stringify(cleaned));
  } catch (e) {
    console.warn('[CardResolver] Failed to save cache:', e);
  }
}

function getCachedCard(cache: CardCache, name: string): ScryfallCard | null {
  const key = name.toLowerCase();
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
  return entry.data;
}

function cacheCard(cache: CardCache, name: string, data: ScryfallCard): void {
  cache[name.toLowerCase()] = { data, cachedAt: Date.now() };
}

/** Clear the entire card cache */
export function clearCardCache(): void {
  localStorage.removeItem(CACHE_KEY);
}

// ─── Scryfall API ───

async function fetchCollection(names: string[]): Promise<{ found: ScryfallCard[]; notFound: string[] }> {
  const identifiers = names.map(name => ({ name }));
  const found: ScryfallCard[] = [];
  const notFound: string[] = [];

  // Batch into groups of 75
  for (let i = 0; i < identifiers.length; i += SCRYFALL_BATCH_SIZE) {
    const batch = identifiers.slice(i, i + SCRYFALL_BATCH_SIZE);

    if (i > 0) {
      // Rate limit delay between requests
      await new Promise(r => setTimeout(r, SCRYFALL_DELAY_MS));
    }

    try {
      const response = await fetch(SCRYFALL_COLLECTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: batch }),
      });

      if (!response.ok) {
        console.warn(`[CardResolver] Scryfall returned ${response.status} for batch ${i / SCRYFALL_BATCH_SIZE + 1}`);
        // Add all cards in this batch to notFound
        for (const id of batch) {
          notFound.push(id.name);
        }
        continue;
      }

      const data = await response.json();
      if (data.data) {
        found.push(...data.data);
      }
      if (data.not_found) {
        for (const nf of data.not_found) {
          notFound.push(nf.name || 'Unknown');
        }
      }
    } catch (err) {
      console.warn(`[CardResolver] Fetch error for batch ${i / SCRYFALL_BATCH_SIZE + 1}:`, err);
      for (const id of batch) {
        notFound.push(id.name);
      }
    }
  }

  return { found, notFound };
}

// ─── Scryfall → Engine Card Transformer ───

function inferTags(oracleText: string, typeLine: string): CardTag[] {
  const tags: CardTag[] = [];
  const lower = oracleText.toLowerCase();
  const type = typeLine.toLowerCase();

  if (/search your library for .*(land|basic)/i.test(lower) || /add .*(mana|{)/i.test(lower)) tags.push('ramp');
  if (/draw .*(card|cards)/i.test(lower)) tags.push('draw');
  if (/destroy target|exile target|deals \d+ damage to/i.test(lower)) tags.push('removal');
  if (/counter target spell/i.test(lower)) tags.push('counter');
  if (/search your library for a card/i.test(lower) && !/land|basic/i.test(lower)) tags.push('tutor');
  if (/destroy all|exile all|all creatures get -/i.test(lower)) tags.push('wipe');
  if (/whenever .*(you|a creature).*draw/i.test(lower)) tags.push('engine');
  if (/return .* from .* graveyard/i.test(lower)) tags.push('recursion');
  if (/create .* token/i.test(lower)) tags.push('token-generator');
  if (/sacrifice a|sacrifice another/i.test(lower)) tags.push('sacrifice-outlet');
  if (type.includes('creature') && /\{t\}: add/i.test(lower)) tags.push('mana-dork');
  if (/\{0\}|costs? \{0\}|without paying/i.test(lower) && type.includes('artifact')) tags.push('fast-mana');
  if (/protection|hexproof|indestructible/i.test(lower) && type.includes('instant')) tags.push('protection');

  return tags;
}

export function scryfallToCard(sf: ScryfallCard, owner: 0 | 1): Card {
  // Handle double-faced cards
  const front = sf.card_faces?.[0];
  const back = sf.card_faces?.[1];
  const useFront = front && !sf.mana_cost; // DFCs store data on faces, not top-level

  const name = useFront ? front.name : sf.name;
  const manaCost = useFront ? (front.mana_cost || '') : (sf.mana_cost || '');
  const typeLine = useFront ? (front.type_line || '') : (sf.type_line || '');
  const oracleText = useFront ? (front.oracle_text || '') : (sf.oracle_text || '');
  const power = useFront ? front.power : sf.power;
  const toughness = useFront ? front.toughness : sf.toughness;
  const loyalty = useFront ? front.loyalty : sf.loyalty;
  const colors = (useFront ? front.colors : sf.colors) || [];
  const imageUrl = useFront
    ? (front.image_uris?.normal || front.image_uris?.small || '')
    : (sf.image_uris?.normal || sf.image_uris?.small || '');

  const card: Card = {
    id: generateCardId(),
    oracleId: sf.oracle_id || '',
    name,
    manaCost,
    cmc: sf.cmc || 0,
    typeLine,
    oracleText,
    power,
    toughness,
    loyalty,
    colors: colors as Color[],
    colorIdentity: (sf.color_identity || []) as Color[],
    rarity: (sf.rarity || 'common') as Card['rarity'],
    tags: inferTags(oracleText, typeLine),
    imageUrl,
    owner,
  };

  // Layout info
  if (sf.layout === 'transform' || sf.layout === 'modal_dfc') {
    card.layout = sf.layout as Card['layout'];
    if (back) {
      card.backFace = {
        name: back.name,
        manaCost: back.mana_cost || '',
        typeLine: back.type_line || '',
        oracleText: back.oracle_text || '',
        power: back.power,
        toughness: back.toughness,
        loyalty: back.loyalty,
        imageUrl: back.image_uris?.normal || back.image_uris?.small,
      };
    }
  } else if (sf.layout === 'adventure' && sf.card_faces?.length === 2) {
    card.layout = 'adventure';
    const adv = sf.card_faces[1];
    card.adventureName = adv.name;
    card.adventureCost = adv.mana_cost;
    card.adventureTypeLine = adv.type_line;
    card.adventureText = adv.oracle_text;
  } else if (sf.layout === 'saga') {
    card.layout = 'saga';
  }

  return card;
}

// ─── Main Resolver ───

/**
 * Resolve an array of card names into full Card objects using Scryfall data.
 *
 * 1. Check localStorage cache for each name
 * 2. Batch-fetch uncached names from Scryfall Collection API
 * 3. Cache results for future use
 * 4. Return Card[] with all fields populated
 *
 * @param names - Card names to resolve (may contain duplicates)
 * @param owner - Which player owns these cards
 * @param onProgress - Optional progress callback
 * @returns Resolved cards (in same order as input names)
 */
export async function resolveCardNames(
  names: string[],
  owner: 0 | 1,
  onProgress?: ProgressCallback,
): Promise<{ cards: Card[]; notFound: string[] }> {
  const cache = loadCache();
  const uniqueNames = [...new Set(names.map(n => n.trim()))];
  const resolved = new Map<string, ScryfallCard>();
  const toFetch: string[] = [];

  // Step 1: Check cache
  for (const name of uniqueNames) {
    const cached = getCachedCard(cache, name);
    if (cached) {
      resolved.set(name.toLowerCase(), cached);
    } else {
      toFetch.push(name);
    }
  }

  onProgress?.(resolved.size, uniqueNames.length, `${resolved.size} cards from cache`);

  // Step 2: Fetch uncached from Scryfall
  const allNotFound: string[] = [];
  if (toFetch.length > 0) {
    onProgress?.(resolved.size, uniqueNames.length, `Fetching ${toFetch.length} cards from Scryfall...`);

    const { found, notFound } = await fetchCollection(toFetch);
    allNotFound.push(...notFound);

    for (const sf of found) {
      const key = sf.name.toLowerCase();
      resolved.set(key, sf);
      cacheCard(cache, sf.name, sf);
    }

    // Also cache by the requested name (handles name mismatches like "Jace, the Mind Sculptor")
    for (const name of toFetch) {
      const key = name.toLowerCase();
      if (!resolved.has(key)) {
        // Try to find by partial match in found results
        const match = found.find(f => f.name.toLowerCase() === key);
        if (match) {
          resolved.set(key, match);
          cacheCard(cache, name, match);
        }
      }
    }

    // Save updated cache
    saveCache(cache);
  }

  onProgress?.(uniqueNames.length, uniqueNames.length, 'Building deck...');

  // Step 3: Build Card[] in original order
  const cards: Card[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    const sfData = resolved.get(key);
    if (sfData) {
      cards.push(scryfallToCard(sfData, owner));
    } else {
      // Fallback: create minimal card with just the name
      cards.push({
        id: generateCardId(),
        oracleId: '',
        name: name.trim(),
        manaCost: '',
        cmc: 0,
        typeLine: 'Unknown',
        oracleText: '',
        colors: [],
        colorIdentity: [],
        rarity: 'common',
        tags: [],
        imageUrl: '',
        owner,
      });
    }
  }

  return { cards, notFound: allNotFound };
}

// ─── EDH Deck Validation ───

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateEDHDeck(cards: Card[], commander: Card): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Card count (99 + 1 commander = 100)
  if (cards.length < 99) {
    warnings.push(`Deck has only ${cards.length} cards (need 99 + commander = 100)`);
  } else if (cards.length > 99) {
    errors.push(`Deck has ${cards.length} cards (max 99 + commander = 100)`);
  }

  // 2. Commander must be Legendary Creature (or have "can be your commander")
  const cmdType = commander.typeLine.toLowerCase();
  const cmdText = commander.oracleText.toLowerCase();
  if (!cmdType.includes('legendary') && !cmdText.includes('can be your commander')) {
    warnings.push(`${commander.name} is not a Legendary Creature`);
  }

  // 3. Singleton rule (except basic lands)
  const nameCounts = new Map<string, number>();
  for (const card of cards) {
    const name = card.name;
    if (card.typeLine.toLowerCase().includes('basic land')) continue;
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }
  for (const [name, count] of nameCounts) {
    if (count > 1) {
      warnings.push(`${name} appears ${count} times (singleton rule)`);
    }
  }

  // 4. Color identity check
  const cmdIdentity = new Set(commander.colorIdentity);
  if (cmdIdentity.size > 0) {
    for (const card of cards) {
      for (const color of card.colorIdentity) {
        if (!cmdIdentity.has(color)) {
          warnings.push(`${card.name} has ${color} outside commander's color identity`);
          break;
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}
