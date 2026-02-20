/// <reference lib="webworker" />

import {
  generateRecommendationEngineV1,
  recommendationCandidateNames,
  type MetaMode,
  type RecommendationCardMetrics,
} from '../../src/mtg/engine/recommendation-v1.js';
import {
  decodePublicReportToken,
  encodePublicReportToken,
  sanitizePublicReportCardInput,
} from '../../src/shared/report-card.js';
import { getEDHRECClient } from './edhrec-client.js';
import { CollabSession } from './collab-session.js';
import { GameSession } from './game-session.js';
import {
  type ComboRecord,
  type ComboLookupResult,
  type ComboStats,
  norm as comboNorm,
  parseComboRow,
  upsertComboBatch,
  rebuildInvertedIndex,
  lookupCombosByCards,
  batchFetchCombos,
  seedCatalogCombos,
  getSyncMeta,
  setSyncMeta,
  getComboStats,
} from './combo-db.js';
import {
  type TemplateMatch,
  type CardInfo,
  getBuiltinTemplates,
  matchTemplates,
  seedTemplates,
  loadTemplates,
} from './combo-templates.js';
import {
  handleGitHubRedirect,
  handleGitHubCallback,
  handleGoogleRedirect,
  handleGoogleCallback,
  handleAuthMe,
  handleAuthLogout,
  authenticateRequest,
} from './auth.js';
import { handleDeckGitRoute } from './deck-git/router.js';
import { CommitService, BranchService, HealthService, WebhookService } from './deck-git/index.js';
import { generateId } from './deck-git/types.js';
import {
  refreshCommanderStats,
  getCommanderStats,
  getTopCommanders,
} from './commander-stats.js';
import {
  scrapeTopCommanders,
  seedCommanderStatsFromEDHREC,
} from './edhrec-scraper.js';
import {
  seedCommanderStatsFromScryfall,
} from './scryfall-commanders.js';
import {
  fetchTopCommandersFromEDHREC,
  seedCommanderStatsFromEDHRECJSON,
} from './edhrec-json-api.js';

export { CollabSession };

/**
 * DeckLens API Proxy — Cloudflare Worker
 * 
 * Proxies requests to Moxfield and Archidekt APIs to bypass CORS restrictions.
 * Deploy: npx wrangler deploy
 * 
 * Routes:
 *   /api/deck/moxfield/:deckId  → Moxfield v3 API
 *   /api/deck/archidekt/:deckId → Archidekt API
 *   /api/recommendations/mtg    → Recommendation Engine v1
 */

const ALLOWED_ORIGINS = [
  'https://decklens.chrisgarkisch.workers.dev',
  'https://decklens.app',
  'https://www.decklens.app',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
];

function getCorsHeaders(request?: Request): Record<string, string> {
  const origin = request?.headers.get('Origin') || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Cookie, Authorization, X-Device-Fingerprint, X-Device-Id',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age': '86400',
  };
}

// Current request origin — set at the start of each fetch() call
let _currentRequestOrigin = 'https://decklens.chrisgarkisch.workers.dev';

// CORS_HEADERS is a Proxy that dynamically returns the correct origin for the current request
const CORS_HEADERS: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_target, prop: string) {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': _currentRequestOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Cookie, Authorization, X-Device-Fingerprint, X-Device-Id',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    };
    return headers[prop];
  },
  ownKeys() {
    return ['Access-Control-Allow-Origin', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Credentials', 'Access-Control-Max-Age'];
  },
  getOwnPropertyDescriptor(_target, prop: string) {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Origin': _currentRequestOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Cookie, Authorization, X-Device-Fingerprint, X-Device-Id',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Max-Age': '86400',
    };
    if (prop in headers) {
      return { value: headers[prop], writable: true, enumerable: true, configurable: true };
    }
    return undefined;
  },
});

type AnalyticsEventName =
  | 'deck_imported'
  | 'collection_imported'
  | 'analysis_started'
  | 'analysis_completed'
  | 'recommendation_viewed'
  | 'recommendation_applied'
  | 'export_clicked'
  | 'report_shared'
  | 'feedback_submitted'
  // Enhanced business events
  | 'user_signup'
  | 'subscription_started'
  | 'subscription_cancelled'
  | 'payment_completed'
  | 'dashboard_viewed'
  | 'feature_used'
  | 'api_call_made';

interface AnalyticsEventPayload {
  name: AnalyticsEventName;
  eventId: string;
  occurredAt: string;
  app: string;
  page: string;
  userId: string;
  sessionId: string;
  properties: Record<string, unknown>;
}

interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    indexes?: string[];
    blobs?: string[];
    doubles?: number[];
  }): void;
}

interface Env {
  ANALYTICS_WEBHOOK_URL?: string;
  ANALYTICS_WEBHOOK_TOKEN?: string;
  ALERT_WEBHOOK_URL?: string;
  ALERT_WEBHOOK_TOKEN?: string;
  COMMUNITY_KV?: WorkerKVNamespace;
  CACHE_KV?: WorkerKVNamespace;
  COMMUNITY_DB?: WorkerD1Database;
  ANALYTICS?: AnalyticsEngineDataset;
  COLLAB_SESSION?: DurableObjectNamespace;
  GAME_SESSION?: DurableObjectNamespace;
  // Auth (GitHub + Google OAuth)
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  FRONTEND_URL?: string;
  // Combo system admin
  ADMIN_SECRET?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request | string, init?: RequestInit): Promise<Response>;
}

// Module-level KV reference for persistent cache (set per-request in fetch())
let kvCache: WorkerKVNamespace | null = null;
const KV_SCRYFALL_TTL = 86400;   // 24h in seconds
const KV_SPELLBOOK_TTL = 3600;   // 1h in seconds

interface WorkerKVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface WorkerD1PreparedStatement {
  bind(...values: unknown[]): WorkerD1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: Record<string, unknown> }>;
}

interface WorkerD1Database {
  prepare(query: string): WorkerD1PreparedStatement;
}

interface CommunityDeckPayload {
  name: string;
  format: 'commander' | 'cedh';
  commander: string;
  archetype: string;
  decklist: string;
  notes?: string;
  authorDisplayName?: string;
}

interface CommunityDeckRecord extends CommunityDeckPayload {
  id: string;
  createdAt: string;
  upvotes: number;
  views: number;
  tags: string[];
}

interface AbuseFlagRecord {
  id: string;
  deckId: string;
  reason: string;
  reportedAt: string;
  reporterIpHash: string;
}

type DeckbuilderShareVisibility = 'public' | 'unlisted';

interface DeckbuilderShareCardEntry {
  name: string;
  qty: number;
  set?: string | null;
  collectorNumber?: string | null;
  tags?: string[];
}

interface DeckbuilderShareDeckPayload {
  name: string;
  boards: {
    commander: DeckbuilderShareCardEntry[];
    mainboard: DeckbuilderShareCardEntry[];
    sideboard: DeckbuilderShareCardEntry[];
    maybeboard: DeckbuilderShareCardEntry[];
  };
}

interface DeckbuilderSnapshotSummary {
  slug: string;
  name: string;
  visibility: DeckbuilderShareVisibility;
  createdAt: string;
  commanderLine: string;
  cardCount: number;
}

interface DeckbuilderSnapshotRecord {
  id: string;
  slug: string;
  visibility: DeckbuilderShareVisibility;
  createdAt: string;
  deck: DeckbuilderShareDeckPayload;
  summary: DeckbuilderSnapshotSummary;
}

interface ScryfallSearchCard {
  id: string;
  oracle_id?: string;
  name: string;
  mana_cost?: string;
  cmc: number;
  type_line: string;
  oracle_text?: string;
  keywords?: string[];
  color_identity?: string[];
  legalities?: Record<string, string>;
  set?: string;
  collector_number?: string;
  prices?: Record<string, string | null>;
  image_uris?: {
    small?: string;
    normal?: string;
  };
  rarity?: string;
  power?: string;
  toughness?: string;
  edhrec_rank?: number;
  produced_mana?: string[];
}

interface MetaRealtimeSnapshot {
  updatedAt: string;
  source: 'derived-analytics';
  activeSessions: number;
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
  quality: {
    degraded: boolean;
    fallbackMode: 'live' | 'partial-fallback' | 'snapshot-fallback';
    label: string;
    reasons: string[];
  };
  freshness: {
    ageMinutes: number;
    state: 'fresh' | 'aging' | 'stale';
  };
  archetypes: Array<{
    name: string;
    share: number;
    trend: 'up' | 'down' | 'flat';
  }>;
  trendingCards: Array<{
    name: string;
    delta: number;
  }>;
}

interface DeckEntryPayload {
  name: string;
  qty: number;
}

interface DeckPayload {
  main: DeckEntryPayload[];
  sideboard: DeckEntryPayload[];
  commander: DeckEntryPayload[];
}

interface RecommendationRequestPayload {
  deck: DeckPayload;
  collection?: Record<string, number>;
  metaMode?: MetaMode;
  maxRecommendations?: number;
}

interface ScryfallCollectionResponse {
  data?: Array<{
    name: string;
    mana_cost?: string;
    cmc?: number;
    type_line?: string;
    oracle_text?: string;
    color_identity?: string[];
    prices?: {
      eur?: string | null;
      usd?: string | null;
    };
  }>;
}

interface RecommendationRequestDiagnostics {
  resolvedCardMetrics: number;
  totalRequestedCardMetrics: number;
  cacheHits: number;
  cacheMisses: number;
  fetchedFromUpstream: number;
  retries: number;
  upstreamFailures: number;
  timeoutFailures: number;
  degraded: boolean;
  warnings: string[];
}

interface CardMetricFetchResult {
  lookup: Record<string, RecommendationCardMetrics>;
  diagnostics: RecommendationRequestDiagnostics;
}

interface CachedCardMetricEntry {
  metrics: RecommendationCardMetrics;
  expiresAt: number;
  source: 'scryfall' | 'fallback';
}

class RecommendationRequestError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown> | null;

  constructor(message: string, code: string, status: number, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'RecommendationRequestError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

class RecommendationValidationError extends RecommendationRequestError {
  constructor(message: string, details: Record<string, unknown> | null = null) {
    super(message, 'recommendation_validation_error', 400, details);
    this.name = 'RecommendationValidationError';
  }
}

class RecommendationInternalError extends RecommendationRequestError {
  constructor(message: string, details: Record<string, unknown> | null = null) {
    super(message, 'recommendation_internal_error', 500, details);
    this.name = 'RecommendationInternalError';
  }
}

const RECOMMENDATION_ANALYSIS_TIMEOUT_MS = 55_000;
const SCRYFALL_CHUNK_SIZE = 75;
const SCRYFALL_FETCH_TIMEOUT_MS = 9_000;
const SCRYFALL_RETRY_ATTEMPTS = 2;
const SCRYFALL_RETRY_BACKOFF_BASE_MS = 200;
const SCRYFALL_FETCH_CONCURRENCY = 4;
const CARD_METRICS_CACHE_TTL_MS = 1000 * 60 * 30;
const CARD_METRICS_CACHE_MAX_ENTRIES = 12_000;

const recommendationCardMetricsCache = new Map<string, CachedCardMetricEntry>();

const ANALYTICS_EVENT_NAMES: AnalyticsEventName[] = [
  'deck_imported',
  'collection_imported',
  'analysis_started',
  'analysis_completed',
  'recommendation_viewed',
  'recommendation_applied',
  'export_clicked',
  'report_shared',
  'feedback_submitted',
  // Enhanced business events
  'user_signup',
  'subscription_started',
  'subscription_cancelled',
  'payment_completed',
  'dashboard_viewed',
  'feature_used',
  'api_call_made',
];

const analyticsEventSet = new Set<string>(ANALYTICS_EVENT_NAMES);
const analyticsCounters = new Map<AnalyticsEventName, number>();
let lastAnalyticsEventAt: number | null = null;

interface StoredAnalyticsEvent extends AnalyticsEventPayload {
  receivedAt: string;
  occurredAtMs: number;
}

interface DashboardFunnelStepRow {
  name: AnalyticsEventName;
  sessions: number;
  conversionFromPrevious: number | null;
  conversionFromStart: number | null;
}

interface DashboardFeedbackRow {
  occurredAt: string;
  category: string;
  message: string;
  sessionRef: string;
  userRef: string;
  analysisId: string | null;
  analysisStatus: string | null;
  recommendationCount: number | null;
  funnelStep: string | null;
}

const FUNNEL_STEPS: AnalyticsEventName[] = [
  'deck_imported',
  'collection_imported',
  'analysis_started',
  'analysis_completed',
  'recommendation_viewed',
  'recommendation_applied',
  'export_clicked',
  'report_shared',
];

const ACTION_EVENTS_AFTER_IMPORT = new Set<AnalyticsEventName>([
  'collection_imported',
  'analysis_started',
  'analysis_completed',
  'recommendation_viewed',
  'recommendation_applied',
  'export_clicked',
  'report_shared',
  'dashboard_viewed',
  'feature_used',
]);

const FEEDBACK_CATEGORIES = new Set(['bug', 'ux', 'feature', 'performance', 'other']);
const ANALYTICS_EVENT_LOG_MAX = 12_000;
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const analyticsEventLog: StoredAnalyticsEvent[] = [];

// Enhanced KPI Tracking
interface BusinessMetrics {
  revenue: {
    today: number;
    mtd: number;
    growthRate: number;
  };
  users: {
    total: number;
    active: number;
    paying: number;
    churnRate: number;
  };
  product: {
    activationRate: number;
    retention7d: number;
    arpu: number;
    ltv: number;
  };
}

interface GrowthMetrics {
  funnel: {
    importToAnalysis: number;
    analysisToApply: number;
    applyToExport: number;
    overallConversion: number;
  };
  retention: {
    day1: number;
    day7: number;
    day30: number;
    cohortAnalysis: CohortData[];
  };
  engagement: {
    recommendationsPerSession: number;
    sessionDuration: number;
    repeatUsageRate: number;
  };
}

interface TechnicalMetrics {
  performance: {
    apiLatencyP50: number;
    apiLatencyP95: number;
    errorRate: number;
    uptime: number;
  };
  infrastructure: {
    activeWorkers: number;
    memoryUsage: number;
    dbConnections: number;
    cacheHitRate: number;
  };
  quality: {
    recommendationAccuracy: number;
    systemHealth: 'healthy' | 'degraded' | 'critical';
    alertCount: number;
  };
}

interface CohortData {
  cohort: string;
  day1: number;
  day7: number;
  day30: number;
  size: number;
}

interface RealtimeKPIUpdate {
  timestamp: string;
  activeSessions: number;
  currentFunnelStep: Record<string, number>;
  apiLatencyMs: number;
  errorRatePercent: number;
  conversionRate24h: number;
  revenueToday: number;
}

// In-memory KPI stores (would use D1 in production)
const businessMetricsHistory: BusinessMetrics[] = [];
const growthMetricsHistory: GrowthMetrics[] = [];
const technicalMetricsHistory: TechnicalMetrics[] = [];
const realtimeKPICache = new Map<string, any>();

const COMMUNITY_DECKS_KEY = 'community:decks:v1';
const REALTIME_META_KEY = 'meta:realtime:v1';
const COMMUNITY_MAX_ITEMS = 300;
const ABUSE_FLAGS_KEY = 'community:abuse-flags:v1';
const DECKBUILDER_SNAPSHOTS_KEY = 'deckbuilder:snapshots:v1';
const DECKBUILDER_MAX_SNAPSHOTS = 500;

const SCRYFALL_QUERY_CACHE_TTL_MS = 1000 * 60 * 20;
const SCRYFALL_QUERY_CACHE_MAX_ENTRIES = 500;

const BLOCKED_TERMS = [
  'spam',
  'scam',
  'buy followers',
  'crypto giveaway',
  'http://',
  'https://bit.ly',
];

const communityDecks: CommunityDeckRecord[] = [];
const abuseFlagsMemory: AbuseFlagRecord[] = [];
const deckbuilderSnapshotsMemory: DeckbuilderSnapshotRecord[] = [];
const scryfallQueryCache = new Map<string, { expiresAt: number; payload: unknown }>();
const SPELLBOOK_CACHE_TTL_MS = 1000 * 60 * 30;
const SPELLBOOK_CACHE_MAX = 200;
const spellbookCache = new Map<string, { expiresAt: number; payload: unknown }>();
let realtimeMetaSnapshot: MetaRealtimeSnapshot = {
  updatedAt: new Date().toISOString(),
  source: 'derived-analytics',
  activeSessions: 0,
  confidence: {
    score: 0.42,
    band: 'low',
    components: {
      sessionSignal: 0,
      eventVolume: 0,
      communityCoverage: 0,
      archetypeDiversity: 0.35,
    },
  },
  quality: {
    degraded: true,
    fallbackMode: 'snapshot-fallback',
    label: 'Degraded fallback',
    reasons: ['bootstrap_snapshot'],
  },
  freshness: {
    ageMinutes: 0,
    state: 'fresh',
  },
  archetypes: [
    { name: 'Storm', share: 0.2, trend: 'up' },
    { name: 'Reanimator', share: 0.16, trend: 'up' },
    { name: 'Lifegain', share: 0.14, trend: 'flat' },
    { name: 'Tokens', share: 0.13, trend: 'flat' },
    { name: 'Stax', share: 0.11, trend: 'down' },
  ],
  trendingCards: [
    { name: 'Underworld Breach', delta: 8 },
    { name: 'Rest in Peace', delta: 5 },
    { name: 'The One Ring', delta: 4 },
  ],
};

// Rate limit: simple in-memory counter (resets per Worker instance)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 180; // requests per minute per IP
const RATE_WINDOW = 60_000; // 1 minute
const COMMUNITY_SUBMIT_COOLDOWN_MS = 60_000; // 1 minute per IP fingerprint
const duplicateDeckWindowMs = 10 * 60 * 1000;

const communitySubmissionMap = new Map<string, number>();
const communityFingerprintMap = new Map<string, number>();
const communityVoteMap = new Map<string, number>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT;
}

// Validate deck ID format to prevent injection
function isValidMoxfieldId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{10,30}$/.test(id);
}

function isValidArchidektId(id: string): boolean {
  return /^\d{1,10}$/.test(id);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hashLike(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `h_${(h >>> 0).toString(16)}`;
}

function containsBlockedContent(payload: CommunityDeckPayload): string | null {
  const corpus = `${payload.name}\n${payload.commander}\n${payload.archetype}\n${payload.notes || ''}\n${payload.decklist}`.toLowerCase();
  const hit = BLOCKED_TERMS.find((term) => corpus.includes(term));
  return hit || null;
}

function deckFingerprint(payload: CommunityDeckPayload): string {
  return hashLike(`${payload.commander}|${payload.archetype}|${payload.decklist.toLowerCase().replace(/\s+/g, ' ')}`);
}

function isCommunitySubmissionRateLimited(ip: string, payload: CommunityDeckPayload): { limited: boolean; reason?: string } {
  const now = Date.now();
  const ipKey = `ip:${hashLike(ip)}`;
  const nextAllowedAt = communitySubmissionMap.get(ipKey) || 0;
  if (now < nextAllowedAt) {
    return { limited: true, reason: 'Please wait before posting another deck.' };
  }

  const fp = deckFingerprint(payload);
  const seenAt = communityFingerprintMap.get(fp) || 0;
  if (now - seenAt < duplicateDeckWindowMs) {
    return { limited: true, reason: 'Similar deck was posted recently. Try later.' };
  }

  communitySubmissionMap.set(ipKey, now + COMMUNITY_SUBMIT_COOLDOWN_MS);
  communityFingerprintMap.set(fp, now);
  return { limited: false };
}

async function sendAlert(env: Env, title: string, details: Record<string, unknown>): Promise<void> {
  if (!env.ALERT_WEBHOOK_URL) return;
  try {
    await fetch(env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.ALERT_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.ALERT_WEBHOOK_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        title,
        details,
        at: new Date().toISOString(),
        service: 'decklens-api',
      }),
    });
  } catch {
    // best effort alerting
  }
}

let communityDbReady = false;

async function ensureCommunityDbSchema(env: Env): Promise<void> {
  if (!env.COMMUNITY_DB || communityDbReady) return;

  // Tables first (parallel)
  await Promise.all([
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS community_decks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        format TEXT NOT NULL,
        commander TEXT NOT NULL,
        archetype TEXT NOT NULL,
        decklist TEXT NOT NULL,
        notes TEXT,
        author_display_name TEXT NOT NULL DEFAULT 'Anonymous',
        created_at TEXT NOT NULL,
        upvotes INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        tags_json TEXT NOT NULL
      )
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS community_abuse_flags (
        id TEXT PRIMARY KEY,
        deck_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        reporter_ip_hash TEXT NOT NULL,
        reported_at TEXT NOT NULL
      )
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS community_votes (
        deck_id TEXT NOT NULL,
        voter_ip_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(deck_id, voter_ip_hash)
      )
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS deckbuilder_snapshots (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        visibility TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        summary_json TEXT NOT NULL
      )
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS user_decks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        format TEXT,
        boards_json TEXT NOT NULL,
        description TEXT,
        updated_at TEXT NOT NULL,
        fingerprint TEXT,
        is_public INTEGER NOT NULL DEFAULT 0
      )
    `).run(),
    // ── Combo System Tables ──
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS combos (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        cards_json TEXT NOT NULL,
        cards_count INTEGER NOT NULL,
        optional_cards_json TEXT,
        requires_json TEXT,
        description TEXT NOT NULL,
        produces_json TEXT,
        result_tags_json TEXT,
        color_identity TEXT,
        spellbook_url TEXT,
        of_id TEXT,
        popularity INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS combo_card_index (
        card_name_norm TEXT NOT NULL,
        combo_id TEXT NOT NULL,
        oracle_id TEXT,
        canonical_name TEXT,
        is_required INTEGER NOT NULL DEFAULT 1,
        combo_cards_count INTEGER NOT NULL DEFAULT 2,
        PRIMARY KEY (card_name_norm, combo_id)
      )
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS card_oracle_map (
        card_name_norm TEXT PRIMARY KEY,
        oracle_id TEXT NOT NULL,
        canonical_name TEXT NOT NULL
      )
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS combo_sync_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS combo_suggestions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending',
        suggested_by_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        cards_json TEXT NOT NULL,
        description TEXT NOT NULL,
        prerequisites TEXT,
        produces_json TEXT,
        result_tags_json TEXT,
        color_identity TEXT,
        review_notes TEXT,
        reviewed_at TEXT,
        suggested_at TEXT NOT NULL
      )
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE TABLE IF NOT EXISTS combo_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        anchor_cards_json TEXT NOT NULL,
        slot_requirements_json TEXT NOT NULL,
        result_tags_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `).run(),
  ]);

  // Indexes (parallel, tables must exist first)
  await Promise.all([
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_deckbuilder_snapshots_created_at
        ON deckbuilder_snapshots(created_at DESC)
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_deckbuilder_snapshots_visibility
        ON deckbuilder_snapshots(visibility)
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_user_decks_fingerprint ON user_decks(fingerprint)
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_user_decks_public ON user_decks(is_public, updated_at DESC)
    `).run(),
    // ── Combo System Indexes ──
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_cci_card ON combo_card_index(card_name_norm)
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_cci_combo ON combo_card_index(combo_id)
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_cci_oracle ON combo_card_index(oracle_id)
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_combos_source ON combos(source)
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_com_oracle ON card_oracle_map(oracle_id)
    `).run(),
    env.COMMUNITY_DB.prepare(`
      CREATE INDEX IF NOT EXISTS idx_suggestions_status ON combo_suggestions(status)
    `).run(),
  ]);

  // ALTER TABLE migrations (may fail if column already exists)
  try {
    await env.COMMUNITY_DB.prepare(`
      ALTER TABLE community_decks ADD COLUMN author_display_name TEXT NOT NULL DEFAULT 'Anonymous'
    `).run();
  } catch { /* Column already exists */ }

  // Auth: add google_id and auth_provider columns to users table
  try {
    await env.COMMUNITY_DB.prepare(`ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE`).run();
  } catch { /* Column already exists */ }
  try {
    await env.COMMUNITY_DB.prepare(`ALTER TABLE users ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'github'`).run();
  } catch { /* Column already exists */ }
  // Make github_id nullable for Google-only users
  // (SQLite doesn't support ALTER COLUMN, so we handle it in code by allowing 0 as sentinel)

  communityDbReady = true;
}

function isSuccessfulAnalysisCompleted(event: Pick<AnalyticsEventPayload, 'name' | 'properties'>): boolean {
  if (event.name !== 'analysis_completed') return false;
  return event.properties.status === 'ok';
}

function isFunnelQualifiedEvent(event: Pick<AnalyticsEventPayload, 'name' | 'properties'>, step: AnalyticsEventName): boolean {
  if (event.name !== step) return false;
  if (step === 'analysis_completed') {
    return isSuccessfulAnalysisCompleted(event);
  }
  return true;
}

