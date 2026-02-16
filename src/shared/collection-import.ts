export type CollectionUnresolvedReason = 'missing_name' | 'invalid_quantity' | 'unknown_card';

export interface CollectionImportParsedRow {
  line: number;
  qty: number;
  name: string;
  idHint?: string;
  values: Record<string, string>;
}

export interface CollectionImportUnresolvedRow {
  line: number;
  qty: number;
  rawName: string;
  normalizedName: string;
  reason: CollectionUnresolvedReason;
  message: string;
  values: Record<string, string>;
}

export interface CollectionCanonicalCard {
  id: string;
  name: string;
  aliases?: string[];
}

export interface CollectionImportMappedItem {
  id: string;
  name: string;
  qty: number;
  lines: number[];
}

export interface CollectionCsvParseResult {
  rows: CollectionImportParsedRow[];
  unresolved: CollectionImportUnresolvedRow[];
  detectedDelimiter: string;
  headerMap: {
    hasHeader: boolean;
    nameKey: string | null;
    qtyKey: string | null;
    idKey: string | null;
  };
  totalLines: number;
}

export interface CollectionMapResult {
  mapped: CollectionImportMappedItem[];
  unresolved: CollectionImportUnresolvedRow[];
  stats: {
    totalRows: number;
    mappedRows: number;
    unresolvedRows: number;
    autoMapRate: number;
  };
}

const NAME_HEADERS = new Set([
  'name',
  'card',
  'cardname',
  'cardtitle',
  'title',
  'productname',
  'itemname',
]);

const QTY_HEADERS = new Set([
  'qty',
  'quantity',
  'count',
  'copies',
  'amount',
  'owned',
  'number',
  'num',
  'stock',
]);

const ID_HEADERS = new Set([
  'id',
  'cardid',
  'oracleid',
  'scryfallid',
  'multiverseid',
  'uuid',
]);

function normalizeHeaderKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i] || '';
    const next = line[i + 1] || '';

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current.trim());
  return fields.map((field) => field.replace(/^"(.*)"$/s, '$1').trim());
}

function detectDelimiter(line: string): string {
  const candidates = [',', ';', '\t'];
  let best = '';
  let bestCount = 0;

  for (const delimiter of candidates) {
    const count = splitCsvLine(line, delimiter).length;
    if (count > bestCount) {
      bestCount = count;
      best = delimiter;
    }
  }

  return bestCount > 1 ? best : '';
}

