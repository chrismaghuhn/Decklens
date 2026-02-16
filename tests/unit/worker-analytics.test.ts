import { describe, expect, it } from 'vitest';
import worker from '../../worker/src/index.ts';

interface TestAnalyticsEvent {
  name: string;
  eventId: string;
  occurredAt: string;
  app: string;
  page: string;
  userId: string;
  sessionId: string;
  properties: Record<string, unknown>;
}

function createValidEvent(name: string): TestAnalyticsEvent {
  return {
    name,
    eventId: `evt_test_${Math.random().toString(36).slice(2, 10)}`,
    occurredAt: new Date(1700000000000).toISOString(),
    app: 'mtg',
    page: '/mtg.html',
    userId: 'u_test_12345',
    sessionId: 's_test_67890',
    properties: {
      source: 'test',
    },
  };
}

function createEventWithOverrides(name: string, overrides: Partial<TestAnalyticsEvent> = {}): TestAnalyticsEvent {
  const base = createValidEvent(name);
  return {
    ...base,
    ...overrides,
    properties: {
      ...base.properties,
      ...(overrides.properties || {}),
    },
  };
}

describe('worker analytics endpoint', () => {
  it('accepts required analytics events and exposes health counters', async () => {
    const requiredEvents = [
      'deck_imported',
      'collection_imported',
      'analysis_started',
      'analysis_completed',
      'recommendation_viewed',
      'recommendation_applied',
      'export_clicked',
      'report_shared',
    ];

    for (const eventName of requiredEvents) {
      const request = new Request('https://decklens.test/api/analytics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createValidEvent(eventName)),
      });

      const response = await worker.fetch(request, {} as never);
      expect(response.status).toBe(202);
    }

    const health = await worker.fetch(new Request('https://decklens.test/api/analytics/health'), {} as never);
    expect(health.status).toBe(200);
    const payload = await health.json() as {
      counters: Record<string, number>;
      requiredEvents: string[];
    };
    expect(payload.requiredEvents).toEqual(expect.arrayContaining(requiredEvents));
    expect(payload.requiredEvents).toContain('feedback_submitted');
    for (const eventName of requiredEvents) {
      expect(payload.counters[eventName]).toBeGreaterThan(0);
    }
  });

  it('rejects malformed analytics events', async () => {
    const request = new Request('https://decklens.test/api/analytics/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    });

    const response = await worker.fetch(request, {} as never);
    expect(response.status).toBe(400);
  });

  it('accepts analysis payloads with meta context properties', async () => {
    const event = createValidEvent('analysis_started');
    event.properties = {
      ...event.properties,
      meta_mode: 'fnm',
      meta_context: {
        mode: 'fnm',
        cadence: 'weekly-fnm',
        interaction_bias: 1.25,
        removal_bias: 1.2,
        ramp_bias: 0.9,
        value_bias: 0.95,
      },
    };

    const request = new Request('https://decklens.test/api/analytics/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    const response = await worker.fetch(request, {} as never);
    expect(response.status).toBe(202);
  });

  it('returns dashboard metrics and triage-ready feedback context', async () => {
    const start = Date.now() - (3 * 24 * 60 * 60 * 1000);
    const userId = 'u_dashboard_user_00000001';
    const sessionA = 's_dashboard_session_alpha_00001';
    const sessionB = 's_dashboard_session_bravo_00002';

    const events: TestAnalyticsEvent[] = [
      createEventWithOverrides('deck_imported', {
        userId,
        sessionId: sessionA,
        occurredAt: new Date(start).toISOString(),
      }),
      createEventWithOverrides('collection_imported', {
        userId,
        sessionId: sessionA,
        occurredAt: new Date(start + (1 * 60_000)).toISOString(),
      }),
      createEventWithOverrides('analysis_started', {
        userId,
        sessionId: sessionA,
        occurredAt: new Date(start + (2 * 60_000)).toISOString(),
        properties: { analysis_id: 'analysis_dash_1' },
      }),
      createEventWithOverrides('analysis_completed', {
        userId,
        sessionId: sessionA,
        occurredAt: new Date(start + (3 * 60_000)).toISOString(),
        properties: { status: 'ok', analysis_id: 'analysis_dash_1' },
      }),
      createEventWithOverrides('recommendation_viewed', {
        userId,
        sessionId: sessionA,
        occurredAt: new Date(start + (4 * 60_000)).toISOString(),
        properties: { analysis_id: 'analysis_dash_1', recommendation_count: 4 },
      }),
      createEventWithOverrides('recommendation_applied', {
        userId,
        sessionId: sessionA,
        occurredAt: new Date(start + (5 * 60_000)).toISOString(),
        properties: { analysis_id: 'analysis_dash_1', recommendation_id: 'rec_1' },
      }),
      createEventWithOverrides('export_clicked', {
        userId,
        sessionId: sessionA,
        occurredAt: new Date(start + (6 * 60_000)).toISOString(),
      }),
      createEventWithOverrides('report_shared', {
        userId,
        sessionId: sessionA,
        occurredAt: new Date(start + (7 * 60_000)).toISOString(),
      }),
      createEventWithOverrides('feedback_submitted', {
        userId,
        sessionId: sessionA,
        occurredAt: new Date(start + (8 * 60_000)).toISOString(),
        properties: {
          feedback_text: 'Applying recommendations feels unclear after viewing top cards.',
          feedback_category: 'ux',
          analysis_id: 'analysis_dash_1',
          analysis_status: 'ok',
          analysis_tool: 'recommendations',
          recommendation_count: 4,
          funnel_step: 'recommendation_viewed',
          has_deck: true,
        },
      }),
      createEventWithOverrides('deck_imported', {
        userId,
        sessionId: sessionB,
        occurredAt: new Date(start + (2 * 24 * 60 * 60 * 1000)).toISOString(),
      }),
      createEventWithOverrides('analysis_started', {
        userId,
        sessionId: sessionB,
        occurredAt: new Date(start + (2 * 24 * 60 * 60 * 1000) + (2 * 60_000)).toISOString(),
      }),
      createEventWithOverrides('analysis_completed', {
        userId,
        sessionId: sessionB,
        occurredAt: new Date(start + (2 * 24 * 60 * 60 * 1000) + (3 * 60_000)).toISOString(),
        properties: { status: 'ok' },
      }),
    ];

    for (const event of events) {
      const response = await worker.fetch(new Request('https://decklens.test/api/analytics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
      }), {} as never);
      expect(response.status).toBe(202);
    }

    const dashboardResponse = await worker.fetch(new Request('https://decklens.test/api/analytics/dashboard?days=30'), {} as never);
    expect(dashboardResponse.status).toBe(200);

    const dashboard = await dashboardResponse.json() as {
      status: string;
      funnel: Array<{ name: string; sessions: number }>;
      metrics: {
        actionRate: { denominator: number; value: number | null };
        retentionProxy7d: { value: number | null };
      };
      feedback: {
        total: number;
        recent: Array<{ analysisId: string | null; sessionRef: string; category: string }>;
      };
    };

    expect(dashboard.status).toBe('ok');
    expect(dashboard.funnel.map((row) => row.name)).toEqual(expect.arrayContaining([
      'deck_imported',
      'collection_imported',
      'analysis_started',
      'analysis_completed',
      'recommendation_viewed',
      'recommendation_applied',
      'export_clicked',
      'report_shared',
    ]));
    expect(dashboard.metrics.actionRate.denominator).toBeGreaterThan(0);
    expect(dashboard.metrics.actionRate.value).not.toBeNull();
    expect((dashboard.metrics.retentionProxy7d.value || 0)).toBeGreaterThan(0);
    expect(dashboard.feedback.total).toBeGreaterThan(0);
    expect(dashboard.feedback.recent[0]?.analysisId).toBe('analysis_dash_1');
    expect(dashboard.feedback.recent[0]?.category).toBe('ux');
    expect(dashboard.feedback.recent[0]?.sessionRef).toContain('...');
  });
});
