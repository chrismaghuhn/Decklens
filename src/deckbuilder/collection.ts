const STORAGE_KEY = 'decklens_collection';

// ==================== Types ====================

export type CardCondition = 'NM' | 'LP' | 'MP' | 'HP';

export interface CollectionEntry {
  qty: number;
  foil?: boolean;
  condition?: CardCondition;
}

// ==================== State ====================

let collection: Map<string, CollectionEntry> = new Map();

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

// ==================== Persistence ====================

export function loadCollection(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);

    // Migration: old format was a simple string[] (Set serialized as array)
    if (Array.isArray(parsed)) {
      collection = new Map();
      for (const name of parsed) {
        if (typeof name === 'string') {
          collection.set(normalizeKey(name), { qty: 1 });
        }
      }
      // Re-save in new format immediately
      saveCollection();
      return;
    }

    // New format: Record<string, CollectionEntry>
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      collection = new Map();
      for (const [key, value] of Object.entries(parsed)) {
        if (value && typeof value === 'object' && 'qty' in (value as Record<string, unknown>)) {
          const entry = value as CollectionEntry;
          if (entry.qty >= 1) {
            collection.set(normalizeKey(key), {
              qty: entry.qty,
              foil: entry.foil,
              condition: entry.condition,
            });
          }
        }
      }
    }
  } catch {
    collection = new Map();
  }
}

function saveCollection(): void {
  const obj: Record<string, CollectionEntry> = {};
  for (const [key, entry] of collection) {
    obj[key] = entry;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

// ==================== Public API ====================

export function isOwned(cardName: string): boolean {
  const entry = collection.get(normalizeKey(cardName));
  return entry !== undefined && entry.qty >= 1;
}

export function getOwnedQty(cardName: string): number {
  const entry = collection.get(normalizeKey(cardName));
  return entry ? entry.qty : 0;
}

export function getCollectionEntry(cardName: string): CollectionEntry | undefined {
  return collection.get(normalizeKey(cardName));
}

export function setOwnedQty(cardName: string, qty: number): void {
  const key = normalizeKey(cardName);
  if (qty <= 0) {
    collection.delete(key);
  } else {
    const existing = collection.get(key);
    collection.set(key, { ...existing, qty });
  }
  saveCollection();
}

export function setCollectionEntry(cardName: string, entry: Partial<CollectionEntry>): void {
  const key = normalizeKey(cardName);
  const existing = collection.get(key) || { qty: 1 };
  const updated = { ...existing, ...entry };
  if (updated.qty <= 0) {
    collection.delete(key);
  } else {
    collection.set(key, updated);
  }
  saveCollection();
}

/** Toggle owned (backward-compatible: adds qty=1 if not owned, removes if owned) */
export function toggleOwned(cardName: string): boolean {
  const key = normalizeKey(cardName);
  if (collection.has(key)) {
    collection.delete(key);
  } else {
    collection.set(key, { qty: 1 });
  }
  saveCollection();
  return collection.has(key);
}

export function getCollectionSize(): number {
  return collection.size;
}

export function getTotalCollectionCards(): number {
  let total = 0;
  for (const entry of collection.values()) {
    total += entry.qty;
  }
  return total;
}

export function exportCollectionText(): string {
  return Array.from(collection.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => {
      const displayName = name.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return entry.qty > 1 ? `${entry.qty}x ${displayName}` : displayName;
    })
    .join('\n');
}

export function importCollectionText(text: string): number {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let added = 0;
  for (const line of lines) {
    // Parse optional quantity prefix: "3x Card Name" or "3 Card Name" or just "Card Name"
    const qtyMatch = line.match(/^(\d+)\s*x?\s+(.+)/i);
    let qty = 1;
    let name = line;
    if (qtyMatch) {
      qty = Math.max(1, parseInt(qtyMatch[1], 10) || 1);
      name = qtyMatch[2];
    }
    const key = normalizeKey(name);
    if (!collection.has(key)) {
      collection.set(key, { qty });
      added++;
    } else {
      // If already in collection, keep the higher qty
      const existing = collection.get(key)!;
      if (qty > existing.qty) {
        collection.set(key, { ...existing, qty });
      }
    }
  }
  saveCollection();
  return added;
}
