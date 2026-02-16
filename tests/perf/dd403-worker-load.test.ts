import { afterEach, describe, it } from 'vitest';
import worker, { __resetRecommendationCacheForTests } from '../../worker/src/index.ts';

type LoadRunMetrics = {
  totalRequests: number;
  concurrency: number;
  wallMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  successRate: number;
  dataRichSuccessRate: number;
  hardErrorRate: number;
  avgResolvedMetrics: number;
  upstreamCalls: number;
  upstreamFailures: number;
};

const originalFetch = globalThis.fetch;

const RICH_DATA_MIN_RESOLVED = 95;
const DEFAULT_TOTAL_REQUESTS = Number(process.env.DD403_TOTAL_REQUESTS || 240);
const DEFAULT_CONCURRENCY = Number(process.env.DD403_CONCURRENCY || 16);
const RUN_PERF = process.env.DD403_RUN_PERF === '1';

function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let m = Math.imul(t ^ (t >>> 15), t | 1);
    m ^= m + Math.imul(m ^ (m >>> 7), m | 61);
    return ((m ^ (m >>> 14)) >>> 0) / 4294967296;
  };
}

const CARD_POOL: string[] = [
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest',
  'Arcane Signet', 'Sol Ring', 'Mind Stone', 'Fellwar Stone', "Wayfarer's Bauble",
  'Cancel', 'Counterspell', 'Negate', 'Ponder', 'Preordain', 'Divination',
  'Fact or Fiction', 'Read the Bones', 'Naturalize', 'Return to Nature',
  'Beast Within', 'Path to Exile', 'Swords to Plowshares', 'Chaos Warp',
  'Terminate', 'Cultivate', "Kodama's Reach", "Nature's Lore", 'Farseek',
  'Three Visits', 'Sign in Blood', "Night's Whisper", 'Heroic Intervention',
  "Teferi's Protection", 'Cyclonic Rift', 'Toxic Deluge', 'Farewell',
  'Colossal Dreadmaw', 'Darksteel Relic', 'Command Tower', 'Exotic Orchard',
  'Evolving Wilds', 'Terramorphic Expanse',
];

for (let i = 0; i < 160; i += 1) {
  CARD_POOL.push(`Card ${i}`);
}

function buildDeck(seed: number): Array<{ name: string; qty: number }> {
  const deck: Array<{ name: string; qty: number }> = [];
  for (let i = 0; i < 100; i += 1) {
    const idx = (seed * 17 + i * 13 + (i % 7) * 5) % CARD_POOL.length;
    deck.push({ name: CARD_POOL[idx], qty: 1 });
  }
  return deck;
}

const REQUEST_DECKS = [buildDeck(1), buildDeck(2), buildDeck(3), buildDeck(4), buildDeck(5)];

function normalizeCard(name: string): Record<string, unknown> {
  const lower = name.toLowerCase();
  const land = ['plains', 'island', 'swamp', 'mountain', 'forest'].includes(lower);
  const blue = lower.includes('counter') || lower.includes('ponder') || lower.includes('cyclonic') || lower.includes('preordain') || lower.includes('fact');
  const white = lower.includes('swords') || lower.includes('path') || lower.includes('teferi') || lower.includes('plains') || lower.includes('farewell');
  const black = lower.includes('toxic') || lower.includes('sign in blood') || lower.includes('night') || lower.includes('swamp') || lower.includes('terminate');
  const red = lower.includes('chaos') || lower.includes('mountain') || lower.includes('terminate');
  const green = lower.includes('beast') || lower.includes('nature') || lower.includes('farseek') || lower.includes('forest') || lower.includes('cultivate') || lower.includes('kodama') || lower.includes('three visits');

  const identity = [
    white ? 'W' : null,
    blue ? 'U' : null,
    black ? 'B' : null,
    red ? 'R' : null,
    green ? 'G' : null,
  ].filter((color): color is string => Boolean(color));

  return {
    name,
    mana_cost: land ? '' : '{2}',
    cmc: land ? 0 : (lower.includes('colossal') ? 6 : (lower.includes('farewell') ? 6 : (lower.includes('sol ring') ? 1 : 2))),
    type_line: land
      ? 'Basic Land'
      : (lower.includes('counter') || lower.includes('negate') || lower.includes('path') || lower.includes('swords')
          ? 'Instant'
          : (lower.includes('divination') || lower.includes('cultivate') || lower.includes('kodama') || lower.includes('farewell')
              ? 'Sorcery'
              : 'Artifact')),
    oracle_text: land
      ? `{T}: Add {${identity[0] || 'C'}}.`
      : (lower.includes('counter')
          ? 'Counter target spell.'
          : (lower.includes('draw') || lower.includes('divination') || lower.includes('ponder') || lower.includes('preordain')
              ? 'Draw a card.'
              : (lower.includes('destroy') || lower.includes('exile') || lower.includes('naturalize') || lower.includes('beast within')
                  ? 'Destroy target permanent.'
                  : '{T}: Add one mana of any color.'))),
    color_identity: identity,
    prices: {
      eur: (0.4 + ((name.length % 11) * 0.35)).toFixed(2),
      usd: (0.5 + ((name.length % 11) * 0.38)).toFixed(2),
    },
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx] || 0;
}

