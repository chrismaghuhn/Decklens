export type DeckVisibility = 'private' | 'unlisted' | 'public';

export type DeckBoard = 'commander' | 'mainboard' | 'sideboard' | 'maybeboard';

export interface DeckbuilderCardEntry {
  name: string;
  qty: number;
  set?: string | null;
  collectorNumber?: string | null;
  tags: string[];
  /** ID of the custom category this card is assigned to (for pile view grouping) */
  customCategoryId?: string;
}

export interface CustomCategory {
  id: string;
  name: string;
  color: string; // Hex color for pile view header
}

export interface DeckbuilderBoards {
  commander: DeckbuilderCardEntry[];
  mainboard: DeckbuilderCardEntry[];
  sideboard: DeckbuilderCardEntry[];
  maybeboard: DeckbuilderCardEntry[];
}

export type DeckFormat = 'commander' | 'standard' | 'modern' | 'pioneer' | 'legacy' | 'pauper' | 'none';

export interface DeckbuilderDeck {
  id: string;
  name: string;
  description?: string;
  /** User notes for deck (supports DSL directives like @require, @combo) */
  notes?: string;
  visibility: DeckVisibility;
  /** C5: Selected format for legality checking */
  format?: DeckFormat;
  createdAt: string;
  updatedAt: string;
  boards: DeckbuilderBoards;
  /** User-defined custom categories for pile view grouping */
  customCategories?: CustomCategory[];
}

export interface DeckbuilderSnapshotSummary {
  slug: string;
  name: string;
  visibility: 'public' | 'unlisted';
  createdAt: string;
  commanderLine: string;
  cardCount: number;
}

export interface DeckbuilderSnapshotRecord {
  slug: string;
  visibility: 'public' | 'unlisted';
  createdAt: string;
  deck: Omit<DeckbuilderDeck, 'id' | 'createdAt' | 'updatedAt'>;
  summary: DeckbuilderSnapshotSummary;
}

export type EdhIssueSeverity = 'warning' | 'error';

export interface EdhRuleIssue {
  code:
    | 'missing_commander'
    | 'too_many_commanders'
    | 'commander_partner_invalid'
    | 'deck_size_under'
    | 'deck_size_over'
    | 'singleton_violation'
    | 'color_identity_violation'
    | 'commander_legality_warning'
    | 'companion_detected';
  severity: EdhIssueSeverity;
  message: string;
  cards?: string[];
  suggestions?: Array<{ cardName: string; replacement: string; reason: string }>;
}

export interface EdhRuleResult {
  issues: EdhRuleIssue[];
  counts: {
    commander: number;
    maindeck: number;
    effectiveDeckSize: number;
  };
}

export interface DeckbuilderCardView {
  id: string;
  oracle_id?: string;
  name: string;
  mana_cost?: string;
  cmc: number;
  type_line: string;
  oracle_text?: string;
  keywords?: string[];
  color_identity?: string[];
  legalities?: Record<string, string>;
  set?: string;
  collector_number?: string;
  prices?: Record<string, string | null>;
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
  };
  rarity?: string;
  power?: string;
  toughness?: string;
  edhrec_rank?: number;
  produced_mana?: string[];
  card_faces?: Array<{
    name?: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    power?: string;
    toughness?: string;
    image_uris?: {
      small?: string;
      normal?: string;
      large?: string;
    };
  }>;
}

export interface DeckbuilderImportLine {
  lineNumber: number;
  board: DeckBoard;
  qty: number;
  name: string;
  /** Set code extracted from MTGA format, e.g. "mh3" */
  set?: string | null;
  /** Collector number extracted from MTGA format, e.g. "303" */
  collectorNumber?: string | null;
}

export interface DeckbuilderImportParseResult {
  lines: DeckbuilderImportLine[];
  errors: string[];
}

export interface DeckbuilderImportUnresolved {
  lineNumber: number;
  board: DeckBoard;
  qty: number;
  name: string;
  reason: 'missing' | 'ambiguous';
  candidates: string[];
}

// ───── Collaborative Editing Types ─────

export type CollabRole = 'owner' | 'editor' | 'viewer';

export interface CollabParticipant {
  id: string;
  name: string;
  color: string;
  connectedAt?: string;
  /** Persistent user ID (if authenticated via GitHub OAuth) */
  userId?: string;
  /** Avatar URL from GitHub */
  avatarUrl?: string | null;
  /** Role in the collab session */
  role?: CollabRole;
}

export interface CollabSessionInfo {
  sessionId: string;
  deckName: string;
  participantCount: number;
  participants: CollabParticipant[];
}

export type CollabMessageType =
  | 'join'
  | 'joined'
  | 'left'
  | 'card-add'
  | 'card-remove'
  | 'card-update'
  | 'deck-meta'
  | 'sync-request'
  | 'sync-response'
  | 'error'
  | 'ping'
  | 'pong';

export type CollabConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface CollabDeckState {
  name: string;
  description: string;
  boards: DeckbuilderBoards;
}

// ───── Collaborative Tools Types ─────

export interface DrawStroke {
  id: string;
  participantId: string;
  color: string;
  tool: 'pen' | 'line' | 'arrow' | 'circle';
  points: [number, number][];   // normalised 0–1 coords relative to viewport
  lineWidth: number;
  timestamp: number;
}

export interface CursorPosition {
  participantId: string;
  name: string;
  color: string;
  x: number;   // normalised 0–1
  y: number;
  timestamp: number;
}

export interface CardPing {
  board: DeckBoard;
  cardName: string;
  participantId: string;
  participantName: string;
  color: string;
}

export interface ChatMessage {
  id: string;
  participantId: string;
  participantName: string;
  color: string;
  text: string;
  timestamp: number;
}

export interface CardVoteTally {
  up: number;
  down: number;
  net: number;
  myVote: 0 | 1 | -1;
}
