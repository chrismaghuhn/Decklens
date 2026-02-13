import type { ScryfallCard, ScryfallBulkDataResponse } from './scryfall-types.ts';
import type { Color, CardTag } from '@mtg/game-engine';

/**
 * Scryfall Bulk Data Loader.
 *
 * Handles:
 * - Downloading bulk oracle_cards data from Scryfall API
 * - Transforming Scryfall card data into our internal CardData format
 * - Filtering for Commander-legal cards only
 *
 * The download() function is Node.js only (uses fs).
 * The transform functions work in any environment.
 */

/** Our internal card data format (lightweight, no owner/id — those are assigned at game time) */
export interface CardData {
  oracleId: string;
  name: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors: Color[];
  colorIdentity: Color[];
  keywords: string[];
  tags: CardTag[];
  imageUrl: string;
  edhrecRank?: number;
  legalities: Record<string, string>;
}

/** Valid MTG color characters */
const VALID_COLORS = new Set(['W', 'U', 'B', 'R', 'G']);

/**
 * Transform a Scryfall card into our CardData format.
 * Handles normal cards, double-faced cards, and split cards.
 */
export function transformScryfallCard(card: ScryfallCard): CardData | null {
  // Skip tokens, emblems, art cards, etc.
  if (
    card.layout === 'token' ||
    card.layout === 'double_faced_token' ||
    card.layout === 'art_series' ||
    card.layout === 'vanguard' ||
    card.layout === 'scheme' ||
    card.layout === 'planar' ||
    card.layout === 'emblem'
  ) {
    return null;
  }

  // For double-faced cards, use the front face data but keep oracle_id from parent
  const face = card.card_faces?.[0];
  const useFace = face && !card.mana_cost;

  const name = card.name;
  const manaCost = (useFace ? face.mana_cost : card.mana_cost) || '';
  const typeLine = (useFace ? face.type_line : card.type_line) || '';
  const oracleText = (useFace ? face.oracle_text : card.oracle_text) || '';
  const power = useFace ? face.power : card.power;
  const toughness = useFace ? face.toughness : card.toughness;
  const loyalty = useFace ? face.loyalty : card.loyalty;

  // Colors
  const rawColors = (useFace ? face.colors : card.colors) || [];
  const colors = rawColors.filter((c): c is Color => VALID_COLORS.has(c)) as Color[];
  const rawIdentity = card.color_identity || [];
  const colorIdentity = rawIdentity.filter((c): c is Color => VALID_COLORS.has(c)) as Color[];

  // Image URL (front face for DFCs)
  const imageUri =
    card.image_uris?.normal ||
    card.card_faces?.[0]?.image_uris?.normal ||
    '';

  return {
    oracleId: card.oracle_id,
    name,
    manaCost,
    cmc: card.cmc || 0,
    typeLine,
    oracleText,
    power,
    toughness,
    loyalty,
    colors,
    colorIdentity,
    keywords: card.keywords || [],
    tags: [], // Tags are assigned later by oracle-parser
    imageUrl: imageUri,
    edhrecRank: card.edhrec_rank,
    legalities: card.legalities || {},
  };
}

/**
 * Filter cards to only Commander-legal ones.
 */
export function filterCommanderLegal(cards: CardData[]): CardData[] {
  return cards.filter((card) => card.legalities['commander'] === 'legal');
}

/**
 * Transform an array of Scryfall cards into CardData format.
 * Filters out null results (tokens, etc.).
 */
export function transformBulkData(scryfallCards: ScryfallCard[]): CardData[] {
  const results: CardData[] = [];
  for (const card of scryfallCards) {
    const transformed = transformScryfallCard(card);
    if (transformed) {
      results.push(transformed);
    }
  }
  return results;
}

/**
 * Download bulk oracle cards from Scryfall.
 * Returns the raw Scryfall card array.
 *
 * NOTE: This fetches ~80MB of JSON data. Use sparingly.
 * In production, the downloaded data should be cached locally.
 */
export async function fetchBulkOracleCards(): Promise<ScryfallCard[]> {
  // 1. Get bulk data catalog
  const catalogResponse = await fetch('https://api.scryfall.com/bulk-data');
  if (!catalogResponse.ok) {
    throw new Error(`Failed to fetch bulk data catalog: ${catalogResponse.status}`);
  }

  const catalog: ScryfallBulkDataResponse = await catalogResponse.json() as ScryfallBulkDataResponse;
  const oracleEntry = catalog.data.find((d) => d.type === 'oracle_cards');
  if (!oracleEntry) {
    throw new Error('Could not find oracle_cards in bulk data catalog');
  }

  // 2. Download the full card database
  const cardsResponse = await fetch(oracleEntry.download_uri);
  if (!cardsResponse.ok) {
    throw new Error(`Failed to download oracle cards: ${cardsResponse.status}`);
  }

  const cards: ScryfallCard[] = await cardsResponse.json() as ScryfallCard[];
  return cards;
}

/**
 * Full pipeline: download → transform → filter → return.
 * This is the main entry point for populating the card database.
 */
export async function downloadAndProcessCards(): Promise<CardData[]> {
  const scryfallCards = await fetchBulkOracleCards();
  const allCards = transformBulkData(scryfallCards);
  const commanderLegal = filterCommanderLegal(allCards);
  return commanderLegal;
}
