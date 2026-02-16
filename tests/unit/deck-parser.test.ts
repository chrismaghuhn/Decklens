import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatDeckParseErrors,
  parseDeckInput,
  parseDeckInputUnsafe,
} from '../../src/shared/deck-parser.js';

function totalCards(result: ReturnType<typeof parseDeckInput>): number {
  return [...result.deck.main, ...result.deck.sideboard, ...result.deck.commander].reduce((sum, entry) => sum + entry.qty, 0);
}

describe('deck-parser fixtures', () => {
  it('parses at least 95% of valid fixture decks', () => {
    const validDir = resolve(process.cwd(), 'tests/fixtures/deck-parser/valid');
    const files = readdirSync(validDir);

    let parsedSuccessfully = 0;

    for (const file of files) {
      const text = readFileSync(resolve(validDir, file), 'utf8');
      const result = parseDeckInput(text);
      const success = result.errors.length === 0 && totalCards(result) > 0;
      if (success) {
        parsedSuccessfully += 1;
      }
    }

    const ratio = parsedSuccessfully / files.length;
    expect(ratio).toBeGreaterThanOrEqual(0.95);
  });

  it('returns clear line-based errors for invalid fixtures', () => {
    const invalidDir = resolve(process.cwd(), 'tests/fixtures/deck-parser/invalid');
    const files = readdirSync(invalidDir);

    for (const file of files) {
      const text = readFileSync(resolve(invalidDir, file), 'utf8');
      const result = parseDeckInput(text);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.every((issue) => issue.line >= 1)).toBe(true);
      expect(result.errors.every((issue) => issue.message.length > 8)).toBe(true);
    }
  });
});

describe('deck-parser validation behavior', () => {
  it('merges duplicates and emits warnings', () => {
    const input = ['4 Lightning Bolt', '2 lightning bolt', 'sideboard:', '1 Pyroblast', '1 pyroblast'].join('\n');
    const result = parseDeckInput(input);

    expect(result.errors).toHaveLength(0);
    expect(result.warnings.some((warning) => warning.code === 'duplicate_entry')).toBe(true);

    const bolt = result.deck.main.find((entry) => entry.name === 'Lightning Bolt');
    const pyro = result.deck.sideboard.find((entry) => entry.name === 'Pyroblast');
    expect(bolt?.qty).toBe(6);
    expect(pyro?.qty).toBe(2);
  });

  it('formats user-friendly error output with line references', () => {
    const result = parseDeckInput(['0 Lightning Bolt', 'oops line', '4 Mountain'].join('\n'));
    const message = formatDeckParseErrors(result.errors, 3);

    expect(message).toContain('Line 1');
    expect(message).toContain('Line 2');
  });

  it('keeps unsafe parse API for backward-compatible deck-only calls', () => {
    const deck = parseDeckInputUnsafe('4 Lightning Bolt\n20 Mountain');
    expect(deck.main.length).toBeGreaterThan(0);
    expect(deck.commander).toHaveLength(0);
  });
});
