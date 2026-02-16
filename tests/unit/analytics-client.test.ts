import { describe, expect, it } from 'vitest';
import { createAnalyticsClientForTest, type AnalyticsEventPayload } from '../../src/shared/analytics.js';

describe('analytics client', () => {
  it('builds a consistent event envelope', async () => {
    const captured: AnalyticsEventPayload[] = [];
    const client = createAnalyticsClientForTest({
      app: 'mtg',
      endpoint: '/api/analytics/events',
      now: () => 1700000000000,
      getPagePath: () => '/mtg.html',
      send: async (_endpoint, payload) => {
        captured.push(payload);
        return true;
      },
    });

    const sent = await client.track('deck_imported', { source: 'paste', total_cards: 100 });
    expect(sent).toBe(true);
    expect(captured).toHaveLength(1);
    const payload = captured[0];
    expect(payload.name).toBe('deck_imported');
    expect(payload.app).toBe('mtg');
    expect(payload.page).toBe('/mtg.html');
    expect(payload.eventId.length).toBeGreaterThan(5);
    expect(payload.userId.length).toBeGreaterThan(5);
    expect(payload.sessionId.length).toBeGreaterThan(5);
    expect(payload.properties.source).toBe('paste');
  });

  it('dedupes events with the same dedupe key', async () => {
    const sentIds: string[] = [];
    const client = createAnalyticsClientForTest({
      now: () => 1700000000000,
      send: async (_endpoint, payload) => {
        sentIds.push(payload.eventId);
        return true;
      },
    });

    const first = await client.track('export_clicked', { trigger: 'copy' }, { dedupeKey: 'export:copy', dedupeWindowMs: 2000 });
    const second = await client.track('export_clicked', { trigger: 'copy' }, { dedupeKey: 'export:copy', dedupeWindowMs: 2000 });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(sentIds).toHaveLength(1);
  });

  it('supports feedback_submitted with analysis context', async () => {
    const captured: AnalyticsEventPayload[] = [];
    const client = createAnalyticsClientForTest({
      app: 'mtg',
      now: () => 1700000001000,
      getPagePath: () => '/mtg.html',
      send: async (_endpoint, payload) => {
        captured.push(payload);
        return true;
      },
    });

    const sent = await client.track('feedback_submitted', {
      feedback_text: 'The recommendation panel is great but filter labels are unclear.',
      feedback_category: 'ux',
      analysis_id: 'analysis_test_1',
      analysis_status: 'ok',
      analysis_tool: 'recommendations',
      recommendation_count: 5,
      funnel_step: 'recommendation_viewed',
      has_deck: true,
    });

    expect(sent).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].name).toBe('feedback_submitted');
    expect(captured[0].properties.feedback_category).toBe('ux');
    expect(captured[0].properties.analysis_id).toBe('analysis_test_1');
  });
});
