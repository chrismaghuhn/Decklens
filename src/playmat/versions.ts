// ==================== Deck Versions ====================
// Local, backend-free deck versioning: snapshots of the boards live in
// localStorage per deck, capped at VERSION_CAP. diffBoards answers the
// paper-deck question "what do I have to swap?".

import type { DeckBoard, DeckbuilderBoards, DeckbuilderDeck } from '../deckbuilder/types.js';

export const VERSION_CAP = 30;

export interface DeckVersion {
  id: string;
  ts: string;
  label: string;
  boards: DeckbuilderBoards;
  name: string;
  format?: string;
  /** commander + mainboard card count at snapshot time */
  total: number;
}

export interface BoardsDiffEntry {
  name: string;
  qty: number;
  board: DeckBoard;
}

export interface BoardsDiff {
  added: BoardsDiffEntry[];
  removed: BoardsDiffEntry[];
}

const BOARDS: DeckBoard[] = ['commander', 'mainboard', 'sideboard', 'maybeboard'];

function nameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function qtyMap(entries: DeckbuilderBoards[DeckBoard]): Map<string, { name: string; qty: number }> {
  const map = new Map<string, { name: string; qty: number }>();
  for (const e of entries) {
    const key = nameKey(e.name);
    const existing = map.get(key);
    if (existing) existing.qty += e.qty;
    else map.set(key, { name: e.name, qty: e.qty });
  }
  return map;
}

/** What changed from `before` to `after`, per board, with quantity deltas. */
export function diffBoards(before: DeckbuilderBoards, after: DeckbuilderBoards): BoardsDiff {
  const added: BoardsDiffEntry[] = [];
  const removed: BoardsDiffEntry[] = [];

  for (const board of BOARDS) {
    const a = qtyMap(before[board]);
    const b = qtyMap(after[board]);
    for (const [key, entry] of b) {
      const prev = a.get(key)?.qty || 0;
      if (entry.qty > prev) added.push({ name: entry.name, qty: entry.qty - prev, board });
    }
    for (const [key, entry] of a) {
      const next = b.get(key)?.qty || 0;
      if (entry.qty > next) removed.push({ name: entry.name, qty: entry.qty - next, board });
    }
  }
  return { added, removed };
}

function storageKey(deckId: string): string {
  return `dl_deck_versions_${deckId}`;
}

export function listVersions(deckId: string): DeckVersion[] {
  try {
    const raw = localStorage.getItem(storageKey(deckId));
    const parsed = raw ? (JSON.parse(raw) as DeckVersion[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function totalOf(boards: DeckbuilderBoards): number {
  return [...boards.commander, ...boards.mainboard].reduce((s, e) => s + e.qty, 0);
}

/**
 * Snapshot the deck's boards. Returns null (and stores nothing) when the
 * boards are identical to the newest stored version.
 */
export function saveVersion(deck: DeckbuilderDeck, label: string): DeckVersion | null {
  const versions = listVersions(deck.id);
  const newest = versions[0];
  if (newest && JSON.stringify(newest.boards) === JSON.stringify(deck.boards)) return null;

  const version: DeckVersion = {
    id: `v_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    ts: new Date().toISOString(),
    label: label.trim().slice(0, 60) || 'Snapshot',
    boards: JSON.parse(JSON.stringify(deck.boards)) as DeckbuilderBoards,
    name: deck.name,
    format: deck.format,
    total: totalOf(deck.boards),
  };
  const next = [version, ...versions].slice(0, VERSION_CAP);
  try {
    localStorage.setItem(storageKey(deck.id), JSON.stringify(next));
  } catch {
    // quota: drop the oldest half and retry once
    try {
      localStorage.setItem(storageKey(deck.id), JSON.stringify(next.slice(0, Math.ceil(next.length / 2))));
    } catch { /* give up silently */ }
  }
  return version;
}

export function deleteVersion(deckId: string, versionId: string): void {
  const next = listVersions(deckId).filter((v) => v.id !== versionId);
  try { localStorage.setItem(storageKey(deckId), JSON.stringify(next)); } catch { /* quota */ }
}