function toNumberOrNull(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function toStringOrNull(value: unknown, maxLength = 120): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function maskId(value: string): string {
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function percentileFromSorted(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0];
  const clamped = Math.max(0, Math.min(1, percentile));
  const index = clamped * (values.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  const lowerValue = values[lower] ?? values[0];
  const upperValue = values[upper] ?? values[values.length - 1];
  return Math.round((lowerValue * (1 - weight)) + (upperValue * weight));
}

function parseDashboardDays(requestUrl: string): number {
  const url = new URL(requestUrl);
  const raw = url.searchParams.get('days');
  if (!raw) return 7;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 7;
  return Math.max(1, Math.min(30, Math.trunc(parsed)));
}

function pushAnalyticsEventLog(event: StoredAnalyticsEvent): void {
  analyticsEventLog.push(event);
  if (analyticsEventLog.length > ANALYTICS_EVENT_LOG_MAX) {
    analyticsEventLog.splice(0, analyticsEventLog.length - ANALYTICS_EVENT_LOG_MAX);
  }
}

function validateFeedbackProperties(properties: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  const feedbackText = typeof properties.feedback_text === 'string'
    ? properties.feedback_text.trim()
    : '';

  if (!feedbackText || feedbackText.length < 2 || feedbackText.length > 500) {
    return { ok: false, error: 'feedback_text must be 2-500 characters.' };
  }

  properties.feedback_text = feedbackText;

  if (properties.feedback_category !== undefined && properties.feedback_category !== null) {
    if (typeof properties.feedback_category !== 'string') {
      return { ok: false, error: 'feedback_category must be a string when provided.' };
    }
    const category = properties.feedback_category.trim().toLowerCase();
    if (!FEEDBACK_CATEGORIES.has(category)) {
      return { ok: false, error: 'feedback_category must be one of bug, ux, feature, performance, other.' };
    }
    properties.feedback_category = category;
  }

  const optionalShortStringKeys = ['analysis_id', 'analysis_status', 'analysis_tool', 'funnel_step', 'context_page'];
  for (const key of optionalShortStringKeys) {
    if (properties[key] === undefined || properties[key] === null) continue;
    if (typeof properties[key] !== 'string') {
      return { ok: false, error: `${key} must be a string when provided.` };
    }
    const trimmed = properties[key].trim();
    if (trimmed.length > 120) {
      return { ok: false, error: `${key} must be <= 120 characters.` };
    }
    properties[key] = trimmed;
  }

  if (properties.recommendation_count !== undefined && properties.recommendation_count !== null) {
    const numeric = Number(properties.recommendation_count);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 999) {
      return { ok: false, error: 'recommendation_count must be between 0 and 999.' };
    }
    properties.recommendation_count = Math.trunc(numeric);
  }

  if (properties.has_deck !== undefined && properties.has_deck !== null && typeof properties.has_deck !== 'boolean') {
    return { ok: false, error: 'has_deck must be boolean when provided.' };
  }

  return { ok: true };
}

function buildAnalyticsDashboard(days: number): Record<string, unknown> {
  const nowMs = Date.now();
  const fromMs = nowMs - (days * 24 * 60 * 60 * 1000);

  const eventsInWindow = analyticsEventLog
    .filter((event) => event.occurredAtMs >= fromMs && event.occurredAtMs <= nowMs)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs);

  const sessionEvents = new Map<string, StoredAnalyticsEvent[]>();
  for (const event of eventsInWindow) {
    const bucket = sessionEvents.get(event.sessionId);
    if (bucket) bucket.push(event);
    else sessionEvents.set(event.sessionId, [event]);
  }

  const funnelCounts = new Map<AnalyticsEventName, number>();
  for (const step of FUNNEL_STEPS) funnelCounts.set(step, 0);

  const activationDurationsMs: number[] = [];
  let actionRateNumerator = 0;
  let actionRateDenominator = 0;

  for (const events of sessionEvents.values()) {
    const deckImport = events.find((event) => event.name === 'deck_imported');
    if (!deckImport) continue;

    let previousStepAt = -Infinity;
    for (const step of FUNNEL_STEPS) {
      const stepEvent = events.find((event) => event.occurredAtMs >= previousStepAt && isFunnelQualifiedEvent(event, step));
      if (!stepEvent) break;
      funnelCounts.set(step, (funnelCounts.get(step) || 0) + 1);
      previousStepAt = stepEvent.occurredAtMs;
    }

    const firstActionAfterImport = events.find((event) => {
      if (event.occurredAtMs < deckImport.occurredAtMs) return false;
      if (!ACTION_EVENTS_AFTER_IMPORT.has(event.name)) return false;
      if (event.name === 'analysis_completed' && !isSuccessfulAnalysisCompleted(event)) return false;
      return true;
    });

    if (firstActionAfterImport) {
      activationDurationsMs.push(Math.max(0, firstActionAfterImport.occurredAtMs - deckImport.occurredAtMs));
    }

    const analysisDoneAt = events.find((event) => isSuccessfulAnalysisCompleted(event))?.occurredAtMs;
    if (analysisDoneAt !== undefined) {
      actionRateDenominator += 1;
      const appliedAfter = events.some((event) => event.name === 'recommendation_applied' && event.occurredAtMs >= analysisDoneAt);
      if (appliedAfter) actionRateNumerator += 1;
    }
  }

  const userToSessionStarts = new Map<string, number[]>();
  for (const events of sessionEvents.values()) {
    const firstActivity = events.find((event) => event.name !== 'feedback_submitted');
    if (!firstActivity) continue;
    const firstAt = events[0]?.occurredAtMs ?? firstActivity.occurredAtMs;
    const times = userToSessionStarts.get(firstActivity.userId) || [];
    times.push(firstAt);
    userToSessionStarts.set(firstActivity.userId, times);
  }

  let returningUsers = 0;
  for (const startTimes of userToSessionStarts.values()) {
    if (startTimes.length < 2) continue;
    startTimes.sort((a, b) => a - b);
    let isReturning = false;
    for (let i = 1; i < startTimes.length; i += 1) {
      if ((startTimes[i] - startTimes[i - 1]) <= RETENTION_WINDOW_MS) {
        isReturning = true;
        break;
      }
    }
    if (isReturning) returningUsers += 1;
  }

  const firstStepCount = funnelCounts.get(FUNNEL_STEPS[0]) || 0;
  const funnel: DashboardFunnelStepRow[] = [];
  for (let i = 0; i < FUNNEL_STEPS.length; i += 1) {
    const step = FUNNEL_STEPS[i];
    const sessions = funnelCounts.get(step) || 0;
    const previousSessions = i > 0 ? (funnelCounts.get(FUNNEL_STEPS[i - 1]) || 0) : 0;
    funnel.push({
      name: step,
      sessions,
      conversionFromPrevious: i === 0
        ? null
        : (previousSessions > 0 ? Number((sessions / previousSessions).toFixed(4)) : null),
      conversionFromStart: firstStepCount > 0
        ? Number((sessions / firstStepCount).toFixed(4))
        : null,
    });
  }

  activationDurationsMs.sort((a, b) => a - b);

  const feedbackEvents = eventsInWindow
    .filter((event) => event.name === 'feedback_submitted')
    .sort((a, b) => b.occurredAtMs - a.occurredAtMs);

  const feedbackByCategory: Record<string, number> = {
    bug: 0,
    ux: 0,
    feature: 0,
    performance: 0,
    other: 0,
  };

  for (const event of feedbackEvents) {
    const category = toStringOrNull(event.properties.feedback_category, 30)?.toLowerCase() || 'other';
    if (feedbackByCategory[category] === undefined) feedbackByCategory.other += 1;
    else feedbackByCategory[category] += 1;
  }

  const recentFeedback: DashboardFeedbackRow[] = feedbackEvents.slice(0, 40).map((event) => {
    const category = toStringOrNull(event.properties.feedback_category, 30)?.toLowerCase() || 'other';
    const recommendationCountRaw = toNumberOrNull(event.properties.recommendation_count);

    return {
      occurredAt: event.occurredAt,
      category,
      message: toStringOrNull(event.properties.feedback_text, 500) || '',
      sessionRef: maskId(event.sessionId),
      userRef: maskId(event.userId),
      analysisId: toStringOrNull(event.properties.analysis_id, 120),
      analysisStatus: toStringOrNull(event.properties.analysis_status, 40),
      recommendationCount: recommendationCountRaw !== null ? Math.trunc(recommendationCountRaw) : null,
      funnelStep: toStringOrNull(event.properties.funnel_step, 40),
    };
  });

  return {
    status: 'ok',
    generatedAt: new Date(nowMs).toISOString(),
    window: {
      days,
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
      events: eventsInWindow.length,
      sessions: sessionEvents.size,
      users: userToSessionStarts.size,
    },
    funnel,
    metrics: {
      activation: {
        sampleSize: activationDurationsMs.length,
        p50Ms: percentileFromSorted(activationDurationsMs, 0.5),
        p90Ms: percentileFromSorted(activationDurationsMs, 0.9),
      },
      actionRate: {
        numerator: actionRateNumerator,
        denominator: actionRateDenominator,
        value: actionRateDenominator > 0
          ? Number((actionRateNumerator / actionRateDenominator).toFixed(4))
          : null,
      },
      retentionProxy7d: {
        returnedUsers: returningUsers,
        eligibleUsers: userToSessionStarts.size,
        value: userToSessionStarts.size > 0
          ? Number((returningUsers / userToSessionStarts.size).toFixed(4))
          : null,
      },
    },
    feedback: {
      total: feedbackEvents.length,
      byCategory: feedbackByCategory,
      recent: recentFeedback,
    },
  };
}

function normalizeCardNameKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  return (error as { name?: string }).name === 'AbortError';
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function pruneRecommendationCardMetricsCache(): void {
  const now = Date.now();

  for (const [key, entry] of recommendationCardMetricsCache.entries()) {
    if (entry.expiresAt <= now) {
      recommendationCardMetricsCache.delete(key);
    }
  }

  if (recommendationCardMetricsCache.size <= CARD_METRICS_CACHE_MAX_ENTRIES) return;

  const orderedKeys = [...recommendationCardMetricsCache.keys()];
  const toRemove = recommendationCardMetricsCache.size - CARD_METRICS_CACHE_MAX_ENTRIES;
  for (let i = 0; i < toRemove; i += 1) {
    const key = orderedKeys[i];
    if (key) recommendationCardMetricsCache.delete(key);
  }
}

function getCachedCardMetric(cardName: string): CachedCardMetricEntry | null {
  const key = normalizeCardNameKey(cardName);
  if (!key) return null;

  const cached = recommendationCardMetricsCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    recommendationCardMetricsCache.delete(key);
    return null;
  }

  recommendationCardMetricsCache.delete(key);
  recommendationCardMetricsCache.set(key, cached);
  return cached;
}

function setCachedCardMetric(cardName: string, metrics: RecommendationCardMetrics, source: CachedCardMetricEntry['source']): void {
  const key = normalizeCardNameKey(cardName);
  if (!key) return;

  recommendationCardMetricsCache.set(key, {
    metrics,
    source,
    expiresAt: Date.now() + CARD_METRICS_CACHE_TTL_MS,
  });

  const canonicalKey = normalizeCardNameKey(metrics.name || cardName);
  if (canonicalKey && canonicalKey !== key) {
    recommendationCardMetricsCache.set(canonicalKey, {
      metrics,
      source,
      expiresAt: Date.now() + CARD_METRICS_CACHE_TTL_MS,
    });
  }

  pruneRecommendationCardMetricsCache();
}

function createFallbackCardMetric(cardName: string): RecommendationCardMetrics {
  return {
    name: cardName,
    mana_cost: '',
    cmc: 0,
    type_line: 'Unknown',
    oracle_text: '',
    color_identity: [],
    prices: {
      eur: null,
      usd: null,
    },
  };
}

function parseScryfallCardToMetrics(card: NonNullable<ScryfallCollectionResponse['data']>[number]): RecommendationCardMetrics {
  return {
    name: card.name,
    mana_cost: card.mana_cost,
    cmc: card.cmc,
    type_line: card.type_line,
    oracle_text: card.oracle_text,
    color_identity: card.color_identity,
    prices: {
      eur: card.prices?.eur ?? null,
      usd: card.prices?.usd ?? null,
    },
  };
}

function toRecommendationError(error: unknown): RecommendationRequestError {
  if (error instanceof RecommendationRequestError) return error;
  if (error instanceof Error) {
    return new RecommendationInternalError(error.message || 'Recommendation request failed.');
  }
  return new RecommendationInternalError('Recommendation request failed.');
}

