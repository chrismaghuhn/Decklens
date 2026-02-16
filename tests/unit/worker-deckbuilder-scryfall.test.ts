import { afterEach, describe, expect, it } from 'vitest';
import worker from '../../worker/src/index.ts';

const originalFetch = globalThis.fetch;

function uniqueToken(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('worker deckbuilder scryfall endpoints', () => {
  it('caches autocomplete responses per query', async () => {
    const token = uniqueToken('autocomplete');
    let autocompleteCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.scryfall.com/cards/autocomplete')) {
        autocompleteCalls += 1;
        return json({ data: [`Card ${token}`] });
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const requestUrl = `https://decklens.test/api/scryfall/autocomplete?q=${encodeURIComponent(`sol ${token}`)}`;

    const first = await worker.fetch(new Request(requestUrl), {} as never);
    expect(first.status).toBe(200);
    const firstPayload = await first.json() as { ok: boolean; data?: { items?: string[] } };
    expect(firstPayload.ok).toBe(true);
    expect(firstPayload.data?.items?.[0]).toContain(token);

    const second = await worker.fetch(new Request(requestUrl), {} as never);
    expect(second.status).toBe(200);
    const secondPayload = await second.json() as { ok: boolean; data?: { items?: string[] } };
    expect(secondPayload.ok).toBe(true);
    expect(secondPayload.data?.items?.[0]).toContain(token);

    expect(autocompleteCalls).toBe(1);
  });

  it('returns 502 for upstream search transport failures', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.scryfall.com/cards/search')) {
        throw new Error('Simulated network failure');
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const response = await worker.fetch(new Request('https://decklens.test/api/scryfall/search?q=sol%20ring'), {} as never);
    expect(response.status).toBe(502);

    const payload = await response.json() as { ok: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('Scryfall search unavailable.');
  });

  it('resolves collection rows by query name even if upstream order differs', async () => {
    const token = uniqueToken('resolve_order');
    const alpha = `Resolve Alpha ${token}`;
    const beta = `Resolve Beta ${token}`;
    const missingName = `Resolve Missing ${token}`;
    let collectionCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (!url.includes('api.scryfall.com/cards/collection')) {
        return new Response('Not Found', { status: 404 });
      }

      collectionCalls += 1;
      const parsed = JSON.parse(String(init?.body || '{}')) as {
        identifiers?: Array<{ name?: string }>;
      };
      const requestedNames = (parsed.identifiers || [])
        .map((item) => String(item.name || '').trim())
        .filter(Boolean);

      const payloadCards = [
        {
          id: `id_${token}_beta`,
          name: beta,
          cmc: 2,
          type_line: 'Artifact',
          prices: { eur: '1.00', usd: '1.10' },
        },
        {
          id: `id_${token}_alpha`,
          name: alpha,
          cmc: 1,
          type_line: 'Artifact',
          prices: { eur: '2.00', usd: '2.20' },
        },
      ];

      const notFound = requestedNames.includes(missingName) ? [{ name: missingName }] : [];
      return json({ data: payloadCards, not_found: notFound });
    }) as typeof fetch;

    const firstResponse = await worker.fetch(new Request('https://decklens.test/api/scryfall/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: [alpha, beta, missingName] }),
    }), {} as never);
    expect(firstResponse.status).toBe(200);
    const firstPayload = await firstResponse.json() as {
      ok: boolean;
      data?: {
        resolved?: Array<{ query: string; card: { name: string } }>;
        missing?: string[];
      };
    };

    expect(firstPayload.ok).toBe(true);
    const firstResolved = firstPayload.data?.resolved || [];
    expect(firstResolved.find((row) => row.query === alpha)?.card.name).toBe(alpha);
    expect(firstResolved.find((row) => row.query === beta)?.card.name).toBe(beta);
    expect(firstPayload.data?.missing || []).toContain(missingName);

    const secondResponse = await worker.fetch(new Request('https://decklens.test/api/scryfall/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: [alpha, beta] }),
    }), {} as never);
    expect(secondResponse.status).toBe(200);

    expect(collectionCalls).toBe(1);
  });

  it('gracefully marks unresolved names missing when collection fetch throws', async () => {
    const token = uniqueToken('resolve_throw');
    const unresolved = `Offline Card ${token}`;

    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('api.scryfall.com/cards/collection')) {
        throw new Error('Simulated timeout');
      }
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;

    const response = await worker.fetch(new Request('https://decklens.test/api/scryfall/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ names: [unresolved] }),
    }), {} as never);
    expect(response.status).toBe(200);

    const payload = await response.json() as {
      ok: boolean;
      data?: {
        resolved?: unknown[];
        missing?: string[];
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data?.resolved || []).toHaveLength(0);
    expect(payload.data?.missing || []).toContain(unresolved);
  });
});
