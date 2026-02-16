import * as LZString from 'lz-string';
import { INPUT_LIMITS } from './security/limits.js';

export const REPORT_CARD_SCHEMA_VERSION = 1;
export const REPORT_CARD_MAX_RECOMMENDATIONS = 5;

export type PublicReportMetaMode = 'local' | 'fnm' | 'commander-pod';
export type PublicReportImpact = 'low' | 'medium' | 'high';
export type PublicReportScoreTier = 'A' | 'B' | 'C' | 'D' | 'E';

export interface PublicReportScore {
  value: number;
  tier: PublicReportScoreTier;
  label: string;
}

export interface PublicReportRecommendation {
  cardName: string;
  reason: string;
  impact: PublicReportImpact;
}

export interface PublicReportCardPayload {
  version: number;
  deckName: string;
  totalCards: number;
  metaMode: PublicReportMetaMode;
  generatedAt: string;
  score: PublicReportScore;
  recommendations: PublicReportRecommendation[];
}

export class InvalidPublicReportLinkError extends Error {
  constructor(message: string = 'Invalid public report link') {
    super(message);
    this.name = 'InvalidPublicReportLinkError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function clampInt(value: number, min: number, max: number): number {
  const normalized = Number.isFinite(value) ? Math.trunc(value) : min;
  return Math.max(min, Math.min(max, normalized));
}

function sanitizeText(raw: unknown, maxLength: number): string {
  return typeof raw === 'string' ? raw.trim().slice(0, maxLength) : '';
}

function normalizeMetaMode(raw: unknown): PublicReportMetaMode {
  if (raw === 'local' || raw === 'fnm' || raw === 'commander-pod') {
    return raw;
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'local' || normalized === 'fnm' || normalized === 'commander-pod') {
      return normalized;
    }
  }
  return 'local';
}

function normalizeImpact(raw: unknown): PublicReportImpact {
  if (raw === 'low' || raw === 'medium' || raw === 'high') {
    return raw;
  }
  if (typeof raw === 'string') {
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
      return normalized;
    }
  }
  return 'medium';
}

function parseScoreTier(raw: unknown): PublicReportScoreTier | null {
  if (raw === 'A' || raw === 'B' || raw === 'C' || raw === 'D' || raw === 'E') {
    return raw;
  }
  if (typeof raw === 'string') {
    const upper = raw.trim().toUpperCase();
    if (upper === 'A' || upper === 'B' || upper === 'C' || upper === 'D' || upper === 'E') {
      return upper;
    }
  }
  return null;
}

function normalizeGeneratedAt(raw: unknown): string {
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return new Date().toISOString();
}

const SCORE_LABEL_BY_TIER: Record<PublicReportScoreTier, string> = {
  A: 'Tournament-ready shell',
  B: 'Strong and cohesive',
  C: 'Playable with clear upgrades',
  D: 'Work in progress',
  E: 'Needs foundational tuning',
};

function normalizeScoreLabel(raw: unknown, tier: PublicReportScoreTier): string {
  const label = sanitizeText(raw, 64);
  return label || SCORE_LABEL_BY_TIER[tier];
}

function sanitizeRecommendation(raw: unknown): PublicReportRecommendation | null {
  if (!isObject(raw)) return null;

  const cardName = sanitizeText(raw.cardName, 140);
  if (!cardName) return null;

  const reason = sanitizeText(raw.reason, 260)
    || 'Directional upgrade for this deck profile.';

  return {
    cardName,
    reason,
    impact: normalizeImpact(raw.impact),
  };
}

