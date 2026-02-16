// ==================== DeckLens Shared Types ====================

/**
 * Basic deck entry (card name + quantity).
 */
export interface DeckEntry {
  name: string;
  qty: number;
  set?: string | null;
  num?: string | null;
}

/**
 * Full deck structure with all zones.
 */
export interface Deck {
  main: DeckEntry[];
  sideboard: DeckEntry[];
  commander: DeckEntry[];
}