function looksLikeQty(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function parseDeckStyleLine(raw: string): { qty: number; name: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const prefixed = trimmed.match(/^(?:\*?)(\d+)\s*x?\s+(.+)$/i);
  if (prefixed) {
    return {
      qty: Number.parseInt(prefixed[1] || '1', 10),
      name: (prefixed[2] || '').trim(),
    };
  }

  const compact = trimmed.match(/^(\d+)x\s*(.+)$/i);
  if (compact) {
    return {
      qty: Number.parseInt(compact[1] || '1', 10),
      name: (compact[2] || '').trim(),
    };
  }

  return null;
}

function parsePositiveInteger(raw: string): number | null {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function lookupVariants(name: string): string[] {
  const base = normalizeCollectionLookupKey(name);
  if (!base) return [];

  const variants = new Set<string>([base]);
  variants.add(base.replace(/'/g, ''));

  if (base.includes(' // ')) {
    const [front] = base.split(' // ');
    if (front) variants.add(front.trim());
  }

  return [...variants].filter(Boolean);
}

export function normalizeCollectionCardName(raw: string): string {
  const stripped = raw
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/^'(.*)'$/s, '$1')
    .replace(/^SB\s*:/i, '')
    .trim()
    .replace(/^\*?\d+x?\s+/i, '')
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s+\([A-Za-z0-9]{2,10}\)\s*\d+[a-z]?\s*$/i, ' ')
    .replace(/\s+\([A-Za-z0-9]{2,10}\)\s*$/i, ' ')
    .replace(/\s+#?\d+[a-z]?\s*$/i, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s*\/\/\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim();

  return stripped;
}

export function normalizeCollectionLookupKey(raw: string): string {
  return normalizeCollectionCardName(raw)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9/' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createFallbackCollectionCardId(name: string): string {
  const key = normalizeCollectionLookupKey(name);
  return key ? `name:${key}` : 'name:unknown';
}

export function parseCollectionCsv(text: string): CollectionCsvParseResult {
  const source = text.replace(/^\uFEFF/, '');
  const lines = source.split(/\r?\n/);

  const unresolved: CollectionImportUnresolvedRow[] = [];
  const rows: CollectionImportParsedRow[] = [];

  const firstDataIndex = lines.findIndex((line) => line.trim().length > 0);
  if (firstDataIndex < 0) {
    return {
      rows,
      unresolved,
      detectedDelimiter: '',
      headerMap: { hasHeader: false, nameKey: null, qtyKey: null, idKey: null },
      totalLines: 0,
    };
  }

  const firstLine = lines[firstDataIndex] || '';
  const delimiter = detectDelimiter(firstLine);
  const firstFields = delimiter ? splitCsvLine(firstLine, delimiter) : [firstLine.trim()];
  const headerNorm = firstFields.map((field) => normalizeHeaderKey(field));

  const nameIdx = headerNorm.findIndex((key) => NAME_HEADERS.has(key));
  const qtyIdx = headerNorm.findIndex((key) => QTY_HEADERS.has(key));
  const idIdx = headerNorm.findIndex((key) => ID_HEADERS.has(key));
  const hasHeader = nameIdx >= 0 || qtyIdx >= 0 || idIdx >= 0;

  const startIndex = hasHeader ? firstDataIndex + 1 : firstDataIndex;

  for (let lineIdx = startIndex; lineIdx < lines.length; lineIdx++) {
    const rawLine = lines[lineIdx] || '';
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const fields = delimiter ? splitCsvLine(rawLine, delimiter) : [rawLine.trim()];
    const values: Record<string, string> = {};
    if (hasHeader) {
      for (let idx = 0; idx < firstFields.length; idx++) {
        const key = (firstFields[idx] || '').trim();
        if (key) values[key] = fields[idx] || '';
      }
    }

    let qtyRaw = '1';
    let rawName = '';
    let idHint = '';

    if (hasHeader) {
      qtyRaw = qtyIdx >= 0 ? (fields[qtyIdx] || '1') : '1';
      rawName = nameIdx >= 0 ? (fields[nameIdx] || '') : '';
      idHint = idIdx >= 0 ? (fields[idIdx] || '') : '';
    } else if (fields.length === 1) {
      const parsedDeckLine = parseDeckStyleLine(fields[0] || '');
      if (parsedDeckLine) {
        qtyRaw = String(parsedDeckLine.qty);
        rawName = parsedDeckLine.name;
      } else {
        rawName = fields[0] || '';
      }
    } else {
      const first = fields[0] || '';
      const second = fields[1] || '';
      if (looksLikeQty(first) && second.trim()) {
        qtyRaw = first;
        rawName = second;
      } else if (looksLikeQty(second) && first.trim()) {
        qtyRaw = second;
        rawName = first;
      } else {
        rawName = first;
      }
      idHint = fields[2] || '';
    }

    const qty = parsePositiveInteger(qtyRaw || '1');
    if (qty === null) {
      unresolved.push({
        line: lineIdx + 1,
        qty: 0,
        rawName,
        normalizedName: normalizeCollectionCardName(rawName),
        reason: 'invalid_quantity',
        message: `Invalid quantity "${qtyRaw}".`,
        values,
      });
      continue;
    }

    const normalizedName = normalizeCollectionCardName(rawName || idHint);
    if (!normalizedName && !idHint) {
      unresolved.push({
        line: lineIdx + 1,
        qty,
        rawName,
        normalizedName,
        reason: 'missing_name',
        message: 'Missing card name.',
        values,
      });
      continue;
    }

    rows.push({
      line: lineIdx + 1,
      qty,
      name: normalizedName || idHint.trim(),
      idHint: idHint.trim() || undefined,
      values,
    });
  }

  return {
    rows,
    unresolved,
    detectedDelimiter: delimiter,
    headerMap: {
      hasHeader,
      nameKey: nameIdx >= 0 ? firstFields[nameIdx] || null : null,
      qtyKey: qtyIdx >= 0 ? firstFields[qtyIdx] || null : null,
      idKey: idIdx >= 0 ? firstFields[idIdx] || null : null,
    },
    totalLines: lines.filter((line) => line.trim().length > 0).length,
  };
}

export function mapCollectionRowsToCanonical(
  rows: CollectionImportParsedRow[],
  cards: CollectionCanonicalCard[],
  baseUnresolved: CollectionImportUnresolvedRow[] = [],
): CollectionMapResult {
  const unresolved: CollectionImportUnresolvedRow[] = [...baseUnresolved];

  const idIndex = new Map<string, CollectionCanonicalCard>();
  const nameIndex = new Map<string, CollectionCanonicalCard>();

  for (const card of cards) {
    idIndex.set(card.id.toLowerCase(), card);
    for (const variant of lookupVariants(card.name)) {
      if (!nameIndex.has(variant)) {
        nameIndex.set(variant, card);
      }
    }
    for (const alias of card.aliases || []) {
      for (const variant of lookupVariants(alias)) {
        if (!nameIndex.has(variant)) {
          nameIndex.set(variant, card);
        }
      }
    }
  }

  const aggregate = new Map<string, CollectionImportMappedItem>();
  let mappedRows = 0;

  for (const row of rows) {
    let matched: CollectionCanonicalCard | undefined;

    if (row.idHint) {
      matched = idIndex.get(row.idHint.toLowerCase());
    }

    if (!matched) {
      const candidates = lookupVariants(row.name);
      for (const key of candidates) {
        const found = nameIndex.get(key);
        if (found) {
          matched = found;
          break;
        }
      }
    }

    if (!matched) {
      unresolved.push({
        line: row.line,
        qty: row.qty,
        rawName: row.name,
        normalizedName: normalizeCollectionCardName(row.name),
        reason: 'unknown_card',
        message: `Could not map "${row.name}" to a known card ID.`,
        values: row.values,
      });
      continue;
    }

    const existing = aggregate.get(matched.id);
    if (existing) {
      existing.qty += row.qty;
      existing.lines.push(row.line);
    } else {
      aggregate.set(matched.id, {
        id: matched.id,
        name: matched.name,
        qty: row.qty,
        lines: [row.line],
      });
    }

    mappedRows += 1;
  }

  const totalRows = rows.length + baseUnresolved.length;
  const unresolvedRows = unresolved.length;

  return {
    mapped: [...aggregate.values()],
    unresolved,
    stats: {
      totalRows,
      mappedRows,
      unresolvedRows,
      autoMapRate: totalRows === 0 ? 1 : mappedRows / totalRows,
    },
  };
}
