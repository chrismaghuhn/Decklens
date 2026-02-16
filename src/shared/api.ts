// ==================== MTG API Module ====================
// Extracted from mtg.html lines 1600-1634
// Handles all external API calls (Scryfall, Moxfield, Archidekt)

import type { Deck, DeckEntry } from './types';
import { validateDeckUrl } from '../shared/security/url-validator';
import { fetchRobust } from '../shared/fetch';
import type { MetaMode, RecommendationEngineV1Response } from '../mtg/engine/recommendation-v1.js';
import type { PublicReportCardPayload } from './report-card.js';

const API_ORIGIN = (() => {
  if (typeof window === 'undefined') return '';
  const w = window as Window & { __DECKLENS_API_ORIGIN?: string };
  if (typeof w.__DECKLENS_API_ORIGIN === 'string' && w.__DECKLENS_API_ORIGIN.trim()) {
    return w.__DECKLENS_API_ORIGIN.trim().replace(/\/$/, '');
  }
  const host = window.location.hostname.toLowerCase();
  const isLocalhost = host === 'localhost' || host === '127.0.0.1';
  return isLocalhost ? '' : 'https://decklens-api.chrisgarkisch.workers.dev';
})();

const DEFAULT_REMOTE_API_ORIGIN = 'https://decklens-api.chrisgarkisch.workers.dev';

function apiPath(path: string): string {
  return `${API_ORIGIN}${path}`;
}

function buildApiFallbackPaths(path: string): string[] {
  const primary = apiPath(path);
  const fallback = `${DEFAULT_REMOTE_API_ORIGIN}${path}`;
  return Array.from(new Set([primary, fallback]));
}


// ==================== Moxfield API ====================

interface MoxfieldCard {
  quantity?: number;
  card?: {
    set?: string;
    cn?: string;
    name?: string;
  };
}

interface MoxfieldBoard {
  cards?: Record<string, MoxfieldCard>;
}

interface MoxfieldDeck {
  name?: string;
  boards?: {
    mainboard?: MoxfieldBoard;
    sideboard?: MoxfieldBoard;
    commanders?: MoxfieldBoard;
    companions?: MoxfieldBoard;
  };
}

async function fetchDeckJson(endpoints: string[]): Promise<unknown> {
  let lastError: Error | null = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetchRobust(endpoint, {
        headers: { Accept: 'application/json' },
        timeoutMs: 15000,
        retries: 1,
        backoffMs: 400,
      });

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        lastError = new Error('Non-JSON response');
        continue;
      }

      const raw = await response.text();
      try {
        return JSON.parse(raw);
      } catch {
        lastError = new Error('Invalid JSON response');
        continue;
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error('Request failed');
    }
  }

  throw lastError ?? new Error('Request failed');
}

/**
 * Process Moxfield board into deck entries.
 */
function processMoxfieldBoard(board: MoxfieldBoard | undefined, target: DeckEntry[]): void {
  if (!board?.cards) return;
  for (const [key, info] of Object.entries(board.cards)) {
    const cardName = info.card?.name || key;
    target.push({
      name: cardName,
      qty: info.quantity || 1,
      set: info.card?.set || null,
      num: info.card?.cn || null,
    });
  }
}

/**
 * Fetch deck from Moxfield API.
 * @param deckId - The deck ID from the URL
 * @returns Deck structure and name
 */
export async function fetchMoxfieldDeck(deckId: string, apiUrl: string): Promise<{ deck: Deck; name: string }> {
  let data: MoxfieldDeck;
  try {
    data = await fetchDeckJson([
      ...buildApiFallbackPaths(`/api/deck/moxfield/${deckId}`),
      apiUrl,
    ]) as MoxfieldDeck;
  } catch (err) {
    throw new Error(
      'Could not fetch from Moxfield (Cloudflare/CORS blocked). ' +
      'Use Export -> MTGO on Moxfield and paste the decklist here, or configure the /api/deck/moxfield proxy worker.'
    );
  }

  const deck: Deck = { main: [], sideboard: [], commander: [] };
  processMoxfieldBoard(data.boards?.mainboard, deck.main);
  processMoxfieldBoard(data.boards?.sideboard, deck.sideboard);
  processMoxfieldBoard(data.boards?.commanders, deck.commander);
  processMoxfieldBoard(data.boards?.companions, deck.sideboard);

  return {
    deck,
    name: data.name || 'Moxfield Deck',
  };
}

