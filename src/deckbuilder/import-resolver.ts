import type { DeckBoard, DeckbuilderBoards, DeckbuilderCardView, DeckbuilderImportLine, DeckbuilderImportParseResult, DeckbuilderImportUnresolved } from './types.js';

const SECTION_HEADERS: Array<{ pattern: RegExp; board: DeckBoard }> = [
  { pattern: /^commander\s*:?$/i, board: 'commander' },
  { pattern: /^main(board| deck)?\s*:?$/i, board: 'mainboard' },
  { pattern: /^deck\s*:?$/i, board: 'mainboard' },
  { pattern: /^side(board)?\s*:?$/i, board: 'sideboard' },
  { pattern: /^(maybeboard|considering|maybe)\s*:?$/i, board: 'maybeboard' },
  { pattern: /^companion\s*:?$/i, board: 'sideboard' },
];

function normalizeNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function sanitizeBoardCardName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

function aggregateBoardEntries(lines: DeckbuilderImportLine[]): DeckbuilderBoards {
  const bucket = new Map<string, { board: DeckBoard; name: string; qty: number; set?: string | null; collectorNumber?: string | null }>();

  for (const line of lines) {
    const name = sanitizeBoardCardName(line.name);
    if (!name) continue;
    const qty = Math.max(1, Math.min(99, Math.trunc(line.qty)));
    const key = `${line.board}::${normalizeNameKey(name)}`;
    const existing = bucket.get(key);
    if (existing) {
      existing.qty += qty;
      continue;
    }
    bucket.set(key, { board: line.board, name, qty, set: line.set || null, collectorNumber: line.collectorNumber || null });
  }

  const boards: DeckbuilderBoards = {
    commander: [],
    mainboard: [],
    sideboard: [],
    maybeboard: [],
  };

  for (const item of Array.from(bucket.values())) {
    boards[item.board].push({
      name: item.name,
      qty: item.qty,
      set: item.set || null,
      collectorNumber: item.collectorNumber || null,
      tags: [],
    });
  }

  const boardKeys: DeckBoard[] = ['commander', 'mainboard', 'sideboard', 'maybeboard'];
  for (const boardKey of boardKeys) {
    boards[boardKey].sort((a, b) => a.name.localeCompare(b.name));
  }

  return boards;
}

export interface ImportResolvedLine {
  lineNumber: number;
  board: DeckBoard;
  qty: number;
  originalName: string;
  resolvedName: string;
  set?: string | null;
  collectorNumber?: string | null;
}

export interface ImportResolutionResult {
  resolved: ImportResolvedLine[];
  unresolved: DeckbuilderImportUnresolved[];
}

export function parseDeckbuilderImportText(input: string): DeckbuilderImportParseResult {
  const lines = input.replace(/^\uFEFF/, '').split(/\r?\n/);
  const parsed: DeckbuilderImportLine[] = [];
  const errors: string[] = [];
  let board: DeckBoard = 'mainboard';

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const rawLine = (lines[index] || '').trim();
    if (!rawLine) continue;
    if (rawLine.startsWith('#') || rawLine.startsWith('//') || rawLine.startsWith(';')) continue;

    const header = SECTION_HEADERS.find((item) => item.pattern.test(rawLine));
    if (header) {
      board = header.board;
      continue;
    }

    let parseBoard = board;
    let payload = rawLine;
    if (/^SB\s*:/i.test(payload)) {
      parseBoard = 'sideboard';
      payload = payload.replace(/^SB\s*:/i, '').trim();
    }

    const standard = payload.match(/^(\d+)\s*x?\s+(.+)$/i);
    const compact = payload.match(/^(\d+)x\s*(.+)$/i);
    const qtyRaw = standard?.[1] || compact?.[1] || '';
    let nameRaw = standard?.[2] || compact?.[2] || '';

    if (!qtyRaw || !nameRaw.trim()) {
      errors.push(`Line ${lineNumber}: Could not parse "${rawLine}". Use format "1 Card Name".`);
      continue;
    }

    // Strip MTGA format: "Card Name (SET) 123" or "Card Name (SET) 123a"
    let importSet: string | null = null;
    let importCollector: string | null = null;
    const mtgaMatch = nameRaw.match(/^(.+?)\s*\(([A-Za-z0-9]{2,6})\)\s*(\d+\w?)$/);
    if (mtgaMatch) {
      nameRaw = mtgaMatch[1].trim();
      importSet = mtgaMatch[2].toLowerCase();
      importCollector = mtgaMatch[3];
    }

    const qty = Number.parseInt(qtyRaw, 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`Line ${lineNumber}: Invalid quantity "${qtyRaw}".`);
      continue;
    }

    parsed.push({
      lineNumber,
      board: parseBoard,
      qty: Math.max(1, Math.min(99, qty)),
      name: sanitizeBoardCardName(nameRaw),
      set: importSet,
      collectorNumber: importCollector,
    });
  }

  return {
    lines: parsed,
    errors,
  };
}

export function resolveParsedImportLines(params: {
  lines: DeckbuilderImportLine[];
  resolvedByName: Record<string, DeckbuilderCardView | undefined>;
  suggestionsByName?: Record<string, string[]>;
}): ImportResolutionResult {
  const resolved: ImportResolvedLine[] = [];
  const unresolved: DeckbuilderImportUnresolved[] = [];

  for (const line of params.lines) {
    const key = normalizeNameKey(line.name);
    const exact = params.resolvedByName[key];
    if (exact) {
      resolved.push({
        lineNumber: line.lineNumber,
        board: line.board,
        qty: line.qty,
        originalName: line.name,
        resolvedName: exact.name,
        set: exact.set || null,
        collectorNumber: exact.collector_number || null,
      });
      continue;
    }

    const suggestions = (params.suggestionsByName?.[key] || [])
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 10);

    if (suggestions.length === 1) {
      resolved.push({
        lineNumber: line.lineNumber,
        board: line.board,
        qty: line.qty,
        originalName: line.name,
        resolvedName: suggestions[0],
      });
      continue;
    }

    unresolved.push({
      lineNumber: line.lineNumber,
      board: line.board,
      qty: line.qty,
      name: line.name,
      reason: suggestions.length > 1 ? 'ambiguous' : 'missing',
      candidates: suggestions,
    });
  }

  return { resolved, unresolved };
}

export function toBoardsFromResolvedImport(lines: ImportResolvedLine[]): DeckbuilderBoards {
  const mapped: DeckbuilderImportLine[] = lines.map((line) => ({
    lineNumber: line.lineNumber,
    board: line.board,
    qty: line.qty,
    name: line.resolvedName,
  }));
  return aggregateBoardEntries(mapped);
}

export function mergeBoards(base: DeckbuilderBoards, extra: DeckbuilderBoards): DeckbuilderBoards {
  const mergedLines: DeckbuilderImportLine[] = [];
  const pushBoard = (board: DeckBoard, entries: DeckbuilderBoards[DeckBoard]): void => {
    for (const entry of entries) {
      mergedLines.push({
        lineNumber: 0,
        board,
        qty: entry.qty,
        name: entry.name,
      });
    }
  };

  pushBoard('commander', base.commander);
  pushBoard('mainboard', base.mainboard);
  pushBoard('sideboard', base.sideboard);
  pushBoard('maybeboard', base.maybeboard);
  pushBoard('commander', extra.commander);
  pushBoard('mainboard', extra.mainboard);
  pushBoard('sideboard', extra.sideboard);
  pushBoard('maybeboard', extra.maybeboard);

  return aggregateBoardEntries(mergedLines);
}
