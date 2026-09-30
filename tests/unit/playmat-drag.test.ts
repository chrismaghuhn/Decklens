import { describe, expect, test } from 'vitest';
import { resolveDrop } from '../../src/playmat/drag.js';
import type { MatLayout } from '../../src/deckbuilder/types.js';

describe('resolveDrop', () => {
  const pilesAt = (c: number, r: number): string | null =>
    (c === 2 && r === 0) ? 'pile-creatures' : null;

  test('free mode: empty cell snaps to grid coordinates', () => {
    expect(resolveDrop(370, 150, 'free', pilesAt)).toEqual({ kind: 'cell', col: 5, row: 2 });
  });

  test('hits an existing pile before falling back to a cell', () => {
    expect(resolveDrop(150, 10, 'free', pilesAt)).toEqual({ kind: 'pile', id: 'pile-creatures' });
  });

  test('sorted modes never produce cells', () => {
    expect(resolveDrop(370, 150, 'type', pilesAt)).toBeNull();
    expect(resolveDrop(150, 10, 'type', pilesAt)).toEqual({ kind: 'pile', id: 'pile-creatures' });
  });

  test('abort leaves layout untouched', async () => {
    const { __testAbortDrag } = await import('../../src/playmat/drag.js');
    const layout: MatLayout = { piles: [{ id: 'a', col: 1, row: 1 }] };
    const before = JSON.stringify(layout);
    __testAbortDrag(layout);
    expect(JSON.stringify(layout)).toBe(before);
  });
});