// ==================== Archidekt API ====================

interface ArchidektCard {
  card?: {
    oracleCard?: { name?: string };
    name?: string;
  };
  quantity?: number;
  categories?: string[];
}

interface ArchidektDeck {
  name?: string;
  cards?: ArchidektCard[];
}

/**
 * Fetch deck from Archidekt API.
 * @param deckId - The deck ID from the URL
 * @returns Deck structure and name
 */
export async function fetchArchidektDeck(deckId: string, apiUrl: string): Promise<{ deck: Deck; name: string }> {
  let data: ArchidektDeck;
  try {
    data = await fetchDeckJson([
      ...buildApiFallbackPaths(`/api/deck/archidekt/${deckId}`),
      apiUrl,
    ]) as ArchidektDeck;
  } catch (err) {
    throw new Error(
      'Could not fetch from Archidekt. ' +
      'Try Export -> Copy to Clipboard on Archidekt and paste here, or configure the /api/deck/archidekt proxy worker.'
    );
  }

  const deck: Deck = { main: [], sideboard: [], commander: [] };

  for (const c of data.cards || []) {
    const name = c.card?.oracleCard?.name || c.card?.name || 'Unknown';
    const qty = c.quantity || 1;
    const cat = (c.categories || [])[0]?.toLowerCase() || '';

    const entry: DeckEntry = { name, qty, set: null, num: null };

    if (cat === 'commander') {
      deck.commander.push(entry);
    } else if (cat === 'sideboard') {
      deck.sideboard.push(entry);
    } else {
      deck.main.push(entry);
    }
  }

  return {
    deck,
    name: data.name || 'Archidekt Deck',
  };
}

// ==================== Unified URL Import ====================

/**
 * Import a deck from a URL (Moxfield or Archidekt).
 * Uses secure URL validation before fetching.
 * 
 * @param url - The deck URL to import
 * @returns Deck structure and name
 * @throws Error with user-friendly message on failure
 */
export async function importDeckFromUrl(url: string): Promise<{ deck: Deck; name: string }> {
  // SECURITY: Validate URL before any fetch
  const validation = validateDeckUrl(url);
  
  if (!validation.valid) {
    throw new Error((validation as { valid: false; error: string }).error);
  }

  // Fetch based on validated site
  if (validation.site === 'Moxfield') {
    return fetchMoxfieldDeck(validation.deckId, validation.apiUrl);
  } else if (validation.site === 'Archidekt') {
    return fetchArchidektDeck(validation.deckId, validation.apiUrl);
  }

  // Should not reach here if validation is correct
  throw new Error('Unsupported deck site. Use Moxfield or Archidekt.');
}

export interface FetchRecommendationsRequest {
  deck: Deck;
  collection?: Record<string, number>;
  metaMode?: MetaMode;
  maxRecommendations?: number;
}

export interface FetchRecommendationsResponse {
  ok: boolean;
  request: {
    metaMode: MetaMode;
    maxRecommendations: number;
    resolvedCardMetrics: number;
    durationMs: number;
  };
  data: RecommendationEngineV1Response;
}

export async function fetchRecommendations(payload: FetchRecommendationsRequest): Promise<FetchRecommendationsResponse> {
  const response = await fetchRobust(apiPath('/api/recommendations/mtg'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 20000,
    retries: 1,
    backoffMs: 300,
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Recommendation endpoint returned non-JSON response.');
  }

  const parsed = await response.json() as FetchRecommendationsResponse;
  if (!parsed.ok || !parsed.data || parsed.data.version !== 'dd201-v1') {
    throw new Error('Recommendation response schema mismatch.');
  }

  return parsed;
}

export interface CreatePublicReportShareResponse {
  ok: boolean;
  data: {
    token: string;
    report: PublicReportCardPayload;
  };
}

export async function createPublicReportShare(report: PublicReportCardPayload): Promise<CreatePublicReportShareResponse> {
  const response = await fetchRobust(apiPath('/api/report/share'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ report }),
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 300,
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Report share endpoint returned non-JSON response.');
  }

  const parsed = await response.json() as CreatePublicReportShareResponse;
  if (!parsed.ok || !parsed.data || typeof parsed.data.token !== 'string' || !parsed.data.report) {
    throw new Error('Report share response schema mismatch.');
  }

  return parsed;
}

