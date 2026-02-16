import type { Deck, DeckEntry } from './types.js';
import { INPUT_LIMITS, validateDeckSize } from './security/limits.js';

export type DeckParseFormat = 'text' | 'csv' | 'json' | 'xml';

export type DeckParseIssueCode =
  | 'invalid_line'
  | 'invalid_quantity'
  | 'invalid_name'
  | 'invalid_json'
  | 'invalid_csv'
  | 'invalid_xml'
  | 'duplicate_entry'
  | 'deck_limit'
  | 'no_cards';

export interface DeckParseIssue {
  code: DeckParseIssueCode;
  line: number;
  message: string;
  rawLine?: string;
}

export interface DeckParseResult {
  format: DeckParseFormat;
  deck: Deck;
  errors: DeckParseIssue[];
  warnings: DeckParseIssue[];
  parsedLineCount: number;
}

type DeckZone = keyof Deck;

interface ZoneState {
  entry: DeckEntry;
  firstLine: number;
}

interface ParseState {
  zones: Record<DeckZone, Map<string, ZoneState>>;
  errors: DeckParseIssue[];
  warnings: DeckParseIssue[];
  parsedLineCount: number;
}

const MAX_CARD_QUANTITY = 250;

const MAIN_HEADERS = [/^main(board| deck)?\s*:?$/i, /^deck\s*:?$/i, /^maindeck\s*:?$/i, /^\/\/\s*main/i];
const SIDE_HEADERS = [/^side(board)?\s*:?$/i, /^sb\s*:?$/i, /^\/\/\s*side/i];
const COMMANDER_HEADERS = [/^commanders?\s*:?$/i, /^\/\/\s*commander/i];

const NAME_COLUMNS = ['name', 'card', 'card name', 'cardname'];
const QTY_COLUMNS = ['quantity', 'qty', 'count', 'copies'];
const SECTION_COLUMNS = ['section', 'zone', 'board', 'category'];

function createState(): ParseState {
  return {
    zones: {
      main: new Map<string, ZoneState>(),
      sideboard: new Map<string, ZoneState>(),
      commander: new Map<string, ZoneState>(),
    },
    errors: [],
    warnings: [],
    parsedLineCount: 0,
  };
}

function normalizeLine(line: string): string {
  return line.trim();
}

function pushError(state: ParseState, issue: DeckParseIssue): void {
  state.errors.push(issue);
}

function pushWarning(state: ParseState, issue: DeckParseIssue): void {
  state.warnings.push(issue);
}

function lineFromOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = i + 1 < line.length ? line[i + 1] : '';

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      fields.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current.trim());
  return fields.map((field) => field.replace(/^"(.*)"$/s, '$1').trim());
}

