import { STORAGE_KEYS, storageGet, storageSet } from '../shared/storage.js';
import type { DeckBoard, DeckVisibility, DeckbuilderBoards, DeckbuilderCardEntry, DeckbuilderDeck } from './types.js';

const MAX_CARD_NAME_LENGTH = 200;
const MAX_TAG_LENGTH = 24;
const MAX_TAGS_PER_CARD = 12;

function createDeckId(): string {
  return `deck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeVisibility(raw: unknown): DeckVisibility {
  if (raw === 'public' || raw === 'unlisted' || raw === 'private') return raw;
  return 'private';
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const normalized = item.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (!normalized) continue;
    if (!out.includes(normalized)) out.push(normalized);
    if (out.length >= MAX_TAGS_PER_CARD) break;
  }
  return out;
}

function normalizeEntry(raw: unknown): DeckbuilderCardEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<DeckbuilderCardEntry>;
  const name = typeof row.name === 'string' ? row.name.trim().slice(0, MAX_CARD_NAME_LENGTH) : '';
  if (!name) return null;

  const qtyRaw = Number(row.qty);
  const qty = Number.isFinite(qtyRaw) ? Math.max(1, Math.min(99, Math.trunc(qtyRaw))) : 1;
  const set = typeof row.set === 'string' && row.set.trim() ? row.set.trim().slice(0, 16) : null;
  const collectorNumber =
    typeof row.collectorNumber === 'string' && row.collectorNumber.trim()
      ? row.collectorNumber.trim().slice(0, 16)
      : null;

  return {
    name,
    qty,
    set,
    collectorNumber,
    tags: normalizeTags(row.tags),
  };
}

function normalizeBoard(raw: unknown): DeckbuilderCardEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: DeckbuilderCardEntry[] = [];
  for (const item of raw) {
    const normalized = normalizeEntry(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function createEmptyBoards(): DeckbuilderBoards {
  return {
    commander: [],
    mainboard: [],
    sideboard: [],
    maybeboard: [],
  };
}

function normalizeBoards(raw: unknown): DeckbuilderBoards {
  if (!raw || typeof raw !== 'object') return createEmptyBoards();
  const obj = raw as Partial<Record<DeckBoard, unknown>>;
  return {
    commander: normalizeBoard(obj.commander),
    mainboard: normalizeBoard(obj.mainboard),
    sideboard: normalizeBoard(obj.sideboard),
    maybeboard: normalizeBoard(obj.maybeboard),
  };
}

function normalizeDeck(raw: unknown): DeckbuilderDeck | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<DeckbuilderDeck>;
  const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : createDeckId();
  const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 100) : 'Untitled Deck';
  const createdAt = typeof obj.createdAt === 'string' && obj.createdAt.trim() ? obj.createdAt : nowIso();
  const updatedAt = typeof obj.updatedAt === 'string' && obj.updatedAt.trim() ? obj.updatedAt : createdAt;

  const description = typeof obj.description === 'string' ? obj.description : undefined;
  const customCategories = Array.isArray(obj.customCategories) ? obj.customCategories : undefined;

  return {
    id,
    name,
    description,
    visibility: normalizeVisibility(obj.visibility),
    createdAt,
    updatedAt,
    boards: normalizeBoards(obj.boards),
    customCategories,
  };
}

export function createEmptyDeck(name = 'Untitled Deck'): DeckbuilderDeck {
  const ts = nowIso();
  return {
    id: createDeckId(),
    name: name.trim().slice(0, 100) || 'Untitled Deck',
    description: '',
    visibility: 'private',
    createdAt: ts,
    updatedAt: ts,
    boards: createEmptyBoards(),
  };
}

export function listDecks(): DeckbuilderDeck[] {
  const raw = storageGet<unknown>(STORAGE_KEYS.DECKBUILDER_DECKS, []);
  if (!Array.isArray(raw)) return [];

  const decks: DeckbuilderDeck[] = [];
  for (const item of raw) {
    const normalized = normalizeDeck(item);
    if (normalized) decks.push(normalized);
  }

  decks.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return decks;
}

export function saveDecks(decks: DeckbuilderDeck[]): boolean {
  const normalized = decks
    .map((deck) => normalizeDeck(deck))
    .filter((deck): deck is DeckbuilderDeck => Boolean(deck));
  const success = storageSet(STORAGE_KEYS.DECKBUILDER_DECKS, normalized);
  if (!success) {
    throw new Error('Failed to save decks - localStorage quota may be exceeded');
  }
  return true;
}

export function getDeckById(deckId: string): DeckbuilderDeck | null {
  const id = deckId.trim();
  if (!id) return null;
  const decks = listDecks();
  return decks.find((deck) => deck.id === id) || null;
}

export function upsertDeck(deck: DeckbuilderDeck): DeckbuilderDeck {
  const normalized = normalizeDeck(deck) || createEmptyDeck(deck.name);
  normalized.updatedAt = nowIso();

  const decks = listDecks();
  const index = decks.findIndex((item) => item.id === normalized.id);
  if (index >= 0) {
    decks[index] = normalized;
  } else {
    decks.push(normalized);
  }
  saveDecks(decks);
  return normalized;
}

export function createDeck(name: string): DeckbuilderDeck {
  const deck = createEmptyDeck(name);
  const decks = listDecks();
  decks.push(deck);
  saveDecks(decks);
  return deck;
}

export function deleteDeck(deckId: string): boolean {
  const id = deckId.trim();
  if (!id) return false;
  const next = listDecks().filter((deck) => deck.id !== id);
  return saveDecks(next);
}

export function duplicateDeck(deckId: string): DeckbuilderDeck | null {
  const source = getDeckById(deckId);
  if (!source) return null;
  const clone: DeckbuilderDeck = {
    ...source,
    id: createDeckId(),
    name: `${source.name} (Copy)`.slice(0, 100),
    visibility: 'private',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    boards: {
      commander: source.boards.commander.map((entry) => ({ ...entry, tags: [...entry.tags] })),
      mainboard: source.boards.mainboard.map((entry) => ({ ...entry, tags: [...entry.tags] })),
      sideboard: source.boards.sideboard.map((entry) => ({ ...entry, tags: [...entry.tags] })),
      maybeboard: source.boards.maybeboard.map((entry) => ({ ...entry, tags: [...entry.tags] })),
    },
  };

  const decks = listDecks();
  decks.push(clone);
  saveDecks(decks);
  return clone;
}

export function getLastOpenedDeckId(): string | null {
  const raw = storageGet<unknown>(STORAGE_KEYS.DECKBUILDER_LAST_OPENED_ID, null);
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

export function setLastOpenedDeckId(deckId: string): void {
  const id = deckId.trim();
  if (!id) return;
  storageSet(STORAGE_KEYS.DECKBUILDER_LAST_OPENED_ID, id);
}

export function summarizeDeckCardCounts(deck: DeckbuilderDeck): { commander: number; mainboard: number; total: number } {
  const commander = deck.boards.commander.reduce((sum, entry) => sum + entry.qty, 0);
  const mainboard = deck.boards.mainboard.reduce((sum, entry) => sum + entry.qty, 0);
  return {
    commander,
    mainboard,
    total: commander + mainboard,
  };
}
