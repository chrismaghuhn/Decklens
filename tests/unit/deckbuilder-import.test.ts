import { describe, expect, it } from 'vitest';
import {
  mergeBoards,
  parseDeckbuilderImportText,
  resolveParsedImportLines,
  toBoardsFromResolvedImport,
} from '../../src/deckbuilder/import-resolver.js';

describe('deckbuilder import resolver', () => {
  it('parses sections and reports malformed rows', () => {
    const parsed = parseDeckbuilderImportText([
      'Commander:',
      '1 Atraxa, Praetors\' Voice',
      'Mainboard:',
      '2 Arcane Signet',
      '1x Sol Ring',
      'SB: 3 Swan Song',
      'Maybe:',
      '1 Rhystic Study',
      'not a valid import row',
    ].join('\n'));

    expect(parsed.lines.length).toBe(5);
    expect(parsed.errors.length).toBe(1);
    expect(parsed.errors[0]).toContain('Line 9');

    const byBoard = parsed.lines.reduce<Record<string, number>>((acc, row) => {
      acc[row.board] = (acc[row.board] || 0) + 1;
      return acc;
    }, {});

    expect(byBoard.commander).toBe(1);
    expect(byBoard.mainboard).toBe(2);
    expect(byBoard.sideboard).toBe(1);
    expect(byBoard.maybeboard).toBe(1);
  });

  it('resolves exact/suggested cards and keeps ambiguous or missing unresolved', () => {
    const parsed = parseDeckbuilderImportText([
      '1 Arcane Signet',
      '1 Ponder',
      '1 Bolt',
      '1 Totally Missing Card',
    ].join('\n'));

    const resolution = resolveParsedImportLines({
      lines: parsed.lines,
      resolvedByName: {
        'arcane signet': {
          id: 'signet',
          name: 'Arcane Signet',
          cmc: 2,
          type_line: 'Artifact',
        },
      },
      suggestionsByName: {
        ponder: ['Ponder'],
        bolt: ['Lightning Bolt', 'Galvanic Blast'],
      },
    });

    expect(resolution.resolved.map((row) => row.resolvedName)).toEqual(['Arcane Signet', 'Ponder']);
    expect(resolution.unresolved.length).toBe(2);
    expect(resolution.unresolved.find((row) => row.name === 'Bolt')?.reason).toBe('ambiguous');
    expect(resolution.unresolved.find((row) => row.name === 'Totally Missing Card')?.reason).toBe('missing');

    const importedBoards = toBoardsFromResolvedImport([
      ...resolution.resolved,
      {
        lineNumber: 99,
        board: 'mainboard',
        qty: 2,
        originalName: 'Arcane Signet',
        resolvedName: 'Arcane Signet',
      },
    ]);

    const merged = mergeBoards(importedBoards, {
      commander: [{ name: 'Atraxa, Praetors\' Voice', qty: 1, set: null, collectorNumber: null, tags: [] }],
      mainboard: [],
      sideboard: [],
      maybeboard: [],
    });

    expect(merged.commander[0]?.name).toBe('Atraxa, Praetors\' Voice');
    expect(merged.mainboard.find((row) => row.name === 'Arcane Signet')?.qty).toBe(3);
  });
});
