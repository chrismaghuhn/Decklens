import { describe, expect, it } from 'vitest';
import worker from '../../worker/src/index.ts';

interface CreatedDeckResponse {
  ok: boolean;
  data?: {
    deck?: {
      id: string;
      name: string;
      archetype: string;
      upvotes: number;
      authorDisplayName?: string;
    };
  };
}

function uniqueToken(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

async function createDeck(params: {
  token: string;
  name: string;
  archetype: string;
  commander: string;
  ip: string;
  authorDisplayName: string;
}): Promise<string> {
  const request = new Request('https://decklens.test/api/community/decks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': params.ip,
    },
    body: JSON.stringify({
      name: `${params.name} ${params.token}`,
      format: 'commander',
      commander: params.commander,
      archetype: params.archetype,
      decklist: `1 Sol Ring\n1 Arcane Signet\n1 Command Tower\n1 ${params.token}`,
      notes: `test-${params.token}`,
      authorDisplayName: params.authorDisplayName,
    }),
  });

  const response = await worker.fetch(request, {} as never);
  expect(response.status).toBe(201);
  const payload = await response.json() as CreatedDeckResponse;
  expect(payload.ok).toBe(true);
  expect(payload.data?.deck?.id).toBeTruthy();
  return payload.data?.deck?.id || '';
}

describe('worker community endpoints', () => {
  it('supports feed sorting/filtering and preserves author metadata', async () => {
    const token = uniqueToken('community_sort');

    const deckA = await createDeck({
      token,
      name: 'Deck A',
      archetype: 'tokens',
      commander: 'Rhys the Redeemed',
      ip: '203.0.113.10',
      authorDisplayName: 'AlphaPilot',
    });

    const deckB = await createDeck({
      token,
      name: 'Deck B',
      archetype: 'stax',
      commander: 'Grand Arbiter Augustin IV',
      ip: '203.0.113.11',
      authorDisplayName: 'BetaPilot',
    });

    const voteResponse = await worker.fetch(new Request('https://decklens.test/api/community/vote', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.12',
      },
      body: JSON.stringify({ deckId: deckB, vote: 'up' }),
    }), {} as never);
    expect(voteResponse.status).toBe(200);

    const sortedTopResponse = await worker.fetch(new Request(`https://decklens.test/api/community/decks?q=${encodeURIComponent(token)}&sort=top&limit=10`), {} as never);
    expect(sortedTopResponse.status).toBe(200);
    const sortedTopPayload = await sortedTopResponse.json() as {
      ok: boolean;
      data?: { items?: Array<{ id: string; authorDisplayName?: string }> };
    };

    expect(sortedTopPayload.ok).toBe(true);
    expect(sortedTopPayload.data?.items?.[0]?.id).toBe(deckB);
    expect(sortedTopPayload.data?.items?.some((item) => item.authorDisplayName === 'AlphaPilot')).toBe(true);

    const archetypeResponse = await worker.fetch(new Request(`https://decklens.test/api/community/decks?q=${encodeURIComponent(token)}&archetype=tokens&limit=10`), {} as never);
    expect(archetypeResponse.status).toBe(200);
    const archetypePayload = await archetypeResponse.json() as {
      ok: boolean;
      data?: { items?: Array<{ id: string; archetype: string }> };
    };

    expect(archetypePayload.ok).toBe(true);
    expect(archetypePayload.data?.items?.length).toBeGreaterThanOrEqual(1);
    expect(archetypePayload.data?.items?.some((item) => item.id === deckA && item.archetype === 'tokens')).toBe(true);
  });

  it('exposes flagged decks in moderation queue', async () => {
    const token = uniqueToken('community_mod');
    const deckId = await createDeck({
      token,
      name: 'Queue Deck',
      archetype: 'midrange',
      commander: 'Atraxa, Praetors\' Voice',
      ip: '203.0.113.21',
      authorDisplayName: 'QueuePilot',
    });

    const flagResponse = await worker.fetch(new Request('https://decklens.test/api/community/flag', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.22',
      },
      body: JSON.stringify({ deckId, reason: 'manual_report' }),
    }), {} as never);
    expect(flagResponse.status).toBe(201);

    const queueResponse = await worker.fetch(new Request('https://decklens.test/api/community/moderation?limit=20'), {} as never);
    expect(queueResponse.status).toBe(200);

    const queuePayload = await queueResponse.json() as {
      ok: boolean;
      data?: {
        items?: Array<{
          deckId: string;
          reason: string;
          deck: { name: string } | null;
          totalFlagsForDeck: number;
        }>;
      };
    };

    expect(queuePayload.ok).toBe(true);
    const flagged = queuePayload.data?.items?.find((item) => item.deckId === deckId);
    expect(flagged).toBeDefined();
    expect(flagged?.reason).toBe('manual_report');
    expect(flagged?.deck?.name).toContain(token);
    expect((flagged?.totalFlagsForDeck || 0)).toBeGreaterThanOrEqual(1);
  });

  it('returns realtime meta with confidence, freshness and quality labels', async () => {
    const response = await worker.fetch(new Request('https://decklens.test/api/meta/realtime'), {} as never);
    expect(response.status).toBe(200);

    const payload = await response.json() as {
      ok: boolean;
      data?: {
        updatedAt: string;
        confidence: {
          score: number;
          band: 'high' | 'medium' | 'low';
          components: {
            sessionSignal: number;
            eventVolume: number;
            communityCoverage: number;
            archetypeDiversity: number;
          };
        };
        freshness: {
          ageMinutes: number;
          state: 'fresh' | 'aging' | 'stale';
        };
        quality: {
          degraded: boolean;
          fallbackMode: 'live' | 'partial-fallback' | 'snapshot-fallback';
          label: string;
          reasons: string[];
        };
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.data?.updatedAt).toBeTruthy();
    expect(typeof payload.data?.confidence.score).toBe('number');
    expect(['high', 'medium', 'low']).toContain(payload.data?.confidence.band);
    expect(['fresh', 'aging', 'stale']).toContain(payload.data?.freshness.state);
    expect(typeof payload.data?.quality.degraded).toBe('boolean');
    expect(['live', 'partial-fallback', 'snapshot-fallback']).toContain(payload.data?.quality.fallbackMode);
    expect(typeof payload.data?.quality.label).toBe('string');
  });
});