function createMockUpstream(seed: number): {
  fetch: typeof fetch;
  stats: { upstreamCalls: number; upstreamFailures: number };
} {
  const rnd = mulberry32(seed);
  const stats = { upstreamCalls: 0, upstreamFailures: 0 };

  const mockedFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (!url.includes('api.scryfall.com/cards/collection')) {
      return originalFetch(input, init);
    }

    stats.upstreamCalls += 1;
    const r = rnd();
    const delay = 180 + Math.floor(rnd() * 220);
    await new Promise((resolve) => setTimeout(resolve, delay));

    if (r < 0.04) {
      stats.upstreamFailures += 1;
      return new Response(JSON.stringify({ error: 'transient upstream overload' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (r >= 0.04 && r < 0.06) {
      stats.upstreamFailures += 1;
      throw new Error('transient network timeout');
    }

    const body = JSON.parse(String(init?.body || '{}')) as { identifiers?: Array<{ name?: string }> };
    const identifiers = Array.isArray(body.identifiers) ? body.identifiers : [];
    const data = identifiers.map((identifier) => normalizeCard(String(identifier.name || 'Unknown')));

    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return {
    fetch: mockedFetch,
    stats,
  };
}

async function runLoadScenario(totalRequests: number, concurrency: number): Promise<LoadRunMetrics> {
  const latencies: number[] = [];
  let successCount = 0;
  let richDataSuccessCount = 0;
  let hardErrorCount = 0;
  let totalResolvedMetrics = 0;

  const start = Date.now();
  let cursor = 0;

  async function workerLoop(): Promise<void> {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= totalRequests) return;

      const req = new Request('https://decklens.test/api/recommendations/mtg', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': `10.88.${idx % 32}.${(Math.floor(idx / 32) % 200) + 1}`,
        },
        body: JSON.stringify({
          metaMode: idx % 3 === 0 ? 'competitive' : (idx % 3 === 1 ? 'balanced' : 'budget'),
          maxRecommendations: 5,
          deck: {
            commander: [{ name: 'Breya, Etherium Shaper', qty: 1 }],
            main: REQUEST_DECKS[idx % REQUEST_DECKS.length],
            sideboard: [],
          },
          collection: {
            'arcane signet': 1,
            'beast within': 2,
          },
        }),
      });

      const t0 = Date.now();
      try {
        const response = await worker.fetch(req, {} as never);
        const elapsed = Date.now() - t0;
        latencies.push(elapsed);

        if (response.status !== 200) {
          hardErrorCount += 1;
          continue;
        }

        const payload = await response.json() as {
          ok?: boolean;
          request?: { resolvedCardMetrics?: number };
          data?: { recommendations?: unknown[] };
        };

        if (payload.ok && Array.isArray(payload.data?.recommendations) && payload.data.recommendations.length > 0) {
          successCount += 1;
        }

        const resolved = Number(payload.request?.resolvedCardMetrics || 0);
        totalResolvedMetrics += resolved;
        if (resolved >= RICH_DATA_MIN_RESOLVED) {
          richDataSuccessCount += 1;
        }
      } catch {
        latencies.push(Date.now() - t0);
        hardErrorCount += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => workerLoop()));

  latencies.sort((a, b) => a - b);
  const wallMs = Date.now() - start;

  return {
    totalRequests,
    concurrency,
    wallMs,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    successRate: Number((successCount / totalRequests).toFixed(4)),
    dataRichSuccessRate: Number((richDataSuccessCount / totalRequests).toFixed(4)),
    hardErrorRate: Number((hardErrorCount / totalRequests).toFixed(4)),
    avgResolvedMetrics: Number((totalResolvedMetrics / totalRequests).toFixed(2)),
    upstreamCalls: 0,
    upstreamFailures: 0,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetRecommendationCacheForTests();
});

const maybeIt = RUN_PERF ? it : it.skip;

describe('dd403 recommendation load benchmark', () => {
  maybeIt('reports p50/p95 latency and success rates', async () => {
    const mock = createMockUpstream(4032026);
    globalThis.fetch = mock.fetch;

    const results = await runLoadScenario(DEFAULT_TOTAL_REQUESTS, DEFAULT_CONCURRENCY);
    results.upstreamCalls = mock.stats.upstreamCalls;
    results.upstreamFailures = mock.stats.upstreamFailures;

    console.log('[dd403-load-profile]', JSON.stringify({
      profile: {
        totalRequests: DEFAULT_TOTAL_REQUESTS,
        concurrency: DEFAULT_CONCURRENCY,
        deckVariants: REQUEST_DECKS.length,
        richDataThreshold: RICH_DATA_MIN_RESOLVED,
        runPerf: RUN_PERF,
      },
      results,
    }, null, 2));
  }, 180_000);
});