export interface FetchPublicReportResponse {
  ok: boolean;
  data: {
    report: PublicReportCardPayload;
  };
}

export async function fetchPublicReport(token: string): Promise<PublicReportCardPayload> {
  const response = await fetchRobust(apiPath(`/api/report/public?report=${encodeURIComponent(token)}`), {
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 300,
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Public report endpoint returned non-JSON response.');
  }

  const parsed = await response.json() as FetchPublicReportResponse;
  if (!parsed.ok || !parsed.data || !parsed.data.report) {
    throw new Error('Public report response schema mismatch.');
  }

  return parsed.data.report;
}

export interface CommunityDeckInput {
  name: string;
  format: 'commander' | 'cedh';
  commander: string;
  archetype: string;
  decklist: string;
  notes?: string;
  authorDisplayName?: string;
}

export interface CommunityDeck {
  id: string;
  name: string;
  format: 'commander' | 'cedh';
  commander: string;
  archetype: string;
  decklist: string;
  notes?: string;
  authorDisplayName?: string;
  createdAt: string;
  upvotes: number;
  views: number;
  tags: string[];
}

export type CommunityFeedSortMode = 'newest' | 'top' | 'archetype';

export interface CommunityModerationQueueItem {
  id: string;
  deckId: string;
  reason: string;
  reportedAt: string;
  reporterRef: string;
  totalFlagsForDeck: number;
  deck: Pick<CommunityDeck, 'id' | 'name' | 'format' | 'commander' | 'archetype' | 'createdAt' | 'upvotes' | 'authorDisplayName'> | null;
}

export interface RealtimeMetaSnapshot {
  updatedAt: string;
  source: string;
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
  archetypes: Array<{ name: string; share: number; trend: 'up' | 'down' | 'flat' }>;
  trendingCards: Array<{ name: string; delta: number }>;
}

export interface MonitorHealthSnapshot {
  status: string;
  persistence: 'd1' | 'kv' | 'memory';
  communityDecks: number;
  abuseFlags24h: number;
  analyticsEvents1h: number;
  rateLimiterKeys: number;
  generatedAt: string;
}

export async function createCommunityDeck(payload: CommunityDeckInput): Promise<CommunityDeck> {
  const response = await fetchRobust(apiPath('/api/community/decks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 300,
  });

  const parsed = await response.json() as { ok: boolean; data?: { deck?: CommunityDeck }; error?: string };
  if (!parsed.ok || !parsed.data?.deck) {
    throw new Error(parsed.error || 'Failed to create community deck.');
  }
  return parsed.data.deck;
}

export async function fetchCommunityDecks(params?: {
  format?: 'commander' | 'cedh';
  sort?: CommunityFeedSortMode;
  archetype?: string;
  q?: string;
  limit?: number;
}): Promise<CommunityDeck[]> {
  const qs = new URLSearchParams();
  if (params?.format) qs.set('format', params.format);
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.archetype) qs.set('archetype', params.archetype);
  if (params?.q) qs.set('q', params.q);
  if (params?.limit) qs.set('limit', String(params.limit));
  const url = apiPath(`/api/community/decks${qs.toString() ? `?${qs.toString()}` : ''}`);
  const response = await fetchRobust(url, {
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: { items?: CommunityDeck[] } };
  if (!parsed.ok) throw new Error('Failed to fetch community decks.');
  return parsed.data?.items || [];
}

export async function fetchCommunityModerationQueue(params?: { limit?: number }): Promise<CommunityModerationQueueItem[]> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  const url = apiPath(`/api/community/moderation${qs.toString() ? `?${qs.toString()}` : ''}`);
  const response = await fetchRobust(url, {
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: { items?: CommunityModerationQueueItem[] } };
  if (!parsed.ok) throw new Error('Failed to fetch moderation queue.');
  return parsed.data?.items || [];
}

export async function upvoteCommunityDeck(deckId: string): Promise<number> {
  const response = await fetchRobust(apiPath('/api/community/vote'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deckId, vote: 'up' }),
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: { upvotes?: number }; error?: string };
  if (!parsed.ok || typeof parsed.data?.upvotes !== 'number') {
    throw new Error(parsed.error || 'Failed to upvote deck.');
  }
  return parsed.data.upvotes;
}

