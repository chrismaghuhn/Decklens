import { afterEach, describe, expect, it } from 'vitest';
import worker, { __resetRecommendationCacheForTests } from '../../worker/src/index.ts';

const originalFetch = globalThis.fetch;

function mockScryfallFetch(options?: { failureMode?: 'none' | 'transient_first' | 'always' }): { getCollectionCalls: () => number } {
  const failureMode = options?.failureMode || 'none';
  let collectionCalls = 0;
  const chunkAttempts = new Map<string, number>();

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('api.scryfall.com/cards/collection')) {
      collectionCalls += 1;
      const payload = JSON.parse(String(init?.body || '{}')) as { identifiers?: Array<{ name?: string }> };
      const chunkKey = (payload.identifiers || []).map((identifier) => String(identifier.name || '').toLowerCase()).join('|');
      const attempt = (chunkAttempts.get(chunkKey) || 0) + 1;
      chunkAttempts.set(chunkKey, attempt);

      if (failureMode === 'always') {
        throw new Error('Simulated Scryfall outage');
      }

      if (failureMode === 'transient_first' && attempt === 1) {
        return new Response(JSON.stringify({ error: 'temporary overload' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const cards = (payload.identifiers || []).map((identifier) => {
        const name = identifier.name || 'Unknown';
        const lower = name.toLowerCase();
        const land = ['plains', 'island', 'swamp', 'mountain', 'forest'].includes(lower);
        const blueCard = lower.includes('counter') || lower.includes('rhystic') || lower.includes('cyclonic') || lower.includes('ponder');
        const whiteCard = lower.includes('swords') || lower.includes('path') || lower.includes('teferi') || lower.includes('plains');
        const redCard = lower.includes('chaos') || lower.includes('mountain');
        const blackCard = lower.includes('toxic') || lower.includes('sign in blood') || lower.includes('swamp');
        const greenCard = lower.includes('beast') || lower.includes('nature') || lower.includes('farseek') || lower.includes('forest') || lower.includes('naturalize');
        const identity = [
          whiteCard ? 'W' : null,
          blueCard ? 'U' : null,
          blackCard ? 'B' : null,
          redCard ? 'R' : null,
          greenCard ? 'G' : null,
        ].filter((color): color is string => Boolean(color));

        const specificOracle = (() => {
          if (lower === 'colossal dreadmaw') return 'Trample';
          if (lower === 'darksteel relic') return 'Indestructible';
          if (lower === 'cancel') return 'Counter target spell.';
          if (lower === 'divination') return 'Draw two cards.';
          if (lower === 'naturalize') return 'Destroy target artifact or enchantment.';
          if (lower === 'ponder') return 'Look at the top three cards of your library.';
          if (lower === 'arcane signet') return '{T}: Add one mana of any color in your commander\'s color identity.';
          if (lower === 'sol ring') return '{T}: Add {C}{C}.';
          return 'Destroy target permanent.';
        })();

        const specificType = (() => {
          if (lower === 'colossal dreadmaw') return 'Creature - Dinosaur';
          if (lower === 'darksteel relic') return 'Artifact';
          if (lower === 'cancel') return 'Instant';
          if (lower === 'divination') return 'Sorcery';
          if (lower === 'naturalize') return 'Instant';
          if (lower === 'ponder') return 'Sorcery';
          if (lower === 'arcane signet') return 'Artifact';
          if (lower === 'sol ring') return 'Artifact';
          return land ? `Basic Land - ${name}` : 'Instant';
        })();

        const specificCmc = (() => {
          if (lower === 'colossal dreadmaw') return 6;
          if (lower === 'cancel') return 3;
          if (lower === 'divination') return 3;
          if (lower === 'naturalize') return 2;
          if (lower === 'ponder') return 1;
          if (lower === 'arcane signet') return 2;
          if (lower === 'sol ring') return 1;
          return land ? 0 : 2;
        })();

        return {
          name,
          mana_cost: land ? '' : '{2}',
          cmc: specificCmc,
          type_line: specificType,
          oracle_text: land
            ? `{T}: Add {${identity[0] || 'C'}}.`
            : specificOracle,
          color_identity: identity,
          prices: { eur: '2.00', usd: '2.20' },
        };
      });

      return new Response(JSON.stringify({ data: cards }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;

  return {
    getCollectionCalls: () => collectionCalls,
  };
}

function createRecommendationRequest(): Request {
  return new Request('https://decklens.test/api/recommendations/mtg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      metaMode: 'balanced',
      maxRecommendations: 5,
      deck: {
        commander: [{ name: 'Breya, Etherium Shaper', qty: 1 }],
        main: [
          { name: 'Plains', qty: 10 },
          { name: 'Island', qty: 10 },
          { name: 'Swamp', qty: 8 },
          { name: 'Mountain', qty: 8 },
          { name: 'Cancel', qty: 2 },
          { name: 'Divination', qty: 2 },
          { name: 'Naturalize', qty: 2 },
          { name: 'Colossal Dreadmaw', qty: 2 },
          { name: 'Darksteel Relic', qty: 1 },
          { name: 'Ponder', qty: 1 },
        ],
        sideboard: [],
      },
      collection: {
        'arcane signet': 1,
      },
    }),
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetRecommendationCacheForTests();
});

describe('worker recommendation endpoint', () => {
  it('returns a stable dd201-v1 response with top-5 and cut/add pairs', async () => {
    mockScryfallFetch();

    const responseA = await worker.fetch(createRecommendationRequest(), {} as never);
    expect(responseA.status).toBe(200);

    const payloadA = await responseA.json() as {
      ok: boolean;
      data: {
        version: string;
        recommendations: Array<{ id: string; cut: { name: string } | null }>;
      };
    };

    const responseB = await worker.fetch(createRecommendationRequest(), {} as never);
    expect(responseB.status).toBe(200);
    const payloadB = await responseB.json() as {
      data: {
        recommendations: Array<{ id: string; cut: { name: string } | null }>;
      };
    };

    expect(payloadA.ok).toBe(true);
    expect(payloadA.data.version).toBe('dd201-v1');
    expect(payloadA.data.recommendations).toHaveLength(5);

    expect(
      payloadA.data.recommendations.map((rec) => [rec.id, rec.cut?.name || null]),
    ).toEqual(
      payloadB.data.recommendations.map((rec) => [rec.id, rec.cut?.name || null]),
    );

    const paired = payloadA.data.recommendations.filter((rec) => rec.cut !== null);
    expect(paired.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects invalid recommendation payloads', async () => {
    mockScryfallFetch();
    const request = new Request('https://decklens.test/api/recommendations/mtg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deck: { main: [], sideboard: [], commander: [] } }),
    });

    const response = await worker.fetch(request, {} as never);
    expect(response.status).toBe(400);
  });

  it('keeps existing health endpoint behavior', async () => {
    const response = await worker.fetch(new Request('https://decklens.test/api/health'), {} as never);
    expect(response.status).toBe(200);
  });

  it('retries transient upstream failures and keeps non-degraded output', async () => {
    const mocked = mockScryfallFetch({ failureMode: 'transient_first' });

    const response = await worker.fetch(createRecommendationRequest(), {} as never);
    expect(response.status).toBe(200);

    const payload = await response.json() as {
      ok: boolean;
      request: {
        retries: number;
        degraded: boolean;
        resolvedCardMetrics: number;
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.request.retries).toBeGreaterThan(0);
    expect(payload.request.degraded).toBe(false);
    expect(payload.request.resolvedCardMetrics).toBeGreaterThan(0);
    expect(mocked.getCollectionCalls()).toBeGreaterThan(0);
  });

  it('returns graceful degraded response on full upstream outage', async () => {
    mockScryfallFetch({ failureMode: 'always' });

    const response = await worker.fetch(createRecommendationRequest(), {} as never);
    expect(response.status).toBe(200);

    const payload = await response.json() as {
      ok: boolean;
      request: {
        degraded: boolean;
        resolvedCardMetrics: number;
      };
      warnings: string[];
      data: {
        recommendations: unknown[];
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.request.degraded).toBe(true);
    expect(payload.request.resolvedCardMetrics).toBe(0);
    expect(payload.warnings.length).toBeGreaterThan(0);
    expect(payload.data.recommendations.length).toBeGreaterThan(0);
  });

  it('uses metrics cache across repeated recommendation calls', async () => {
    const mocked = mockScryfallFetch();

    const first = await worker.fetch(createRecommendationRequest(), {} as never);
    expect(first.status).toBe(200);
    const firstPayload = await first.json() as {
      request: { cacheHits: number; fetchedFromUpstream: number };
    };

    const callsAfterFirst = mocked.getCollectionCalls();

    const second = await worker.fetch(createRecommendationRequest(), {} as never);
    expect(second.status).toBe(200);
    const secondPayload = await second.json() as {
      request: { cacheHits: number; fetchedFromUpstream: number };
    };

    const callsAfterSecond = mocked.getCollectionCalls();

    expect(firstPayload.request.fetchedFromUpstream).toBeGreaterThan(0);
    expect(secondPayload.request.cacheHits).toBeGreaterThan(0);
    expect(secondPayload.request.fetchedFromUpstream).toBe(0);
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });
});