function normalizeCardName(raw: string): string {
  return raw
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    .replace(/\s*<[^>]*>\s*/g, ' ')
    .replace(/\s+\([A-Za-z0-9]{2,10}\)\s*\d+[a-z]?\s*$/i, ' ')
    .replace(/\s+\([A-Za-z0-9]{2,10}\)\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSetAndCollector(rawName: string): { name: string; set: string | null; num: string | null } {
  const match = rawName.match(/^(.+?)\s+\(([A-Za-z0-9]{2,10})\)\s*(\d+[a-z]?)?\s*$/i);
  if (!match) {
    return { name: normalizeCardName(rawName), set: null, num: null };
  }

  return {
    name: normalizeCardName(match[1] || ''),
    set: match[2] || null,
    num: match[3] || null,
  };
}

function parseQuantity(raw: string | number, state: ParseState, line: number, rawLine: string): number | null {
  const qty = typeof raw === 'number' ? raw : Number.parseInt(String(raw).trim(), 10);

  if (!Number.isFinite(qty) || !Number.isInteger(qty)) {
    pushError(state, {
      code: 'invalid_quantity',
      line,
      message: `Invalid quantity "${String(raw)}". Use a whole number.`,
      rawLine,
    });
    return null;
  }

  if (qty <= 0 || qty > MAX_CARD_QUANTITY) {
    pushError(state, {
      code: 'invalid_quantity',
      line,
      message: `Quantity must be between 1 and ${MAX_CARD_QUANTITY} (got ${qty}).`,
      rawLine,
    });
    return null;
  }

  return qty;
}

function validateCardName(name: string, state: ParseState, line: number, rawLine: string): boolean {
  if (!name) {
    pushError(state, {
      code: 'invalid_name',
      line,
      message: 'Card name is missing.',
      rawLine,
    });
    return false;
  }

  if (name.length > INPUT_LIMITS.CARD_NAME_MAX_LENGTH) {
    pushError(state, {
      code: 'invalid_name',
      line,
      message: `Card name is too long (max ${INPUT_LIMITS.CARD_NAME_MAX_LENGTH} chars).`,
      rawLine,
    });
    return false;
  }

  if (!/[\p{L}\p{N}]/u.test(name)) {
    pushError(state, {
      code: 'invalid_name',
      line,
      message: `Card name "${name}" is not valid.`,
      rawLine,
    });
    return false;
  }

  return true;
}

function addEntry(
  state: ParseState,
  zone: DeckZone,
  line: number,
  rawLine: string,
  rawQty: string | number,
  rawName: string,
  set: string | null = null,
  num: string | null = null,
): void {
  const qty = parseQuantity(rawQty, state, line, rawLine);
  if (qty === null) return;

  const normalizedName = normalizeCardName(rawName);
  if (!validateCardName(normalizedName, state, line, rawLine)) return;

  const key = normalizedName.toLowerCase();
  const existing = state.zones[zone].get(key);

  if (existing) {
    existing.entry.qty += qty;
    if (!existing.entry.set && set) existing.entry.set = set;
    if (!existing.entry.num && num) existing.entry.num = num;

    pushWarning(state, {
      code: 'duplicate_entry',
      line,
      message: `Duplicate "${normalizedName}" in ${zone} merged with line ${existing.firstLine}.`,
      rawLine,
    });
    return;
  }

  state.zones[zone].set(key, {
    firstLine: line,
    entry: {
      name: normalizedName,
      qty,
      set,
      num,
    },
  });

  state.parsedLineCount += 1;
}

function detectFormat(text: string): DeckParseFormat {
  const trimmed = text.trim();
  if (trimmed.startsWith('<?xml') || /<\s*(deck|cards|card)\b/i.test(trimmed)) {
    return 'xml';
  }

  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return 'json';
  }

  const firstNonEmpty = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  if (firstNonEmpty.includes(',')) {
    const cols = splitCsvLine(firstNonEmpty).map((col) => col.toLowerCase());
    if (cols.some((col) => NAME_COLUMNS.includes(col))) {
      return 'csv';
    }
  }

  return 'text';
}

function isSectionHeader(line: string, headers: RegExp[]): boolean {
  return headers.some((pattern) => pattern.test(line));
}

function mapCsvSection(raw: string): DeckZone {
  const value = raw.trim().toLowerCase();
  if (value.includes('side')) return 'sideboard';
  if (value.includes('command')) return 'commander';
  return 'main';
}

function parseTextDeck(text: string, state: ParseState): void {
  const lines = text.split(/\r?\n/);
  let section: DeckZone = 'main';

  for (let index = 0; index < lines.length; index++) {
    const rawLine = lines[index] || '';
    const line = normalizeLine(rawLine);
    const lineNumber = index + 1;

    if (!line) continue;
    if (line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) continue;

    if (isSectionHeader(line, MAIN_HEADERS)) {
      section = 'main';
      continue;
    }
    if (isSectionHeader(line, SIDE_HEADERS)) {
      section = 'sideboard';
      continue;
    }
    if (isSectionHeader(line, COMMANDER_HEADERS)) {
      section = 'commander';
      continue;
    }

    let zone = section;
    let payload = line;

    if (/^SB\s*:/i.test(payload)) {
      zone = 'sideboard';
      payload = payload.replace(/^SB\s*:/i, '').trim();
    }

    const parsedWithSet = payload.match(/^(\*?\d+)\s*x?\s+(.+)$/i);
    const parsedCompact = payload.match(/^(\d+)x\s*(.+)$/i);

    let qtyRaw: string | number = 1;
    let nameRaw = '';

    if (parsedWithSet) {
      qtyRaw = parsedWithSet[1].replace('*', '');
      nameRaw = parsedWithSet[2].trim();
    } else if (parsedCompact) {
      qtyRaw = parsedCompact[1];
      nameRaw = parsedCompact[2].trim();
    }

    if (!nameRaw) {
      pushError(state, {
        code: 'invalid_line',
        line: lineNumber,
        message: 'Could not parse this line. Expected "4 Card Name" or "SB: 2 Card Name".',
        rawLine,
      });
      continue;
    }

    const withSet = extractSetAndCollector(nameRaw);
    addEntry(state, zone, lineNumber, rawLine, qtyRaw, withSet.name, withSet.set, withSet.num);
  }
}

function parseCsvDeck(text: string, state: ParseState): void {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return;

  const header = splitCsvLine(lines[0] || '').map((col) => col.toLowerCase().trim());
  const nameIdx = header.findIndex((col) => NAME_COLUMNS.includes(col));
  const qtyIdx = header.findIndex((col) => QTY_COLUMNS.includes(col));
  const sectionIdx = header.findIndex((col) => SECTION_COLUMNS.includes(col));

  if (nameIdx < 0) {
    pushError(state, {
      code: 'invalid_csv',
      line: 1,
      message: 'CSV header must include a card name column (name/card/card name).',
      rawLine: lines[0] || '',
    });
    return;
  }

  for (let index = 1; index < lines.length; index++) {
    const rawLine = lines[index] || '';
    const line = normalizeLine(rawLine);
    const lineNumber = index + 1;
    if (!line) continue;

    const fields = splitCsvLine(rawLine);
    const rawName = fields[nameIdx] || '';
    const rawQty = qtyIdx >= 0 ? (fields[qtyIdx] || '1') : '1';
    const zone = sectionIdx >= 0 ? mapCsvSection(fields[sectionIdx] || '') : 'main';

    if (!rawName.trim()) {
      pushError(state, {
        code: 'invalid_name',
        line: lineNumber,
        message: 'Card name is missing in CSV row.',
        rawLine,
      });
      continue;
    }

    addEntry(state, zone, lineNumber, rawLine, rawQty, rawName);
  }
}

function parseDeckArray(
  state: ParseState,
  arr: unknown,
  zone: DeckZone,
  fallbackLine: number,
  sourceText: string,
): void {
  if (!Array.isArray(arr)) return;

  for (let idx = 0; idx < arr.length; idx++) {
    const item = arr[idx];
    const line = fallbackLine + idx;

    if (typeof item === 'string') {
      addEntry(state, zone, line, item, 1, item);
      continue;
    }

    if (!item || typeof item !== 'object') {
      pushError(state, {
        code: 'invalid_json',
        line,
        message: `Invalid JSON entry at index ${idx + 1}.`,
      });
      continue;
    }

    const entry = item as Record<string, unknown>;
    const rawName = String(entry.name ?? entry.card ?? entry.cardName ?? '').trim();
    const rawQty = (entry.qty ?? entry.quantity ?? entry.count ?? 1) as string | number;
    const set = typeof entry.set === 'string' ? entry.set : null;
    const num = typeof entry.num === 'string' ? entry.num : null;

    if (!rawName) {
      pushError(state, {
        code: 'invalid_name',
        line,
        message: `Missing card name in JSON entry #${idx + 1}.`,
      });
      continue;
    }

    const sectionRaw = String(entry.section ?? entry.zone ?? '').toLowerCase();
    const resolvedZone = sectionRaw ? mapCsvSection(sectionRaw) : zone;
    addEntry(state, resolvedZone, line, sourceText, rawQty, rawName, set, num);
  }
}

function parseJsonDeck(text: string, state: ParseState): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    pushError(state, {
      code: 'invalid_json',
      line: 1,
      message: 'Invalid JSON format.',
      rawLine: text.split(/\r?\n/)[0] || '',
    });
    return;
  }

  if (Array.isArray(parsed)) {
    parseDeckArray(state, parsed, 'main', 1, text);
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    pushError(state, {
      code: 'invalid_json',
      line: 1,
      message: 'JSON deck must be an object or array.',
    });
    return;
  }

  const obj = parsed as Record<string, unknown>;
  parseDeckArray(state, obj.main, 'main', 2, text);
  parseDeckArray(state, obj.sideboard, 'sideboard', 2, text);
  parseDeckArray(state, obj.commander, 'commander', 2, text);

  if (state.parsedLineCount === 0) {
    parseDeckArray(state, obj.cards, 'main', 2, text);
  }
}