export async function flagCommunityDeck(deckId: string, reason: string): Promise<string> {
  const response = await fetchRobust(apiPath('/api/community/flag'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deckId, reason }),
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: { flagId?: string }; error?: string };
  if (!parsed.ok || typeof parsed.data?.flagId !== 'string') {
    throw new Error(parsed.error || 'Failed to flag deck.');
  }
  return parsed.data.flagId;
}

export async function moderateCommunityDeck(
  deckId: string,
  action: 'remove' | 'dismiss',
  flagId?: string,
): Promise<void> {
  const body: Record<string, string> = { deckId, action };
  if (flagId) body.flagId = flagId;
  const response = await fetchRobust(apiPath('/api/community/moderation/action'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; error?: string };
  if (!parsed.ok) {
    throw new Error(parsed.error || `Failed to ${action} deck.`);
  }
}

export async function fetchRealtimeMeta(): Promise<RealtimeMetaSnapshot> {
  const response = await fetchRobust(apiPath('/api/meta/realtime'), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: RealtimeMetaSnapshot };
  if (!parsed.ok || !parsed.data) {
    throw new Error('Failed to fetch realtime meta.');
  }
  return parsed.data;
}

export async function fetchMonitorHealth(): Promise<MonitorHealthSnapshot> {
  const response = await fetchRobust(apiPath('/api/monitor/health'), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: MonitorHealthSnapshot };
  if (!parsed.ok || !parsed.data) {
    throw new Error('Failed to fetch monitor health.');
  }
  return parsed.data;
}

// Enhanced KPI Dashboard Types
export interface BusinessMetrics {
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

export interface GrowthMetrics {
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
    cohortAnalysis: Array<{
      cohort: string;
      day1: number;
      day7: number;
      day30: number;
      size: number;
    }>;
  };
  engagement: {
    recommendationsPerSession: number;
    sessionDuration: number;
    repeatUsageRate: number;
  };
}

export interface TechnicalMetrics {
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

export interface FeedbackAnalytics {
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

export interface PublicSummary {
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

export interface RealtimeKPIUpdate {
  timestamp: string;
  activeSessions: number;
  currentFunnelStep: Record<string, number>;
  apiLatencyMs: number;
  errorRatePercent: number;
  conversionRate24h: number;
  revenueToday: number;
}

// Enhanced KPI Dashboard API Functions
export async function fetchBusinessKPIs(days: number = 30): Promise<BusinessMetrics> {
  const response = await fetchRobust(apiPath(`/api/analytics/kpi/business?days=${days}`), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: BusinessMetrics };
  if (!parsed.ok || !parsed.data) {
    throw new Error('Failed to fetch business KPIs.');
  }
  return parsed.data;
}

export async function fetchGrowthKPIs(days: number = 30): Promise<GrowthMetrics> {
  const response = await fetchRobust(apiPath(`/api/analytics/kpi/growth?days=${days}`), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: GrowthMetrics };
  if (!parsed.ok || !parsed.data) {
    throw new Error('Failed to fetch growth KPIs.');
  }
  return parsed.data;
}

export async function fetchTechnicalKPIs(): Promise<TechnicalMetrics> {
  const response = await fetchRobust(apiPath('/api/analytics/kpi/technical'), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: TechnicalMetrics };
  if (!parsed.ok || !parsed.data) {
    throw new Error('Failed to fetch technical KPIs.');
  }
  return parsed.data;
}

export async function fetchCommunityKPIs(days: number = 30): Promise<FeedbackAnalytics> {
  const response = await fetchRobust(apiPath(`/api/analytics/kpi/community?days=${days}`), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: FeedbackAnalytics };
  if (!parsed.ok || !parsed.data) {
    throw new Error('Failed to fetch community KPIs.');
  }
  return parsed.data;
}

export async function fetchPublicSummary(): Promise<PublicSummary> {
  const response = await fetchRobust(apiPath('/api/analytics/public/summary'), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: PublicSummary };
  if (!parsed.ok || !parsed.data) {
    throw new Error('Failed to fetch public summary.');
  }
  return parsed.data;
}

export function createRealtimeKPIConnection(
  onUpdate: (update: RealtimeKPIUpdate) => void,
  onError?: (error: Event) => void
): EventSource | null {
  try {
    const eventSource = new EventSource(apiPath('/api/analytics/live/updates'));
    
    eventSource.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data) as RealtimeKPIUpdate;
        onUpdate(update);
      } catch (error) {
        console.error('Failed to parse real-time KPI update:', error);
      }
    };
    
    if (onError) {
      eventSource.onerror = onError;
    }
    
    return eventSource;
  } catch (error) {
    console.error('Failed to create real-time KPI connection:', error);
    return null;
  }
}

export interface DeckbuilderSearchCard {
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
    large?: string;
  };
  rarity?: string;
  power?: string;
  toughness?: string;
  edhrec_rank?: number;
  produced_mana?: string[];
  card_faces?: Array<{
    name?: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    power?: string;
    toughness?: string;
    image_uris?: {
      small?: string;
      normal?: string;
      large?: string;
    };
  }>;
}