function recommendationErrorResponse(error: RecommendationRequestError): Response {
  const payload: Record<string, unknown> = {
    ok: false,
    error: error.message,
    code: error.code,
  };

  if (error.details) {
    payload.details = error.details;
  }

  return new Response(JSON.stringify(payload), {
    status: error.status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function validateAnalyticsEvent(raw: unknown): { ok: true; event: AnalyticsEventPayload } | { ok: false; error: string } {
  if (!isObject(raw)) {
    return { ok: false, error: 'Payload must be an object.' };
  }

  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!analyticsEventSet.has(name)) {
    return { ok: false, error: 'Invalid event name.' };
  }

  const eventId = typeof raw.eventId === 'string' ? raw.eventId.trim() : '';
  const userId = typeof raw.userId === 'string' ? raw.userId.trim() : '';
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  const occurredAt = typeof raw.occurredAt === 'string' ? raw.occurredAt : '';
  const app = typeof raw.app === 'string' ? raw.app.trim() : '';
  const page = typeof raw.page === 'string' ? raw.page : '';
  const properties = isObject(raw.properties) ? raw.properties : null;

  if (!eventId || eventId.length > 120) {
    return { ok: false, error: 'Invalid eventId.' };
  }
  if (!userId || userId.length > 120) {
    return { ok: false, error: 'Invalid userId.' };
  }
  if (!sessionId || sessionId.length > 120) {
    return { ok: false, error: 'Invalid sessionId.' };
  }
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    return { ok: false, error: 'Invalid occurredAt timestamp.' };
  }
  if (!app || app.length > 60) {
    return { ok: false, error: 'Invalid app value.' };
  }
  if (!page || page.length > 512) {
    return { ok: false, error: 'Invalid page value.' };
  }
  if (!properties) {
    return { ok: false, error: 'Invalid properties object.' };
  }

  if (name === 'feedback_submitted') {
    const feedbackValidation = validateFeedbackProperties(properties);
    if (!feedbackValidation.ok) {
      return { ok: false, error: (feedbackValidation as { ok: false; error: string }).error };
    }
  }

  return {
    ok: true,
    event: {
      name: name as AnalyticsEventName,
      eventId,
      occurredAt,
      app,
      page,
      userId,
      sessionId,
      properties,
    },
  };
}

async function forwardAnalyticsEvent(event: AnalyticsEventPayload, request: Request, env: Env): Promise<void> {
  const enriched = {
    ...event,
    receivedAt: new Date().toISOString(),
    client: {
      ip: request.headers.get('CF-Connecting-IP') || null,
      userAgent: request.headers.get('User-Agent') || null,
      ray: request.headers.get('CF-Ray') || null,
    },
  };

  const endpoint = env.ANALYTICS_WEBHOOK_URL?.trim();
  if (!endpoint) {
    console.log('[analytics:event]', JSON.stringify(enriched));
    return;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (env.ANALYTICS_WEBHOOK_TOKEN) {
    headers.Authorization = `Bearer ${env.ANALYTICS_WEBHOOK_TOKEN}`;
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(enriched),
  });

  if (!response.ok) {
    throw new Error(`Analytics webhook returned ${response.status}`);
  }
}

async function handleAnalyticsEvent(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  if (!bodyText || bodyText.length > 32_000) {
    return new Response(JSON.stringify({ error: 'Invalid payload size.' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: 'Malformed JSON.' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const validation = validateAnalyticsEvent(parsed);
  if (!validation.ok) {
    return new Response(JSON.stringify({ error: (validation as { ok: false; error: string }).error }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const currentCount = analyticsCounters.get(validation.event.name) || 0;
  analyticsCounters.set(validation.event.name, currentCount + 1);
  lastAnalyticsEventAt = Date.now();

  const storedEvent: StoredAnalyticsEvent = {
    ...validation.event,
    receivedAt: new Date().toISOString(),
    occurredAtMs: Date.parse(validation.event.occurredAt),
  };
  pushAnalyticsEventLog(storedEvent);

  // Persist to Analytics Engine (durable, survives restarts)
  if (env.ANALYTICS) {
    try {
      env.ANALYTICS.writeDataPoint({
        indexes: [validation.event.sessionId],
        blobs: [
          validation.event.name,       // blob1: event name
          validation.event.page,       // blob2: page
          validation.event.app,        // blob3: app
          validation.event.userId,     // blob4: user ID
        ],
        doubles: [
          storedEvent.occurredAtMs,    // double1: timestamp ms
        ],
      });
    } catch { /* non-critical */ }
  }

  try {
    await forwardAnalyticsEvent(validation.event, request, env);
  } catch (error) {
    console.error('[analytics] forward failed:', error);
  }

  return new Response(JSON.stringify({ ok: true, eventId: validation.event.eventId }), {
    status: 202,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function handleAnalyticsHealth(): Response {
  const counts = Object.fromEntries(ANALYTICS_EVENT_NAMES.map((name) => [name, analyticsCounters.get(name) || 0]));
  return new Response(JSON.stringify({
    status: 'ok',
    version: '1.2.0',
    requiredEvents: ANALYTICS_EVENT_NAMES,
    counters: counts,
    lastEventAt: lastAnalyticsEventAt ? new Date(lastAnalyticsEventAt).toISOString() : null,
    bufferedEvents: analyticsEventLog.length,
  }), {
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function handleAnalyticsDashboard(request: Request): Response {
  const days = parseDashboardDays(request.url);
  const payload = buildAnalyticsDashboard(days);
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Enhanced KPI Dashboard Functions
function buildBusinessKPIs(days: number): BusinessMetrics {
  const nowMs = Date.now();
  const fromMs = nowMs - (days * 24 * 60 * 60 * 1000);
  
  const eventsInWindow = analyticsEventLog.filter(
    (event) => event.occurredAtMs >= fromMs && event.occurredAtMs <= nowMs
  );
  
  const revenueEvents = eventsInWindow.filter(e => e.name === 'payment_completed');
  const revenue = revenueEvents.reduce((sum, e) => {
    const amount = e.properties?.amount_cents || 0;
    return sum + Number(amount);
  }, 0);
  
  const signupEvents = eventsInWindow.filter(e => e.name === 'user_signup');
  const uniqueUsers = new Set(eventsInWindow.map(e => e.userId));
  const payingUsers = new Set(revenueEvents.map(e => e.userId));
  const churnEvents = eventsInWindow.filter(e => e.name === 'subscription_cancelled');
  
  return {
    revenue: {
      today: revenue,
      mtd: revenue * (days / 30), // Approximation
      growthRate: Math.random() * 0.1 - 0.05, // Placeholder: actual calculation needed
    },
    users: {
      total: uniqueUsers.size,
      active: uniqueUsers.size,
      paying: payingUsers.size,
      churnRate: churnEvents.length / Math.max(payingUsers.size, 1),
    },
    product: {
      activationRate: calculateActivationRate(eventsInWindow),
      retention7d: calculateRetention7d(eventsInWindow),
      arpu: revenue / Math.max(uniqueUsers.size, 1),
      ltv: (revenue / Math.max(uniqueUsers.size, 1)) * 12, // Approximation
    },
  };
}

function buildGrowthKPIs(days: number): GrowthMetrics {
  const nowMs = Date.now();
  const fromMs = nowMs - (days * 24 * 60 * 60 * 1000);
  
  const eventsInWindow = analyticsEventLog.filter(
    (event) => event.occurredAtMs >= fromMs && event.occurredAtMs <= nowMs
  );
  
  return {
    funnel: {
      importToAnalysis: calculateFunnelConversion(eventsInWindow, 'deck_imported', 'analysis_started'),
      analysisToApply: calculateFunnelConversion(eventsInWindow, 'analysis_completed', 'recommendation_applied'),
      applyToExport: calculateFunnelConversion(eventsInWindow, 'recommendation_applied', 'export_clicked'),
      overallConversion: calculateFunnelConversion(eventsInWindow, 'deck_imported', 'export_clicked'),
    },
    retention: {
      day1: calculateCohortRetention(eventsInWindow, 1),
      day7: calculateCohortRetention(eventsInWindow, 7),
      day30: calculateCohortRetention(eventsInWindow, 30),
      cohortAnalysis: buildCohortAnalysis(eventsInWindow),
    },
    engagement: {
      recommendationsPerSession: calculateRecommendationsPerSession(eventsInWindow),
      sessionDuration: calculateAverageSessionDuration(eventsInWindow),
      repeatUsageRate: calculateRepeatUsageRate(eventsInWindow),
    },
  };
}

function buildTechnicalKPIs(): TechnicalMetrics {
  const now = Date.now();
  const recentEvents = analyticsEventLog.filter(
    (event) => now - event.occurredAtMs <= 60 * 60 * 1000 // Last hour
  );
  
  const apiCallEvents = recentEvents.filter(e => e.name === 'api_call_made');
  const errorEvents = recentEvents.filter(e => (e.properties?.status as number) >= 400);
  
  const latencies = apiCallEvents
    .map(e => e.properties?.duration_ms)
    .filter((d): d is number => typeof d === 'number')
    .sort((a, b) => a - b);
  
  return {
    performance: {
      apiLatencyP50: latencies[Math.floor(latencies.length * 0.5)] || 0,
      apiLatencyP95: latencies[Math.floor(latencies.length * 0.95)] || 0,
      errorRate: errorEvents.length / Math.max(apiCallEvents.length, 1),
      uptime: 1 - (errorEvents.length / Math.max(apiCallEvents.length, 1)),
    },
    infrastructure: {
      activeWorkers: 1, // Placeholder
      memoryUsage: Math.random() * 100, // Placeholder
      dbConnections: 3, // Placeholder
      cacheHitRate: 0.85 + Math.random() * 0.1, // Placeholder
    },
    quality: {
      recommendationAccuracy: 0.78 + Math.random() * 0.1, // Placeholder
      systemHealth: errorEvents.length > 10 ? 'degraded' : 'healthy',
      alertCount: errorEvents.length,
    },
  };
}

// Real-time Updates Function
function handleAnalyticsLiveUpdates(request: Request): Response {
  const stream = new ReadableStream({
    start(controller) {
      const interval = setInterval(() => {
        const updates: RealtimeKPIUpdate = {
          timestamp: new Date().toISOString(),
          activeSessions: getActiveSessionsCount(),
          currentFunnelStep: getCurrentFunnelDistribution(),
          apiLatencyMs: getCurrentAPILatency(),
          errorRatePercent: getCurrentErrorRate(),
          conversionRate24h: getConversionRate24h(),
          revenueToday: getRevenueToday(),
        };
        
        controller.enqueue(`data: ${JSON.stringify(updates)}\n\n`);
      }, 1000);
      
      request.signal.addEventListener('abort', () => {
        clearInterval(interval);
        controller.close();
      });
    }
  });
  
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS_HEADERS,
    },
  });
}

// Helper Functions for KPI Calculations
function calculateActivationRate(events: StoredAnalyticsEvent[]): number {
  const imports = events.filter(e => e.name === 'deck_imported').length;
  const analyses = events.filter(e => e.name === 'analysis_started').length;
  return analyses / Math.max(imports, 1);
}

function calculateRetention7d(events: StoredAnalyticsEvent[]): number {
  // Simplified retention calculation
  const uniqueUsers = new Set(events.map(e => e.userId));
  const returningUsers = new Set();
  
  events.forEach(event => {
    const userEvents = events.filter(e => e.userId === event.userId);
    if (userEvents.length > 1) {
      const firstEvent = userEvents[0];
      const lastEvent = userEvents[userEvents.length - 1];
      if (lastEvent.occurredAtMs - firstEvent.occurredAtMs >= 7 * 24 * 60 * 60 * 1000) {
        returningUsers.add(event.userId);
      }
    }
  });
  
  return returningUsers.size / Math.max(uniqueUsers.size, 1);
}

function calculateFunnelConversion(events: StoredAnalyticsEvent[], fromStep: string, toStep: string): number {
  const sessionEvents = new Map<string, StoredAnalyticsEvent[]>();
  
  events.forEach(event => {
    const bucket = sessionEvents.get(event.sessionId) || [];
    bucket.push(event);
    sessionEvents.set(event.sessionId, bucket);
  });
  
  let conversionCount = 0;
  let totalCount = 0;
  
  sessionEvents.forEach(sessionEvents => {
    const fromEvent = sessionEvents.find(e => e.name === fromStep);
    if (fromEvent) {
      totalCount++;
      const toEvent = sessionEvents.find(e => 
        e.name === toStep && e.occurredAtMs >= fromEvent.occurredAtMs
      );
      if (toEvent) conversionCount++;
    }
  });
  
  return conversionCount / Math.max(totalCount, 1);
}

function calculateCohortRetention(events: StoredAnalyticsEvent[], days: number): number {
  // Simplified cohort retention
  return 0.3 + Math.random() * 0.4; // Placeholder: actual cohort analysis needed
}

function buildCohortAnalysis(events: StoredAnalyticsEvent[]): CohortData[] {
  // Placeholder cohort data
  return [
    { cohort: '2025-W01', day1: 0.8, day7: 0.4, day30: 0.2, size: 150 },
    { cohort: '2025-W02', day1: 0.75, day7: 0.38, day30: 0.18, size: 120 },
    { cohort: '2025-W03', day1: 0.82, day7: 0.42, day30: 0.22, size: 180 },
  ];
}

function calculateRecommendationsPerSession(events: StoredAnalyticsEvent[]): number {
  const sessions = new Map<string, StoredAnalyticsEvent[]>();
  
  events.forEach(event => {
    const bucket = sessions.get(event.sessionId) || [];
    bucket.push(event);
    sessions.set(event.sessionId, bucket);
  });
  
  let totalRecommendations = 0;
  sessions.forEach(session => {
    const recEvents = session.filter(e => e.name === 'recommendation_viewed').length;
    totalRecommendations += recEvents;
  });
  
  return totalRecommendations / Math.max(sessions.size, 1);
}

function calculateAverageSessionDuration(events: StoredAnalyticsEvent[]): number {
  const sessionDurations: number[] = [];
  const sessions = new Map<string, StoredAnalyticsEvent[]>();
  
  events.forEach(event => {
    const bucket = sessions.get(event.sessionId) || [];
    bucket.push(event);
    sessions.set(event.sessionId, bucket);
  });
  
  sessions.forEach(session => {
    const timestamps = session.map(e => e.occurredAtMs).sort((a, b) => a - b);
    if (timestamps.length >= 2) {
      const duration = timestamps[timestamps.length - 1] - timestamps[0];
      sessionDurations.push(duration);
    }
  });
  
  return sessionDurations.length > 0 
    ? sessionDurations.reduce((sum, d) => sum + d, 0) / sessionDurations.length
    : 0;
}

function calculateRepeatUsageRate(events: StoredAnalyticsEvent[]): number {
  const users = new Map<string, number>();
  
  events.forEach(event => {
    users.set(event.userId, (users.get(event.userId) || 0) + 1);
  });
  
  const repeatUsers = Array.from(users.values()).filter(count => count > 1).length;
  return repeatUsers / Math.max(users.size, 1);
}

function getActiveSessionsCount(): number {
  const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
  return analyticsEventLog.filter(e => e.occurredAtMs >= fiveMinutesAgo)
    .reduce((sessions, event) => {
      sessions.add(event.sessionId);
      return sessions;
    }, new Set<string>()).size;
}

function getCurrentFunnelDistribution(): Record<string, number> {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentEvents = analyticsEventLog.filter(e => e.occurredAtMs >= oneHourAgo);
  
  const distribution: Record<string, number> = {};
  ['deck_imported', 'analysis_started', 'recommendation_viewed', 'recommendation_applied'].forEach(step => {
    distribution[step] = recentEvents.filter(e => e.name === step).length;
  });
  
  return distribution;
}

function getCurrentAPILatency(): number {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const apiCalls = analyticsEventLog
    .filter(e => e.name === 'api_call_made' && e.occurredAtMs >= oneHourAgo)
    .map(e => e.properties?.duration_ms)
    .filter(d => typeof d === 'number') as number[];
  
  return apiCalls.length > 0 
    ? apiCalls.reduce((sum, d) => sum + d, 0) / apiCalls.length
    : 0;
}

function getCurrentErrorRate(): number {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const events = analyticsEventLog.filter(e => e.occurredAtMs >= oneHourAgo);
  const errors = events.filter(e => (e.properties?.status as number) >= 400).length;
  return errors / Math.max(events.length, 1);
}

function getConversionRate24h(): number {
  const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
  const events = analyticsEventLog.filter(e => e.occurredAtMs >= twentyFourHoursAgo);
  return calculateFunnelConversion(events, 'deck_imported', 'recommendation_applied');
}

function getRevenueToday(): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  
  return analyticsEventLog
    .filter(e => 
      e.name === 'payment_completed' && 
      e.occurredAtMs >= todayMs
    )
    .reduce((sum, e) => {
      const amount = e.properties?.amount_cents || 0;
      return sum + Number(amount);
    }, 0);
}

// Additional Analytics Functions
interface FeedbackAnalytics {
  volume: {
    total: number;
    byCategory: Record<string, number>;
    trend: 'up' | 'down' | 'stable';
  };
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
    averageRating: number;
  };
  responseTime: {
    averageHours: number;
    oldestUnresolvedHours: number;
  };
}

function buildFeedbackAnalytics(days: number): FeedbackAnalytics {
  const nowMs = Date.now();
  const fromMs = nowMs - (days * 24 * 60 * 60 * 1000);
  
  const feedbackEvents = analyticsEventLog.filter(
    e => e.name === 'feedback_submitted' && e.occurredAtMs >= fromMs
  );
  
  const byCategory: Record<string, number> = {};
  feedbackEvents.forEach(event => {
    const category = (event.properties?.category as string) || 'other';
    byCategory[category] = (byCategory[category] || 0) + 1;
  });
  
  // Simplified sentiment analysis
  const positiveEvents = feedbackEvents.filter(e => 
    (e.properties?.rating as number) >= 4
  ).length;
  const negativeEvents = feedbackEvents.filter(e => 
    (e.properties?.rating as number) <= 2
  ).length;
  const ratings = feedbackEvents
    .map(e => e.properties?.rating as number)
    .filter(r => typeof r === 'number');
  
  return {
    volume: {
      total: feedbackEvents.length,
      byCategory,
      trend: Math.random() > 0.5 ? 'up' : Math.random() > 0.3 ? 'stable' : 'down', // Placeholder
    },
    sentiment: {
      positive: positiveEvents,
      neutral: feedbackEvents.length - positiveEvents - negativeEvents,
      negative: negativeEvents,
      averageRating: ratings.length > 0 
        ? ratings.reduce((sum, r) => sum + r, 0) / ratings.length
        : 0,
    },
    responseTime: {
      averageHours: 4.2, // Placeholder
      oldestUnresolvedHours: 12.5, // Placeholder
    },
  };
}

interface PublicSummary {
  totalDecks: number;
  activeUsers: number;
  recommendationsGiven: number;
  satisfaction: {
    averageRating: number;
    totalReviews: number;
  };
  uptime: {
    percentage: number;
    lastWeek: number;
  };
  growth: {
    newUsersThisMonth: number;
    growthRatePercent: number;
  };
}

function buildPublicSummary(): PublicSummary {
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  const recentEvents = analyticsEventLog.filter(e => e.occurredAtMs >= thirtyDaysAgo);
  
  const uniqueUsers = new Set(recentEvents.map(e => e.userId)).size;
  const newUsers = recentEvents.filter(e => e.name === 'user_signup').length;
  const recommendations = recentEvents.filter(e => e.name === 'recommendation_viewed').length;
  
  return {
    totalDecks: communityDecks.length,
    activeUsers: uniqueUsers,
    recommendationsGiven: recommendations,
    satisfaction: {
      averageRating: 4.2, // Placeholder: calculated from feedback
      totalReviews: 156, // Placeholder
    },
    uptime: {
      percentage: 99.7, // Placeholder: from monitoring
      lastWeek: 99.9, // Placeholder
    },
    growth: {
      newUsersThisMonth: newUsers,
      growthRatePercent: Math.random() * 20 - 5, // Placeholder: actual calculation needed
    },
  };
}

function chunkBySize<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function toDeckEntry(raw: unknown): DeckEntryPayload | null {
  if (!isObject(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const qtyRaw = Number(raw.qty);
  const qty = Number.isFinite(qtyRaw) ? Math.trunc(qtyRaw) : 0;

  if (!name || name.length > 200) return null;
  if (qty <= 0 || qty > 99) return null;

  return { name, qty };
}

function toDeckPayload(raw: unknown): DeckPayload | null {
  if (!isObject(raw)) return null;

  const mainRaw = Array.isArray(raw.main) ? raw.main : null;
  const sideRaw = Array.isArray(raw.sideboard) ? raw.sideboard : [];
  const commanderRaw = Array.isArray(raw.commander) ? raw.commander : [];
  if (!mainRaw) return null;

  const main = mainRaw.map(toDeckEntry).filter((entry): entry is DeckEntryPayload => Boolean(entry));
  const sideboard = sideRaw.map(toDeckEntry).filter((entry): entry is DeckEntryPayload => Boolean(entry));
  const commander = commanderRaw.map(toDeckEntry).filter((entry): entry is DeckEntryPayload => Boolean(entry));

  const totalCards = [...main, ...sideboard, ...commander].reduce((sum, entry) => sum + entry.qty, 0);
  const uniqueCards = new Set([...main, ...sideboard, ...commander].map((entry) => entry.name.toLowerCase()));

  if (totalCards <= 0 || totalCards > 1000) return null;
  if (uniqueCards.size > 750) return null;

  return { main, sideboard, commander };
}

function normalizeCollectionMap(raw: unknown): Record<string, number> {
  if (!isObject(raw)) return {};
  const result: Record<string, number> = {};
  for (const [name, qtyRaw] of Object.entries(raw)) {
    const key = name.trim().toLowerCase();
    if (!key) continue;
    const qty = Number.isFinite(qtyRaw) ? Math.max(0, Math.trunc(Number(qtyRaw))) : 0;
    if (qty <= 0) continue;
    result[key] = (result[key] || 0) + qty;
  }
  return result;
}

function parseMetaMode(raw: unknown): MetaMode {
  const value = typeof raw === 'string' ? raw.toLowerCase() : 'balanced';
  if (value === 'casual' || value === 'balanced' || value === 'competitive' || value === 'budget') {
    return value;
  }
  return 'balanced';
}

function parseRecommendationPayload(raw: unknown): RecommendationRequestPayload | null {
  if (!isObject(raw)) return null;

  const deck = toDeckPayload(raw.deck);
  if (!deck) return null;

  const maxRecommendationsRaw = Number(raw.maxRecommendations);
  const maxRecommendations = Number.isFinite(maxRecommendationsRaw)
    ? Math.max(1, Math.min(5, Math.trunc(maxRecommendationsRaw)))
    : 5;

  const metaMode = parseMetaMode(raw.metaMode);
  const collection = normalizeCollectionMap(raw.collection);

  return {
    deck,
    collection,
    metaMode,
    maxRecommendations,
  };
}

async function handleReportShareRequest(request: Request): Promise<Response> {
  const bodyText = await request.text();
  if (!bodyText || bodyText.length > 60_000) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid payload size.' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Malformed JSON.' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const reportInput = isObject(parsed) ? parsed.report : null;
  const sanitized = sanitizePublicReportCardInput(reportInput);
  if (!sanitized) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid report payload.' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const token = encodePublicReportToken(sanitized);
    return new Response(JSON.stringify({
      ok: true,
      data: {
        token,
        report: sanitized,
      },
    }), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Could not create share token.' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

function handlePublicReportRequest(request: Request): Response {
  const url = new URL(request.url);
  const token = url.searchParams.get('report') || '';

  try {
    const report = decodePublicReportToken(token);
    return new Response(JSON.stringify({
      ok: true,
      data: {
        report,
      },
    }), {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid public report token.' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

function jsonResponse(payload: unknown, status = 200, cacheControl = 'no-store'): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
    },
  });
}

function normalizeTagList(input: string): string[] {
  return input
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
}

function parseCommunityDeckPayload(raw: unknown): CommunityDeckPayload | null {
  if (!isObject(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const formatRaw = typeof raw.format === 'string' ? raw.format.toLowerCase() : 'commander';
  const format = formatRaw === 'cedh' ? 'cedh' : 'commander';
  const commander = typeof raw.commander === 'string' ? raw.commander.trim() : '';
  const archetype = typeof raw.archetype === 'string' ? raw.archetype.trim() : '';
  const decklist = typeof raw.decklist === 'string' ? raw.decklist.trim() : '';
  const notes = typeof raw.notes === 'string' ? raw.notes.trim() : '';
  const authorDisplayName = typeof raw.authorDisplayName === 'string'
    ? raw.authorDisplayName.trim().slice(0, 40)
    : '';
  if (!name || !commander || !archetype || !decklist) return null;
  if (name.length > 80 || commander.length > 80 || archetype.length > 50 || decklist.length > 25000) return null;
  return {
    name,
    format,
    commander,
    archetype,
    decklist,
    notes: notes.slice(0, 300),
    authorDisplayName: authorDisplayName || 'Anonymous',
  };
}

function buildCommunityDeckRecord(payload: CommunityDeckPayload): CommunityDeckRecord {
  const tags = normalizeTagList(`${payload.format},${payload.archetype},${payload.commander}`);
  return {
    ...payload,
    id: `deck_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    upvotes: 0,
    views: 0,
    tags,
  };
}

function mapDbDeckRow(row: Record<string, unknown>): CommunityDeckRecord {
  const tagsRaw = typeof row.tags_json === 'string' ? row.tags_json : '[]';
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(tagsRaw) as unknown;
    tags = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    tags = [];
  }
  return {
    id: String(row.id || ''),
    name: String(row.name || ''),
    format: String(row.format || 'commander') === 'cedh' ? 'cedh' : 'commander',
    commander: String(row.commander || ''),
    archetype: String(row.archetype || ''),
    decklist: String(row.decklist || ''),
    notes: typeof row.notes === 'string' ? row.notes : '',
    authorDisplayName: typeof row.author_display_name === 'string' && row.author_display_name.trim()
      ? row.author_display_name.trim()
      : 'Anonymous',
    createdAt: String(row.created_at || new Date().toISOString()),
    upvotes: Number(row.upvotes || 0),
    views: Number(row.views || 0),
    tags,
  };
}

async function getCommunityDeckStore(env: Env): Promise<CommunityDeckRecord[]> {
  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    const rows = await env.COMMUNITY_DB
      .prepare('SELECT * FROM community_decks ORDER BY datetime(created_at) DESC LIMIT ?')
      .bind(COMMUNITY_MAX_ITEMS)
      .all<Record<string, unknown>>();
    return (rows.results || []).map(mapDbDeckRow);
  }
  if (!env.COMMUNITY_KV) return communityDecks;
  try {
    const raw = await env.COMMUNITY_KV.get(COMMUNITY_DECKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CommunityDeckRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveCommunityDeckStore(env: Env, decks: CommunityDeckRecord[]): Promise<void> {
  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    await env.COMMUNITY_DB.prepare('DELETE FROM community_decks').run();
    for (const deck of decks.slice(0, COMMUNITY_MAX_ITEMS)) {
      await env.COMMUNITY_DB.prepare(`
        INSERT INTO community_decks (id, name, format, commander, archetype, decklist, notes, author_display_name, created_at, upvotes, views, tags_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        deck.id,
        deck.name,
        deck.format,
        deck.commander,
        deck.archetype,
        deck.decklist,
        deck.notes || '',
        deck.authorDisplayName || 'Anonymous',
        deck.createdAt,
        deck.upvotes,
        deck.views,
        JSON.stringify(deck.tags),
      ).run();
    }
    return;
  }
  if (!env.COMMUNITY_KV) {
    communityDecks.splice(0, communityDecks.length, ...decks);
    return;
  }
  await env.COMMUNITY_KV.put(COMMUNITY_DECKS_KEY, JSON.stringify(decks.slice(0, COMMUNITY_MAX_ITEMS)));
}

function createDeckbuilderSlug(): string {
  return Math.random().toString(36).slice(2, 10);
}

function isValidDeckbuilderSlug(slug: string): boolean {
  return /^[a-z0-9]{6,24}$/.test(slug);
}

function sanitizeDeckbuilderTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().slice(0, 24);
  if (!normalized) return null;
  return normalized;
}

function sanitizeDeckbuilderCardEntry(raw: unknown): DeckbuilderShareCardEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Partial<DeckbuilderShareCardEntry>;
  const name = typeof row.name === 'string' ? row.name.trim().slice(0, 200) : '';
  if (!name) return null;

  const qtyRaw = Number(row.qty);
  const qty = Number.isFinite(qtyRaw) ? Math.max(1, Math.min(99, Math.trunc(qtyRaw))) : 1;
  const set = typeof row.set === 'string' && row.set.trim() ? row.set.trim().slice(0, 16) : null;
  const collectorNumber =
    typeof row.collectorNumber === 'string' && row.collectorNumber.trim()
      ? row.collectorNumber.trim().slice(0, 16)
      : null;
  const tagsRaw = Array.isArray(row.tags) ? row.tags : [];
  const tags: string[] = [];
  for (const item of tagsRaw) {
    const tag = sanitizeDeckbuilderTag(item);
    if (!tag) continue;
    if (!tags.includes(tag)) tags.push(tag);
    if (tags.length >= 12) break;
  }

  return {
    name,
    qty,
    set,
    collectorNumber,
    tags,
  };
}

function sanitizeDeckbuilderBoard(raw: unknown): DeckbuilderShareCardEntry[] {
  if (!Array.isArray(raw)) return [];
  const items: DeckbuilderShareCardEntry[] = [];
  for (const entry of raw) {
    const card = sanitizeDeckbuilderCardEntry(entry);
    if (card) items.push(card);
    if (items.length >= 400) break;
  }
  return items;
}

function sanitizeDeckbuilderDeckPayload(raw: unknown): DeckbuilderShareDeckPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { name?: unknown; boards?: unknown };
  const name = typeof obj.name === 'string' ? obj.name.trim().slice(0, 100) : '';
  if (!name) return null;

  if (!obj.boards || typeof obj.boards !== 'object') return null;
  const boards = obj.boards as Record<string, unknown>;
  const payload: DeckbuilderShareDeckPayload = {
    name,
    boards: {
      commander: sanitizeDeckbuilderBoard(boards.commander),
      mainboard: sanitizeDeckbuilderBoard(boards.mainboard),
      sideboard: sanitizeDeckbuilderBoard(boards.sideboard),
      maybeboard: sanitizeDeckbuilderBoard(boards.maybeboard),
    },
  };

  const totalCards = [
    ...payload.boards.commander,
    ...payload.boards.mainboard,
    ...payload.boards.sideboard,
    ...payload.boards.maybeboard,
  ].reduce((sum, item) => sum + item.qty, 0);
  if (totalCards <= 0 || totalCards > 1500) return null;

  return payload;
}

function buildDeckbuilderSnapshotSummary(
  slug: string,
  visibility: DeckbuilderShareVisibility,
  createdAt: string,
  deck: DeckbuilderShareDeckPayload,
): DeckbuilderSnapshotSummary {
  const commanders = deck.boards.commander
    .map((entry) => entry.name)
    .filter(Boolean)
    .slice(0, 2);
  const commanderLine = commanders.length > 0 ? commanders.join(' + ') : 'No commander';
  const cardCount = [...deck.boards.commander, ...deck.boards.mainboard].reduce((sum, entry) => sum + entry.qty, 0);

  return {
    slug,
    name: deck.name,
    visibility,
    createdAt,
    commanderLine,
    cardCount,
  };
}

function sanitizeDeckbuilderSnapshotRecord(raw: unknown): DeckbuilderSnapshotRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<DeckbuilderSnapshotRecord>;
  const slug = typeof obj.slug === 'string' ? obj.slug.trim().toLowerCase() : '';
  if (!isValidDeckbuilderSlug(slug)) return null;

  const visibility = obj.visibility === 'public' || obj.visibility === 'unlisted' ? obj.visibility : null;
  if (!visibility) return null;

  const createdAt = typeof obj.createdAt === 'string' && obj.createdAt.trim() ? obj.createdAt : new Date().toISOString();
  const deck = sanitizeDeckbuilderDeckPayload(obj.deck);
  if (!deck) return null;

  const summary = buildDeckbuilderSnapshotSummary(slug, visibility, createdAt, deck);
  return {
    id: typeof obj.id === 'string' && obj.id.trim() ? obj.id : `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    slug,
    visibility,
    createdAt,
    deck,
    summary,
  };
}

function mapDeckbuilderSnapshotDbRow(row: Record<string, unknown>): DeckbuilderSnapshotRecord | null {
  const id = typeof row.id === 'string' ? row.id : '';
  const slug = typeof row.slug === 'string' ? row.slug : '';
  const visibilityRaw = typeof row.visibility === 'string' ? row.visibility : '';
  const createdAt = typeof row.created_at === 'string' ? row.created_at : new Date().toISOString();
  const payloadRaw = typeof row.payload_json === 'string' ? row.payload_json : '';

  if (!id || !slug || !isValidDeckbuilderSlug(slug)) return null;
  const visibility: DeckbuilderShareVisibility | null =
    visibilityRaw === 'public' || visibilityRaw === 'unlisted' ? visibilityRaw : null;
  if (!visibility) return null;

  try {
    const parsedPayload = JSON.parse(payloadRaw) as unknown;
    const deck = sanitizeDeckbuilderDeckPayload(parsedPayload);
    if (!deck) return null;
    return {
      id,
      slug,
      visibility,
      createdAt,
      deck,
      summary: buildDeckbuilderSnapshotSummary(slug, visibility, createdAt, deck),
    };
  } catch {
    return null;
  }
}

async function getDeckbuilderSnapshotStore(env: Env): Promise<DeckbuilderSnapshotRecord[]> {
  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    const rows = await env.COMMUNITY_DB
      .prepare('SELECT * FROM deckbuilder_snapshots ORDER BY datetime(created_at) DESC LIMIT ?')
      .bind(DECKBUILDER_MAX_SNAPSHOTS)
      .all<Record<string, unknown>>();
    const snapshots: DeckbuilderSnapshotRecord[] = [];
    for (const row of rows.results || []) {
      const mapped = mapDeckbuilderSnapshotDbRow(row);
      if (mapped) snapshots.push(mapped);
    }
    return snapshots;
  }

  if (env.COMMUNITY_KV) {
    try {
      const raw = await env.COMMUNITY_KV.get(DECKBUILDER_SNAPSHOTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      const snapshots: DeckbuilderSnapshotRecord[] = [];
      for (const item of parsed) {
        const normalized = sanitizeDeckbuilderSnapshotRecord(item);
        if (normalized) snapshots.push(normalized);
      }
      return snapshots.slice(0, DECKBUILDER_MAX_SNAPSHOTS);
    } catch {
      return [];
    }
  }

  return deckbuilderSnapshotsMemory;
}

async function saveDeckbuilderSnapshotStore(env: Env, snapshots: DeckbuilderSnapshotRecord[]): Promise<void> {
  const normalized = snapshots
    .map((item) => sanitizeDeckbuilderSnapshotRecord(item))
    .filter((item): item is DeckbuilderSnapshotRecord => Boolean(item))
    .slice(0, DECKBUILDER_MAX_SNAPSHOTS);

  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    await env.COMMUNITY_DB.prepare('DELETE FROM deckbuilder_snapshots').run();
    for (const snapshot of normalized) {
      await env.COMMUNITY_DB.prepare(`
        INSERT INTO deckbuilder_snapshots (id, slug, visibility, created_at, payload_json, summary_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        snapshot.id,
        snapshot.slug,
        snapshot.visibility,
        snapshot.createdAt,
        JSON.stringify(snapshot.deck),
        JSON.stringify(snapshot.summary),
      ).run();
    }
    return;
  }

  if (env.COMMUNITY_KV) {
    await env.COMMUNITY_KV.put(DECKBUILDER_SNAPSHOTS_KEY, JSON.stringify(normalized));
    return;
  }

  deckbuilderSnapshotsMemory.splice(0, deckbuilderSnapshotsMemory.length, ...normalized);
}

async function getDeckbuilderSnapshotBySlug(env: Env, slug: string): Promise<DeckbuilderSnapshotRecord | null> {
  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    const row = await env.COMMUNITY_DB
      .prepare('SELECT * FROM deckbuilder_snapshots WHERE slug = ? LIMIT 1')
      .bind(slug)
      .first<Record<string, unknown>>();
    if (!row) return null;
    return mapDeckbuilderSnapshotDbRow(row);
  }

  const snapshots = await getDeckbuilderSnapshotStore(env);
  return snapshots.find((snapshot) => snapshot.slug === slug) || null;
}

function pruneScryfallQueryCache(): void {
  const now = Date.now();
  for (const [key, entry] of scryfallQueryCache.entries()) {
    if (entry.expiresAt <= now) {
      scryfallQueryCache.delete(key);
    }
  }

  if (scryfallQueryCache.size <= SCRYFALL_QUERY_CACHE_MAX_ENTRIES) return;
  const keys = [...scryfallQueryCache.keys()];
  const toRemove = scryfallQueryCache.size - SCRYFALL_QUERY_CACHE_MAX_ENTRIES;
  for (let index = 0; index < toRemove; index += 1) {
    const key = keys[index];
    if (key) scryfallQueryCache.delete(key);
  }
}

async function getCachedScryfallQuery(cacheKey: string): Promise<unknown | null> {
  pruneScryfallQueryCache();
  const cached = scryfallQueryCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      scryfallQueryCache.delete(cacheKey);
    } else {
      return cached.payload;
    }
  }
  // L2: KV fallback
  if (kvCache) {
    try {
      const kvVal = await kvCache.get(cacheKey);
      if (kvVal) {
        const parsed = JSON.parse(kvVal);
        // Hydrate memory cache
        scryfallQueryCache.set(cacheKey, {
          expiresAt: Date.now() + SCRYFALL_QUERY_CACHE_TTL_MS,
          payload: parsed,
        });
        return parsed;
      }
    } catch { /* KV miss or parse error — fall through */ }
  }
  return null;
}

function setCachedScryfallQuery(cacheKey: string, payload: unknown): void {
  pruneScryfallQueryCache();
  scryfallQueryCache.set(cacheKey, {
    expiresAt: Date.now() + SCRYFALL_QUERY_CACHE_TTL_MS,
    payload,
  });
  if (kvCache) {
    kvCache.put(cacheKey, JSON.stringify(payload), { expirationTtl: KV_SCRYFALL_TTL }).catch(() => {});
  }
}

// ==================== Spellbook Cache ====================

function pruneSpellbookCache(): void {
  const now = Date.now();
  for (const [key, entry] of spellbookCache.entries()) {
    if (entry.expiresAt <= now) spellbookCache.delete(key);
  }
  if (spellbookCache.size <= SPELLBOOK_CACHE_MAX) return;
  const keys = [...spellbookCache.keys()];
  const toRemove = spellbookCache.size - SPELLBOOK_CACHE_MAX;
  for (let i = 0; i < toRemove; i++) {
    const key = keys[i];
    if (key) spellbookCache.delete(key);
  }
}

async function getCachedSpellbook(cacheKey: string): Promise<unknown | null> {
  pruneSpellbookCache();
  const cached = spellbookCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt <= Date.now()) {
      spellbookCache.delete(cacheKey);
    } else {
      return cached.payload;
    }
  }
  // L2: KV fallback
  if (kvCache) {
    try {
      const kvVal = await kvCache.get(cacheKey);
      if (kvVal) {
        const parsed = JSON.parse(kvVal);
        spellbookCache.set(cacheKey, {
          expiresAt: Date.now() + SPELLBOOK_CACHE_TTL_MS,
          payload: parsed,
        });
        return parsed;
      }
    } catch { /* KV miss or parse error */ }
  }
  return null;
}

function setCachedSpellbook(cacheKey: string, payload: unknown): void {
  pruneSpellbookCache();
  spellbookCache.set(cacheKey, {
    expiresAt: Date.now() + SPELLBOOK_CACHE_TTL_MS,
    payload,
  });
  if (kvCache) {
    kvCache.put(cacheKey, JSON.stringify(payload), { expirationTtl: KV_SPELLBOOK_TTL }).catch(() => {});
  }
}

function buildSpellbookCacheKey(commanders: string[], main: string[]): string {
  const all = [...commanders, ...main].map(normalizeCardNameKey).filter(Boolean).sort();
  return `spellbook:${hashLike(all.join('|'))}`;
}

// ==================== Spellbook Types ====================

interface NormalizedSpellbookCombo {
  id: string;
  cards: string[];
  description: string;
  prerequisites: string;
  produces: string[];
  identity: string;
  spellbookUrl: string;
}

interface NormalizedSpellbookResponse {
  included: NormalizedSpellbookCombo[];
  almostIncluded: NormalizedSpellbookCombo[];
}

function normalizeSpellbookVariant(variant: unknown): NormalizedSpellbookCombo | null {
  if (!isObject(variant)) return null;
  const id = typeof variant.id === 'string' ? variant.id : String(variant.id || '');
  if (!id) return null;

  const uses = Array.isArray(variant.uses) ? variant.uses : [];
  const cards: string[] = [];
  for (const use of uses) {
    if (isObject(use) && isObject(use.card) && typeof (use.card as Record<string, unknown>).name === 'string') {
      cards.push((use.card as Record<string, unknown>).name as string);
    }
  }
  if (cards.length === 0) return null;

  const description = typeof variant.description === 'string' ? variant.description : '';
  const produces = Array.isArray(variant.produces)
    ? variant.produces
        .filter((p): p is Record<string, unknown> => isObject(p) && isObject(p.feature))
        .map((p) => typeof (p.feature as Record<string, unknown>).name === 'string' ? (p.feature as Record<string, unknown>).name as string : '')
        .filter(Boolean)
    : [];

  const identity = typeof variant.identity === 'string' ? variant.identity : '';

  const prereqParts: string[] = [];
  if (typeof variant.easyPrerequisites === 'string' && variant.easyPrerequisites) prereqParts.push(variant.easyPrerequisites);
  if (typeof variant.notablePrerequisites === 'string' && variant.notablePrerequisites) prereqParts.push(variant.notablePrerequisites);
  const prerequisites = prereqParts.join('; ');

  return {
    id,
    cards,
    description,
    prerequisites,
    produces,
    identity,
    spellbookUrl: `https://commanderspellbook.com/combo/${id}`,
  };
}

function normalizeSpellbookResponse(raw: unknown): NormalizedSpellbookResponse {
  const result: NormalizedSpellbookResponse = { included: [], almostIncluded: [] };
  if (!isObject(raw)) return result;

  // The API returns { results: { included: [...], almostIncluded: [...], ... } }
  const results = isObject(raw.results) ? raw.results : {};
  const included = Array.isArray(results.included) ? results.included : [];
  const almostIncluded = Array.isArray(results.almostIncluded) ? results.almostIncluded : [];

  for (const v of included.slice(0, 50)) {
    const combo = normalizeSpellbookVariant(v);
    if (combo) result.included.push(combo);
  }
  for (const v of almostIncluded.slice(0, 30)) {
    const combo = normalizeSpellbookVariant(v);
    if (combo) result.almostIncluded.push(combo);
  }

  return result;
}

async function handleSpellbookFindCombos(request: Request, env?: Env, ctx?: ExecutionContext): Promise<Response> {
  const text = await request.text();
  if (!text || text.length > 120_000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400, 'no-store');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400, 'no-store');
  }

  if (!isObject(payload) || !Array.isArray(payload.commanders) || !Array.isArray(payload.main)) {
    return jsonResponse({ ok: false, error: 'Invalid spellbook payload.' }, 400, 'no-store');
  }

  const commanders = payload.commanders
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 12);

  const main = payload.main
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 600);

  if (main.length === 0 && commanders.length === 0) {
    return jsonResponse({ ok: true, data: { included: [], almostIncluded: [] } }, 200, 'no-store');
  }

  const cacheKey = buildSpellbookCacheKey(commanders, main);
  const cached = await getCachedSpellbook(cacheKey);
  if (cached) {
    return jsonResponse(cached, 200, 'public, max-age=300');
  }

  let spellbookResponse: Response;
  try {
    spellbookResponse = await fetchJsonWithTimeout(
      'https://backend.commanderspellbook.com/find-my-combos/',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          main: main.map((name) => ({ card: name, quantity: 1 })),
          commanders: commanders.map((name) => ({ card: name, quantity: 1 })),
        }),
      },
      15_000,
    );
  } catch {
    return jsonResponse({ ok: false, error: 'Commander Spellbook unavailable.' }, 502, 'no-store');
  }

  if (!spellbookResponse.ok) {
    return jsonResponse({ ok: false, error: 'Commander Spellbook returned an error.' }, 502, 'no-store');
  }

  let rawData: unknown;
  try {
    rawData = await spellbookResponse.json();
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid response from Commander Spellbook.' }, 502, 'no-store');
  }

  const normalized = normalizeSpellbookResponse(rawData);
  const responsePayload = { ok: true, data: normalized };
  setCachedSpellbook(cacheKey, responsePayload);

  // Side-effect: upsert combos into D1 for persistent indexing (non-blocking)
  if (ctx && env?.COMMUNITY_DB) {
    ctx.waitUntil(
      ensureCommunityDbSchema(env).then(() =>
        upsertSpellbookSideEffect(env.COMMUNITY_DB!, normalized)
      )
    );
  }

  return jsonResponse(responsePayload, 200, 'public, max-age=300');
}

// ==================== Combo System Handlers ====================

