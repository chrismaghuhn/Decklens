export type DeckVisibility = 'private' | 'unlisted' | 'public';

export type DeckBoard = 'commander' | 'mainboard' | 'sideboard' | 'maybeboard';

export interface DeckbuilderCardEntry {
  name: string;
  qty: number;
  set?: string | null;
  collectorNumber?: string | null;
  tags: string[];
}

export interface DeckbuilderDeck {
  id: string;
  name: string;
  description?: string;
  visibility: DeckVisibility;
  createdAt: string;
  updatedAt: string;
  boards: {
    commander: DeckbuilderCardEntry[];
    mainboard: DeckbuilderCardEntry[];
    sideboard: DeckbuilderCardEntry[];
    maybeboard: DeckbuilderCardEntry[];
  };
}

export interface DeckEntry {
  name: string;
  qty: number;
}

export interface AnalyzerCardView {
  name: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  keywords?: string[];
  power?: string;
  toughness?: string;
  color_identity?: string[];
}