export interface DeckbuilderSearchParams {
  q: string;
  colorIdentity?: string;
  type?: string;
  manaValue?: string;
  oracleText?: string;
  keyword?: string;
  legality?: 'commander';
  sort?: 'name' | 'mv' | 'price';
}

function normalizeNameKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function fetchDeckbuilderAutocomplete(query: string, options?: { signal?: AbortSignal }): Promise<string[]> {
  const q = query.trim();
  if (!q) return [];

  const endpoint = apiPath(`/api/scryfall/autocomplete?q=${encodeURIComponent(q)}`);
  const response = await fetchRobust(endpoint, {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 250,
    signal: options?.signal,
  });
  const parsed = await response.json() as { ok: boolean; data?: { items?: Array<string | { name: string }> } };
  if (!parsed.ok) {
    throw new Error('Failed to fetch autocomplete suggestions.');
  }
  const raw = Array.isArray(parsed.data?.items) ? parsed.data?.items || [] : [];
  // Items may be strings or card objects with .name — normalize to strings
  return raw.map((item) => typeof item === 'string' ? item : (item && typeof item === 'object' && 'name' in item ? item.name : '')).filter(Boolean);
}

export async function searchDeckbuilderCards(params: DeckbuilderSearchParams, options?: { signal?: AbortSignal }): Promise<{
  items: DeckbuilderSearchCard[];
  hasMore: boolean;
  totalCards: number | null;
}> {
  const qs = new URLSearchParams();
  qs.set('q', params.q.trim());
  if (params.colorIdentity) qs.set('colorIdentity', params.colorIdentity.trim());
  if (params.type) qs.set('type', params.type.trim());
  if (params.manaValue) qs.set('manaValue', params.manaValue.trim());
  if (params.oracleText) qs.set('oracleText', params.oracleText.trim());
  if (params.keyword) qs.set('keyword', params.keyword.trim());
  if (params.legality) qs.set('legality', params.legality);
  if (params.sort) qs.set('sort', params.sort);

  const endpoint = apiPath(`/api/scryfall/search?${qs.toString()}`);
  const response = await fetchRobust(endpoint, {
    timeoutMs: 12000,
    retries: 1,
    backoffMs: 300,
    signal: options?.signal,
  });
  const parsed = await response.json() as {
    ok: boolean;
    data?: {
      items?: DeckbuilderSearchCard[];
      hasMore?: boolean;
      totalCards?: number | null;
    };
  };
  if (!parsed.ok) {
    throw new Error('Failed to search cards.');
  }

  return {
    items: Array.isArray(parsed.data?.items) ? parsed.data?.items || [] : [],
    hasMore: Boolean(parsed.data?.hasMore),
    totalCards: typeof parsed.data?.totalCards === 'number' ? parsed.data.totalCards : null,
  };
}

