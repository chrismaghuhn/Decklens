import type { Deck, DeckEntry } from './types.js';

export type DeckExportFormat = 'text' | 'arena' | 'mtgo' | 'csv' | 'json' | 'moxfield';

interface SerializeDeckOptions {
  format: DeckExportFormat;
  deckName?: string;
}

interface EntryBucket {
  qty: number;
  names: Set<string>;
  set: string | null;
  num: string | null;
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

function nameCompare(a: string, b: string): number {
  const lowerDiff = a.toLowerCase().localeCompare(b.toLowerCase());
  if (lowerDiff !== 0) return lowerDiff;
  return a.localeCompare(b);
}

function normalizeEntries(entries: DeckEntry[]): DeckEntry[] {
  const byName = new Map<string, EntryBucket>();

  for (const entry of entries) {
    const normalized = normalizeName(entry.name || '');
    if (!normalized) continue;

    const qty = Math.trunc(Number(entry.qty));
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const key = normalized.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.qty += qty;
      existing.names.add(normalized);
      if (!existing.set && entry.set) existing.set = entry.set;
      if (!existing.num && entry.num) existing.num = entry.num;
    } else {
      byName.set(key, {
        qty,
        names: new Set([normalized]),
        set: entry.set || null,
        num: entry.num || null,
      });
    }
  }

  const normalizedEntries: DeckEntry[] = [];
  for (const bucket of byName.values()) {
    const sortedNames = [...bucket.names].sort(nameCompare);
    normalizedEntries.push({
      name: sortedNames[0] || '',
      qty: bucket.qty,
      set: bucket.set,
      num: bucket.num,
    });
  }

  normalizedEntries.sort((a, b) => nameCompare(a.name, b.name));
  return normalizedEntries;
}

function escapeCsvField(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function normalizeDeckForExport(deck: Deck): Deck {
  return {
    main: normalizeEntries(deck.main || []),
    sideboard: normalizeEntries(deck.sideboard || []),
    commander: normalizeEntries(deck.commander || []),
  };
}

export function serializeDeckForExport(deck: Deck, options: SerializeDeckOptions): string {
  const normalized = normalizeDeckForExport(deck);
  const format = options.format;

  if (format === 'json') {
    return JSON.stringify({
      name: options.deckName || 'Untitled Deck',
      main: normalized.main,
      sideboard: normalized.sideboard,
      commander: normalized.commander,
    }, null, 2);
  }

  if (format === 'csv') {
    const lines: string[] = ['Quantity,Name,Section'];
    for (const entry of normalized.main) {
      lines.push(`${entry.qty},${escapeCsvField(entry.name)},Main`);
    }
    for (const entry of normalized.sideboard) {
      lines.push(`${entry.qty},${escapeCsvField(entry.name)},Sideboard`);
    }
    for (const entry of normalized.commander) {
      lines.push(`${entry.qty},${escapeCsvField(entry.name)},Commander`);
    }
    return lines.join('\n');
  }

  if (format === 'arena') {
    const lines: string[] = [];
    for (const entry of normalized.main) {
      lines.push(`${entry.qty} ${entry.name}`);
    }
    if (normalized.sideboard.length > 0) {
      lines.push('');
      for (const entry of normalized.sideboard) {
        lines.push(`${entry.qty} ${entry.name}`);
      }
    }
    return lines.join('\n');
  }

  if (format === 'mtgo') {
    const lines: string[] = ['Main Deck'];
    for (const entry of normalized.main) {
      lines.push(`${entry.qty} ${entry.name}`);
    }
    if (normalized.sideboard.length > 0) {
      lines.push('');
      lines.push('Sideboard');
      for (const entry of normalized.sideboard) {
        lines.push(`${entry.qty} ${entry.name}`);
      }
    }
    if (normalized.commander.length > 0) {
      lines.push('');
      lines.push('Commander');
      for (const entry of normalized.commander) {
        lines.push(`${entry.qty} ${entry.name}`);
      }
    }
    return lines.join('\n');
  }

  if (format === 'moxfield') {
    const lines: string[] = [];
    for (const entry of normalized.main) {
      lines.push(`${entry.qty} ${entry.name}`);
    }
    if (normalized.sideboard.length > 0) {
      lines.push('');
      lines.push('Sideboard');
      for (const entry of normalized.sideboard) {
        lines.push(`${entry.qty} ${entry.name}`);
      }
    }
    if (normalized.commander.length > 0) {
      lines.push('');
      lines.push('Commander');
      for (const entry of normalized.commander) {
        lines.push(`${entry.qty} ${entry.name}`);
      }
    }
    return lines.join('\n');
  }

  const lines: string[] = [];
  for (const entry of normalized.main) {
    lines.push(`${entry.qty} ${entry.name}`);
  }
  if (normalized.sideboard.length > 0) {
    lines.push('');
    lines.push('Sideboard:');
    for (const entry of normalized.sideboard) {
      lines.push(`${entry.qty} ${entry.name}`);
    }
  }
  if (normalized.commander.length > 0) {
    lines.push('');
    lines.push('Commander:');
    for (const entry of normalized.commander) {
      lines.push(`${entry.qty} ${entry.name}`);
    }
  }
  return lines.join('\n');
}