function base64ToBase64url(base64: string): string {
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlToBase64(base64url: string): string {
  let base64 = base64url
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const pad = base64.length % 4;
  if (pad) {
    base64 += '='.repeat(4 - pad);
  }
  return base64;
}

export function gradePublicReportScore(score: number): PublicReportScoreTier {
  const value = clampInt(score, 0, 100);
  if (value >= 88) return 'A';
  if (value >= 74) return 'B';
  if (value >= 60) return 'C';
  if (value >= 45) return 'D';
  return 'E';
}

export function sanitizePublicReportCardInput(raw: unknown): PublicReportCardPayload | null {
  if (!isObject(raw)) return null;

  const versionRaw = raw.version;
  if (versionRaw !== undefined && versionRaw !== null) {
    const parsedVersion = Number(versionRaw);
    if (!Number.isFinite(parsedVersion) || Math.trunc(parsedVersion) !== REPORT_CARD_SCHEMA_VERSION) {
      return null;
    }
  }

  const deckName = sanitizeText(raw.deckName, 100);
  if (!deckName) return null;

  const totalCardsRaw = Number(raw.totalCards);
  if (!Number.isFinite(totalCardsRaw)) return null;
  const totalCards = clampInt(totalCardsRaw, 1, 1000);

  const scoreRaw = isObject(raw.score) ? raw.score : null;
  if (!scoreRaw) return null;

  const scoreValueRaw = Number(scoreRaw.value);
  if (!Number.isFinite(scoreValueRaw)) return null;
  const scoreValue = clampInt(scoreValueRaw, 0, 100);
  const scoreTier = parseScoreTier(scoreRaw.tier) || gradePublicReportScore(scoreValue);
  const scoreLabel = normalizeScoreLabel(scoreRaw.label, scoreTier);

  const rawRecommendations = Array.isArray(raw.recommendations) ? raw.recommendations : [];
  const recommendations = rawRecommendations
    .map((entry) => sanitizeRecommendation(entry))
    .filter((entry): entry is PublicReportRecommendation => Boolean(entry))
    .slice(0, REPORT_CARD_MAX_RECOMMENDATIONS);

  return {
    version: REPORT_CARD_SCHEMA_VERSION,
    deckName,
    totalCards,
    metaMode: normalizeMetaMode(raw.metaMode),
    generatedAt: normalizeGeneratedAt(raw.generatedAt),
    score: {
      value: scoreValue,
      tier: scoreTier,
      label: scoreLabel,
    },
    recommendations,
  };
}

export function encodePublicReportToken(report: PublicReportCardPayload): string {
  const sanitized = sanitizePublicReportCardInput(report);
  if (!sanitized) {
    throw new InvalidPublicReportLinkError('Invalid report payload');
  }

  const json = JSON.stringify(sanitized);
  const compressed = LZString.compressToBase64(json);
  if (!compressed) {
    throw new InvalidPublicReportLinkError('Failed to encode report payload');
  }

  const token = base64ToBase64url(compressed);
  if (!token || token.length > INPUT_LIMITS.SHARE_URL_MAX_LENGTH) {
    throw new InvalidPublicReportLinkError('Report token too large');
  }

  return token;
}

export function decodePublicReportToken(token: string): PublicReportCardPayload {
  if (!token || typeof token !== 'string') {
    throw new InvalidPublicReportLinkError('Missing report token');
  }

  if (token.length > INPUT_LIMITS.SHARE_URL_MAX_LENGTH) {
    throw new InvalidPublicReportLinkError('Report token too large');
  }

  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new InvalidPublicReportLinkError('Invalid report token format');
  }

  let json = '';
  try {
    json = LZString.decompressFromBase64(base64urlToBase64(token)) || '';
  } catch {
    throw new InvalidPublicReportLinkError('Could not decode report token');
  }

  if (!json) {
    throw new InvalidPublicReportLinkError('Could not decode report token');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new InvalidPublicReportLinkError('Invalid report payload');
  }

  const sanitized = sanitizePublicReportCardInput(parsed);
  if (!sanitized) {
    throw new InvalidPublicReportLinkError('Invalid report payload');
  }

  return sanitized;
}

export function buildPublicReportUrl(token: string, game: 'mtg' | 'ygo' = 'mtg', origin?: string): string {
  const safeToken = token.trim();
  const safeOrigin = origin
    || (typeof window !== 'undefined' ? window.location.origin : 'https://decklens.app');
  const page = game === 'ygo' ? 'yugioh.html' : 'mtg.html';
  return `${safeOrigin}/${page}?report=${safeToken}`;
}
