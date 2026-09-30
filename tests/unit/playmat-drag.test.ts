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

  test('Escape mid-drag aborts: no mutation, ghost removed', async () => {
    window.matchMedia = window.matchMedia
      || ((q: string) => ({ matches: false, media: q }) as MediaQueryList);
    const { initDrag } = await import('../../src/playmat/drag.js');

    document.body.innerHTML = `
      <div id="mat"><div class="pm-field">
        <div data-pile="pile-a"><div class="pm-pile-head" data-drag="pile"></div></div>
      </div></div>`;
    const mat = document.getElementById('mat')!;
    const layout: MatLayout = { piles: [{ id: 'pile-a', col: 1, row: 1 }] };
    const state = {
      deck: { id: 'd1', name: 'T', boards: { commander: [], mainboard: [], sideboard: [], maybeboard: [] }, matLayout: layout },
      cardByName: {},
      sortMode: 'free',
    };
    initDrag(mat, state as never);

    const head = mat.querySelector<HTMLElement>('[data-drag="pile"]')!;
    const ev = (type: string, x: number, y: number): MouseEvent =>
      new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    head.dispatchEvent(ev('pointerdown', 10, 10));
    document.dispatchEvent(ev('pointermove', 60, 60));
    expect(document.querySelector('.pm-drag-ghost')).not.toBeNull();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(ev('pointerup', 200, 200));

    expect(document.querySelector('.pm-drag-ghost')).toBeNull();
    expect(document.body.classList.contains('pm-dragging')).toBe(false);
    expect(state.deck.matLayout).toEqual({ piles: [{ id: 'pile-a', col: 1, row: 1 }] });
  });
});