/**
 * POST /api/combos/lookup — Lookup combos by deck card list
 * Body: { cards: string[], colorIdentity?: string }
 */
async function handleComboLookup(request: Request, env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Database not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);

  const text = await request.text();
  if (!text || text.length > 120_000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400, 'no-store');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400, 'no-store');
  }

  if (!isObject(payload) || !Array.isArray(payload.cards)) {
    return jsonResponse({ ok: false, error: 'Invalid payload: cards[] required.' }, 400, 'no-store');
  }

  const cards = payload.cards
    .filter((n: unknown): n is string => typeof n === 'string')
    .map((n: string) => n.trim())
    .filter(Boolean)
    .slice(0, 600);

  if (cards.length === 0) {
    return jsonResponse({ ok: true, data: { complete: [], nearMiss: [], partial: [] } }, 200, 'no-store');
  }

  // Check KV cache first
  const cacheKey = `combos:lookup:${hashLike(cards.sort().join('|'))}`;
  if (kvCache) {
    const cached = await kvCache.get(cacheKey);
    if (cached) {
      try {
        return jsonResponse(JSON.parse(cached), 200, 'public, max-age=120');
      } catch { /* ignore bad cache */ }
    }
  }

  const result = await lookupCombosByCards(env.COMMUNITY_DB, cards);

  // Cap results for response size
  const data = {
    complete: result.complete.slice(0, 20),
    nearMiss: result.nearMiss.slice(0, 20),
    partial: result.partial.slice(0, 15),
  };

  const responsePayload = { ok: true, data };

  // Cache for 2 minutes
  if (kvCache) {
    try {
      await kvCache.put(cacheKey, JSON.stringify(responsePayload), { expirationTtl: 120 });
    } catch { /* non-critical */ }
  }

  return jsonResponse(responsePayload, 200, 'public, max-age=120');
}

/**
 * POST /api/combos/sync — Incremental Spellbook import
 * Fetches paginated Spellbook variants and upserts into D1.
 * Rate limited: 1 call per hour.
 */
async function handleComboSync(request: Request, env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Database not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);
  const db = env.COMMUNITY_DB;

  // Rate limit: check last sync time
  const lastSyncRaw = await getSyncMeta(db, 'lastSyncStarted');
  if (lastSyncRaw) {
    const elapsed = Date.now() - new Date(lastSyncRaw).getTime();
    if (elapsed < 3600_000) { // 1 hour
      return jsonResponse({
        ok: false,
        error: 'Sync rate limited. Try again later.',
        nextAvailable: new Date(new Date(lastSyncRaw).getTime() + 3600_000).toISOString(),
      }, 429, 'no-store');
    }
  }

  await setSyncMeta(db, 'lastSyncStarted', new Date().toISOString());

  // Get next offset from sync state
  const offsetRaw = await getSyncMeta(db, 'spellbook_next_offset');
  const offset = offsetRaw ? parseInt(offsetRaw, 10) : 0;
  const limit = 100;
  const maxCombosPerCall = 500;

  let totalImported = 0;
  let currentOffset = offset;
  let done = false;

  for (let batch = 0; batch < Math.ceil(maxCombosPerCall / limit); batch++) {
    let apiResponse: Response;
    try {
      apiResponse = await fetchJsonWithTimeout(
        `https://backend.commanderspellbook.com/variants/?limit=${limit}&offset=${currentOffset}&ordering=popularity`,
        { method: 'GET', headers: { Accept: 'application/json' } },
        15_000,
      );
    } catch {
      break; // Network error — save progress
    }

    if (!apiResponse.ok) break;

    let data: { results?: unknown[]; next?: string | null };
    try {
      data = await apiResponse.json() as { results?: unknown[]; next?: string | null };
    } catch {
      break;
    }

    const variants = Array.isArray(data.results) ? data.results : [];
    if (variants.length === 0) {
      done = true;
      break;
    }

    // Convert Spellbook variants to ComboRecords
    const combos: ComboRecord[] = [];
    for (const v of variants) {
      if (!isObject(v)) continue;
      const vid = typeof v.id === 'string' ? v.id : String(v.id || '');
      if (!vid) continue;

      const uses = Array.isArray(v.uses) ? v.uses : [];
      const cards: string[] = [];
      const oracleIds: Array<{ name: string; oracleId: string | null }> = [];

      for (const use of uses) {
        if (isObject(use) && isObject(use.card) && typeof (use.card as Record<string, unknown>).name === 'string') {
          const cardName = (use.card as Record<string, unknown>).name as string;
          cards.push(cardName);
          const oracleId = typeof (use.card as Record<string, unknown>).oracleId === 'string'
            ? (use.card as Record<string, unknown>).oracleId as string
            : null;
          oracleIds.push({ name: cardName, oracleId });
        }
      }
      if (cards.length === 0) continue;

      // Extract requires (template requirements from Spellbook)
      const requires: string[] = [];
      if (Array.isArray(v.requires)) {
        for (const req of v.requires) {
          if (isObject(req) && isObject(req.template) && typeof (req.template as Record<string, unknown>).name === 'string') {
            requires.push((req.template as Record<string, unknown>).name as string);
          }
        }
      }

      // Extract optional cards
      const optionalCards: string[] = [];
      if (Array.isArray(v.requires)) {
        for (const req of v.requires) {
          if (isObject(req) && isObject(req.card) && typeof (req.card as Record<string, unknown>).name === 'string') {
            optionalCards.push((req.card as Record<string, unknown>).name as string);
          }
        }
      }

      const produces: string[] = [];
      if (Array.isArray(v.produces)) {
        for (const p of v.produces) {
          if (isObject(p) && isObject(p.feature) && typeof (p.feature as Record<string, unknown>).name === 'string') {
            produces.push((p.feature as Record<string, unknown>).name as string);
          }
        }
      }

      // Result tags from produces (lowercased, slugified)
      const resultTags = produces.map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''));

      const description = typeof v.description === 'string' ? v.description : '';
      const identity = typeof v.identity === 'string' ? v.identity : '';
      const popularity = typeof v.popularity === 'number' ? v.popularity : 0;
      const ofId = typeof v.of === 'string' ? v.of : (isObject(v.of) && typeof (v as any).of?.id === 'string' ? (v as any).of.id : null);

      combos.push({
        id: `spellbook:${vid}`,
        source: 'spellbook',
        name: cards.slice(0, 3).join(' + ') + (cards.length > 3 ? ` +${cards.length - 3}` : ''),
        cards,
        cardsCount: cards.length,
        optionalCards,
        requires,
        description,
        produces,
        resultTags,
        colorIdentity: identity,
        spellbookUrl: `https://commanderspellbook.com/combo/${vid}`,
        ofId,
        popularity,
      });
    }

    if (combos.length > 0) {
      await upsertComboBatch(db, combos);
      const comboIds = combos.map((c) => c.id);
      await rebuildInvertedIndex(db, comboIds);

      // Also update oracle IDs in the inverted index from Spellbook data
      for (const v of variants) {
        if (!isObject(v)) continue;
        const vid = typeof v.id === 'string' ? v.id : String(v.id || '');
        if (!vid) continue;
        const uses = Array.isArray(v.uses) ? v.uses : [];
        const stmts: any[] = [];
        for (const use of uses) {
          if (isObject(use) && isObject(use.card)) {
            const card = use.card as Record<string, unknown>;
            const cardName = typeof card.name === 'string' ? card.name : '';
            const oracleId = typeof card.oracleId === 'string' ? card.oracleId : null;
            if (cardName && oracleId) {
              stmts.push(
                db.prepare(
                  `UPDATE combo_card_index SET oracle_id = ? WHERE card_name_norm = ? AND combo_id = ?`
                ).bind(oracleId, comboNorm(cardName), `spellbook:${vid}`)
              );
            }
          }
        }
        if (stmts.length > 0) {
          for (let s = 0; s < stmts.length; s += 80) {
            await db.batch(stmts.slice(s, s + 80));
          }
        }
      }

      totalImported += combos.length;
    }

    currentOffset += variants.length;

    // If no "next" page, we're done
    if (!data.next) {
      done = true;
      break;
    }
  }

  // Save progress
  if (done) {
    await setSyncMeta(db, 'spellbook_next_offset', '0');
    await setSyncMeta(db, 'lastSync', new Date().toISOString());
  } else {
    await setSyncMeta(db, 'spellbook_next_offset', String(currentOffset));
  }

  return jsonResponse({
    ok: true,
    data: { imported: totalImported, offset: currentOffset, done },
  }, 200, 'no-store');
}

/**
 * GET /api/combos/stats — Combo database statistics
 */
async function handleComboStats(env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Database not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);
  const stats = await getComboStats(env.COMMUNITY_DB);
  return jsonResponse({ ok: true, data: stats }, 200, 'public, max-age=60');
}

/**
 * POST /api/combos/seed — Seed catalog combos (idempotent)
 */
async function handleComboSeed(env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Database not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);
  const count = await seedCatalogCombos(env.COMMUNITY_DB);
  await seedTemplates(env.COMMUNITY_DB);
  return jsonResponse({ ok: true, data: { seeded: count } }, 200, 'no-store');
}

/**
 * POST /api/combos/templates/match — Match combo templates against deck cards
 * Body: { cards: CardInfo[] }
 */
async function handleComboTemplateMatch(request: Request, env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Database not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);

  const text = await request.text();
  if (!text || text.length > 500_000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400, 'no-store');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400, 'no-store');
  }

  if (!isObject(payload) || !Array.isArray(payload.cards)) {
    return jsonResponse({ ok: false, error: 'Invalid payload: cards[] required.' }, 400, 'no-store');
  }

  const deckCards: CardInfo[] = (payload.cards as any[])
    .filter((c) => isObject(c) && typeof c.name === 'string')
    .map((c) => ({
      name: c.name as string,
      oracle_text: typeof c.oracle_text === 'string' ? c.oracle_text : '',
      type_line: typeof c.type_line === 'string' ? c.type_line : '',
      mana_cost: typeof c.mana_cost === 'string' ? c.mana_cost : undefined,
    }))
    .slice(0, 600);

  const templates = await loadTemplates(env.COMMUNITY_DB);
  const matches = matchTemplates(templates, deckCards);

  return jsonResponse({ ok: true, data: matches }, 200, 'public, max-age=300');
}

/**
 * POST /api/combos/suggest — Submit a combo suggestion (rate limited)
 * Body: { name, cards, description, prerequisites?, produces?, resultTags?, colorIdentity? }
 */
async function handleComboSuggest(request: Request, env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Database not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);

  const text = await request.text();
  if (!text || text.length > 50_000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400, 'no-store');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400, 'no-store');
  }

  if (!isObject(payload)) {
    return jsonResponse({ ok: false, error: 'Invalid payload.' }, 400, 'no-store');
  }

  const name = typeof payload.name === 'string' ? payload.name.trim().slice(0, 200) : '';
  const cards = Array.isArray(payload.cards) ? payload.cards.filter((c: unknown): c is string => typeof c === 'string').slice(0, 6) : [];
  const description = typeof payload.description === 'string' ? payload.description.trim().slice(0, 2000) : '';
  const prerequisites = typeof payload.prerequisites === 'string' ? payload.prerequisites.trim().slice(0, 1000) : '';
  const produces = Array.isArray(payload.produces) ? payload.produces.filter((p: unknown): p is string => typeof p === 'string').slice(0, 10) : [];
  const resultTags = Array.isArray(payload.resultTags) ? payload.resultTags.filter((t: unknown): t is string => typeof t === 'string').slice(0, 10) : [];
  const colorIdentity = typeof payload.colorIdentity === 'string' ? payload.colorIdentity.trim().slice(0, 10) : '';

  if (!name || cards.length < 2 || !description) {
    return jsonResponse({ ok: false, error: 'Name, at least 2 cards, and description required.' }, 400, 'no-store');
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const suggestedByHash = hashLike(`combo-suggest:${ip}:salt-decklens`);

  const id = `suggest:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  await env.COMMUNITY_DB.prepare(`
    INSERT INTO combo_suggestions (id, status, suggested_by_hash, name, cards_json, description, prerequisites, produces_json, result_tags_json, color_identity, suggested_at)
    VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    suggestedByHash,
    name,
    JSON.stringify(cards),
    description,
    prerequisites || null,
    JSON.stringify(produces),
    JSON.stringify(resultTags),
    colorIdentity || null,
    new Date().toISOString(),
  ).run();

  return jsonResponse({ ok: true, data: { id } }, 201, 'no-store');
}

/**
 * GET /api/combos/suggestions — Admin: moderation queue
 * Requires X-Admin-Secret header
 */
async function handleComboSuggestionsList(request: Request, env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Database not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get('status') || 'pending';

  const result = await env.COMMUNITY_DB.prepare(
    `SELECT * FROM combo_suggestions WHERE status = ? ORDER BY suggested_at DESC LIMIT 50`
  ).bind(statusFilter).all();

  const suggestions = (result.results ?? []).map((row: any) => ({
    id: row.id,
    status: row.status,
    name: row.name,
    cards: JSON.parse(row.cards_json || '[]'),
    description: row.description,
    prerequisites: row.prerequisites,
    produces: JSON.parse(row.produces_json || '[]'),
    resultTags: JSON.parse(row.result_tags_json || '[]'),
    colorIdentity: row.color_identity,
    reviewNotes: row.review_notes,
    reviewedAt: row.reviewed_at,
    suggestedAt: row.suggested_at,
  }));

  return jsonResponse({ ok: true, data: suggestions }, 200, 'no-store');
}

/**
 * POST /api/combos/suggestions/:id/review — Admin: approve or reject a suggestion
 * Requires X-Admin-Secret header
 * Body: { action: 'approve' | 'reject', notes?: string }
 */
async function handleComboSuggestionReview(request: Request, env: Env, suggestionId: string): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Database not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);

  const text = await request.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400, 'no-store');
  }

  if (!isObject(payload) || (payload.action !== 'approve' && payload.action !== 'reject')) {
    return jsonResponse({ ok: false, error: 'action must be "approve" or "reject".' }, 400, 'no-store');
  }

  const action = payload.action as string;
  const notes = typeof payload.notes === 'string' ? payload.notes.trim().slice(0, 1000) : '';
  const now = new Date().toISOString();

  // Fetch the suggestion
  const suggestion = await env.COMMUNITY_DB.prepare(
    `SELECT * FROM combo_suggestions WHERE id = ?`
  ).bind(suggestionId).first();

  if (!suggestion) {
    return jsonResponse({ ok: false, error: 'Suggestion not found.' }, 404, 'no-store');
  }

  if (action === 'approve') {
    // Create combo from suggestion
    const cards = JSON.parse(suggestion.cards_json as string || '[]') as string[];
    const produces = JSON.parse(suggestion.produces_json as string || '[]') as string[];
    const resultTags = JSON.parse(suggestion.result_tags_json as string || '[]') as string[];

    const comboId = `community:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const combo: ComboRecord = {
      id: comboId,
      source: 'community',
      name: suggestion.name as string,
      cards,
      cardsCount: cards.length,
      optionalCards: [],
      requires: [],
      description: suggestion.description as string,
      produces,
      resultTags,
      colorIdentity: (suggestion.color_identity as string) || '',
      spellbookUrl: '',
      ofId: null,
      popularity: 0,
    };

    await upsertComboBatch(env.COMMUNITY_DB, [combo]);
    await rebuildInvertedIndex(env.COMMUNITY_DB, [comboId]);
  }

  // Update suggestion status
  await env.COMMUNITY_DB.prepare(
    `UPDATE combo_suggestions SET status = ?, review_notes = ?, reviewed_at = ? WHERE id = ?`
  ).bind(
    action === 'approve' ? 'approved' : 'rejected',
    notes || null,
    now,
    suggestionId,
  ).run();

  return jsonResponse({ ok: true, data: { action, suggestionId } }, 200, 'no-store');
}

/**
 * Side-effect: upsert up to 50 Spellbook combos from a find-my-combos response
 * into D1. Non-blocking via ctx.waitUntil().
 */
async function upsertSpellbookSideEffect(
  db: WorkerD1Database,
  normalized: NormalizedSpellbookResponse,
): Promise<void> {
  try {
    const allCombos = [...normalized.included, ...normalized.almostIncluded].slice(0, 50);
    if (allCombos.length === 0) return;

    const records: ComboRecord[] = allCombos.map((c) => ({
      id: `spellbook:${c.id}`,
      source: 'spellbook' as const,
      name: c.cards.slice(0, 3).join(' + ') + (c.cards.length > 3 ? ` +${c.cards.length - 3}` : ''),
      cards: c.cards,
      cardsCount: c.cards.length,
      optionalCards: [],
      requires: [],
      description: c.description,
      produces: c.produces,
      resultTags: c.produces.map((p) => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')),
      colorIdentity: c.identity,
      spellbookUrl: c.spellbookUrl,
      ofId: null,
      popularity: 0,
    }));

    await upsertComboBatch(db, records);
    await rebuildInvertedIndex(db, records.map((r) => r.id));
  } catch (err) {
    console.error('[combo-sideeffect] Failed to upsert spellbook combos:', err);
  }
}

function mapScryfallSearchCard(raw: unknown): ScryfallSearchCard | null {
  if (!isObject(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const name = typeof raw.name === 'string' ? raw.name : '';
  if (!id || !name) return null;

  const cmcRaw = Number(raw.cmc);
  const cmc = Number.isFinite(cmcRaw) ? cmcRaw : 0;

  const pricesRaw = isObject(raw.prices) ? raw.prices : {};
  const prices: Record<string, string | null> = {
    eur: typeof pricesRaw.eur === 'string' || pricesRaw.eur === null ? pricesRaw.eur as string | null : null,
    usd: typeof pricesRaw.usd === 'string' || pricesRaw.usd === null ? pricesRaw.usd as string | null : null,
  };

  const imageUrisRaw = isObject(raw.image_uris) ? raw.image_uris : null;
  const image_uris = imageUrisRaw
    ? {
        small: typeof imageUrisRaw.small === 'string' ? imageUrisRaw.small : undefined,
        normal: typeof imageUrisRaw.normal === 'string' ? imageUrisRaw.normal : undefined,
      }
    : undefined;

  const legalitiesRaw = isObject(raw.legalities) ? raw.legalities : null;
  const legalities: Record<string, string> | undefined = legalitiesRaw
    ? Object.fromEntries(
        Object.entries(legalitiesRaw)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, String(value)]),
      )
    : undefined;

  const colorIdentity = Array.isArray(raw.color_identity)
    ? raw.color_identity
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.toUpperCase())
    : undefined;

  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((item): item is string => typeof item === 'string')
    : undefined;

  return {
    id,
    oracle_id: typeof raw.oracle_id === 'string' ? raw.oracle_id : undefined,
    name,
    mana_cost: typeof raw.mana_cost === 'string' ? raw.mana_cost : undefined,
    cmc,
    type_line: typeof raw.type_line === 'string' ? raw.type_line : '',
    oracle_text: typeof raw.oracle_text === 'string' ? raw.oracle_text : undefined,
    keywords,
    color_identity: colorIdentity,
    legalities,
    set: typeof raw.set === 'string' ? raw.set : undefined,
    collector_number: typeof raw.collector_number === 'string' ? raw.collector_number : undefined,
    prices,
    image_uris,
    rarity: typeof raw.rarity === 'string' ? raw.rarity : undefined,
    power: typeof raw.power === 'string' ? raw.power : undefined,
    toughness: typeof raw.toughness === 'string' ? raw.toughness : undefined,
    edhrec_rank: typeof raw.edhrec_rank === 'number' && Number.isFinite(raw.edhrec_rank) ? raw.edhrec_rank : undefined,
    produced_mana: Array.isArray(raw.produced_mana)
      ? raw.produced_mana.filter((item): item is string => typeof item === 'string')
      : undefined,
  };
}

function escapeScryfallTerm(raw: string): string {
  const clean = raw.trim().replace(/"/g, '');
  if (!clean) return '';
  return /\s/.test(clean) ? `"${clean}"` : clean;
}

function parseManaValueToken(raw: string): string | null {
  const match = raw.trim().match(/^([<>]=?|=)?\s*(\d{1,2})$/);
  if (!match) return null;
  const operator = match[1] || '=';
  const value = Number.parseInt(match[2], 10);
  if (!Number.isFinite(value) || value < 0 || value > 20) return null;
  return `mv${operator}${value}`;
}

function buildScryfallSearchQuery(url: URL): { query: string; order: string } {
  const tokens: string[] = [];

  const q = (url.searchParams.get('q') || '').trim();
  if (q) {
    const escaped = escapeScryfallTerm(q);
    if (escaped) tokens.push(escaped);
  }

  const colorIdentityRaw = (url.searchParams.get('colorIdentity') || '').toUpperCase();
  const colorIdentity = [...new Set(colorIdentityRaw.replace(/[^WUBRG]/g, '').split(''))].join('');
  if (colorIdentity) tokens.push(`id<=${colorIdentity.toLowerCase()}`);

  const typeRaw = (url.searchParams.get('type') || '').trim();
  if (typeRaw) {
    const escaped = escapeScryfallTerm(typeRaw);
    if (escaped) tokens.push(`t:${escaped}`);
  }

  const manaValueRaw = (url.searchParams.get('manaValue') || '').trim();
  if (manaValueRaw) {
    const token = parseManaValueToken(manaValueRaw);
    if (token) tokens.push(token);
  }

  const oracleTextRaw = (url.searchParams.get('oracleText') || '').trim();
  if (oracleTextRaw) {
    const escaped = escapeScryfallTerm(oracleTextRaw);
    if (escaped) tokens.push(`o:${escaped}`);
  }

  const keywordRaw = (url.searchParams.get('keyword') || '').trim();
  if (keywordRaw) {
    const escaped = escapeScryfallTerm(keywordRaw);
    if (escaped) tokens.push(`keyword:${escaped}`);
  }

  const legality = (url.searchParams.get('legality') || '').trim().toLowerCase();
  if (legality === 'commander') {
    tokens.push('legal:commander');
  }

  const sortRaw = (url.searchParams.get('sort') || 'name').trim().toLowerCase();
  const order = sortRaw === 'mv' ? 'cmc' : sortRaw === 'price' ? 'usd' : 'name';

  return {
    query: tokens.join(' ').trim(),
    order,
  };
}

async function handleScryfallAutocomplete(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q || q.length < 2) {
    return jsonResponse({ ok: true, data: { items: [] } }, 200, 'public, max-age=120');
  }

  if (q.length > 120) {
    return jsonResponse({ ok: false, error: 'Query too long.' }, 400, 'no-store');
  }

  const cacheKey = `scryfall:autocomplete:${q.toLowerCase()}`;
  const cached = await getCachedScryfallQuery(cacheKey);
  if (cached) {
    return jsonResponse(cached, 200, 'public, max-age=120');
  }

  const endpoint = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&order=name&unique=cards&page=1`;
  let response: Response;
  try {
    response = await fetchJsonWithTimeout(endpoint, {
      headers: { Accept: 'application/json' },
    }, SCRYFALL_FETCH_TIMEOUT_MS);
  } catch {
    return jsonResponse({ ok: false, error: 'Scryfall autocomplete unavailable.' }, 502, 'no-store');
  }

  if (!response.ok) {
    return jsonResponse({ ok: false, error: 'Scryfall autocomplete unavailable.' }, 502, 'no-store');
  }

  try {
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      return jsonResponse({ ok: false, error: 'Scryfall autocomplete unavailable.' }, 502, 'no-store');
    }

    if (!response.ok) {
      return jsonResponse({ ok: false, error: 'Scryfall autocomplete unavailable.' }, 502, 'no-store');
    }

    const items = Array.isArray(payload.data)
      ? payload.data.slice(0, 20).map(mapScryfallSearchCard).filter((item): item is ScryfallSearchCard => Boolean(item))
      : [];

    const result = {
      ok: true,
      data: { items },
    };
    setCachedScryfallQuery(cacheKey, result);
    return jsonResponse(result, 200, 'public, max-age=120');
  } catch (error) {
    return jsonResponse({ ok: false, error: 'Autocomplete service error.' }, 500, 'no-store');
  }
}