export async function resolveDeckbuilderCards(names: string[]): Promise<{
  resolved: Record<string, DeckbuilderSearchCard>;
  missing: string[];
}> {
  const clean = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean))).slice(0, 500);
  if (clean.length === 0) {
    return {
      resolved: {},
      missing: [],
    };
  }

  const endpoint = apiPath('/api/scryfall/resolve');
  console.log('[DEBUG] API_ORIGIN:', API_ORIGIN);
  console.log('[DEBUG] Sending request to:', endpoint, 'with', clean.length, 'names');
  console.log('[DEBUG] First 3 names:', clean.slice(0, 3));
  const response = await fetchRobust(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ names: clean }),
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 300,
  });
  console.log('[DEBUG] API response status:', response.status, response.statusText);
  const rawResponse = await response.text();
  console.log('[DEBUG] Raw API response (first 500 chars):', rawResponse.slice(0, 500));
  
  let parsed;
  try {
    parsed = JSON.parse(rawResponse) as {
      ok?: boolean;
      error?: string;
      data?: {
        resolved?: Array<{ query: string; card: DeckbuilderSearchCard }>;
        missing?: string[];
      };
      resolved?: Array<{ query: string; card: DeckbuilderSearchCard }>;
      missing?: string[];
    };
  } catch (e) {
    console.error('[DEBUG] Failed to parse JSON:', e);
    throw new Error('Invalid JSON response from API');
  }
  
  console.log('[DEBUG] Parsed response:', parsed);
  console.log('[DEBUG] Has ok field:', 'ok' in parsed, 'ok value:', parsed.ok);
  console.log('[DEBUG] Has data field:', 'data' in parsed);
  console.log('[DEBUG] Has resolved field:', 'resolved' in parsed);
  console.log('[DEBUG] Has missing field:', 'missing' in parsed);
  
  // Support both formats: { ok: true, data: { resolved, missing } } and { resolved, missing }
  const hasOkField = 'ok' in parsed;
  const isOk = hasOkField ? parsed.ok === true : true;
  
  if (hasOkField && !isOk) {
    console.error('[DEBUG] API returned ok: false, error:', parsed.error);
    throw new Error(`Failed to resolve cards: ${parsed.error || 'Unknown error'}`);
  }
  
  // Extract data from either format
  const resolvedList = parsed.data?.resolved || parsed.resolved || [];
  const missingList = parsed.data?.missing || parsed.missing || [];
  
  console.log('[DEBUG] Extracted:', { resolvedCount: resolvedList.length, missingCount: missingList.length });

  // Build resolved map
  const resolvedMap: Record<string, DeckbuilderSearchCard> = {};
  for (const row of resolvedList) {
    if (!row || typeof row.query !== 'string' || !row.card || typeof row.card.name !== 'string') continue;
    resolvedMap[normalizeNameKey(row.query)] = row.card;
    resolvedMap[normalizeNameKey(row.card.name)] = row.card;
  }

  console.log('[DEBUG] Returning resolved cards:', Object.keys(resolvedMap).length);

  return {
    resolved: resolvedMap,
    missing: Array.isArray(missingList) ? missingList : [],
  };
}

// ==================== Commander Spellbook API ====================

export interface SpellbookCombo {
  id: string;
  cards: string[];
  description: string;
  prerequisites: string;
  produces: string[];
  identity: string;
  spellbookUrl: string;
}

export interface SpellbookCombosResponse {
  included: SpellbookCombo[];
  almostIncluded: SpellbookCombo[];
}

export async function fetchSpellbookCombos(
  commanders: string[],
  main: string[],
): Promise<SpellbookCombosResponse> {
  const response = await fetchRobust(apiPath('/api/spellbook/combos'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commanders, main }),
    timeoutMs: 20000,
    retries: 1,
    backoffMs: 500,
  });

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    throw new Error('Spellbook endpoint returned non-JSON response.');
  }

  const parsed = await response.json() as {
    ok: boolean;
    data?: SpellbookCombosResponse;
    error?: string;
  };
  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.error || 'Failed to fetch combos from Commander Spellbook.');
  }

  return parsed.data;
}

// ==================== Deck Cloud Sync ====================

export interface CloudDeckSummary {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  isPublic: boolean;
}

export interface CloudDeckFull {
  id: string;
  name: string;
  boards: unknown;
  description: string;
  updatedAt: string;
  isPublic: boolean;
}