function parseXmlAttributes(rawAttrs: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(rawAttrs)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2]);
  }
  return attrs;
}

function parseXmlDeck(text: string, state: ParseState): void {
  const deckCardRegex = /<Cards\b([^>]*)\/?>(?:<\/Cards>)?/gi;
  const altCardRegex = /<card\b([^>]*)\/?>(?:<\/card>)?/gi;

  let foundAny = false;
  let match: RegExpExecArray | null;

  while ((match = deckCardRegex.exec(text)) !== null) {
    foundAny = true;
    const attrs = parseXmlAttributes(match[1] || '');
    const line = lineFromOffset(text, match.index);
    const rawLine = match[0];

    const rawName = attrs.Name || attrs.name || '';
    const rawQty = attrs.Quantity || attrs.quantity || '1';
    const sideboardFlag = String(attrs.Sideboard || attrs.sideboard || 'false').toLowerCase() === 'true';

    const zone: DeckZone = sideboardFlag ? 'sideboard' : 'main';
    addEntry(state, zone, line, rawLine, rawQty, rawName);
  }

  while ((match = altCardRegex.exec(text)) !== null) {
    foundAny = true;
    const attrs = parseXmlAttributes(match[1] || '');
    const line = lineFromOffset(text, match.index);
    const rawLine = match[0];

    const rawName = attrs.name || attrs.Name || '';
    const rawQty = attrs.qty || attrs.Quantity || '1';
    addEntry(state, 'main', line, rawLine, rawQty, rawName);
  }

  if (!foundAny) {
    pushError(state, {
      code: 'invalid_xml',
      line: 1,
      message: 'No card nodes found in XML deck.',
      rawLine: text.split(/\r?\n/)[0] || '',
    });
  }
}