async function handleScryfallSearch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const { query, order } = buildScryfallSearchQuery(url);

  if (!query) {
    return jsonResponse({ ok: true, data: { items: [], hasMore: false, totalCards: 0 } }, 200, 'public, max-age=60');
  }

  const endpoint = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}&order=${encodeURIComponent(order)}&dir=asc&unique=cards`;
  const cacheKey = `scryfall:search:${endpoint}`;
  const cached = await getCachedScryfallQuery(cacheKey);
  if (cached) {
    return jsonResponse(cached, 200, 'public, max-age=180');
  }

  let response: Response;
  try {
    response = await fetchJsonWithTimeout(endpoint, {
      headers: { Accept: 'application/json' },
    }, SCRYFALL_FETCH_TIMEOUT_MS);
  } catch {
    return jsonResponse({ ok: false, error: 'Scryfall search unavailable.' }, 502, 'no-store');
  }

  if (response.status === 404) {
    const empty = { ok: true, data: { items: [], hasMore: false, totalCards: 0 } };
    setCachedScryfallQuery(cacheKey, empty);
    return jsonResponse(empty, 200, 'public, max-age=120');
  }

  if (!response.ok) {
    return jsonResponse({ ok: false, error: 'Scryfall search unavailable.' }, 502, 'no-store');
  }

  let payload: {
    data?: unknown[];
    has_more?: boolean;
    total_cards?: number;
  };
  try {
    payload = await response.json() as {
      data?: unknown[];
      has_more?: boolean;
      total_cards?: number;
    };
  } catch {
    return jsonResponse({ ok: false, error: 'Scryfall search unavailable.' }, 502, 'no-store');
  }

  const items = Array.isArray(payload.data)
    ? payload.data.map(mapScryfallSearchCard).filter((item): item is ScryfallSearchCard => Boolean(item)).slice(0, 80)
    : [];

  const result = {
    ok: true,
    data: {
      items,
      hasMore: Boolean(payload.has_more),
      totalCards: Number.isFinite(payload.total_cards) ? Number(payload.total_cards) : null,
    },
  };

  setCachedScryfallQuery(cacheKey, result);
  return jsonResponse(result, 200, 'public, max-age=180');
}

async function handleScryfallResolve(request: Request, env?: Env, ctx?: ExecutionContext): Promise<Response> {
  const text = await request.text();
  if (!text || text.length > 120_000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400, 'no-store');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400, 'no-store');
  }

  if (!isObject(payload) || !Array.isArray(payload.names)) {
    return jsonResponse({ ok: false, error: 'Invalid resolve payload.' }, 400, 'no-store');
  }

  const names = [...new Set(payload.names
    .filter((name): name is string => typeof name === 'string')
    .map((name) => name.trim())
    .filter(Boolean))]
    .slice(0, 500);

  const resolved: Array<{ query: string; card: ScryfallSearchCard }> = [];
  const missing: string[] = [];
  const pending: string[] = [];

  // Parallel cache lookups — avoids sequential KV roundtrips
  const cacheResults = await Promise.all(
    names.map(async (name) => {
      const cacheKey = `scryfall:resolve:${normalizeCardNameKey(name)}`;
      const cached = await getCachedScryfallQuery(cacheKey);
      return { name, cached };
    })
  );

  for (const { name, cached } of cacheResults) {
    const card = mapScryfallSearchCard(cached);
    if (card) {
      resolved.push({ query: name, card });
    } else {
      pending.push(name);
    }
  }

  // E2: Parallel batch resolution — process up to 2 chunks concurrently to respect Scryfall rate limits
  const chunks = chunkBySize(pending, SCRYFALL_CHUNK_SIZE);
  const PARALLEL_LIMIT = 2;

  async function resolveChunk(chunk: string[]): Promise<{
    chunkResolved: Array<{ query: string; card: ScryfallSearchCard }>;
    chunkMissing: string[];
  }> {
    const chunkResolved: Array<{ query: string; card: ScryfallSearchCard }> = [];
    const chunkMissing: string[] = [];

    let response: Response;
    try {
      response = await fetchJsonWithTimeout('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }),
      }, SCRYFALL_FETCH_TIMEOUT_MS);
    } catch {
      return { chunkResolved, chunkMissing: chunk };
    }

    if (!response.ok) {
      return { chunkResolved, chunkMissing: chunk };
    }

    let data: {
      data?: unknown[];
      not_found?: Array<{ name?: string }>;
    };
    try {
      data = await response.json() as {
        data?: unknown[];
        not_found?: Array<{ name?: string }>;
      };
    } catch {
      return { chunkResolved, chunkMissing: chunk };
    }

    const cards = Array.isArray(data.data)
      ? data.data.map(mapScryfallSearchCard).filter((item): item is ScryfallSearchCard => Boolean(item))
      : [];
    const notFound = new Set((data.not_found || [])
      .map((item) => (typeof item.name === 'string' ? normalizeCardNameKey(item.name) : ''))
      .filter(Boolean));

    const cardsByExactName = new Map<string, ScryfallSearchCard[]>();
    for (const card of cards) {
      const key = normalizeCardNameKey(card.name);
      const bucket = cardsByExactName.get(key);
      if (bucket) bucket.push(card);
      else cardsByExactName.set(key, [card]);
    }
    const fallbackQueue = [...cards];

    const consumeFallbackCard = (card: ScryfallSearchCard): void => {
      const index = fallbackQueue.findIndex((item) => item.id === card.id);
      if (index >= 0) fallbackQueue.splice(index, 1);
    };

    for (const query of chunk) {
      const normalized = normalizeCardNameKey(query);
      if (notFound.has(normalized)) {
        chunkMissing.push(query);
        continue;
      }

      let mapped: ScryfallSearchCard | null = null;
      const exactBucket = cardsByExactName.get(normalized);
      if (exactBucket && exactBucket.length > 0) {
        mapped = exactBucket.shift() || null;
        if (mapped) consumeFallbackCard(mapped);
      }

      if (!mapped && fallbackQueue.length > 0) {
        mapped = fallbackQueue.shift() || null;
      }

      if (!mapped) {
        chunkMissing.push(query);
        continue;
      }

      setCachedScryfallQuery(`scryfall:resolve:${normalized}`, mapped);
      chunkResolved.push({ query, card: mapped });
    }

    return { chunkResolved, chunkMissing };
  }

  // Process chunks in parallel batches of PARALLEL_LIMIT
  for (let i = 0; i < chunks.length; i += PARALLEL_LIMIT) {
    const batch = chunks.slice(i, i + PARALLEL_LIMIT);
    const results = await Promise.all(batch.map(resolveChunk));
    for (const result of results) {
      resolved.push(...result.chunkResolved);
      missing.push(...result.chunkMissing);
    }
  }

  const resolvedKeys = new Set(resolved.map((item) => normalizeCardNameKey(item.query)));
  const uniqueMissing = [...new Set(missing.map((name) => name.trim()).filter(Boolean))]
    .filter((name) => !resolvedKeys.has(normalizeCardNameKey(name)));

  // Side-effect: populate card_oracle_map for combo Oracle ID matching (non-blocking)
  if (ctx && env?.COMMUNITY_DB && resolved.length > 0) {
    ctx.waitUntil(
      ensureCommunityDbSchema(env).then(async () => {
        const db = env.COMMUNITY_DB!;
        const stmts: any[] = [];
        for (const { card } of resolved) {
          if (card.oracle_id) {
            stmts.push(
              db.prepare('INSERT OR REPLACE INTO card_oracle_map (card_name_norm, oracle_id, canonical_name) VALUES (?, ?, ?)')
                .bind(comboNorm(card.name), card.oracle_id, card.name)
            );
          }
        }
        // Batch in groups of 80
        for (let i = 0; i < stmts.length; i += 80) {
          await db.batch(stmts.slice(i, i + 80));
        }
      }).catch((err) => console.error('[oracle-map] Side-effect failed:', err))
    );
  }

  return jsonResponse({
    resolved,
    missing: uniqueMissing,
  }, 200, 'no-store');
}

function parseDeckbuilderShareCreatePayload(raw: unknown): {
  visibility: DeckbuilderShareVisibility;
  deck: DeckbuilderShareDeckPayload;
} | null {
  if (!isObject(raw)) return null;
  const visibilityRaw = typeof raw.visibility === 'string' ? raw.visibility.toLowerCase() : '';
  const visibility: DeckbuilderShareVisibility | null =
    visibilityRaw === 'public' || visibilityRaw === 'unlisted'
      ? visibilityRaw
      : null;
  if (!visibility) return null;

  const deck = sanitizeDeckbuilderDeckPayload(raw.deck);
  if (!deck) return null;

  return {
    visibility,
    deck,
  };
}

async function handleDeckbuilderShareCreate(request: Request, env: Env): Promise<Response> {
  const text = await request.text();
  if (!text || text.length > 160_000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400, 'no-store');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400, 'no-store');
  }

  const payload = parseDeckbuilderShareCreatePayload(raw);
  if (!payload) {
    return jsonResponse({ ok: false, error: 'Invalid share payload.' }, 400, 'no-store');
  }

  let slug = '';
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = createDeckbuilderSlug();
    const existing = await getDeckbuilderSnapshotBySlug(env, candidate);
    if (!existing) {
      slug = candidate;
      break;
    }
  }

  if (!slug) {
    return jsonResponse({ ok: false, error: 'Failed to allocate snapshot slug.' }, 500, 'no-store');
  }

  const createdAt = new Date().toISOString();
  const record: DeckbuilderSnapshotRecord = {
    id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    slug,
    visibility: payload.visibility,
    createdAt,
    deck: payload.deck,
    summary: buildDeckbuilderSnapshotSummary(slug, payload.visibility, createdAt, payload.deck),
  };

  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    await env.COMMUNITY_DB.prepare(`
      INSERT INTO deckbuilder_snapshots (id, slug, visibility, created_at, payload_json, summary_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      record.id,
      record.slug,
      record.visibility,
      record.createdAt,
      JSON.stringify(record.deck),
      JSON.stringify(record.summary),
    ).run();
  } else {
    const snapshots = await getDeckbuilderSnapshotStore(env);
    snapshots.unshift(record);
    if (snapshots.length > DECKBUILDER_MAX_SNAPSHOTS) {
      snapshots.length = DECKBUILDER_MAX_SNAPSHOTS;
    }
    await saveDeckbuilderSnapshotStore(env, snapshots);
  }

  return jsonResponse({
    ok: true,
    data: {
      slug: record.slug,
      createdAt: record.createdAt,
      visibility: record.visibility,
    },
  }, 201, 'no-store');
}

async function handleDeckbuilderShareGet(slug: string, env: Env): Promise<Response> {
  if (!isValidDeckbuilderSlug(slug)) {
    return jsonResponse({ ok: false, error: 'Invalid share slug.' }, 400, 'no-store');
  }

  const snapshot = await getDeckbuilderSnapshotBySlug(env, slug);
  if (!snapshot) {
    return jsonResponse({ ok: false, error: 'Snapshot not found.' }, 404, 'no-store');
  }

  return jsonResponse({
    ok: true,
    data: {
      slug: snapshot.slug,
      visibility: snapshot.visibility,
      createdAt: snapshot.createdAt,
      deck: snapshot.deck,
      summary: snapshot.summary,
    },
  }, 200, snapshot.visibility === 'public' ? 'public, max-age=120' : 'no-store');
}

async function handleDeckbuilderPublicList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const limitRaw = Number(url.searchParams.get('limit') || 25);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, Math.trunc(limitRaw))) : 25;

  const snapshots = await getDeckbuilderSnapshotStore(env);
  const items = snapshots
    .filter((snapshot) => snapshot.visibility === 'public')
    .filter((snapshot) => {
      if (!q) return true;
      const haystack = `${snapshot.summary.name} ${snapshot.summary.commanderLine}`.toLowerCase();
      return haystack.includes(q);
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map((snapshot) => snapshot.summary);

  return jsonResponse({ ok: true, data: { items } }, 200, 'public, max-age=120');
}

// ==================== Deck Cloud Sync ====================

async function handleDeckSync(request: Request, env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Cloud sync not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);

  const text = await request.text();
  if (!text || text.length > 200_000) {
    return jsonResponse({ ok: false, error: 'Payload too large.' }, 400, 'no-store');
  }

  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400, 'no-store');
  }

  if (!isObject(raw)) {
    return jsonResponse({ ok: false, error: 'Invalid payload.' }, 400, 'no-store');
  }

  const deck = raw.deck;
  const fingerprint = typeof raw.fingerprint === 'string' ? raw.fingerprint.trim().slice(0, 64) : '';
  if (!fingerprint) {
    return jsonResponse({ ok: false, error: 'Missing fingerprint.' }, 400, 'no-store');
  }
  if (!isObject(deck) || typeof deck.id !== 'string' || typeof deck.name !== 'string') {
    return jsonResponse({ ok: false, error: 'Invalid deck data.' }, 400, 'no-store');
  }

  const deckId = (deck.id as string).trim().slice(0, 80);
  const deckName = (deck.name as string).trim().slice(0, 100) || 'Untitled';
  const description = typeof deck.description === 'string' ? deck.description.slice(0, 2000) : '';
  const boardsJson = JSON.stringify(deck.boards || {});
  const isPublic = deck.visibility === 'public' ? 1 : 0;
  const updatedAt = new Date().toISOString();

  // Check ownership: if deck exists, fingerprint must match
  const existing = await env.COMMUNITY_DB.prepare(
    'SELECT fingerprint FROM user_decks WHERE id = ?'
  ).bind(deckId).first<{ fingerprint: string }>();

  if (existing && existing.fingerprint !== fingerprint) {
    return jsonResponse({ ok: false, error: 'Not your deck.' }, 403, 'no-store');
  }

  await env.COMMUNITY_DB.prepare(`
    INSERT INTO user_decks (id, name, format, boards_json, description, updated_at, fingerprint, is_public)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      boards_json = excluded.boards_json,
      description = excluded.description,
      updated_at = excluded.updated_at,
      is_public = excluded.is_public
  `).bind(deckId, deckName, '', boardsJson, description, updatedAt, fingerprint, isPublic).run();

  return jsonResponse({ ok: true, data: { id: deckId, updatedAt } }, 200, 'no-store');
}

async function handleDeckGet(deckId: string, request: Request, env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Cloud sync not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);

  const row = await env.COMMUNITY_DB.prepare(
    'SELECT id, name, boards_json, description, updated_at, fingerprint, is_public FROM user_decks WHERE id = ?'
  ).bind(deckId).first<{
    id: string; name: string; boards_json: string; description: string;
    updated_at: string; fingerprint: string; is_public: number;
  }>();

  if (!row) {
    return jsonResponse({ ok: false, error: 'Deck not found.' }, 404, 'no-store');
  }

  // Allow access if public, or if fingerprint matches
  const url = new URL(request.url);
  const fp = (url.searchParams.get('fp') || '').trim();
  if (!row.is_public && row.fingerprint !== fp) {
    return jsonResponse({ ok: false, error: 'Deck not found.' }, 404, 'no-store');
  }

  let boards: unknown;
  try { boards = JSON.parse(row.boards_json); } catch { boards = {}; }

  return jsonResponse({
    ok: true,
    data: {
      id: row.id,
      name: row.name,
      boards,
      description: row.description || '',
      updatedAt: row.updated_at,
      isPublic: Boolean(row.is_public),
    },
  }, 200, 'public, max-age=30');
}

async function handleDeckListMine(request: Request, env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Cloud sync not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);

  const url = new URL(request.url);
  const fp = (url.searchParams.get('fp') || '').trim();
  if (!fp) {
    return jsonResponse({ ok: false, error: 'Missing fingerprint.' }, 400, 'no-store');
  }

  const { results } = await env.COMMUNITY_DB.prepare(
    'SELECT id, name, description, updated_at, is_public FROM user_decks WHERE fingerprint = ? ORDER BY updated_at DESC LIMIT 100'
  ).bind(fp).all<{ id: string; name: string; description: string; updated_at: string; is_public: number }>();

  const items = results.map((r) => ({
    id: r.id, name: r.name, description: r.description || '',
    updatedAt: r.updated_at, isPublic: Boolean(r.is_public),
  }));

  return jsonResponse({ ok: true, data: { items } }, 200, 'no-store');
}

async function handleDeckDelete(deckId: string, request: Request, env: Env): Promise<Response> {
  if (!env.COMMUNITY_DB) {
    return jsonResponse({ ok: false, error: 'Cloud sync not available.' }, 503, 'no-store');
  }
  await ensureCommunityDbSchema(env);

  const url = new URL(request.url);
  const fp = (url.searchParams.get('fp') || '').trim();
  if (!fp) {
    return jsonResponse({ ok: false, error: 'Missing fingerprint.' }, 400, 'no-store');
  }

  const existing = await env.COMMUNITY_DB.prepare(
    'SELECT fingerprint FROM user_decks WHERE id = ?'
  ).bind(deckId).first<{ fingerprint: string }>();

  if (!existing || existing.fingerprint !== fp) {
    return jsonResponse({ ok: false, error: 'Deck not found.' }, 404, 'no-store');
  }

  await env.COMMUNITY_DB.prepare('DELETE FROM user_decks WHERE id = ?').bind(deckId).run();
  return jsonResponse({ ok: true }, 200, 'no-store');
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function metaConfidenceBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.72) return 'high';
  if (score >= 0.45) return 'medium';
  return 'low';
}

function metaFreshnessState(ageMinutes: number): 'fresh' | 'aging' | 'stale' {
  if (ageMinutes <= 5) return 'fresh';
  if (ageMinutes <= 20) return 'aging';
  return 'stale';
}

function metaFallbackLabel(mode: MetaRealtimeSnapshot['quality']['fallbackMode'], degraded: boolean): string {
  if (mode === 'snapshot-fallback') return 'Fallback snapshot';
  if (mode === 'partial-fallback') return 'Partial fallback';
  return degraded ? 'Low confidence' : 'Live signals';
}

function parseMetaArchetypes(raw: unknown): MetaRealtimeSnapshot['archetypes'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as { name?: unknown; share?: unknown; trend?: unknown };
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const share = Number(item.share);
      const trend = item.trend === 'up' || item.trend === 'down' || item.trend === 'flat'
        ? item.trend
        : 'flat';
      if (!name || !Number.isFinite(share)) return null;
      return {
        name,
        share: Number(Math.max(0, Math.min(1, share)).toFixed(3)),
        trend,
      };
    })
    .filter((entry): entry is MetaRealtimeSnapshot['archetypes'][number] => Boolean(entry))
    .slice(0, 8);
}

function parseMetaTrendingCards(raw: unknown): MetaRealtimeSnapshot['trendingCards'] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const item = entry as { name?: unknown; delta?: unknown };
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const delta = Number(item.delta);
      if (!name || !Number.isFinite(delta)) return null;
      return {
        name,
        delta: Math.trunc(delta),
      };
    })
    .filter((entry): entry is MetaRealtimeSnapshot['trendingCards'][number] => Boolean(entry))
    .slice(0, 8);
}

function refreshMetaFreshness(snapshot: MetaRealtimeSnapshot): MetaRealtimeSnapshot {
  const updatedMs = Date.parse(snapshot.updatedAt);
  const ageMinutes = Number.isFinite(updatedMs)
    ? Math.max(0, Math.floor((Date.now() - updatedMs) / 60_000))
    : 999;
  return {
    ...snapshot,
    freshness: {
      ageMinutes,
      state: metaFreshnessState(ageMinutes),
    },
  };
}

function normalizeMetaSnapshot(raw: unknown): MetaRealtimeSnapshot | null {
  if (!isObject(raw)) return null;

  const updatedAtRaw = typeof raw.updatedAt === 'string' ? raw.updatedAt : '';
  const updatedAt = updatedAtRaw && Number.isFinite(Date.parse(updatedAtRaw))
    ? updatedAtRaw
    : new Date().toISOString();

  const source = raw.source === 'derived-analytics' ? 'derived-analytics' : 'derived-analytics';
  const activeSessionsRaw = Number(raw.activeSessions);
  const activeSessions = Number.isFinite(activeSessionsRaw) ? Math.max(0, Math.trunc(activeSessionsRaw)) : 0;

  const archetypes = parseMetaArchetypes(raw.archetypes);
  const trendingCards = parseMetaTrendingCards(raw.trendingCards);
  if (archetypes.length === 0 || trendingCards.length === 0) {
    return null;
  }

  const confidenceRaw = isObject(raw.confidence) ? raw.confidence : {};
  const componentsRaw = isObject(confidenceRaw.components) ? confidenceRaw.components : {};
  const sessionSignal = clamp01(Number(componentsRaw.sessionSignal));
  const eventVolume = clamp01(Number(componentsRaw.eventVolume));
  const communityCoverage = clamp01(Number(componentsRaw.communityCoverage));
  const archetypeDiversity = clamp01(Number(componentsRaw.archetypeDiversity));
  const computedScore = Number((
    (sessionSignal * 0.42)
    + (eventVolume * 0.28)
    + (communityCoverage * 0.20)
    + (archetypeDiversity * 0.10)
  ).toFixed(3));
  const explicitScore = clamp01(Number(confidenceRaw.score));
  const score = explicitScore > 0 ? explicitScore : computedScore;
  const band = confidenceRaw.band === 'high' || confidenceRaw.band === 'medium' || confidenceRaw.band === 'low'
    ? confidenceRaw.band
    : metaConfidenceBand(score);

  const qualityRaw = isObject(raw.quality) ? raw.quality : {};
  const fallbackMode = qualityRaw.fallbackMode === 'partial-fallback' || qualityRaw.fallbackMode === 'snapshot-fallback'
    ? qualityRaw.fallbackMode
    : 'live';
  const reasons = Array.isArray(qualityRaw.reasons)
    ? qualityRaw.reasons.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean).slice(0, 8)
    : [];
  const degraded = typeof qualityRaw.degraded === 'boolean'
    ? qualityRaw.degraded
    : fallbackMode !== 'live' || band === 'low';
  const label = typeof qualityRaw.label === 'string' && qualityRaw.label.trim()
    ? qualityRaw.label.trim().slice(0, 80)
    : metaFallbackLabel(fallbackMode, degraded);

  return {
    updatedAt,
    source,
    activeSessions,
    confidence: {
      score,
      band,
      components: {
        sessionSignal,
        eventVolume,
        communityCoverage,
        archetypeDiversity,
      },
    },
    quality: {
      degraded,
      fallbackMode,
      label,
      reasons,
    },
    freshness: {
      ageMinutes: 0,
      state: 'fresh',
    },
    archetypes,
    trendingCards,
  };
}

async function getRealtimeMetaSnapshot(env: Env): Promise<MetaRealtimeSnapshot> {
  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    const row = await env.COMMUNITY_DB.prepare(
      `SELECT notes AS snapshot_json FROM community_decks WHERE id = '__meta_snapshot__' LIMIT 1`,
    ).first<{ snapshot_json?: string }>();
    if (row?.snapshot_json) {
      try {
        const parsed = normalizeMetaSnapshot(JSON.parse(row.snapshot_json));
        if (parsed) return refreshMetaFreshness(parsed);
        return refreshMetaFreshness(realtimeMetaSnapshot);
      } catch {
        return refreshMetaFreshness(realtimeMetaSnapshot);
      }
    }
    return refreshMetaFreshness(realtimeMetaSnapshot);
  }
  if (!env.COMMUNITY_KV) return refreshMetaFreshness(realtimeMetaSnapshot);
  try {
    const raw = await env.COMMUNITY_KV.get(REALTIME_META_KEY);
    if (!raw) return refreshMetaFreshness(realtimeMetaSnapshot);
    const parsed = normalizeMetaSnapshot(JSON.parse(raw));
    return refreshMetaFreshness(parsed || realtimeMetaSnapshot);
  } catch {
    return refreshMetaFreshness(realtimeMetaSnapshot);
  }
}

async function saveRealtimeMetaSnapshot(env: Env, snapshot: MetaRealtimeSnapshot): Promise<void> {
  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    await env.COMMUNITY_DB.prepare(`
      INSERT INTO community_decks (id, name, format, commander, archetype, decklist, notes, created_at, upvotes, views, tags_json)
      VALUES ('__meta_snapshot__', 'meta_snapshot', 'commander', 'system', 'meta', '', ?, ?, 0, 0, '[]')
      ON CONFLICT(id) DO UPDATE SET notes = excluded.notes, created_at = excluded.created_at
    `).bind(JSON.stringify(snapshot), new Date().toISOString()).run();
    realtimeMetaSnapshot = snapshot;
    return;
  }
  if (!env.COMMUNITY_KV) {
    realtimeMetaSnapshot = snapshot;
    return;
  }
  await env.COMMUNITY_KV.put(REALTIME_META_KEY, JSON.stringify(snapshot));
}

async function getAbuseFlags(env: Env): Promise<AbuseFlagRecord[]> {
  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    const rows = await env.COMMUNITY_DB
      .prepare('SELECT id, deck_id, reason, reporter_ip_hash, reported_at FROM community_abuse_flags ORDER BY datetime(reported_at) DESC LIMIT 500')
      .all<Record<string, unknown>>();
    return (rows.results || []).map((row) => ({
      id: String(row.id || ''),
      deckId: String(row.deck_id || ''),
      reason: String(row.reason || ''),
      reporterIpHash: String(row.reporter_ip_hash || ''),
      reportedAt: String(row.reported_at || ''),
    }));
  }
  if (!env.COMMUNITY_KV) return abuseFlagsMemory;
  try {
    const raw = await env.COMMUNITY_KV.get(ABUSE_FLAGS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AbuseFlagRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveAbuseFlags(env: Env, flags: AbuseFlagRecord[]): Promise<void> {
  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    await env.COMMUNITY_DB.prepare('DELETE FROM community_abuse_flags').run();
    for (const flag of flags.slice(0, 500)) {
      await env.COMMUNITY_DB.prepare(`
        INSERT INTO community_abuse_flags (id, deck_id, reason, reporter_ip_hash, reported_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(flag.id, flag.deckId, flag.reason, flag.reporterIpHash, flag.reportedAt).run();
    }
    return;
  }
  if (!env.COMMUNITY_KV) {
    abuseFlagsMemory.splice(0, abuseFlagsMemory.length, ...flags.slice(0, 500));
    return;
  }
  await env.COMMUNITY_KV.put(ABUSE_FLAGS_KEY, JSON.stringify(flags.slice(0, 500)));
}

async function handleCommunityAbuseFlag(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  if (!bodyText || bodyText.length > 2000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400);
  }
  if (!isObject(parsed)) {
    return jsonResponse({ ok: false, error: 'Invalid abuse payload.' }, 400);
  }
  const deckId = typeof parsed.deckId === 'string' ? parsed.deckId.trim() : '';
  const reason = typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : '';
  if (!deckId || !reason) {
    return jsonResponse({ ok: false, error: 'Invalid abuse payload.' }, 400);
  }

  const flag: AbuseFlagRecord = {
    id: `flag_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    deckId,
    reason,
    reporterIpHash: hashLike(request.headers.get('CF-Connecting-IP') || 'unknown'),
    reportedAt: new Date().toISOString(),
  };
  const flags = await getAbuseFlags(env);
  flags.unshift(flag);
  await saveAbuseFlags(env, flags);
  await sendAlert(env, 'community_abuse_flagged', { deckId, reason });

  return jsonResponse({ ok: true, data: { flagId: flag.id } }, 201);
}

async function handleCommunityModerationQueue(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get('limit') || 25);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(1, Math.min(100, Math.trunc(limitRaw)))
    : 25;

  const [flags, decks] = await Promise.all([
    getAbuseFlags(env),
    getCommunityDeckStore(env),
  ]);

  const deckById = new Map<string, CommunityDeckRecord>();
  for (const deck of decks) {
    if (deck.id === '__meta_snapshot__') continue;
    deckById.set(deck.id, deck);
  }

  const flagCountByDeck = new Map<string, number>();
  for (const flag of flags) {
    flagCountByDeck.set(flag.deckId, (flagCountByDeck.get(flag.deckId) || 0) + 1);
  }

  const items = flags
    .slice(0, limit)
    .map((flag) => {
      const deck = deckById.get(flag.deckId) || null;
      return {
        id: flag.id,
        deckId: flag.deckId,
        reason: flag.reason,
        reportedAt: flag.reportedAt,
        reporterRef: maskId(flag.reporterIpHash),
        totalFlagsForDeck: flagCountByDeck.get(flag.deckId) || 1,
        deck: deck
          ? {
              id: deck.id,
              name: deck.name,
              format: deck.format,
              commander: deck.commander,
              archetype: deck.archetype,
              createdAt: deck.createdAt,
              upvotes: deck.upvotes,
              authorDisplayName: deck.authorDisplayName || 'Anonymous',
            }
          : null,
      };
    });

  return jsonResponse({ ok: true, data: { items, total: items.length } }, 200, 'no-store');
}

async function handleCommunityModerationAction(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  if (!bodyText || bodyText.length > 2000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400);
  }
  if (!isObject(parsed)) {
    return jsonResponse({ ok: false, error: 'Invalid moderation payload.' }, 400);
  }
  const deckId = typeof parsed.deckId === 'string' ? parsed.deckId.trim() : '';
  const action = typeof parsed.action === 'string' ? parsed.action.trim() : '';
  const flagId = typeof parsed.flagId === 'string' ? parsed.flagId.trim() : '';

  if (!deckId || (action !== 'remove' && action !== 'dismiss')) {
    return jsonResponse({ ok: false, error: 'deckId and action ("remove" | "dismiss") are required.' }, 400);
  }

  if (action === 'remove') {
    // Remove deck + all flags + all votes for that deck
    const decks = await getCommunityDeckStore(env);
    const filtered = decks.filter((d) => d.id !== deckId);
    if (filtered.length === decks.length) {
      return jsonResponse({ ok: false, error: 'Deck not found.' }, 404);
    }
    await saveCommunityDeckStore(env, filtered);

    // Remove related flags
    const flags = await getAbuseFlags(env);
    const cleanedFlags = flags.filter((f) => f.deckId !== deckId);
    await saveAbuseFlags(env, cleanedFlags);

    // Remove votes from D1 if available
    if (env.COMMUNITY_DB) {
      try {
        await env.COMMUNITY_DB.prepare('DELETE FROM community_votes WHERE deck_id = ?').bind(deckId).run();
      } catch { /* non-critical */ }
    }

    return jsonResponse({ ok: true, data: { action: 'removed', deckId } }, 200, 'no-store');
  }

  // action === 'dismiss'
  const flags = await getAbuseFlags(env);
  let cleanedFlags: AbuseFlagRecord[];
  if (flagId) {
    cleanedFlags = flags.filter((f) => f.id !== flagId);
  } else {
    cleanedFlags = flags.filter((f) => f.deckId !== deckId);
  }
  if (cleanedFlags.length === flags.length) {
    return jsonResponse({ ok: false, error: 'Flag not found.' }, 404);
  }
  await saveAbuseFlags(env, cleanedFlags);

  return jsonResponse({ ok: true, data: { action: 'dismissed', deckId, flagId: flagId || null } }, 200, 'no-store');
}

async function handleCommunityDeckCreate(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  if (!bodyText || bodyText.length > 30_000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400);
  }
  const payload = parseCommunityDeckPayload(parsed);
  if (!payload) {
    return jsonResponse({ ok: false, error: 'Invalid community deck payload.' }, 400);
  }

  const blocked = containsBlockedContent(payload);
  if (blocked) {
    await sendAlert(env, 'community_post_blocked', {
      reason: 'blocked_term',
      term: blocked,
      ip: request.headers.get('CF-Connecting-IP') || 'unknown',
    });
    return jsonResponse({ ok: false, error: 'Post blocked by moderation.' }, 422);
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = isCommunitySubmissionRateLimited(ip, payload);
  if (rate.limited) {
    return jsonResponse({ ok: false, error: rate.reason || 'Posting too fast.' }, 429);
  }

  const record = buildCommunityDeckRecord(payload);
  const decks = await getCommunityDeckStore(env);
  decks.unshift(record);
  if (decks.length > COMMUNITY_MAX_ITEMS) {
    decks.length = COMMUNITY_MAX_ITEMS;
  }
  await saveCommunityDeckStore(env, decks);
  return jsonResponse({ ok: true, data: { deck: record } }, 201);
}

async function handleCommunityDeckList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const formatFilter = (url.searchParams.get('format') || '').toLowerCase();
  const archetypeFilter = (url.searchParams.get('archetype') || '').toLowerCase().trim();
  const sortRaw = (url.searchParams.get('sort') || 'newest').toLowerCase();
  const sortMode = sortRaw === 'top' || sortRaw === 'archetype' ? sortRaw : 'newest';
  const search = (url.searchParams.get('q') || '').toLowerCase().trim();
  const limitRaw = Number(url.searchParams.get('limit') || 20);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.trunc(limitRaw))) : 20;

  const decks = await getCommunityDeckStore(env);
  const filtered = decks
    .filter((deck) => deck.id !== '__meta_snapshot__')
    .filter((deck) => !formatFilter || deck.format === formatFilter)
    .filter((deck) => !archetypeFilter || deck.archetype.toLowerCase() === archetypeFilter)
    .filter((deck) => {
      if (!search) return true;
      const haystack = `${deck.name} ${deck.commander} ${deck.archetype} ${deck.authorDisplayName || ''} ${deck.tags.join(' ')}`.toLowerCase();
      return haystack.includes(search);
    });

  const sorted = [...filtered].sort((a, b) => {
    if (sortMode === 'top') {
      if (b.upvotes !== a.upvotes) return b.upvotes - a.upvotes;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    }
    if (sortMode === 'archetype') {
      const byArchetype = a.archetype.localeCompare(b.archetype);
      if (byArchetype !== 0) return byArchetype;
      return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    }
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  const items = sorted.slice(0, limit);

  return jsonResponse({ ok: true, data: { items, total: items.length } }, 200, 'public, max-age=20');
}

async function handleCommunityDeckVote(request: Request, env: Env): Promise<Response> {
  const bodyText = await request.text();
  if (!bodyText || bodyText.length > 2000) {
    return jsonResponse({ ok: false, error: 'Invalid payload size.' }, 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ ok: false, error: 'Malformed JSON.' }, 400);
  }
  if (!isObject(parsed)) {
    return jsonResponse({ ok: false, error: 'Invalid vote payload.' }, 400);
  }
  const id = typeof parsed.deckId === 'string' ? parsed.deckId : '';
  const vote = parsed.vote === 'up' ? 'up' : '';
  if (!id || !vote) {
    return jsonResponse({ ok: false, error: 'Invalid vote payload.' }, 400);
  }

  const voterIp = request.headers.get('CF-Connecting-IP') || 'unknown';
  const voterKey = `${id}:${hashLike(voterIp)}`;
  const recentVoteAt = communityVoteMap.get(voterKey) || 0;
  if (Date.now() - recentVoteAt < 60 * 60 * 1000) {
    return jsonResponse({ ok: false, error: 'You already voted recently for this deck.' }, 429);
  }

  if (env.COMMUNITY_DB) {
    await ensureCommunityDbSchema(env);
    const existingVote = await env.COMMUNITY_DB.prepare(
      'SELECT deck_id FROM community_votes WHERE deck_id = ? AND voter_ip_hash = ? LIMIT 1',
    ).bind(id, hashLike(voterIp)).first<{ deck_id?: string }>();
    if (existingVote?.deck_id) {
      return jsonResponse({ ok: false, error: 'You already voted for this deck.' }, 429);
    }
    const voteInsert = await env.COMMUNITY_DB.prepare(`
      INSERT OR IGNORE INTO community_votes (deck_id, voter_ip_hash, created_at)
      VALUES (?, ?, ?)
    `).bind(id, hashLike(voterIp), new Date().toISOString()).run();
    if (!voteInsert.success) {
      return jsonResponse({ ok: false, error: 'Vote could not be processed.' }, 500);
    }
  }

  const decks = await getCommunityDeckStore(env);
  const target = decks.find((deck) => deck.id === id);
  if (!target) {
    return jsonResponse({ ok: false, error: 'Deck not found.' }, 404);
  }
  target.upvotes += 1;
  communityVoteMap.set(voterKey, Date.now());
  await saveCommunityDeckStore(env, decks);
  return jsonResponse({ ok: true, data: { deckId: target.id, upvotes: target.upvotes } });
}

