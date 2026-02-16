import { describe, expect, it } from 'vitest';
import worker from '../../worker/src/index.ts';

interface ShareCreateResponse {
  ok: boolean;
  data?: {
    slug?: string;
    visibility?: 'public' | 'unlisted';
  };
}

interface ShareGetResponse {
  ok: boolean;
  data?: {
    slug: string;
    visibility: 'public' | 'unlisted';
    deck: {
      name: string;
      boards: {
        commander: Array<{ name: string; qty: number }>;
        mainboard: Array<{ name: string; qty: number }>;
      };
    };
    summary: {
      cardCount: number;
      commanderLine: string;
    };
  };
}

function uniqueToken(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function createShare(params: {
  token: string;
  visibility: 'public' | 'unlisted';
  name: string;
  ip: string;
  mainboardQty?: number;
}): Promise<string> {
  const body = {
    visibility: params.visibility,
    deck: {
      name: `${params.name} ${params.token}`,
      boards: {
        commander: [{ name: 'Atraxa, Praetors\' Voice', qty: 1, set: '2X2', collectorNumber: '190', tags: [] }],
        mainboard: [{ name: 'Sol Ring', qty: params.mainboardQty || 99, set: 'CMM', collectorNumber: '396', tags: [] }],
        sideboard: [],
        maybeboard: [],
      },
    },
  };

  const response = await worker.fetch(new Request('https://decklens.test/api/deckbuilder/share', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': params.ip,
    },
    body: JSON.stringify(body),
  }), {} as never);

  expect(response.status).toBe(201);
  const payload = await response.json() as ShareCreateResponse;
  expect(payload.ok).toBe(true);
  expect(payload.data?.slug).toMatch(/^[a-z0-9]{6,24}$/);
  expect(payload.data?.visibility).toBe(params.visibility);
  return payload.data?.slug || '';
}

describe('worker deckbuilder share endpoints', () => {
  it('lists only public snapshots while allowing direct unlisted fetches', async () => {
    const token = uniqueToken('deckbuilder_public');
    const publicSlug = await createShare({
      token,
      visibility: 'public',
      name: 'Public Deck',
      ip: '198.51.100.70',
    });
    const unlistedSlug = await createShare({
      token,
      visibility: 'unlisted',
      name: 'Unlisted Deck',
      ip: '198.51.100.71',
    });

    const listResponse = await worker.fetch(new Request(`https://decklens.test/api/deckbuilder/public?q=${encodeURIComponent(token)}&limit=20`), {} as never);
    expect(listResponse.status).toBe(200);
    const listPayload = await listResponse.json() as {
      ok: boolean;
      data?: { items?: Array<{ slug: string }> };
    };

    expect(listPayload.ok).toBe(true);
    const slugs = listPayload.data?.items?.map((item) => item.slug) || [];
    expect(slugs).toContain(publicSlug);
    expect(slugs).not.toContain(unlistedSlug);

    const publicResponse = await worker.fetch(new Request(`https://decklens.test/api/deckbuilder/share/${publicSlug}`), {} as never);
    expect(publicResponse.status).toBe(200);
    const publicPayload = await publicResponse.json() as ShareGetResponse;
    expect(publicPayload.ok).toBe(true);
    expect(publicPayload.data?.visibility).toBe('public');

    const unlistedResponse = await worker.fetch(new Request(`https://decklens.test/api/deckbuilder/share/${unlistedSlug}`), {} as never);
    expect(unlistedResponse.status).toBe(200);
    const unlistedPayload = await unlistedResponse.json() as ShareGetResponse;
    expect(unlistedPayload.ok).toBe(true);
    expect(unlistedPayload.data?.visibility).toBe('unlisted');
  });

  it('creates immutable snapshots with distinct slugs and preserved payloads', async () => {
    const token = uniqueToken('deckbuilder_immutable');
    const firstSlug = await createShare({
      token,
      visibility: 'public',
      name: 'Version One',
      ip: '198.51.100.72',
      mainboardQty: 99,
    });
    const secondSlug = await createShare({
      token,
      visibility: 'public',
      name: 'Version Two',
      ip: '198.51.100.73',
      mainboardQty: 98,
    });

    expect(firstSlug).not.toBe(secondSlug);

    const firstResponse = await worker.fetch(new Request(`https://decklens.test/api/deckbuilder/share/${firstSlug}`), {} as never);
    const secondResponse = await worker.fetch(new Request(`https://decklens.test/api/deckbuilder/share/${secondSlug}`), {} as never);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const firstPayload = await firstResponse.json() as ShareGetResponse;
    const secondPayload = await secondResponse.json() as ShareGetResponse;

    expect(firstPayload.data?.deck.name).toContain('Version One');
    expect(secondPayload.data?.deck.name).toContain('Version Two');
    expect(firstPayload.data?.summary.cardCount).toBe(100);
    expect(secondPayload.data?.summary.cardCount).toBe(99);
  });
});