export async function syncDeckToCloud(
  deck: { id: string; name: string; description?: string; visibility?: string; boards: unknown },
  fingerprint: string,
): Promise<{ id: string; updatedAt: string }> {
  const response = await fetchRobust(apiPath('/api/decks/sync'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deck, fingerprint }),
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: { id: string; updatedAt: string }; error?: string };
  if (!parsed.ok || !parsed.data) throw new Error(parsed.error || 'Sync failed.');
  return parsed.data;
}

export async function fetchCloudDeck(deckId: string, fingerprint: string): Promise<CloudDeckFull> {
  const response = await fetchRobust(apiPath(`/api/decks/${encodeURIComponent(deckId)}?fp=${encodeURIComponent(fingerprint)}`), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: CloudDeckFull; error?: string };
  if (!parsed.ok || !parsed.data) throw new Error(parsed.error || 'Deck not found.');
  return parsed.data;
}

export async function fetchMyCloudDecks(fingerprint: string): Promise<CloudDeckSummary[]> {
  const response = await fetchRobust(apiPath(`/api/decks/mine?fp=${encodeURIComponent(fingerprint)}`), {
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: { items: CloudDeckSummary[] }; error?: string };
  if (!parsed.ok || !parsed.data) throw new Error(parsed.error || 'Failed to fetch decks.');
  return parsed.data.items;
}

export async function deleteCloudDeck(deckId: string, fingerprint: string): Promise<void> {
  const response = await fetchRobust(apiPath(`/api/decks/${encodeURIComponent(deckId)}?fp=${encodeURIComponent(fingerprint)}`), {
    method: 'DELETE',
    timeoutMs: 10000,
    retries: 0,
    backoffMs: 0,
  });
  const parsed = await response.json() as { ok: boolean; error?: string };
  if (!parsed.ok) throw new Error(parsed.error || 'Delete failed.');
}

export type DeckbuilderShareVisibility = 'public' | 'unlisted';

export interface DeckbuilderShareCardEntry {
  name: string;
  qty: number;
  set?: string | null;
  collectorNumber?: string | null;
  tags?: string[];
}

export interface DeckbuilderShareDeckPayload {
  name: string;
  description?: string;
  boards: {
    commander: DeckbuilderShareCardEntry[];
    mainboard: DeckbuilderShareCardEntry[];
    sideboard: DeckbuilderShareCardEntry[];
    maybeboard: DeckbuilderShareCardEntry[];
  };
}

export interface DeckbuilderShareSummary {
  slug: string;
  name: string;
  visibility: DeckbuilderShareVisibility;
  createdAt: string;
  commanderLine: string;
  cardCount: number;
}

export interface DeckbuilderSharedSnapshot {
  slug: string;
  visibility: DeckbuilderShareVisibility;
  createdAt: string;
  deck: DeckbuilderShareDeckPayload;
  summary: DeckbuilderShareSummary;
}

export async function createDeckbuilderShareSnapshot(payload: {
  visibility: DeckbuilderShareVisibility;
  deck: DeckbuilderShareDeckPayload;
}): Promise<{
  slug: string;
  createdAt: string;
  visibility: DeckbuilderShareVisibility;
}> {
  const response = await fetchRobust(apiPath('/api/deckbuilder/share'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as {
    ok: boolean;
    data?: {
      slug?: string;
      createdAt?: string;
      visibility?: DeckbuilderShareVisibility;
    };
    error?: string;
  };
  if (!parsed.ok || !parsed.data?.slug || !parsed.data.createdAt || !parsed.data.visibility) {
    throw new Error(parsed.error || 'Failed to create shared snapshot.');
  }
  return {
    slug: parsed.data.slug,
    createdAt: parsed.data.createdAt,
    visibility: parsed.data.visibility,
  };
}

export async function fetchDeckbuilderSharedSnapshot(slug: string): Promise<DeckbuilderSharedSnapshot> {
  const response = await fetchRobust(apiPath(`/api/deckbuilder/share/${encodeURIComponent(slug)}`), {
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: DeckbuilderSharedSnapshot; error?: string };
  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.error || 'Failed to fetch shared snapshot.');
  }
  return parsed.data;
}

export async function fetchDeckbuilderPublicDecks(params?: {
  q?: string;
  limit?: number;
}): Promise<DeckbuilderShareSummary[]> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set('q', params.q.trim());
  if (typeof params?.limit === 'number') qs.set('limit', String(params.limit));
  const response = await fetchRobust(apiPath(`/api/deckbuilder/public${qs.toString() ? `?${qs.toString()}` : ''}`), {
    timeoutMs: 12000,
    retries: 1,
    backoffMs: 250,
  });
  const parsed = await response.json() as {
    ok: boolean;
    data?: {
      items?: DeckbuilderShareSummary[];
    };
  };
  if (!parsed.ok) {
    throw new Error('Failed to fetch public decks.');
  }
  return Array.isArray(parsed.data?.items) ? parsed.data?.items || [] : [];
}


// ==================== EDHREC Synergy API ====================

export interface EDHRECSynergyCard {
  name: string;
  synergy: number;
  num_decks: number;
}

export interface EDHRECTrendingCard {
  name: string;
  current_rank: number;
  previous_rank: number;
  delta: number;
}

export interface EDHRECSynergyResponse {
  highSynergy: EDHRECSynergyCard[];
  staples: string[];
  trending: EDHRECTrendingCard[];
  themes: string[];
  tribes: string[];
}

export async function fetchEdhrecSynergies(commanderName: string): Promise<EDHRECSynergyResponse> {
  const encoded = encodeURIComponent(commanderName);
  const response = await fetchRobust(apiPath(`/api/edhrec/commander/${encoded}`), {
    timeoutMs: 15000,
    retries: 1,
    backoffMs: 500,
  });
  const parsed = await response.json() as {
    ok: boolean;
    data?: EDHRECSynergyResponse;
    error?: string;
  };
  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.error || 'Failed to fetch EDHREC data.');
  }
  return parsed.data;
}