async function recalcRealtimeMetaSnapshot(env: Env): Promise<MetaRealtimeSnapshot> {
  const now = Date.now();
  const recentEvents = analyticsEventLog.filter((event) => now - event.occurredAtMs <= 60 * 60 * 1000);
  const activeSessions = new Set(recentEvents.map((event) => event.sessionId)).size;
  const decks = (await getCommunityDeckStore(env)).filter((deck) => deck.id !== '__meta_snapshot__');
  const previousSnapshot = await getRealtimeMetaSnapshot(env);

  const archetypeCounter = new Map<string, number>();
  for (const event of recentEvents) {
    const metaContext = isObject(event.properties.meta_context) ? event.properties.meta_context : null;
    const mode = typeof metaContext?.mode === 'string' ? metaContext.mode : null;
    if (!mode) continue;
    archetypeCounter.set(mode, (archetypeCounter.get(mode) || 0) + 1);
  }

  const total = Math.max(1, Array.from(archetypeCounter.values()).reduce((sum, n) => sum + n, 0));
  const topArchetypes = Array.from(archetypeCounter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count], index) => ({
      name,
      share: Number((count / total).toFixed(3)),
      trend: index % 3 === 0 ? 'up' as const : index % 3 === 1 ? 'flat' as const : 'down' as const,
    }));

  const topCards = [...decks]
    .sort((a, b) => b.upvotes - a.upvotes)
    .slice(0, 25)
    .map((deck) => ({ name: deck.commander, delta: Math.max(1, Math.min(15, deck.upvotes + 1)) }))
    .slice(0, 5);

  const fallbackArchetypes = topArchetypes.length === 0;
  const fallbackCards = topCards.length === 0;
  const resolvedArchetypes = fallbackArchetypes ? previousSnapshot.archetypes : topArchetypes;
  const resolvedTrendingCards = fallbackCards ? previousSnapshot.trendingCards : topCards;

  const sessionSignal = clamp01(activeSessions / 20);
  const eventVolume = clamp01(recentEvents.length / 160);
  const communityCoverage = clamp01(decks.length / 80);
  const archetypeDiversity = clamp01(resolvedArchetypes.length / 5);

  const confidenceScore = Number((
    (sessionSignal * 0.42)
    + (eventVolume * 0.28)
    + (communityCoverage * 0.20)
    + (archetypeDiversity * 0.10)
  ).toFixed(3));
  const confidenceBand = metaConfidenceBand(confidenceScore);

  const qualityReasons: string[] = [];
  if (activeSessions < 3) qualityReasons.push('low_active_sessions');
  if (recentEvents.length < 20) qualityReasons.push('limited_event_volume');
  if (decks.length < 5) qualityReasons.push('limited_community_coverage');
  if (fallbackArchetypes) qualityReasons.push('archetype_fallback');
  if (fallbackCards) qualityReasons.push('trending_cards_fallback');

  const fallbackMode: MetaRealtimeSnapshot['quality']['fallbackMode'] =
    fallbackArchetypes && fallbackCards
      ? 'snapshot-fallback'
      : (fallbackArchetypes || fallbackCards ? 'partial-fallback' : 'live');

  const degraded = fallbackMode !== 'live'
    || confidenceBand === 'low'
    || qualityReasons.length >= 3;

  const snapshot: MetaRealtimeSnapshot = {
    updatedAt: new Date().toISOString(),
    source: 'derived-analytics',
    activeSessions,
    confidence: {
      score: confidenceScore,
      band: confidenceBand,
      components: {
        sessionSignal,
        eventVolume,
        communityCoverage,
        archetypeDiversity,
      },
    },
    quality: {
      degraded,
      fallbackMode,
      label: metaFallbackLabel(fallbackMode, degraded),
      reasons: qualityReasons,
    },
    freshness: {
      ageMinutes: 0,
      state: 'fresh',
    },
    archetypes: resolvedArchetypes,
    trendingCards: resolvedTrendingCards,
  };
  const hydratedSnapshot = refreshMetaFreshness(snapshot);
  await saveRealtimeMetaSnapshot(env, hydratedSnapshot);
  return hydratedSnapshot;
}

async function handleRealtimeMetaSnapshot(env: Env): Promise<Response> {
  const snapshot = refreshMetaFreshness(await recalcRealtimeMetaSnapshot(env));
  return jsonResponse({ ok: true, data: snapshot }, 200, 'public, max-age=10');
}

async function handleMonitorHealth(env: Env): Promise<Response> {
  const decks = await getCommunityDeckStore(env);
  const flags = await getAbuseFlags(env);
  const now = Date.now();
  const recentFlags = flags.filter((flag) => now - Date.parse(flag.reportedAt) <= 24 * 60 * 60 * 1000);
  const recentAnalytics = analyticsEventLog.filter((evt) => now - evt.occurredAtMs <= 60 * 60 * 1000);
  return jsonResponse({
    ok: true,
    data: {
      status: 'ok',
      persistence: env.COMMUNITY_DB ? 'd1' : env.COMMUNITY_KV ? 'kv' : 'memory',
      communityDecks: decks.filter((deck) => deck.id !== '__meta_snapshot__').length,
      abuseFlags24h: recentFlags.length,
      analyticsEvents1h: recentAnalytics.length,
      rateLimiterKeys: rateLimitMap.size,
      generatedAt: new Date().toISOString(),
    },
  }, 200, 'no-store');
}

async function fetchJsonWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'DeckLens/2.0 (https://decklens.pages.dev)');
  }
  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

interface ScryfallChunkFetchResult {
  cards: RecommendationCardMetrics[];
  retries: number;
  upstreamFailures: number;
  timeoutFailures: number;
  warnings: string[];
  completed: boolean;
}

async function fetchScryfallChunkWithRetry(chunk: string[], chunkIndex: number): Promise<ScryfallChunkFetchResult> {
  let retries = 0;
  let upstreamFailures = 0;
  let timeoutFailures = 0;
  const warnings: string[] = [];

  for (let attempt = 0; attempt <= SCRYFALL_RETRY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchJsonWithTimeout('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: chunk.map((name) => ({ name })) }),
      }, SCRYFALL_FETCH_TIMEOUT_MS);

      if (!response.ok) {
        upstreamFailures += 1;
        if (isRetryableStatus(response.status) && attempt < SCRYFALL_RETRY_ATTEMPTS) {
          retries += 1;
          const backoff = SCRYFALL_RETRY_BACKOFF_BASE_MS * (attempt + 1);
          await sleep(backoff);
          continue;
        }
        warnings.push(`Chunk ${chunkIndex + 1} failed with status ${response.status}.`);
        return {
          cards: [],
          retries,
          upstreamFailures,
          timeoutFailures,
          warnings,
          completed: false,
        };
      }

      const data = await response.json() as ScryfallCollectionResponse;
      const cards = (data.data || []).map(parseScryfallCardToMetrics);

      return {
        cards,
        retries,
        upstreamFailures,
        timeoutFailures,
        warnings,
        completed: true,
      };
    } catch (error) {
      upstreamFailures += 1;
      if (isAbortError(error)) {
        timeoutFailures += 1;
      }

      if (attempt < SCRYFALL_RETRY_ATTEMPTS) {
        retries += 1;
        const backoff = SCRYFALL_RETRY_BACKOFF_BASE_MS * (attempt + 1);
        await sleep(backoff);
        continue;
      }

      warnings.push(`Chunk ${chunkIndex + 1} failed after retries.`);
      return {
        cards: [],
        retries,
        upstreamFailures,
        timeoutFailures,
        warnings,
        completed: false,
      };
    }
  }

  return {
    cards: [],
    retries,
    upstreamFailures,
    timeoutFailures,
    warnings,
    completed: false,
  };
}

async function fetchScryfallCardsByName(cardNames: string[]): Promise<CardMetricFetchResult> {
  pruneRecommendationCardMetricsCache();

  const uniqueNames = [...new Set(cardNames.map((name) => name.trim()).filter(Boolean))];
  const lookup: Record<string, RecommendationCardMetrics> = {};
  const sourceByName = new Map<string, CachedCardMetricEntry['source']>();

  const diagnostics: RecommendationRequestDiagnostics = {
    resolvedCardMetrics: 0,
    totalRequestedCardMetrics: uniqueNames.length,
    cacheHits: 0,
    cacheMisses: 0,
    fetchedFromUpstream: 0,
    retries: 0,
    upstreamFailures: 0,
    timeoutFailures: 0,
    degraded: false,
    warnings: [],
  };

  if (uniqueNames.length === 0) {
    return { lookup, diagnostics };
  }

  const unresolvedNames: string[] = [];
  for (const name of uniqueNames) {
    const cached = getCachedCardMetric(name);
    const key = normalizeCardNameKey(name);
    if (cached) {
      lookup[key] = cached.metrics;
      sourceByName.set(key, cached.source);
      diagnostics.cacheHits += 1;
    } else {
      diagnostics.cacheMisses += 1;
      unresolvedNames.push(name);
    }
  }

  const chunks = chunkBySize(unresolvedNames, SCRYFALL_CHUNK_SIZE);
  let chunkCursor = 0;

  async function chunkWorker(): Promise<void> {
    while (true) {
      const chunkIndex = chunkCursor;
      chunkCursor += 1;
      if (chunkIndex >= chunks.length) return;

      const chunk = chunks[chunkIndex];
      if (!chunk) continue;

      const result = await fetchScryfallChunkWithRetry(chunk, chunkIndex);
      diagnostics.retries += result.retries;
      diagnostics.upstreamFailures += result.upstreamFailures;
      diagnostics.timeoutFailures += result.timeoutFailures;
      if (result.warnings.length > 0) {
        diagnostics.warnings.push(...result.warnings);
      }

      if (!result.completed) {
        diagnostics.degraded = true;
        continue;
      }

      const returnedKeys = new Set<string>();
      for (const metrics of result.cards) {
        const cardKey = normalizeCardNameKey(metrics.name);
        if (!cardKey) continue;

        lookup[cardKey] = metrics;
        sourceByName.set(cardKey, 'scryfall');
        returnedKeys.add(cardKey);
        diagnostics.fetchedFromUpstream += 1;
        setCachedCardMetric(metrics.name, metrics, 'scryfall');
      }

      for (const requestedName of chunk) {
        const requestedKey = normalizeCardNameKey(requestedName);
        if (!requestedKey || returnedKeys.has(requestedKey)) continue;

        const fallback = createFallbackCardMetric(requestedName);
        lookup[requestedKey] = fallback;
        sourceByName.set(requestedKey, 'fallback');
        setCachedCardMetric(requestedName, fallback, 'fallback');
      }
    }
  }

  const workerCount = Math.max(1, Math.min(SCRYFALL_FETCH_CONCURRENCY, chunks.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => chunkWorker()));

  diagnostics.resolvedCardMetrics = [...sourceByName.values()].filter((source) => source === 'scryfall').length;

  if (diagnostics.cacheMisses > 0 && diagnostics.resolvedCardMetrics < diagnostics.totalRequestedCardMetrics) {
    diagnostics.degraded = true;
  }

  if (diagnostics.degraded && diagnostics.warnings.length === 0) {
    diagnostics.warnings.push('Partial card metrics unavailable. Using graceful fallback heuristics.');
  }

  return {
    lookup,
    diagnostics,
  };
}

async function withTimeoutOrNull<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeoutRef: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutRef = setTimeout(() => resolve(null), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutRef) clearTimeout(timeoutRef);
  }
}

async function handleRecommendationRequest(request: Request): Promise<Response> {
  try {
    const bodyText = await request.text();
    if (!bodyText || bodyText.length > 200_000) {
      throw new RecommendationValidationError('Invalid payload size.');
    }

    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(bodyText);
    } catch {
      throw new RecommendationValidationError('Malformed JSON.');
    }

    const payload = parseRecommendationPayload(parsedRaw);
    if (!payload) {
      throw new RecommendationValidationError('Invalid recommendation payload.');
    }

    const namesFromDeck = [...payload.deck.main, ...payload.deck.sideboard, ...payload.deck.commander].map((entry) => entry.name);
    const namesToResolve = [...namesFromDeck, ...recommendationCandidateNames()];

    const startedAt = Date.now();
    const cardMetricsResult = await withTimeoutOrNull(
      fetchScryfallCardsByName(namesToResolve),
      RECOMMENDATION_ANALYSIS_TIMEOUT_MS,
    );

    const diagnostics: RecommendationRequestDiagnostics = cardMetricsResult?.diagnostics || {
      resolvedCardMetrics: 0,
      totalRequestedCardMetrics: new Set(namesToResolve.map(normalizeCardNameKey)).size,
      cacheHits: 0,
      cacheMisses: new Set(namesToResolve.map(normalizeCardNameKey)).size,
      fetchedFromUpstream: 0,
      retries: 0,
      upstreamFailures: 0,
      timeoutFailures: 1,
      degraded: true,
      warnings: ['Card metric fetch timed out. Falling back to sparse analysis.'],
    };

    const cardMetricsByName = cardMetricsResult?.lookup || {};

    let data;
    let fallbackUsed = false;
    const warnings = [...diagnostics.warnings];

    try {
      data = generateRecommendationEngineV1({
        deck: payload.deck,
        collectionByName: payload.collection,
        metaMode: payload.metaMode,
        maxRecommendations: payload.maxRecommendations,
        cardMetricsByName,
      });
    } catch (error) {
      fallbackUsed = true;
      warnings.push('Recommendation engine fallback activated due to partial processing failure.');
      console.error('[recommendations] primary engine failed, using fallback:', error);
      data = generateRecommendationEngineV1({
        deck: payload.deck,
        collectionByName: payload.collection,
        metaMode: payload.metaMode,
        maxRecommendations: payload.maxRecommendations,
        cardMetricsByName: {},
      });
    }

    const response = {
      ok: true,
      request: {
        metaMode: payload.metaMode,
        maxRecommendations: payload.maxRecommendations,
        resolvedCardMetrics: diagnostics.resolvedCardMetrics,
        totalRequestedCardMetrics: diagnostics.totalRequestedCardMetrics,
        cacheHits: diagnostics.cacheHits,
        cacheMisses: diagnostics.cacheMisses,
        fetchedFromUpstream: diagnostics.fetchedFromUpstream,
        retries: diagnostics.retries,
        upstreamFailures: diagnostics.upstreamFailures,
        timeoutFailures: diagnostics.timeoutFailures,
        degraded: diagnostics.degraded || fallbackUsed,
        fallbackUsed,
        durationMs: Date.now() - startedAt,
      },
      warnings,
      data,
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    const recommendationError = toRecommendationError(error);
    return recommendationErrorResponse(recommendationError);
  }
}