function buildDeck(state: ParseState): Deck {
  return {
    main: [...state.zones.main.values()].map((item) => item.entry),
    sideboard: [...state.zones.sideboard.values()].map((item) => item.entry),
    commander: [...state.zones.commander.values()].map((item) => item.entry),
  };
}

function finalizeDeckValidation(state: ParseState, deck: Deck): void {
  const total = [...deck.main, ...deck.sideboard, ...deck.commander].reduce((sum, entry) => sum + entry.qty, 0);

  if (total === 0) {
    pushError(state, {
      code: 'no_cards',
      line: 1,
      message: 'No cards could be parsed from the decklist.',
    });
    return;
  }

  try {
    validateDeckSize(deck);
  } catch (error) {
    pushError(state, {
      code: 'deck_limit',
      line: 1,
      message: error instanceof Error ? error.message : 'Deck size validation failed.',
    });
  }
}

export function parseDeckInput(text: string): DeckParseResult {
  const source = text.replace(/^\uFEFF/, '');
  const state = createState();
  const format = detectFormat(source);

  if (!source.trim()) {
    pushError(state, {
      code: 'no_cards',
      line: 1,
      message: 'Deck input is empty.',
    });

    return {
      format,
      deck: { main: [], sideboard: [], commander: [] },
      errors: state.errors,
      warnings: state.warnings,
      parsedLineCount: 0,
    };
  }

  if (format === 'xml') {
    parseXmlDeck(source, state);
  } else if (format === 'json') {
    parseJsonDeck(source, state);
  } else if (format === 'csv') {
    parseCsvDeck(source, state);
  } else {
    parseTextDeck(source, state);
  }

  const deck = buildDeck(state);
  finalizeDeckValidation(state, deck);

  return {
    format,
    deck,
    errors: state.errors,
    warnings: state.warnings,
    parsedLineCount: state.parsedLineCount,
  };
}

export function parseDeckInputUnsafe(text: string): Deck {
  return parseDeckInput(text).deck;
}

export function formatDeckParseErrors(issues: DeckParseIssue[], maxIssues = 4): string {
  if (issues.length === 0) {
    return 'Unknown deck parsing error.';
  }

  const lines = issues
    .slice(0, maxIssues)
    .map((issue) => `Line ${issue.line}: ${issue.message}`);

  if (issues.length > maxIssues) {
    lines.push(`...and ${issues.length - maxIssues} more issue(s).`);
  }

  return lines.join('\n');
}