// ==================== Collaborative Editing API ====================

export interface CollabCreateResponse {
  sessionId: string;
  ownerToken: string;
}

export interface CollabSessionInfoResponse {
  deckName: string;
  participantCount: number;
  participants: Array<{ id: string; name: string; color: string }>;
}

export async function createCollabSession(deck?: {
  name?: string;
  description?: string;
  boards?: Record<string, unknown[]>;
}): Promise<CollabCreateResponse> {
  const response = await fetchRobust(apiPath('/api/collab/create'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deck }),
    timeoutMs: 10000,
    retries: 1,
    backoffMs: 500,
  });
  const parsed = await response.json() as { ok: boolean; data?: CollabCreateResponse; error?: string };
  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.error || 'Failed to create collab session.');
  }
  return parsed.data;
}

export async function getCollabSessionInfo(sessionId: string): Promise<CollabSessionInfoResponse> {
  const response = await fetchRobust(apiPath(`/api/collab/${encodeURIComponent(sessionId)}/info`), {
    timeoutMs: 8000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: CollabSessionInfoResponse; error?: string };
  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.error || 'Failed to get session info.');
  }
  return parsed.data;
}

export async function closeCollabSession(sessionId: string, ownerToken: string): Promise<void> {
  const response = await fetchRobust(apiPath(`/api/collab/${encodeURIComponent(sessionId)}/close`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerToken }),
    timeoutMs: 8000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; error?: string };
  if (!parsed.ok) {
    throw new Error(parsed.error || 'Failed to close session.');
  }
}

export async function getCollabSnapshot(sessionId: string): Promise<{
  deck: { name: string; description: string; boards: Record<string, unknown[]> };
}> {
  const response = await fetchRobust(apiPath(`/api/collab/${encodeURIComponent(sessionId)}/snapshot`), {
    timeoutMs: 8000,
    retries: 1,
    backoffMs: 300,
  });
  const parsed = await response.json() as { ok: boolean; data?: { deck: { name: string; description: string; boards: Record<string, unknown[]> } }; error?: string };
  if (!parsed.ok || !parsed.data) {
    throw new Error(parsed.error || 'Failed to get snapshot.');
  }
  return parsed.data;
}

export function getCollabWebSocketUrl(sessionId: string): string {
  // Use wss:// for HTTPS, ws:// for localhost
  const apiOrigin = API_ORIGIN || window.location.origin;
  const wsProtocol = apiOrigin.startsWith('https') ? 'wss' : 'ws';
  const host = apiOrigin.replace(/^https?:\/\//, '');
  return `${wsProtocol}://${host}/api/collab/${encodeURIComponent(sessionId)}/join`;
}
