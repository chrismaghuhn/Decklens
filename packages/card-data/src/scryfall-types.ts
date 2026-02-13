/**
 * Scryfall API response types.
 * Only the fields we actually use from the bulk oracle_cards data.
 */

/** A single card from Scryfall bulk data */
export interface ScryfallCard {
  // Identity
  id: string;
  oracle_id: string;
  name: string;

  // Mana
  mana_cost?: string;
  cmc: number;

  // Type
  type_line: string;

  // Text
  oracle_text?: string;

  // Stats
  power?: string;
  toughness?: string;
  loyalty?: string;

  // Colors
  colors?: string[];
  color_identity?: string[];

  // Keywords
  keywords?: string[];

  // Legality
  legalities?: Record<string, string>;

  // Images
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
    png?: string;
    art_crop?: string;
    border_crop?: string;
  };

  // Card faces (for double-faced cards)
  card_faces?: ScryfallCardFace[];

  // Layout
  layout: string;

  // Set
  set: string;
  set_name: string;

  // Prices
  prices?: Record<string, string | null>;

  // Ranking
  edhrec_rank?: number;

  // Misc
  reserved?: boolean;
  digital?: boolean;
  games?: string[];
}

/** Card face for double-faced, split, adventure cards */
export interface ScryfallCardFace {
  name: string;
  mana_cost?: string;
  type_line?: string;
  oracle_text?: string;
  power?: string;
  toughness?: string;
  loyalty?: string;
  colors?: string[];
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
  };
}

/** Scryfall bulk data catalog entry */
export interface ScryfallBulkDataEntry {
  id: string;
  type: string;
  name: string;
  description: string;
  download_uri: string;
  updated_at: string;
  size: number;
  content_type: string;
  content_encoding: string;
}

/** Scryfall bulk data catalog response */
export interface ScryfallBulkDataResponse {
  object: string;
  has_more: boolean;
  data: ScryfallBulkDataEntry[];
}
