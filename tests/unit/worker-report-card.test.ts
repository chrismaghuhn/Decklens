import { describe, expect, it } from 'vitest';
import worker from '../../worker/src/index.ts';

function createValidReportPayload() {
  return {
    version: 1,
    deckName: 'Esper Midrange',
    totalCards: 100,
    metaMode: 'fnm',
    generatedAt: '2026-02-09T12:00:00.000Z',
    score: {
      value: 79,
      tier: 'B',
      label: 'Strong and cohesive',
    },
    recommendations: [
      {
        cardName: 'Swords to Plowshares',
        reason: 'Efficient answer for key threats.',
        impact: 'high',
      },
      {
        cardName: 'Arcane Signet',
        reason: 'Improves curve stability.',
        impact: 'medium',
      },
    ],
  };
}

describe('worker report-card endpoints', () => {
  it('creates stable token and resolves public report view payload', async () => {
    const firstRequest = new Request('https://decklens.test/api/report/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: createValidReportPayload() }),
    });
    const secondRequest = new Request('https://decklens.test/api/report/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ report: createValidReportPayload() }),
    });

    const firstResponse = await worker.fetch(firstRequest, {} as never);
    const secondResponse = await worker.fetch(secondRequest, {} as never);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const firstPayload = await firstResponse.json() as {
      ok: boolean;
      data: { token: string };
    };
    const secondPayload = await secondResponse.json() as {
      ok: boolean;
      data: { token: string };
    };

    expect(firstPayload.ok).toBe(true);
    expect(firstPayload.data.token).toBe(secondPayload.data.token);

    const publicResponse = await worker.fetch(
      new Request(`https://decklens.test/api/report/public?report=${firstPayload.data.token}`),
      {} as never,
    );
    expect(publicResponse.status).toBe(200);

    const publicPayload = await publicResponse.json() as {
      ok: boolean;
      data: {
        report: {
          deckName: string;
          score: { value: number };
          recommendations: Array<{ cardName: string }>;
        };
      };
    };

    expect(publicPayload.ok).toBe(true);
    expect(publicPayload.data.report.deckName).toBe('Esper Midrange');
    expect(publicPayload.data.report.score.value).toBe(79);
    expect(publicPayload.data.report.recommendations.length).toBeGreaterThan(0);
  });

  it('filters private fields server-side before issuing public payload', async () => {
    const request = new Request('https://decklens.test/api/report/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report: {
          ...createValidReportPayload(),
          collection: {
            'swords to plowshares': 0,
          },
          privateNotes: 'do not leak',
          recommendations: [
            {
              cardName: 'Swords to Plowshares',
              reason: 'Efficient answer for key threats.',
              impact: 'high',
              ownedCount: 0,
              collectionId: 'oracle:abc',
            },
          ],
        },
      }),
    });

    const response = await worker.fetch(request, {} as never);
    expect(response.status).toBe(200);

    const payload = await response.json() as {
      data: {
        token: string;
        report: {
          recommendations: Array<Record<string, unknown>>;
        };
      };
    };

    const reportObject = payload.data.report as unknown as Record<string, unknown>;
    expect(reportObject.collection).toBeUndefined();
    expect(reportObject.privateNotes).toBeUndefined();

    const rec = payload.data.report.recommendations[0];
    expect(Object.keys(rec).sort()).toEqual(['cardName', 'impact', 'reason']);
    expect(rec.ownedCount).toBeUndefined();
    expect(rec.collectionId).toBeUndefined();

    const publicResponse = await worker.fetch(
      new Request(`https://decklens.test/api/report/public?report=${payload.data.token}`),
      {} as never,
    );
    expect(publicResponse.status).toBe(200);
    const publicPayload = await publicResponse.json() as {
      data: {
        report: Record<string, unknown>;
      };
    };
    expect(publicPayload.data.report.collection).toBeUndefined();
    expect(publicPayload.data.report.privateNotes).toBeUndefined();
  });

  it('rejects invalid report links and malformed share payloads', async () => {
    const invalidReportResponse = await worker.fetch(
      new Request('https://decklens.test/api/report/public?report=bad!token'),
      {} as never,
    );
    expect(invalidReportResponse.status).toBe(400);

    const malformedShareResponse = await worker.fetch(
      new Request('https://decklens.test/api/report/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: { deckName: 'Missing score' } }),
      }),
      {} as never,
    );
    expect(malformedShareResponse.status).toBe(400);
  });
});