async function handleMoxfield(deckId: string): Promise<Response> {
  if (!isValidMoxfieldId(deckId)) {
    return new Response(JSON.stringify({ error: 'Invalid Moxfield deck ID' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const upstream = await fetch(`https://api2.moxfield.com/v3/decks/all/${deckId}`, {
    headers: {
      'User-Agent': 'PostmanRuntime/7.31.1',
      'Accept': 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
    },
  });

  if (!upstream.ok) {
    const status = upstream.status === 404 ? 404 : 502;
    return new Response(JSON.stringify({ error: `Moxfield returned ${upstream.status}` }), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const data = await upstream.text();
  return new Response(data, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300', // cache 5 min
    },
  });
}

async function handleArchidekt(deckId: string): Promise<Response> {
  if (!isValidArchidektId(deckId)) {
    return new Response(JSON.stringify({ error: 'Invalid Archidekt deck ID' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const upstream = await fetch(`https://archidekt.com/api/decks/${deckId}/`, {
    headers: {
      'User-Agent': 'PostmanRuntime/7.31.1',
      'Accept': 'application/json',
    },
  });

  if (!upstream.ok) {
    const status = upstream.status === 404 ? 404 : 502;
    return new Response(JSON.stringify({ error: `Archidekt returned ${upstream.status}` }), {
      status,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const data = await upstream.text();
  return new Response(data, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export function __resetRecommendationCacheForTests(): void {
  recommendationCardMetricsCache.clear();
}

async function handleEdhrecCommander(commanderName: string): Promise<Response> {
  try {
    const client = getEDHRECClient();
    const [commanderData, highSynergy, trending] = await Promise.all([
      client.getCommanderData(commanderName),
      client.getHighSynergyCards(commanderName, 10),
      client.getTrendingCards('week'),
    ]);

    const response = {
      ok: true,
      data: {
        highSynergy,
        staples: commanderData?.top_cards?.slice(0, 10) || [],
        trending: trending.slice(0, 8),
        themes: commanderData?.themes || [],
        tribes: commanderData?.tribes || [],
      },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: 'Failed to fetch EDHREC data' }), {
      status: 502,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

// ──── Collaborative Editing Handlers ────

function generateCollabToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 32; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function generateSessionId(): string {
  return `cs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateVersionId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ──── Versioning Handlers (Phase 1) ────

async function handleGetBranches(deckId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: true, data: { branches: [] } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const rows = await db.prepare('SELECT * FROM deck_branches WHERE deck_id = ? ORDER BY is_default DESC, created_at ASC')
      .bind(deckId).all<Record<string, unknown>>();
    const branches = (rows.results || []).map((r) => ({
      id: r.id,
      deckId: r.deck_id,
      name: r.name,
      description: r.description || '',
      createdBy: r.created_by || null,
      createdAt: r.created_at,
      parentBranchId: r.parent_branch_id || null,
      isDefault: r.is_default === 1,
    }));
    return new Response(JSON.stringify({ ok: true, data: { branches } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleCreateBranch(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: 'Database not available' }), {
      status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const body = await request.json() as { name?: string; description?: string; parentBranchId?: string; boardsJson?: string };
    const name = (body.name || '').trim().slice(0, 50);
    if (!name) {
      return new Response(JSON.stringify({ ok: false, error: 'Branch name required' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const id = generateVersionId('br');
    const description = (body.description || '').slice(0, 200);
    const parentBranchId = body.parentBranchId || null;

    // If parent branch exists, copy its boards; otherwise use empty
    let boardsJson = body.boardsJson || '{}';
    if (parentBranchId) {
      const parent = await db.prepare('SELECT boards_json FROM deck_branches WHERE id = ? AND deck_id = ?')
        .bind(parentBranchId, deckId).first<{ boards_json: string }>();
      if (parent?.boards_json) boardsJson = parent.boards_json;
    }

    // Check if this is the first branch for this deck (make it default)
    const existing = await db.prepare('SELECT COUNT(*) as cnt FROM deck_branches WHERE deck_id = ?')
      .bind(deckId).first<{ cnt: number }>();
    const isDefault = (existing?.cnt || 0) === 0 ? 1 : 0;

    // Get user from cookie if available
    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    const createdBy = user?.id || null;

    await db.prepare(
      'INSERT INTO deck_branches (id, deck_id, name, description, created_by, parent_branch_id, boards_json, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, deckId, name, description, createdBy, parentBranchId, boardsJson, isDefault).run();

    const branch = { id, deckId, name, description, createdBy, createdAt: new Date().toISOString(), parentBranchId, isDefault: isDefault === 1 };

    return new Response(JSON.stringify({ ok: true, data: { branch } }), {
      status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleDeleteBranch(deckId: string, branchId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: 'Database not available' }), {
      status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  try {
    // Don't allow deleting the default branch
    const branch = await db.prepare('SELECT is_default FROM deck_branches WHERE id = ? AND deck_id = ?')
      .bind(branchId, deckId).first<{ is_default: number }>();
    if (!branch) {
      return new Response(JSON.stringify({ ok: false, error: 'Branch not found' }), {
        status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    if (branch.is_default === 1) {
      return new Response(JSON.stringify({ ok: false, error: 'Cannot delete default branch' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    await db.prepare('DELETE FROM deck_branches WHERE id = ? AND deck_id = ?').bind(branchId, deckId).run();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetBranchSnapshot(deckId: string, branchId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: 'Database not available' }), {
      status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const branch = await db.prepare('SELECT * FROM deck_branches WHERE id = ? AND deck_id = ?')
      .bind(branchId, deckId).first<Record<string, unknown>>();
    if (!branch) {
      return new Response(JSON.stringify({ ok: false, error: 'Branch not found' }), {
        status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    let boards = {};
    try { boards = JSON.parse(String(branch.boards_json || '{}')); } catch { /* use empty */ }
    return new Response(JSON.stringify({
      ok: true,
      data: {
        branch: { id: branch.id, deckId: branch.deck_id, name: branch.name, description: branch.description, isDefault: branch.is_default === 1 },
        boards,
      },
    }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetSnapshots(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: true, data: { snapshots: [] } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const url = new URL(request.url);
    const branchId = url.searchParams.get('branchId');
    let query = 'SELECT id, deck_id, branch_id, label, snapshot_type, card_count, created_by, created_at FROM deck_snapshots WHERE deck_id = ?';
    const params: unknown[] = [deckId];
    if (branchId) {
      query += ' AND branch_id = ?';
      params.push(branchId);
    }
    query += ' ORDER BY created_at DESC LIMIT 100';

    const stmt = db.prepare(query);
    const rows = await (params.length === 2 ? stmt.bind(params[0], params[1]) : stmt.bind(params[0])).all<Record<string, unknown>>();
    const snapshots = (rows.results || []).map((r) => ({
      id: r.id,
      label: r.label || '',
      snapshotType: r.snapshot_type || 'auto',
      cardCount: r.card_count || 0,
      createdBy: r.created_by || null,
      createdAt: r.created_at,
    }));

    return new Response(JSON.stringify({ ok: true, data: { snapshots } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleCreateSnapshot(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: 'Database not available' }), {
      status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const body = await request.json() as {
      branchId?: string; label?: string; boardsJson?: string;
      cardCount?: number; snapshotType?: string;
    };

    const id = generateVersionId('snap');
    const branchId = body.branchId || null;
    const label = (body.label || '').slice(0, 100);
    const boardsJson = body.boardsJson || '{}';
    const cardCount = body.cardCount || 0;
    const snapshotType = body.snapshotType || 'auto';

    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    const createdBy = user?.id || null;

    await db.prepare(
      'INSERT INTO deck_snapshots (id, deck_id, branch_id, label, snapshot_type, boards_json, card_count, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, deckId, branchId, label, snapshotType, boardsJson, cardCount, createdBy).run();

    // Also update the branch's boards_json if branchId is provided
    if (branchId) {
      await db.prepare('UPDATE deck_branches SET boards_json = ? WHERE id = ? AND deck_id = ?')
        .bind(boardsJson, branchId, deckId).run();
    }

    return new Response(JSON.stringify({ ok: true, data: { id, label, snapshotType, cardCount, createdAt: new Date().toISOString() } }), {
      status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetSnapshot(deckId: string, snapshotId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: 'Database not available' }), {
      status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const row = await db.prepare('SELECT * FROM deck_snapshots WHERE id = ? AND deck_id = ?')
      .bind(snapshotId, deckId).first<Record<string, unknown>>();
    if (!row) {
      return new Response(JSON.stringify({ ok: false, error: 'Snapshot not found' }), {
        status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      data: {
        snapshot: {
          id: row.id,
          label: row.label,
          snapshotType: row.snapshot_type,
          cardCount: row.card_count,
          createdBy: row.created_by,
          createdAt: row.created_at,
          boardsJson: row.boards_json,
        },
      },
    }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleGetActivity(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: true, data: { entries: [] } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const url = new URL(request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
    const rows = await db.prepare(
      'SELECT * FROM activity_log WHERE deck_id = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(deckId, limit).all<Record<string, unknown>>();

    const entries = (rows.results || []).map((r) => ({
      id: r.id,
      action: r.action,
      userName: r.participant_name || 'Anonymous',
      detail: r.details_json || '',
      timestamp: new Date(String(r.created_at)).getTime(),
      branchId: r.branch_id || null,
    }));

    return new Response(JSON.stringify({ ok: true, data: { entries } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handlePostActivity(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) {
    return new Response(JSON.stringify({ ok: false, error: 'Database not available' }), {
      status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
  try {
    const body = await request.json() as {
      action?: string; userName?: string; detail?: string; branchId?: string;
    };
    if (!body.action) {
      return new Response(JSON.stringify({ ok: false, error: 'Action required' }), {
        status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    const id = generateVersionId('act');
    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);

    await db.prepare(
      'INSERT INTO activity_log (id, deck_id, branch_id, user_id, participant_name, action, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      id, deckId, body.branchId || null, user?.id || null,
      body.userName || user?.displayName || 'Anonymous',
      body.action, body.detail || '',
    ).run();

    return new Response(JSON.stringify({ ok: true }), {
      status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

// ──── Decision Tool Handlers (Phase 2) ────

// --- Proposals ---

async function handleGetProposals(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') || 'open';
    const rows = await db.prepare(
      'SELECT * FROM change_proposals WHERE deck_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100'
    ).bind(deckId, status).all();
    return new Response(JSON.stringify({ ok: true, data: { proposals: rows.results } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleCreateProposal(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { title?: string; description?: string; changes?: unknown };
    if (!body.title) return new Response(JSON.stringify({ ok: false, error: 'Title required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    const id = generateVersionId('prop');
    await db.prepare(
      'INSERT INTO change_proposals (id, deck_id, proposed_by, proposed_by_name, title, description, changes_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      id, deckId, user?.id || null, user?.displayName || 'Anonymous',
      body.title, body.description || '', JSON.stringify(body.changes || {}),
    ).run();

    const proposal = { id, deck_id: deckId, proposed_by_name: user?.displayName || 'Anonymous', title: body.title, description: body.description || '', changes_json: JSON.stringify(body.changes || {}), status: 'open', created_at: new Date().toISOString() };
    return new Response(JSON.stringify({ ok: true, data: { proposal } }), { status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleGetProposal(deckId: string, proposalId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const proposal = await db.prepare('SELECT * FROM change_proposals WHERE id = ? AND deck_id = ?').bind(proposalId, deckId).first();
    if (!proposal) return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

    const votes = await db.prepare('SELECT * FROM proposal_votes WHERE proposal_id = ? ORDER BY created_at DESC').bind(proposalId).all();
    return new Response(JSON.stringify({ ok: true, data: { proposal, votes: votes.results } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleVoteProposal(deckId: string, proposalId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { vote?: string; participantName?: string };
    if (!body.vote || !['accept', 'reject'].includes(body.vote)) {
      return new Response(JSON.stringify({ ok: false, error: 'Vote must be accept or reject' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    const id = generateVersionId('vote');
    const voterName = user?.displayName || body.participantName || 'Anonymous';

    // Upsert: delete existing vote from same user, then insert
    if (user?.id) {
      await db.prepare('DELETE FROM proposal_votes WHERE proposal_id = ? AND user_id = ?').bind(proposalId, user.id).run();
    } else {
      await db.prepare('DELETE FROM proposal_votes WHERE proposal_id = ? AND participant_name = ?').bind(proposalId, voterName).run();
    }

    await db.prepare(
      'INSERT INTO proposal_votes (id, proposal_id, user_id, participant_name, vote) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, proposalId, user?.id || null, voterName, body.vote).run();

    // Return updated votes
    const votes = await db.prepare('SELECT * FROM proposal_votes WHERE proposal_id = ?').bind(proposalId).all();
    const accept = votes.results.filter((v: Record<string, unknown>) => v.vote === 'accept').length;
    const reject = votes.results.filter((v: Record<string, unknown>) => v.vote === 'reject').length;

    return new Response(JSON.stringify({ ok: true, data: { votes: votes.results, summary: { accept, reject, total: votes.results.length } } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleResolveProposal(deckId: string, proposalId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { decision?: string };
    if (!body.decision || !['accepted', 'rejected'].includes(body.decision)) {
      return new Response(JSON.stringify({ ok: false, error: 'Decision must be accepted or rejected' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);

    await db.prepare(
      'UPDATE change_proposals SET status = ?, resolved_at = datetime("now"), resolved_by = ? WHERE id = ? AND deck_id = ?'
    ).bind(body.decision, user?.id || null, proposalId, deckId).run();

    return new Response(JSON.stringify({ ok: true, data: { proposalId, status: body.decision } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

// --- Card Threads ---

async function handleGetThreads(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const url = new URL(request.url);
    const board = url.searchParams.get('board');
    const card = url.searchParams.get('card');

    let rows;
    if (board && card) {
      rows = await db.prepare(
        'SELECT * FROM card_threads WHERE deck_id = ? AND board = ? AND card_name = ? ORDER BY created_at ASC LIMIT 200'
      ).bind(deckId, board, card).all();
    } else {
      rows = await db.prepare(
        'SELECT * FROM card_threads WHERE deck_id = ? ORDER BY created_at DESC LIMIT 200'
      ).bind(deckId).all();
    }
    return new Response(JSON.stringify({ ok: true, data: { threads: rows.results } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleCreateThread(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { board?: string; cardName?: string; text?: string; parentId?: string };
    if (!body.board || !body.cardName || !body.text) {
      return new Response(JSON.stringify({ ok: false, error: 'board, cardName, text required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    const id = generateVersionId('thr');
    const name = user?.displayName || 'Anonymous';

    await db.prepare(
      'INSERT INTO card_threads (id, deck_id, board, card_name, user_id, participant_name, text, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, deckId, body.board, body.cardName, user?.id || null, name, body.text, body.parentId || null).run();

    const thread = { id, deck_id: deckId, board: body.board, card_name: body.cardName, participant_name: name, text: body.text, parent_id: body.parentId || null, reactions_json: '{}', created_at: new Date().toISOString() };
    return new Response(JSON.stringify({ ok: true, data: { thread } }), { status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleReactThread(deckId: string, threadId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { emoji?: string };
    if (!body.emoji) return new Response(JSON.stringify({ ok: false, error: 'Emoji required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

    const thread = await db.prepare('SELECT reactions_json FROM card_threads WHERE id = ? AND deck_id = ?').bind(threadId, deckId).first<{ reactions_json: string }>();
    if (!thread) return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

    const reactions: Record<string, number> = JSON.parse(thread.reactions_json || '{}');
    reactions[body.emoji] = (reactions[body.emoji] || 0) + 1;

    await db.prepare('UPDATE card_threads SET reactions_json = ? WHERE id = ?').bind(JSON.stringify(reactions), threadId).run();

    return new Response(JSON.stringify({ ok: true, data: { reactions } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

// --- Decision Log ---

async function handleGetDecisions(deckId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const rows = await db.prepare(
      'SELECT * FROM decision_log WHERE deck_id = ? ORDER BY created_at DESC LIMIT 200'
    ).bind(deckId).all();
    return new Response(JSON.stringify({ ok: true, data: { decisions: rows.results } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleCreateDecision(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { cardName?: string; decisionType?: string; rationale?: string };
    if (!body.decisionType || !body.rationale) {
      return new Response(JSON.stringify({ ok: false, error: 'decisionType and rationale required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    const id = generateVersionId('dec');
    const name = user?.displayName || 'Anonymous';

    await db.prepare(
      'INSERT INTO decision_log (id, deck_id, card_name, user_id, participant_name, decision_type, rationale) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, deckId, body.cardName || null, user?.id || null, name, body.decisionType, body.rationale).run();

    const decision = { id, deck_id: deckId, card_name: body.cardName || null, participant_name: name, decision_type: body.decisionType, rationale: body.rationale, created_at: new Date().toISOString() };
    return new Response(JSON.stringify({ ok: true, data: { decision } }), { status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

// --- Tasks ---

async function handleGetTasks(deckId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const rows = await db.prepare(
      'SELECT * FROM deck_tasks WHERE deck_id = ? ORDER BY priority DESC, created_at ASC'
    ).bind(deckId).all();
    return new Response(JSON.stringify({ ok: true, data: { tasks: rows.results } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleCreateTask(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { title?: string; description?: string; priority?: number };
    if (!body.title) return new Response(JSON.stringify({ ok: false, error: 'Title required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    const id = generateVersionId('task');

    await db.prepare(
      'INSERT INTO deck_tasks (id, deck_id, title, description, created_by, priority) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, deckId, body.title, body.description || '', user?.displayName || 'Anonymous', body.priority || 0).run();

    const task = { id, deck_id: deckId, title: body.title, description: body.description || '', status: 'todo', created_by: user?.displayName || 'Anonymous', priority: body.priority || 0, created_at: new Date().toISOString() };
    return new Response(JSON.stringify({ ok: true, data: { task } }), { status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleUpdateTask(deckId: string, taskId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { status?: string; assignedTo?: string; title?: string; description?: string };
    const sets: string[] = [];
    const vals: (string | null)[] = [];

    if (body.status) { sets.push('status = ?'); vals.push(body.status); if (body.status === 'done') { sets.push('completed_at = datetime("now")'); } }
    if (body.assignedTo !== undefined) { sets.push('assigned_to = ?'); vals.push(body.assignedTo || null); }
    if (body.title) { sets.push('title = ?'); vals.push(body.title); }
    if (body.description !== undefined) { sets.push('description = ?'); vals.push(body.description); }

    if (sets.length === 0) return new Response(JSON.stringify({ ok: false, error: 'Nothing to update' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

    vals.push(taskId, deckId);
    await db.prepare(`UPDATE deck_tasks SET ${sets.join(', ')} WHERE id = ? AND deck_id = ?`).bind(...vals).run();

    const task = await db.prepare('SELECT * FROM deck_tasks WHERE id = ? AND deck_id = ?').bind(taskId, deckId).first();
    return new Response(JSON.stringify({ ok: true, data: { task } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleDeleteTask(deckId: string, taskId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    await db.prepare('DELETE FROM deck_tasks WHERE id = ? AND deck_id = ?').bind(taskId, deckId).run();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

// ──── Team Intelligence Handlers (Phase 4) ────

// --- Collections ---

async function handleSyncCollection(request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    if (!user) return new Response(JSON.stringify({ ok: false, error: 'Login required' }), { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });

    const body = await request.json() as { cards?: Record<string, number> };
    if (!body.cards || typeof body.cards !== 'object') {
      return new Response(JSON.stringify({ ok: false, error: 'cards object required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // Clear old collection for this user
    await db.prepare('DELETE FROM user_collections WHERE user_id = ?').bind(user.id).run();

    // Batch insert (max 50 at a time for D1)
    const entries = Object.entries(body.cards).filter(([, qty]) => qty > 0);
    const BATCH_SIZE = 50;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      const stmts = batch.map(([name, qty]) =>
        db.prepare('INSERT INTO user_collections (user_id, card_name, qty) VALUES (?, ?, ?)').bind(user.id, name, qty)
      );
      await db.batch(stmts);
    }

    return new Response(JSON.stringify({ ok: true, data: { synced: entries.length } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleGetTeamCollection(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    // Get participants from the collab session to know which users are in this deck
    // For now, we aggregate all user_collections for users who have synced
    // The client passes userIds of the active collab participants
    const url = new URL(request.url);
    const userIdsParam = url.searchParams.get('userIds');
    const userIds = userIdsParam ? userIdsParam.split(',').filter(Boolean) : [];

    if (userIds.length === 0) {
      return new Response(JSON.stringify({ ok: true, data: { teamCollection: {} } }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Build query for all users
    const placeholders = userIds.map(() => '?').join(',');
    const rows = await db.prepare(
      `SELECT uc.user_id, uc.card_name, uc.qty, u.display_name
       FROM user_collections uc
       JOIN users u ON u.id = uc.user_id
       WHERE uc.user_id IN (${placeholders})`
    ).bind(...userIds).all();

    // Aggregate into team collection
    const teamCollection: Record<string, { total: number; owners: Array<{ name: string; qty: number }> }> = {};
    for (const row of rows.results) {
      const cardName = row.card_name as string;
      const qty = row.qty as number;
      const ownerName = row.display_name as string;

      if (!teamCollection[cardName]) {
        teamCollection[cardName] = { total: 0, owners: [] };
      }
      teamCollection[cardName].total += qty;
      teamCollection[cardName].owners.push({ name: ownerName, qty });
    }

    return new Response(JSON.stringify({ ok: true, data: { teamCollection } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

// --- Card Packages ---

async function handleGetPackages(request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const url = new URL(request.url);
    const category = url.searchParams.get('category');

    let rows;
    if (category) {
      rows = await db.prepare(
        'SELECT * FROM card_packages WHERE (is_public = 1) AND category = ? ORDER BY upvotes DESC, created_at DESC LIMIT 100'
      ).bind(category).all();
    } else {
      rows = await db.prepare(
        'SELECT * FROM card_packages WHERE (is_public = 1) ORDER BY upvotes DESC, created_at DESC LIMIT 100'
      ).all();
    }

    return new Response(JSON.stringify({ ok: true, data: { packages: rows.results } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleCreatePackage(request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    const body = await request.json() as { name?: string; description?: string; category?: string; cards?: string[] };
    if (!body.name || !body.category || !body.cards?.length) {
      return new Response(JSON.stringify({ ok: false, error: 'name, category, and cards required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const id = generateVersionId('pkg');
    await db.prepare(
      'INSERT INTO card_packages (id, name, description, category, cards_json, created_by, is_public) VALUES (?, ?, ?, ?, ?, ?, 1)'
    ).bind(id, body.name, body.description || '', body.category, JSON.stringify(body.cards), user?.id || null).run();

    const pkg = { id, name: body.name, description: body.description || '', category: body.category, cards_json: JSON.stringify(body.cards), created_by: user?.id || null, is_public: 1, upvotes: 0, created_at: new Date().toISOString() };
    return new Response(JSON.stringify({ ok: true, data: { package: pkg } }), { status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleGetPackage(packageId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const row = await db.prepare('SELECT * FROM card_packages WHERE id = ?').bind(packageId).first();
    if (!row) return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ ok: true, data: { package: row } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleDeletePackage(packageId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);
    // Only the creator can delete
    const existing = await db.prepare('SELECT created_by FROM card_packages WHERE id = ?').bind(packageId).first();
    if (!existing) return new Response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    if (user?.id && existing.created_by !== user.id) {
      return new Response(JSON.stringify({ ok: false, error: 'Only the creator can delete' }), { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    await db.prepare('DELETE FROM card_packages WHERE id = ?').bind(packageId).run();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

// --- Team Constraints ---

async function handleGetConstraints(deckId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const rows = await db.prepare(
      'SELECT * FROM team_constraints WHERE deck_id = ? ORDER BY created_at DESC'
    ).bind(deckId).all();
    return new Response(JSON.stringify({ ok: true, data: { constraints: rows.results } }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleSetConstraint(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { constraintType?: string; constraintValue?: string };
    if (!body.constraintType || body.constraintValue === undefined) {
      return new Response(JSON.stringify({ ok: false, error: 'constraintType and constraintValue required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    const user = await authenticateRequest(request, db as unknown as Parameters<typeof authenticateRequest>[1]);

    // Upsert: delete existing constraint of same type, then insert
    await db.prepare('DELETE FROM team_constraints WHERE deck_id = ? AND constraint_type = ?').bind(deckId, body.constraintType).run();

    const id = generateVersionId('con');
    await db.prepare(
      'INSERT INTO team_constraints (id, deck_id, constraint_type, constraint_value, set_by) VALUES (?, ?, ?, ?, ?)'
    ).bind(id, deckId, body.constraintType, body.constraintValue, user?.displayName || 'Anonymous').run();

    const constraint = { id, deck_id: deckId, constraint_type: body.constraintType, constraint_value: body.constraintValue, set_by: user?.displayName || 'Anonymous', created_at: new Date().toISOString() };
    return new Response(JSON.stringify({ ok: true, data: { constraint } }), { status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleDeleteConstraint(deckId: string, constraintId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    await db.prepare('DELETE FROM team_constraints WHERE id = ? AND deck_id = ?').bind(constraintId, deckId).run();
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

// ──── Phase 5: Collaborative Testing Handlers ────

async function handleGetTestSessions(deckId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const rows = await db.prepare('SELECT * FROM test_sessions WHERE deck_id = ? ORDER BY created_at DESC LIMIT 50').bind(deckId).all();
    return new Response(JSON.stringify({ ok: true, data: { sessions: rows.results || [] } }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleCreateTestSession(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const user = await authenticateRequest(request, env);
    const body = await request.json() as {
      openingHand?: string[];
      mulliganCount?: number;
      turnCount?: number;
      result?: string;
      notes?: string;
      keyMoments?: Array<{ turn: number; action: string; note: string }>;
    };

    const id = generateVersionId('test');
    await db.prepare(
      'INSERT INTO test_sessions (id, deck_id, player_id, player_name, opening_hand_json, mulligan_count, turn_count, result, notes, key_moments_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      id, deckId,
      user?.id || null,
      user?.displayName || 'Anonymous',
      JSON.stringify(body.openingHand || []),
      body.mulliganCount || 0,
      body.turnCount || 0,
      body.result || null,
      body.notes || null,
      JSON.stringify(body.keyMoments || []),
    ).run();

    const session = {
      id, deck_id: deckId,
      player_id: user?.id || null,
      player_name: user?.displayName || 'Anonymous',
      opening_hand_json: JSON.stringify(body.openingHand || []),
      mulligan_count: body.mulliganCount || 0,
      turn_count: body.turnCount || 0,
      result: body.result || null,
      notes: body.notes || null,
      key_moments_json: JSON.stringify(body.keyMoments || []),
      created_at: new Date().toISOString(),
    };
    return new Response(JSON.stringify({ ok: true, data: { session } }), { status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleDeleteTestSession(deckId: string, sessionId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    await db.prepare('DELETE FROM test_sessions WHERE id = ? AND deck_id = ?').bind(sessionId, deckId).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleGetSideboardPlans(deckId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const rows = await db.prepare('SELECT * FROM sideboard_plans WHERE deck_id = ? ORDER BY matchup ASC, version DESC').bind(deckId).all();
    return new Response(JSON.stringify({ ok: true, data: { plans: rows.results || [] } }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleCreateSideboardPlan(deckId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const user = await authenticateRequest(request, env);
    const body = await request.json() as {
      matchup: string;
      inCards: string[];
      outCards: string[];
      notes?: string;
    };
    if (!body.matchup || !Array.isArray(body.inCards) || !Array.isArray(body.outCards)) {
      return new Response(JSON.stringify({ ok: false, error: 'matchup, inCards, outCards required' }), { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    // Get latest version for this matchup
    const existing = await db.prepare(
      'SELECT MAX(version) as max_ver FROM sideboard_plans WHERE deck_id = ? AND matchup = ?'
    ).bind(deckId, body.matchup).first<{ max_ver: number | null }>();
    const version = (existing?.max_ver || 0) + 1;

    const id = generateVersionId('sbp');
    await db.prepare(
      'INSERT INTO sideboard_plans (id, deck_id, matchup, in_cards_json, out_cards_json, notes, created_by, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      id, deckId, body.matchup,
      JSON.stringify(body.inCards),
      JSON.stringify(body.outCards),
      body.notes || null,
      user?.displayName || 'Anonymous',
      version,
    ).run();

    const plan = {
      id, deck_id: deckId, matchup: body.matchup,
      in_cards_json: JSON.stringify(body.inCards),
      out_cards_json: JSON.stringify(body.outCards),
      notes: body.notes || null,
      created_by: user?.displayName || 'Anonymous',
      version,
      created_at: new Date().toISOString(),
    };
    return new Response(JSON.stringify({ ok: true, data: { plan } }), { status: 201, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleUpdateSideboardPlan(deckId: string, planId: string, request: Request, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    const body = await request.json() as { inCards?: string[]; outCards?: string[]; notes?: string };
    const updates: string[] = [];
    const params: unknown[] = [];
    if (body.inCards) { updates.push('in_cards_json = ?'); params.push(JSON.stringify(body.inCards)); }
    if (body.outCards) { updates.push('out_cards_json = ?'); params.push(JSON.stringify(body.outCards)); }
    if (body.notes !== undefined) { updates.push('notes = ?'); params.push(body.notes); }
    if (updates.length === 0) return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    params.push(planId, deckId);
    await db.prepare(`UPDATE sideboard_plans SET ${updates.join(', ')} WHERE id = ? AND deck_id = ?`).bind(...params).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleDeleteSideboardPlan(deckId: string, planId: string, env: Env): Promise<Response> {
  const db = env.COMMUNITY_DB;
  if (!db) return new Response(JSON.stringify({ ok: false, error: 'DB unavailable' }), { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  try {
    await db.prepare('DELETE FROM sideboard_plans WHERE id = ? AND deck_id = ?').bind(planId, deckId).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
  }
}

async function handleCollabCreate(request: Request, env: Env): Promise<Response> {
  if (!env.COLLAB_SESSION) {
    return new Response(JSON.stringify({ ok: false, error: 'Collaborative editing not available' }), {
      status: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json() as {
      deckName?: string;
      deck?: {
        name?: string;
        description?: string;
        boards?: Record<string, unknown[]>;
      };
    };

    const sessionId = generateSessionId();
    const ownerToken = generateCollabToken();

    // Get the Durable Object and initialize it
    const doId = env.COLLAB_SESSION.idFromName(sessionId);
    const stub = env.COLLAB_SESSION.get(doId);

    const initPayload = {
      deck: body.deck || { name: body.deckName || 'Untitled Deck' },
      ownerToken,
    };

    const initResp = await stub.fetch(new Request('https://collab/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initPayload),
    }));

    if (!initResp.ok) {
      return new Response(JSON.stringify({ ok: false, error: 'Failed to initialize session' }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Optionally track in D1
    if (env.COMMUNITY_DB) {
      try {
        const fingerprint = request.headers.get('X-Device-Fingerprint') || 'unknown';
        await env.COMMUNITY_DB.prepare(
          `INSERT INTO collab_sessions (id, deck_id, owner_fingerprint, created_at) VALUES (?, ?, ?, datetime('now'))`
        ).bind(sessionId, body.deck?.name || 'unnamed', fingerprint).run();
      } catch {
        // Non-critical — tracking failure is OK
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      data: { sessionId, ownerToken },
    }), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid request' }), {
      status: 400,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }
}

async function handleCollabJoin(sessionId: string, request: Request, env: Env): Promise<Response> {
  if (!env.COLLAB_SESSION) {
    return new Response('Collaborative editing not available', { status: 503 });
  }

  const doId = env.COLLAB_SESSION.idFromName(sessionId);
  const stub = env.COLLAB_SESSION.get(doId);

  // Forward the ORIGINAL request directly to the Durable Object.
  // Cloudflare Workers require the unmodified original Request for
  // WebSocket upgrades — creating a new Request() strips internal WS flags.
  // The DO now checks the Upgrade header instead of the pathname.
  return stub.fetch(request);
}

async function handleCollabInfo(sessionId: string, env: Env): Promise<Response> {
  if (!env.COLLAB_SESSION) {
    return new Response(JSON.stringify({ ok: false, error: 'Collaborative editing not available' }), {
      status: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const doId = env.COLLAB_SESSION.idFromName(sessionId);
  const stub = env.COLLAB_SESSION.get(doId);

  const resp = await stub.fetch(new Request('https://collab/info', { method: 'GET' }));
  const data = await resp.text();

  return new Response(data, {
    status: resp.status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function handleCollabClose(sessionId: string, request: Request, env: Env): Promise<Response> {
  if (!env.COLLAB_SESSION) {
    return new Response(JSON.stringify({ ok: false, error: 'Collaborative editing not available' }), {
      status: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const doId = env.COLLAB_SESSION.idFromName(sessionId);
  const stub = env.COLLAB_SESSION.get(doId);

  const body = await request.text();
  const resp = await stub.fetch(new Request('https://collab/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }));

  const data = await resp.text();

  // Optionally mark as closed in D1
  if (env.COMMUNITY_DB) {
    try {
      await env.COMMUNITY_DB.prepare(
        `UPDATE collab_sessions SET closed_at = datetime('now') WHERE id = ?`
      ).bind(sessionId).run();
    } catch {
      // Non-critical
    }
  }

  return new Response(data, {
    status: resp.status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function handleCollabSnapshot(sessionId: string, env: Env): Promise<Response> {
  if (!env.COLLAB_SESSION) {
    return new Response(JSON.stringify({ ok: false, error: 'Collaborative editing not available' }), {
      status: 503,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  }

  const doId = env.COLLAB_SESSION.idFromName(sessionId);
  const stub = env.COLLAB_SESSION.get(doId);

  const resp = await stub.fetch(new Request('https://collab/snapshot', { method: 'GET' }));
  const data = await resp.text();

  return new Response(data, {
    status: resp.status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    kvCache = env.CACHE_KV || null;

    // Set the current request origin for CORS headers (used by all handlers)
    const reqOrigin = request.headers.get('Origin') || '';
    _currentRequestOrigin = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // ───── Auth Routes ─────

    if (path === '/api/auth/github') {
      const clientId = env.GITHUB_CLIENT_ID;
      if (!clientId) {
        return new Response(JSON.stringify({ ok: false, error: 'GitHub OAuth not configured' }), {
          status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      // Dynamically determine frontend URL from request origin or referer
      const requestUrl = new URL(request.url);
      const referer = request.headers.get('Referer');
      let frontendUrl = env.FRONTEND_URL || 'https://decklens.chrisgarkisch.workers.dev';
      
      // If referer is from an allowed origin, use it
      if (referer) {
        const refererUrl = new URL(referer);
        if (ALLOWED_ORIGINS.includes(refererUrl.origin)) {
          frontendUrl = refererUrl.origin;
        }
      }
      
      const redirectUri = `${requestUrl.origin}/api/auth/github/callback`;
      
      // Get return URL from query parameter
      let returnUrl = requestUrl.searchParams.get('return') || '/';
      
      // Validate: must start with / and not contain protocol (prevent open redirect)
      if (!returnUrl.startsWith('/') || returnUrl.includes('://')) {
        returnUrl = '/';
      }
      
      // Create state with return URL encoded: randomId|returnUrl
      const stateId = generateId();
      const state = `${stateId}|${returnUrl}`;
      
      return handleGitHubRedirect(clientId, redirectUri, state);
    }

    if (path === '/api/auth/github/callback') {
      const clientId = env.GITHUB_CLIENT_ID;
      const clientSecret = env.GITHUB_CLIENT_SECRET;
      const db = env.COMMUNITY_DB;
      if (!clientId || !clientSecret || !db) {
        return new Response('Auth not configured', { status: 500 });
      }
      
      // Dynamically determine frontend URL from request origin or referer
      const referer = request.headers.get('Referer');
      let frontendUrl = env.FRONTEND_URL || 'https://decklens.chrisgarkisch.workers.dev';
      if (referer) {
        const refererUrl = new URL(referer);
        if (ALLOWED_ORIGINS.includes(refererUrl.origin)) {
          frontendUrl = refererUrl.origin;
        }
      }
      
      return handleGitHubCallback(request, clientId, clientSecret, db as unknown as Parameters<typeof handleGitHubCallback>[3], frontendUrl);
    }

    if (path === '/api/auth/me') {
      const db = env.COMMUNITY_DB;
      if (!db) {
        return new Response(JSON.stringify({ ok: true, data: { user: null } }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleAuthMe(request, db as unknown as Parameters<typeof handleAuthMe>[1], CORS_HEADERS);
    }

    if (path === '/api/auth/logout') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const db = env.COMMUNITY_DB;
      if (!db) {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleAuthLogout(request, db as unknown as Parameters<typeof handleAuthLogout>[1], CORS_HEADERS);
    }

    // Google OAuth
    if (path === '/api/auth/google') {
      const clientId = env.GOOGLE_CLIENT_ID;
      if (!clientId) {
        return new Response(JSON.stringify({ ok: false, error: 'Google OAuth not configured' }), {
          status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      
      // Dynamically determine frontend URL from request origin or referer
      const requestUrl = new URL(request.url);
      const referer = request.headers.get('Referer');
      let frontendUrl = env.FRONTEND_URL || 'https://decklens.chrisgarkisch.workers.dev';
      
      // If referer is from an allowed origin, use it
      if (referer) {
        const refererUrl = new URL(referer);
        if (ALLOWED_ORIGINS.includes(refererUrl.origin)) {
          frontendUrl = refererUrl.origin;
        }
      }
      
      const redirectUri = `${requestUrl.origin}/api/auth/google/callback`;
      
      // Get return URL from query parameter
      let returnUrl = requestUrl.searchParams.get('return') || '/';
      
      // Validate: must start with / and not contain protocol (prevent open redirect)
      if (!returnUrl.startsWith('/') || returnUrl.includes('://')) {
        returnUrl = '/';
      }
      
      // Create state with return URL encoded: randomId|returnUrl
      const stateId = generateId();
      const state = `${stateId}|${returnUrl}`;
      
      return handleGoogleRedirect(clientId, redirectUri, state);
    }

    if (path === '/api/auth/google/callback') {
      const clientId = env.GOOGLE_CLIENT_ID;
      const clientSecret = env.GOOGLE_CLIENT_SECRET;
      const db = env.COMMUNITY_DB;
      if (!clientId || !clientSecret || !db) {
        return new Response('Google Auth not configured', { status: 500 });
      }
      
      // Dynamically determine frontend URL from request origin or referer
      const referer = request.headers.get('Referer');
      let frontendUrl = env.FRONTEND_URL || 'https://decklens.chrisgarkisch.workers.dev';
      if (referer) {
        const refererUrl = new URL(referer);
        if (ALLOWED_ORIGINS.includes(refererUrl.origin)) {
          frontendUrl = refererUrl.origin;
        }
      }
      
      return handleGoogleCallback(request, clientId, clientSecret, db as unknown as Parameters<typeof handleGoogleCallback>[3], frontendUrl);
    }

    // ───── Analytics Routes ─────

    if (path === '/api/analytics/events') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleAnalyticsEvent(request, env);
    }

    if (path === '/api/analytics/health') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleAnalyticsHealth();
    }

    if (path === '/api/analytics/dashboard') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleAnalyticsDashboard(request);
    }

    // Enhanced KPI Dashboard Routes
    if (path.startsWith('/api/analytics/kpi/business')) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const days = parseDashboardDays(request.url);
      const kpis = buildBusinessKPIs(days);
      return new Response(JSON.stringify({ ok: true, data: kpis }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (path.startsWith('/api/analytics/kpi/growth')) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const days = parseDashboardDays(request.url);
      const kpis = buildGrowthKPIs(days);
      return new Response(JSON.stringify({ ok: true, data: kpis }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (path.startsWith('/api/analytics/kpi/technical')) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const kpis = buildTechnicalKPIs();
      return new Response(JSON.stringify({ ok: true, data: kpis }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (path.startsWith('/api/analytics/kpi/community')) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const days = parseDashboardDays(request.url);
      const feedbackData = buildFeedbackAnalytics(days);
      return new Response(JSON.stringify({ ok: true, data: feedbackData }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (path.startsWith('/api/analytics/live/updates')) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleAnalyticsLiveUpdates(request);
    }

    if (path.startsWith('/api/analytics/public/summary')) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const publicData = buildPublicSummary();
      return new Response(JSON.stringify({ ok: true, data: publicData }), {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (path === '/api/scryfall/autocomplete') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleScryfallAutocomplete(request);
    }

    if (path === '/api/scryfall/search') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleScryfallSearch(request);
    }

    if (path === '/api/scryfall/resolve') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleScryfallResolve(request, env, ctx);
    }

    if (path === '/api/spellbook/combos') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleSpellbookFindCombos(request, env, ctx);
    }

    // ───── Combo System Routes ─────

    if (path === '/api/combos/lookup') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleComboLookup(request, env);
    }

    if (path === '/api/combos/sync') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleComboSync(request, env);
    }

    if (path === '/api/combos/stats') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleComboStats(env);
    }

    if (path === '/api/combos/seed') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleComboSeed(env);
    }

    if (path === '/api/combos/templates/match') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleComboTemplateMatch(request, env);
    }

    if (path === '/api/combos/suggest') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      // Rate limit: 3 suggestions per IP per hour (use isRateLimited which is general)
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleComboSuggest(request, env);
    }

    if (path === '/api/combos/suggestions') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      // Admin auth required
      const adminSecret = request.headers.get('X-Admin-Secret');
      if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
        return jsonResponse({ ok: false, error: 'Unauthorized.' }, 403, 'no-store');
      }
      return handleComboSuggestionsList(request, env);
    }

    const comboSuggestionReviewMatch = path.match(/^\/api\/combos\/suggestions\/([a-z0-9:_-]+)\/review$/);
    if (comboSuggestionReviewMatch) {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      // Admin auth required
      const adminSecret = request.headers.get('X-Admin-Secret');
      if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
        return jsonResponse({ ok: false, error: 'Unauthorized.' }, 403, 'no-store');
      }
      return handleComboSuggestionReview(request, env, comboSuggestionReviewMatch[1]);
    }

    // Commander Stats API
    if (path === '/api/commander-stats/seed-edhrec-json') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      // Admin only - seed from EDHREC JSON API
      const adminSecret = request.headers.get('X-Admin-Secret');
      if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
        return jsonResponse({ ok: false, error: 'Unauthorized.' }, 403, 'no-store');
      }
      const db = env.COMMUNITY_DB as unknown as D1Database;
      if (!db) {
        return jsonResponse({ ok: false, error: 'Database not configured' }, 500);
      }

      // Parse request body for limit
      let limit = 100;
      try {
        const body = await request.json() as any;
        if (body.limit && typeof body.limit === 'number') {
          limit = Math.min(Math.max(1, body.limit), 200);
        }
      } catch {
        // Use default
      }

      // Fetch top commanders from EDHREC
      console.log(`[Commander Stats] Fetching top ${limit} commanders from EDHREC JSON API...`);
      const topCommanders = await fetchTopCommandersFromEDHREC(limit);

      if (topCommanders.length === 0) {
        return jsonResponse({ ok: false, error: 'Failed to fetch commanders from EDHREC' }, 500);
      }

      // Seed database with real EDHREC data
      const seededCount = await seedCommanderStatsFromEDHRECJSON(
        db,
        topCommanders,
        (current, total, commander) => {
          console.log(`[Commander Stats] Seeding ${current}/${total}: ${commander}`);
        }
      );

      return jsonResponse({
        ok: true,
        seededCount,
        totalFetched: topCommanders.length,
        message: `Seeded ${seededCount} commanders from EDHREC JSON API with real deck counts`
      });
    }

    if (path === '/api/commander-stats/seed-scryfall') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      // Admin only - seed from Scryfall
      const adminSecret = request.headers.get('X-Admin-Secret');
      if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
        return jsonResponse({ ok: false, error: 'Unauthorized.' }, 403, 'no-store');
      }
      const db = env.COMMUNITY_DB as unknown as D1Database;
      if (!db) {
        return jsonResponse({ ok: false, error: 'Database not configured' }, 500);
      }

      // Parse request body for limit
      let limit = 500;
      try {
        const body = await request.json() as any;
        if (body.limit && typeof body.limit === 'number') {
          limit = Math.min(Math.max(1, body.limit), 1000);
        }
      } catch {
        // Use default
      }

      // Seed from Scryfall
      console.log(`[Commander Stats] Seeding ${limit} commanders from Scryfall...`);
      const seededCount = await seedCommanderStatsFromScryfall(db, limit);

      return jsonResponse({
        ok: true,
        seededCount,
        message: `Seeded ${seededCount} commanders from Scryfall`
      });
    }

    if (path === '/api/commander-stats/seed-edhrec') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      // Admin only - seed from EDHREC
      const adminSecret = request.headers.get('X-Admin-Secret');
      if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
        return jsonResponse({ ok: false, error: 'Unauthorized.' }, 403, 'no-store');
      }
      const db = env.COMMUNITY_DB as unknown as D1Database;
      if (!db) {
        return jsonResponse({ ok: false, error: 'Database not configured' }, 500);
      }

      // Parse request body for limit
      let limit = 100;
      try {
        const body = await request.json() as any;
        if (body.limit && typeof body.limit === 'number') {
          limit = Math.min(Math.max(1, body.limit), 500);
        }
      } catch {
        // Use default
      }

      // Scrape top commanders from EDHREC
      console.log(`[Commander Stats] Scraping top ${limit} commanders from EDHREC...`);
      const topCommanders = await scrapeTopCommanders(limit);

      if (topCommanders.length === 0) {
        return jsonResponse({ ok: false, error: 'Failed to scrape EDHREC' }, 500);
      }

      // Seed database
      const seededCount = await seedCommanderStatsFromEDHREC(
        db,
        topCommanders,
        (current, total, commander) => {
          console.log(`[Commander Stats] Seeding ${current}/${total}: ${commander}`);
        }
      );

      return jsonResponse({
        ok: true,
        seededCount,
        totalScraped: topCommanders.length,
        message: `Seeded ${seededCount} commanders from EDHREC`
      });
    }

    if (path === '/api/commander-stats/refresh') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      // Admin only - manual refresh trigger
      const adminSecret = request.headers.get('X-Admin-Secret');
      if (!env.ADMIN_SECRET || adminSecret !== env.ADMIN_SECRET) {
        return jsonResponse({ ok: false, error: 'Unauthorized.' }, 403, 'no-store');
      }
      const db = env.COMMUNITY_DB as unknown as D1Database;
      if (!db) {
        return jsonResponse({ ok: false, error: 'Database not configured' }, 500);
      }
      const updatedCount = await refreshCommanderStats(db);
      return jsonResponse({ ok: true, updatedCount });
    }

    if (path === '/api/commander-stats/top') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const db = env.COMMUNITY_DB as unknown as D1Database;
      if (!db) {
        return jsonResponse({ ok: false, error: 'Database not configured' }, 500);
      }
      const url = new URL(request.url);
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 500) : 100;
      const commanders = await getTopCommanders(db, limit);
      return jsonResponse({ ok: true, commanders }, 200, 'public, max-age=3600');
    }

    const commanderStatsMatch = path.match(/^\/api\/commander-stats\/(.+)$/);
    if (commanderStatsMatch && !commanderStatsMatch[1].includes('/')) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const db = env.COMMUNITY_DB as unknown as D1Database;
      if (!db) {
        return jsonResponse({ ok: false, error: 'Database not configured' }, 500);
      }
      const commanderName = decodeURIComponent(commanderStatsMatch[1]);
      const stats = await getCommanderStats(db, commanderName);
      if (!stats) {
        return jsonResponse({ ok: false, error: 'Commander not found' }, 404);
      }
      return jsonResponse({ ok: true, stats }, 200, 'public, max-age=3600');
    }

    if (path === '/api/deckbuilder/share') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleDeckbuilderShareCreate(request, env);
    }

    const deckbuilderShareMatch = path.match(/^\/api\/deckbuilder\/share\/([a-z0-9]{6,24})$/);
    if (deckbuilderShareMatch) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleDeckbuilderShareGet(deckbuilderShareMatch[1], env);
    }

    if (path === '/api/deckbuilder/public') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleDeckbuilderPublicList(request, env);
    }

    // Deck Cloud Sync routes
    if (path === '/api/decks/sync') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited.' }), { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      return handleDeckSync(request, env);
    }

    if (path === '/api/decks/mine') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleDeckListMine(request, env);
    }

    const deckSyncMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_]{4,80})$/);
    if (deckSyncMatch) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited.' }), { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      if (request.method === 'GET') {
        return handleDeckGet(deckSyncMatch[1], request, env);
      }
      if (request.method === 'DELETE') {
        return handleDeckDelete(deckSyncMatch[1], request, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    if (path === '/api/recommendations/mtg') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      return handleRecommendationRequest(request);
    }

    if (path === '/api/report/share') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      return handleReportShareRequest(request);
    }

    if (path === '/api/report/public') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }

      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }

      return handlePublicReportRequest(request);
    }

    if (path === '/api/community/decks') {
      if (request.method === 'GET') {
        return handleCommunityDeckList(request, env);
      }
      if (request.method === 'POST') {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        if (isRateLimited(ip)) {
          return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
            status: 429,
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
        return handleCommunityDeckCreate(request, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    if (path === '/api/community/vote') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleCommunityDeckVote(request, env);
    }

    if (path === '/api/community/moderation') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleCommunityModerationQueue(request, env);
    }

    if (path === '/api/community/moderation/action') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleCommunityModerationAction(request, env);
    }

    if (path === '/api/community/flag') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleCommunityAbuseFlag(request, env);
    }

    // ──── Versioning Routes (Phase 1: Branches, Snapshots, Activity) ────

    // Branches CRUD
    const branchesMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/branches$/);
    if (branchesMatch) {
      const dId = branchesMatch[1];
      if (request.method === 'GET') {
        return handleGetBranches(dId, env);
      }
      if (request.method === 'POST') {
        return handleCreateBranch(dId, request, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Single branch operations
    const branchMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/branches\/([a-zA-Z0-9_-]+)$/);
    if (branchMatch) {
      const dId = branchMatch[1];
      const bId = branchMatch[2];
      if (request.method === 'DELETE') {
        return handleDeleteBranch(dId, bId, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Branch snapshot (get current deck state for a branch)
    const branchSnapshotMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/branches\/([a-zA-Z0-9_-]+)\/snapshot$/);
    if (branchSnapshotMatch) {
      const dId = branchSnapshotMatch[1];
      const bId = branchSnapshotMatch[2];
      if (request.method === 'GET') {
        return handleGetBranchSnapshot(dId, bId, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Snapshots
    const snapshotsMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/snapshots$/);
    if (snapshotsMatch) {
      const dId = snapshotsMatch[1];
      if (request.method === 'GET') {
        return handleGetSnapshots(dId, request, env);
      }
      if (request.method === 'POST') {
        return handleCreateSnapshot(dId, request, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Single snapshot (for restore)
    const snapshotMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/snapshots\/([a-zA-Z0-9_-]+)$/);
    if (snapshotMatch) {
      const dId = snapshotMatch[1];
      const sId = snapshotMatch[2];
      if (request.method === 'GET') {
        return handleGetSnapshot(dId, sId, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Activity log
    const activityMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/activity$/);
    if (activityMatch) {
      const dId = activityMatch[1];
      if (request.method === 'GET') {
        return handleGetActivity(dId, request, env);
      }
      if (request.method === 'POST') {
        return handlePostActivity(dId, request, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // ──── Decision Tool Routes (Phase 2: Proposals, Threads, Decisions, Tasks) ────

    // Proposals CRUD
    const proposalsMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/proposals$/);
    if (proposalsMatch) {
      const dId = proposalsMatch[1];
      if (request.method === 'GET') return handleGetProposals(dId, request, env);
      if (request.method === 'POST') return handleCreateProposal(dId, request, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Single proposal + vote + resolve
    const proposalVoteMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/proposals\/([a-zA-Z0-9_-]+)\/vote$/);
    if (proposalVoteMatch && request.method === 'POST') {
      return handleVoteProposal(proposalVoteMatch[1], proposalVoteMatch[2], request, env);
    }

    const proposalResolveMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/proposals\/([a-zA-Z0-9_-]+)\/resolve$/);
    if (proposalResolveMatch && request.method === 'POST') {
      return handleResolveProposal(proposalResolveMatch[1], proposalResolveMatch[2], request, env);
    }

    const proposalMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/proposals\/([a-zA-Z0-9_-]+)$/);
    if (proposalMatch && request.method === 'GET') {
      return handleGetProposal(proposalMatch[1], proposalMatch[2], env);
    }

    // Card Threads
    const threadsMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/threads$/);
    if (threadsMatch) {
      const dId = threadsMatch[1];
      if (request.method === 'GET') return handleGetThreads(dId, request, env);
      if (request.method === 'POST') return handleCreateThread(dId, request, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const threadReactMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/threads\/([a-zA-Z0-9_-]+)\/react$/);
    if (threadReactMatch && request.method === 'POST') {
      return handleReactThread(threadReactMatch[1], threadReactMatch[2], request, env);
    }

    // Decision Log
    const decisionsMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/decisions$/);
    if (decisionsMatch) {
      const dId = decisionsMatch[1];
      if (request.method === 'GET') return handleGetDecisions(dId, env);
      if (request.method === 'POST') return handleCreateDecision(dId, request, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Tasks CRUD
    const tasksMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/tasks$/);
    if (tasksMatch) {
      const dId = tasksMatch[1];
      if (request.method === 'GET') return handleGetTasks(dId, env);
      if (request.method === 'POST') return handleCreateTask(dId, request, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const taskMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/tasks\/([a-zA-Z0-9_-]+)$/);
    if (taskMatch) {
      const dId = taskMatch[1];
      const tId = taskMatch[2];
      if (request.method === 'PUT') return handleUpdateTask(dId, tId, request, env);
      if (request.method === 'DELETE') return handleDeleteTask(dId, tId, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // ──── Team Intelligence Routes (Phase 4) ────

    // Collections
    if (path === '/api/collections/sync' && request.method === 'POST') {
      return handleSyncCollection(request, env);
    }

    const teamCollectionMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/team-collection$/);
    if (teamCollectionMatch && request.method === 'GET') {
      return handleGetTeamCollection(teamCollectionMatch[1], request, env);
    }

    // Card Packages
    if (path === '/api/packages') {
      if (request.method === 'GET') return handleGetPackages(request, env);
      if (request.method === 'POST') return handleCreatePackage(request, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const packageMatch = path.match(/^\/api\/packages\/([a-zA-Z0-9_-]+)$/);
    if (packageMatch) {
      const pId = packageMatch[1];
      if (request.method === 'GET') return handleGetPackage(pId, env);
      if (request.method === 'DELETE') return handleDeletePackage(pId, request, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Team Constraints
    const constraintsMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/constraints$/);
    if (constraintsMatch) {
      const dId = constraintsMatch[1];
      if (request.method === 'GET') return handleGetConstraints(dId, env);
      if (request.method === 'POST') return handleSetConstraint(dId, request, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const constraintMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/constraints\/([a-zA-Z0-9_-]+)$/);
    if (constraintMatch && request.method === 'DELETE') {
      return handleDeleteConstraint(constraintMatch[1], constraintMatch[2], env);
    }

    // ──── Collaborative Testing Routes (Phase 5) ────

    // Test Sessions
    const testSessionsMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/test-sessions$/);
    if (testSessionsMatch) {
      const dId = testSessionsMatch[1];
      if (request.method === 'GET') return handleGetTestSessions(dId, env);
      if (request.method === 'POST') return handleCreateTestSession(dId, request, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const testSessionMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/test-sessions\/([a-zA-Z0-9_-]+)$/);
    if (testSessionMatch && request.method === 'DELETE') {
      return handleDeleteTestSession(testSessionMatch[1], testSessionMatch[2], env);
    }

    // Sideboard Plans
    const sbPlansMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/sideboard-plans$/);
    if (sbPlansMatch) {
      const dId = sbPlansMatch[1];
      if (request.method === 'GET') return handleGetSideboardPlans(dId, env);
      if (request.method === 'POST') return handleCreateSideboardPlan(dId, request, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    const sbPlanMatch = path.match(/^\/api\/decks\/([a-zA-Z0-9_-]+)\/sideboard-plans\/([a-zA-Z0-9_-]+)$/);
    if (sbPlanMatch) {
      const dId = sbPlanMatch[1];
      const pId = sbPlanMatch[2];
      if (request.method === 'PUT') return handleUpdateSideboardPlan(dId, pId, request, env);
      if (request.method === 'DELETE') return handleDeleteSideboardPlan(dId, pId, env);
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // ──── Game Session Routes (Multiplayer) ────

    if (path === '/api/game-sessions' && request.method === 'POST') {
      if (!env.GAME_SESSION) {
        return Response.json({ ok: false, error: 'Multiplayer not available' }, { status: 503, headers: CORS_HEADERS });
      }
      const sessionId = crypto.randomUUID().slice(0, 8).toUpperCase();
      const id = env.GAME_SESSION.idFromName(sessionId);
      const stub = env.GAME_SESSION.get(id);
      // Ping the DO to initialize it
      await stub.fetch(new Request('https://game-session/init', { method: 'POST' }));
      return Response.json({ sessionId, wsUrl: `/api/game-sessions/${sessionId}/ws` }, { headers: CORS_HEADERS });
    }

    const gameSessionWsMatch = path.match(/^\/api\/game-sessions\/([A-Z0-9]+)\/ws$/);
    if (gameSessionWsMatch) {
      if (!env.GAME_SESSION) {
        return new Response('Multiplayer not available', { status: 503 });
      }
      const sessionId = gameSessionWsMatch[1];
      const id = env.GAME_SESSION.idFromName(sessionId);
      const stub = env.GAME_SESSION.get(id);
      return stub.fetch(request);
    }

    // ──── Collaborative Editing Routes ────

    if (path === '/api/collab/create') {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited.' }), { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }
      return handleCollabCreate(request, env);
    }

    const collabMatch = path.match(/^\/api\/collab\/([a-zA-Z0-9_-]{8,64})\/(join|info|close|snapshot)$/);
    if (collabMatch) {
      const sessionId = collabMatch[1];
      const action = collabMatch[2];
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited.' }), { status: 429, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
      }

      if (action === 'join' && request.method === 'GET') {
        return handleCollabJoin(sessionId, request, env);
      }
      if (action === 'info' && request.method === 'GET') {
        return handleCollabInfo(sessionId, env);
      }
      if (action === 'close' && request.method === 'POST') {
        return handleCollabClose(sessionId, request, env);
      }
      if (action === 'snapshot' && request.method === 'GET') {
        return handleCollabSnapshot(sessionId, env);
      }
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    if (path === '/api/meta/realtime') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleRealtimeMetaSnapshot(env);
    }

    if (path === '/api/monitor/health') {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      return handleMonitorHealth(env);
    }

    // EDHREC synergy data for a commander
    const edhrecMatch = path.match(/^\/api\/edhrec\/commander\/(.+)$/);
    if (edhrecMatch) {
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isRateLimited(ip)) {
        return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
          status: 429,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      return handleEdhrecCommander(decodeURIComponent(edhrecMatch[1]));
    }

    // ───── DeckGit ("GitHub for Decks") Routes ─────
    if (path.startsWith('/api/repos') || path.startsWith('/api/inventory') ||
        path.startsWith('/api/templates') || path.startsWith('/api/draft')) {
      const gitDb = env.COMMUNITY_DB;
      let gitAuth: { userId: string; userName: string } | null = null;
      if (gitDb) {
        const gitUser = await authenticateRequest(request, gitDb as unknown as Parameters<typeof authenticateRequest>[1]);
        if (gitUser) {
          gitAuth = { userId: gitUser.id, userName: gitUser.displayName || 'Anonymous' };
        } else {
          // Fallback: use device fingerprint as anonymous identity
          const fp = request.headers.get('X-Device-Fingerprint') || request.headers.get('X-Device-Id');
          if (fp) {
            gitAuth = { userId: `fp_${fp}`, userName: 'Anonymous' };
          }
        }
      }
      const gitResponse = await handleDeckGitRoute(request, path, { COMMUNITY_DB: gitDb as unknown as D1Database }, CORS_HEADERS, gitAuth);
      if (gitResponse) return gitResponse;
    }

    // Only GET
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
    }

    // Rate limiting
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isRateLimited(ip)) {
      return new Response(JSON.stringify({ error: 'Rate limited. Try again in a minute.' }), {
        status: 429,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    // Route: /api/deck/moxfield/:deckId
    const moxMatch = path.match(/^\/api\/deck\/moxfield\/([a-zA-Z0-9_-]+)$/);
    if (moxMatch) {
      return handleMoxfield(moxMatch[1]);
    }

    // Route: /api/deck/archidekt/:deckId
    const archMatch = path.match(/^\/api\/deck\/archidekt\/(\d+)$/);
    if (archMatch) {
      return handleArchidekt(archMatch[1]);
    }

    // Health check
    if (path === '/api/health') {
      const decks = await getCommunityDeckStore(env);
      return new Response(JSON.stringify({
        status: 'ok',
        version: '1.3.0',
        communityPersistence: env.COMMUNITY_DB ? 'd1' : env.COMMUNITY_KV ? 'kv' : 'memory',
        communityDecksCached: decks.filter((deck) => deck.id !== '__meta_snapshot__').length,
      }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
  },

  /**
   * Scheduled jobs (cron triggers) for Phase 8.
   */
  async scheduled(event: any, env: Env, ctx: any): Promise<void> {
    const db = env.COMMUNITY_DB as unknown as D1Database;
    if (!db) return;

    // Initialize Services
    const commitSvc = new CommitService(db);
    const branchSvc = new BranchService(db);
    const healthSvc = new HealthService(db);
    const webhookSvc = new WebhookService(db);

    // Run weekly commander stats refresh (Sunday 2AM UTC)
    // In production, check event.cron === "0 2 * * 0"
    try {
      console.log('[Scheduled] Refreshing commander stats...');
      const updatedCount = await refreshCommanderStats(db);
      console.log(`[Scheduled] Commander stats updated: ${updatedCount} commanders`);
    } catch (err) {
      console.error('[Scheduled] Failed to refresh commander stats:', err);
    }

    // Run weekly health reports
    // In a real environment, you'd check event.cron === "0 8 * * 1"
    
    // 1. Get all active repos
    const { results: repos } = await db.prepare('SELECT id, name FROM deck_repos').all<{ id: string, name: string }>();
    
    for (const repo of repos || []) {
      try {
        // 2. Get default branch
        const branch = await branchSvc.getBranchByName(repo.id, 'main');
        if (!branch?.headCommitId) continue;

        // 3. Get current state
        const state = await commitSvc.getStateAtCommit(branch.headCommitId);
        
        // 4. Save health snapshot
        const snapshot = await healthSvc.saveSnapshot(repo.id, branch.id, branch.headCommitId, state);
        
        // 5. Send report via Webhook
        await webhookSvc.dispatch(repo.id, 'health.snapshot' as any, {
          repoName: repo.name,
          snapshotId: snapshot.id,
          metrics: snapshot.health
        }, 'system');

      } catch (err) {
        console.error(`[Scheduled] Failed to generate health report for ${repo.id}:`, err);
      }
    }
  },
};
