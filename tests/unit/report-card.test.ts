import { describe, expect, it } from 'vitest';
import {
  buildPublicReportUrl,
  decodePublicReportToken,
  encodePublicReportToken,
  gradePublicReportScore,
  InvalidPublicReportLinkError,
  sanitizePublicReportCardInput,
  type PublicReportCardPayload,
} from '../../src/shared/report-card.js';

function createValidReport(): PublicReportCardPayload {
  return {
    version: 1,
    deckName: 'Azorius Control',
    totalCards: 100,
    metaMode: 'fnm',
    generatedAt: '2026-02-09T12:00:00.000Z',
    score: {
      value: 83,
      tier: 'B',
      label: 'Strong and cohesive',
    },
    recommendations: [
      {
        cardName: 'Swords to Plowshares',
        reason: 'Improves cheap interaction density.',
        impact: 'high',
      },
      {
        cardName: 'Arcane Signet',
        reason: 'Smooths curve and color access.',
        impact: 'medium',
      },
    ],
  };
}

describe('report card token helpers', () => {
  it('round-trips a valid report payload', () => {
    const original = createValidReport();
    const token = encodePublicReportToken(original);
    const decoded = decodePublicReportToken(token);

    expect(decoded.deckName).toBe(original.deckName);
    expect(decoded.totalCards).toBe(original.totalCards);
    expect(decoded.metaMode).toBe(original.metaMode);
    expect(decoded.recommendations).toHaveLength(2);
    expect(decoded.score.value).toBe(83);
  });

  it('rejects malformed tokens', () => {
    expect(() => decodePublicReportToken('invalid!token')).toThrow(InvalidPublicReportLinkError);
  });
});

describe('report card sanitization', () => {
  it('filters private fields from payload and recommendations', () => {
    const raw = {
      ...createValidReport(),
      privateNotes: 'do not share',
      collection: { 'sol ring': 2 },
      recommendations: [
        {
          cardName: 'Sol Ring',
          reason: 'Fast mana for early tempo.',
          impact: 'high',
          ownedCount: 0,
          collectionId: 'oracle:123',
        },
      ],
    } as unknown;

    const sanitized = sanitizePublicReportCardInput(raw);
    expect(sanitized).not.toBeNull();

    const report = sanitized as PublicReportCardPayload;
    expect((report as unknown as Record<string, unknown>).privateNotes).toBeUndefined();
    expect((report as unknown as Record<string, unknown>).collection).toBeUndefined();

    const rec = report.recommendations[0] as unknown as Record<string, unknown>;
    expect(Object.keys(rec).sort()).toEqual(['cardName', 'impact', 'reason']);
    expect(rec.ownedCount).toBeUndefined();
    expect(rec.collectionId).toBeUndefined();
  });

  it('returns null for incomplete report payloads', () => {
    expect(sanitizePublicReportCardInput({ deckName: 'Missing score' })).toBeNull();
  });
});

describe('report score helpers', () => {
  it('grades score tiers consistently', () => {
    expect(gradePublicReportScore(92)).toBe('A');
    expect(gradePublicReportScore(78)).toBe('B');
    expect(gradePublicReportScore(61)).toBe('C');
    expect(gradePublicReportScore(48)).toBe('D');
    expect(gradePublicReportScore(22)).toBe('E');
  });

  it('builds public report URL with report parameter', () => {
    const url = buildPublicReportUrl('abc123', 'mtg', 'https://decklens.test');
    expect(url).toBe('https://decklens.test/mtg.html?report=abc123');
  });
});
