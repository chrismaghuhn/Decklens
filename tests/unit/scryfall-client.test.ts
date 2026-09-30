import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchDeckbuilderAutocomplete,
  searchDeckbuilderCards,
  resolveDeckbuilderCards,
} from '../../src/shared/scryfall-client.js';

function scryfallCard(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `id-${name.toLowerCase().replace(/\s+/g, '-')}`,
    name,
    cmc: 2,
    type_line: 'Creature — Test',
    ...extra,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchDeckbuilderAutocomplete', () => {
  test('returns card names from the Scryfall autocomplete catalog', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: ['Lightning Bolt', 'Lightning Helix'] }));

    const names = await fetchDeckbuilderAutocomplete('lightning');

    expect(names).toEqual(['Lightning Bolt', 'Lightning Helix']);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('api.scryfall.com/cards/autocomplete');
    expect(url).toContain('q=lightning');
  });

  test('returns empty list for blank query without fetching', async () => {
    const names = await fetchDeckbuilderAutocomplete('   ');
    expect(names).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('searchDeckbuilderCards', () => {
  test('builds a Scryfall query from structured params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [scryfallCard('Sol Ring')], has_more: false, total_cards: 1 }));

    await searchDeckbuilderCards({
      q: 'ring',
      colorIdentity: 'wu',
      type: 'artifact',
      manaValue: '<=2',
      oracleText: 'add mana',
      keyword: 'haste',
      legality: 'commander',
      sort: 'mv',
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.host).toBe('api.scryfall.com');
    const q = url.searchParams.get('q') || '';
    expect(q).toContain('ring');
    expect(q).toContain('id<=wu');
    expect(q).toContain('t:artifact');
    expect(q).toContain('mv<=2');
    expect(q).toContain('o:"add mana"');
    expect(q).toContain('keyword:haste');
    expect(q).toContain('legal:commander');
    expect(url.searchParams.get('order')).toBe('cmc');
  });

  test('maps result cards and pagination fields', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [scryfallCard('Sol Ring', { image_uris: { small: 's.jpg', normal: 'n.jpg' }, prices: { eur: '1.00', usd: null } })],
      has_more: true,
      total_cards: 900,
    }));

    const result = await searchDeckbuilderCards({ q: 'sol' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('Sol Ring');
    expect(result.items[0].image_uris?.normal).toBe('n.jpg');
    expect(result.hasMore).toBe(true);
    expect(result.totalCards).toBe(900);
  });

  test('treats Scryfall 404 (no results) as an empty result, not an error', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ object: 'error', code: 'not_found' }, 404));

    const result = await searchDeckbuilderCards({ q: 'zzzznothing' });

    expect(result).toEqual({ items: [], hasMore: false, totalCards: 0 });
  });
});

describe('resolveDeckbuilderCards', () => {
  test('chunks collection requests at 75 identifiers', async () => {
    const names = Array.from({ length: 80 }, (_, i) => `Card ${i}`);
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { identifiers: Array<{ name: string }> };
      return jsonResponse({ data: body.identifiers.map((it) => scryfallCard(it.name)), not_found: [] });
    });

    const result = await resolveDeckbuilderCards(names);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBatch = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { identifiers: unknown[] };
    const secondBatch = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)) as { identifiers: unknown[] };
    expect(firstBatch.identifiers).toHaveLength(75);
    expect(secondBatch.identifiers).toHaveLength(5);
    expect(Object.keys(result.resolved).length).toBeGreaterThanOrEqual(80);
    expect(result.missing).toEqual([]);
  });

  test('reports not_found names as missing and keys resolved by normalized name', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: [scryfallCard('Sol Ring')],
      not_found: [{ name: 'Fake Card' }],
    }));

    const result = await resolveDeckbuilderCards(['  sol   RING ', 'Fake Card']);

    expect(result.resolved['sol ring']?.name).toBe('Sol Ring');
    expect(result.missing).toEqual(['Fake Card']);
  });
});
