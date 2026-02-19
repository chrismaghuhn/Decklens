// ==================== MTG Application (Full Extraction from mtg.html) ====================
// Source: mtg.html lines 1317-4839
// Step B (DOM Policy): Refactored to use h() helper for XSS-safe rendering (Sprint 2)
// Sprint 2 S2-A3: Using STORAGE_KEYS instead of magic strings.

import { h, replaceChildren, fragment, mapChildren } from '../shared/dom.js';
import { STORAGE_KEYS, storageGet, storageSet } from '../shared/storage.js';
import { fetchRobust } from '../shared/fetch.js';
import {
  createCommunityDeck,
  createPublicReportShare,
  fetchCommunityDecks,
  fetchPublicReport,
  fetchRealtimeMeta,
  importDeckFromUrl,
  upvoteCommunityDeck,
  type CommunityDeck,
  type RealtimeMetaSnapshot,
} from '../shared/api.js';
import { formatDeckParseErrors, parseDeckInput, parseDeckInputUnsafe, type DeckParseResult } from '../shared/deck-parser.js';
import { serializeDeckForExport, type DeckExportFormat } from '../shared/deck-export.js';
import {
  createFallbackCollectionCardId,
  mapCollectionRowsToCanonical,
  normalizeCollectionCardName,
  parseCollectionCsv,
  type CollectionCanonicalCard,
  type CollectionImportMappedItem,
  type CollectionImportParsedRow,
  type CollectionImportUnresolvedRow,
} from '../shared/collection-import.js';
import {
  createPriceAdapter,
  formatPriceAmount,
  formatPriceAsOfTimestamp,
  type PriceQuote,
} from '../shared/price-adapter.js';
import { trackAnalyticsEvent } from '../shared/analytics.js';
import { escapeHtml, sanitizeUrl } from '../shared/utils.js';
import { analyzeDeckDNA, calculateSaltAnalysis, detectDeckSynergies, type DNAArchetype } from './engine/analyzers.js';
import type { ArchetypeDetectionResult } from './engine/archetype-detector.js';
import { generateAntiMetaRecommendations, type AntiMetaRecommendation } from './engine/anti-meta-engine.js';
import { getArchetypeById, type ArchetypeId } from './engine/archetype-catalog.js';
import { getUserFeedbackSystem } from './engine/user-feedback.js';
import { getWorkerManager } from '../workers/worker-manager.js';
import { chunkBySize, collectUniqueDeckCardNames, processWithConcurrency } from './engine/fetch-pipeline.js';
import {
  buildMatchupGuide,
  type MatchupArchetype,
  type MatchupGuide,
  type MatchupMove,
} from './engine/matchup-guide.js';
import {
  buildRecommendationCollectionView,
  buildRecommendations,
  buildRecommendationsDynamic,
  formatRecommendationGapHint,
  getRecommendationCatalogCardNames,
  summarizeRecommendations,
  type RecommendationLogicTag,
  type RecommendationItem,
  type DynamicDiscoveryStats,
} from './recommendation-impact.js';
import {
  applyRecommendationAtomically,
  undoRecommendationApply,
  type AppliedRecommendationMutation,
  type RecommendationApplyAction,
  type RecommendationApplyMode,
} from './recommendation-apply.js';
import {
  DEFAULT_META_MODE,
  createMetaContextProperties,
  formatMetaModeLabel,
  loadMetaModePreference,
  normalizeMetaMode,
  persistMetaModePreference,
  type MetaMode,
} from './meta-mode.js';
import {
  buildPublicReportUrl,
  gradePublicReportScore,
  REPORT_CARD_SCHEMA_VERSION,
  type PublicReportCardPayload,
  type PublicReportRecommendation,
} from '../shared/report-card.js';
import { 
  decodeSharedDeck, 
  InvalidShareLinkError,
  type DecodedSharedDeck 
} from '../shared/deck-sharing.js';
import {
  compareDecksDiff,
  renderDeckComparison,
  createDiffSummary,
  injectComparisonStyles,
  type DeckZones as CompDeckZones,
  type DeckDiff,
  type DiffEntry,
} from '../shared/features/deck-comparison.js';
import {
  getDeckRecommendationHistory,
  getOrCreateDeviceProfile,
  recordRecommendationApplyHistory,
  recordRecommendationUndoHistory,
  type RecommendationHistoryEntry,
} from './recommendation-history.js';
import {
  generatePrintHTML,
  injectProxyStyles,
  type ProxyCard,
} from '../shared/features/print-proxy.js';

// ==================== TYPES ====================
interface DeckEntry {
  name: string;
  qty: number;
  set?: string | null;
  num?: string | null;
}

interface Deck {
  main: DeckEntry[];
  sideboard: DeckEntry[];
  commander: DeckEntry[];
}

interface ScryfallCard {
  id: string;
  oracle_id?: string;
  name: string;
  mana_cost?: string;
  cmc: number;
  type_line: string;
  oracle_text?: string;
  flavor_text?: string;
  colors?: string[];
  color_identity?: string[];
  legalities?: Record<string, string>;
  prices?: Record<string, string | null>;
  power?: string;
  toughness?: string;
  loyalty?: string;
  image_uris?: {
    small?: string;
    normal?: string;
    large?: string;
    art_crop?: string;
  };
  card_faces?: Array<{
    name: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    image_uris?: { small?: string; normal?: string; large?: string; };
  }>;
  set: string;
  collector_number: string;
  rarity: string;
  keywords?: string[];
  produced_mana?: string[];
  purchase_uris?: Record<string, string>;
}

type CardDataMap = Record<string, ScryfallCard>;

interface HandState {
  cards: string[];
  mulligans: number;
  phase: 'idle' | 'mulligan' | 'scry' | 'bottom';
  bottomNeeded: number;
  bottomed: string[];
}

type ImportFlowStep = 'import' | 'analysis' | 'recommend' | 'apply' | 'export';
type ImportFlowStatus = 'empty' | 'loading' | 'ready' | 'error';

interface ImportFlowState {
  step: ImportFlowStep;
  status: ImportFlowStatus;
  message: string;
}

interface FlowApplyVisualState {
  active: boolean;
  addedCardKey: string | null;
  removedCardKey: string | null;
}

interface CollectionStorageEntry {
  id: string;
  name: string;
  qty: number;
}

interface CollectionStorageV2 {
  version: 2;
  items: CollectionStorageEntry[];
  unresolved: CollectionImportUnresolvedRow[];
}

type FeedbackCategory = 'bug' | 'ux' | 'feature' | 'performance' | 'other';

interface RecommendationAnalysisContext {
  analysisId: string | null;
  status: 'idle' | 'running' | 'ok' | 'error';
  recommendationCount: number;
  startedAt: number | null;
  completedAt: number | null;
}

interface RecommendationApplyPreviewState {
  recommendationId: string;
  cardName: string;
  cutName: string | null;
  mode: RecommendationApplyMode;
  addCmc: number | null;
  cutCmc: number | null;
  curveDelta: number | null;
  priceDelta: number | null;
  powerImpactScore: number;
  powerImpactLabel: string;
  reason: string;
  confidence: number;
  confidenceBreakdown: {
    signalStrength: number;
    dataCoverage: number;
    heuristicConsensus: number;
  };
  logicTags: RecommendationLogicTag[];
}

interface AnalyticsDashboardFunnelRow {
  name: string;
  sessions: number;
  conversionFromPrevious: number | null;
  conversionFromStart: number | null;
}

interface AnalyticsDashboardFeedbackRow {
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

interface AnalyticsDashboardResponse {
  status: 'ok';
  generatedAt: string;
  window: {
    days: number;
    from: string;
    to: string;
    events: number;
    sessions: number;
    users: number;
  };
  funnel: AnalyticsDashboardFunnelRow[];
  metrics: {
    activation: {
      sampleSize: number;
      p50Ms: number | null;
      p90Ms: number | null;
    };
    actionRate: {
      numerator: number;
      denominator: number;
      value: number | null;
    };
    retentionProxy7d: {
      returnedUsers: number;
      eligibleUsers: number;
      value: number | null;
    };
  };
  feedback: {
    total: number;
    byCategory: Record<string, number>;
    recent: AnalyticsDashboardFeedbackRow[];
  };
}

type MatchupMetaMode = MetaMode;

// ==================== GLOBALS ====================
let currentDeck: Deck | null = null;
let cardData: CardDataMap = {};
let currentDeckName = 'Untitled Deck';
let currentView = 'card';
let handState: HandState = { cards: [], mulligans: 0, phase: 'idle', bottomNeeded: 0, bottomed: [] };
let userCollection: Record<string, number> = {};
let userCollectionNames: Record<string, string> = {};
let unresolvedCollectionRows: CollectionImportUnresolvedRow[] = [];
let userWishlist: Array<{ name: string; priority: number; addedAt: number }> = storageGet<Array<{ name: string; priority: number; addedAt: number }>>(STORAGE_KEYS.MTG_WISHLIST, []);

const CARD_CACHE_VERSION = 1;
const CARD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CARD_CACHE_MAX_ENTRIES = 5000;

interface CardCachePayload {
  version: number;
  savedAt: number;
  cards: CardDataMap;
}

// ==================== SEARCH STATE ====================
let searchTerm = '';
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
/** Cached lowercase card names for O(1) lookup during search */
let cardNameIndex: Map<string, string> = new Map(); // original -> lowercase
let moxfieldClipboardWatchActive = false;
let moxfieldClipboardWatchTimeout: ReturnType<typeof setTimeout> | null = null;
let moxfieldClipboardWatchInterval: ReturnType<typeof setInterval> | null = null;
let lastClipboardText = '';
let clipboardWatchDeckName = 'Imported Deck';
let clipboardWatchSourceLabel = '';
let deckNameAutoDetected = false;
let importBadgeTimeout: ReturnType<typeof setTimeout> | null = null;
let hoverPreviewCardName = '';
let symbolTooltipVisible = false;
let toastTimeout: ReturnType<typeof setTimeout> | null = null;
let errorTimeout: ReturnType<typeof setTimeout> | null = null;
let currentExportFormat: DeckExportFormat = 'text';
let lastPriceSyncAt: number | null = null;
let recommendationItemsCache: RecommendationItem[] = [];
let recommendationDiscoveryStats: DynamicDiscoveryStats | null = null;
let recommendationDiscoveryLoading = false;
let communityDeckFeed: CommunityDeck[] = [];
let realtimeMetaSnapshot: RealtimeMetaSnapshot | null = null;
let realtimeMetaPollTimer: ReturnType<typeof setInterval> | null = null;
let useDynamicDiscovery = storageGet<boolean>(
  STORAGE_KEYS.MTG_USE_DYNAMIC_DISCOVERY,
  true,
  (value): value is boolean => typeof value === 'boolean',
);
let useArchetypeDetection = storageGet<boolean>(
  STORAGE_KEYS.MTG_USE_ARCHETYPE_DETECTION,
  true,
  (value): value is boolean => typeof value === 'boolean',
);
let appliedRecommendationIds: Set<string> = new Set();
let appliedRecommendationMutations: Map<string, AppliedRecommendationMutation> = new Map();
let lastRecommendationApplyAction: RecommendationApplyAction | null = null;
let recommendationApplyPreviewState: RecommendationApplyPreviewState | null = null;
let flowAnalysisSpotlightOpen = false;
let flowApplyHighlightNames: Set<string> = new Set();
let flowApplyVisualState: FlowApplyVisualState = {
  active: false,
  addedCardKey: null,
  removedCardKey: null,
};
let flowApplyVisualTimeout: ReturnType<typeof setTimeout> | null = null;
let analysisPanelHomeParent: HTMLElement | null = null;
let analysisPanelHomeNextSibling: ChildNode | null = null;
let matchupGuideCache: MatchupGuide | null = null;
const MATCHUP_META_MODE_ORDER: MatchupMetaMode[] = ['local', 'fnm', 'commander-pod'];
const MATCHUP_META_MODE_LABEL: Record<MatchupMetaMode, string> = {
  local: 'Local',
  fnm: 'FNM',
  'commander-pod': 'Commander Pod',
};
let matchupMetaMode: MatchupMetaMode = storageGet<MatchupMetaMode>(
  STORAGE_KEYS.MTG_MATCHUP_META_MODE,
  'fnm',
  (value): value is MatchupMetaMode => value === 'local' || value === 'fnm' || value === 'commander-pod',
);
const STRONG_RECOMMENDATION_BUILD_SIZE = 5;
let recommendationMetaMode: MetaMode = DEFAULT_META_MODE;
let recommendationApplyMode: RecommendationApplyMode = storageGet<RecommendationApplyMode>(
  STORAGE_KEYS.MTG_RECOMMENDATION_APPLY_MODE,
  'add',
  (value): value is RecommendationApplyMode => value === 'add' || value === 'swap',
);
let recommendationIncludeMissingCards = storageGet<boolean>(
  STORAGE_KEYS.MTG_RECOMMENDATION_INCLUDE_MISSING,
  false,
  (value): value is boolean => typeof value === 'boolean',
);
let currentArchetypeDetection: ArchetypeDetectionResult | null = null;
let currentAntiMetaRecommendations: AntiMetaRecommendation[] = [];
const FEEDBACK_TEXT_MAX_CHARS = 500;
let recommendationAnalysisContext: RecommendationAnalysisContext = {
  analysisId: null,
  status: 'idle',
  recommendationCount: 0,
  startedAt: null,
  completedAt: null,
};
let analyticsDashboardCache: AnalyticsDashboardResponse | null = null;
let analyticsDashboardLoading = false;

const FLOW_STEP_ORDER: ImportFlowStep[] = ['import', 'analysis', 'recommend', 'apply', 'export'];
let importFlowState: ImportFlowState = {
  step: 'import',
  status: 'empty',
  message: 'Start with Step 1: import a deck list or file.',
};
let retryImportAction: (() => Promise<void> | void) | null = null;
let publicReportMode = false;

const DEBUG_LOG_ENABLED = (globalThis as { DECKLENS_DEBUG?: boolean }).DECKLENS_DEBUG === true;
const debugLog = (...args: unknown[]): void => {
  if (DEBUG_LOG_ENABLED) {
    console.log(...args);
  }
};

function loadCardCache(): void {
  const payload = storageGet<CardCachePayload | null>(STORAGE_KEYS.MTG_CARD_CACHE, null);
  if (!payload || payload.version !== CARD_CACHE_VERSION) return;
  if (!payload.cards || typeof payload.cards !== 'object') return;

  const age = Date.now() - payload.savedAt;
  if (age > CARD_CACHE_TTL_MS) return;

  cardData = { ...payload.cards, ...cardData };
  lastPriceSyncAt = payload.savedAt;
}

function persistCardCache(): void {
  const savedAt = Date.now();
  const entries = Object.entries(cardData);
  const trimmedEntries = entries.length > CARD_CACHE_MAX_ENTRIES
    ? entries.slice(entries.length - CARD_CACHE_MAX_ENTRIES)
    : entries;

  storageSet(STORAGE_KEYS.MTG_CARD_CACHE, {
    version: CARD_CACHE_VERSION,
    savedAt,
    cards: Object.fromEntries(trimmedEntries),
  } as CardCachePayload);
  lastPriceSyncAt = savedAt;
}

// ==================== DOM HELPERS ====================
export const $ = (id: string): HTMLElement | null => document.getElementById(id);
export const show = (el: HTMLElement | null): void => { el?.classList.add('active'); };
export const hide = (el: HTMLElement | null): void => { el?.classList.remove('active'); };

export function showToast(msg: string): void {
  const t = $('toast');
  if (!t) return;
  t.textContent = msg;
  show(t);
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => hide(t), 2200);
}

export function showError(msg: string): void {
  const e = $('errorMsg');
  if (!e) return;
  e.textContent = msg;
  show(e);
  if (errorTimeout) clearTimeout(errorTimeout);
  errorTimeout = setTimeout(() => hide(e), 10000);
}

function clearError(): void {
  if (errorTimeout) {
    clearTimeout(errorTimeout);
    errorTimeout = null;
  }
  hide($('errorMsg'));
}

function setImportSuccessBadge(source: string): void {
  const badge = $('importSourceBadge');
  if (!badge) return;
  badge.textContent = `Imported from ${source}`;
  badge.classList.add('active');
  if (importBadgeTimeout) clearTimeout(importBadgeTimeout);
  importBadgeTimeout = setTimeout(() => {
    badge.classList.remove('active');
  }, 7000);
}

function setRetryImportAction(action: (() => Promise<void> | void) | null): void {
  retryImportAction = action;
  updateImportFlowUI();
}

function setImportFlowState(status: ImportFlowStatus, step: ImportFlowStep, message: string): void {
  importFlowState = { status, step, message };
  updateImportFlowUI();
}

function updateImportFlowUI(): void {
  const panel = $('flowPanel');
  if (!panel) return;

  panel.setAttribute('data-status', importFlowState.status);
  panel.setAttribute('data-step', importFlowState.step);

  const badge = $('flowStateBadge');
  if (badge) {
    const labels: Record<ImportFlowStatus, string> = {
      empty: 'Waiting',
      loading: 'Loading',
      ready: 'Ready',
      error: 'Error',
    };
    badge.textContent = labels[importFlowState.status];
  }

  const messageEl = $('flowStateText');
  if (messageEl) {
    messageEl.textContent = importFlowState.message;
  }

  const activeIndex = FLOW_STEP_ORDER.indexOf(importFlowState.step);
  const deckLoaded = currentDeck !== null;
  const stepButtons: Array<[ImportFlowStep, HTMLButtonElement | null]> = [
    ['import', $('flowStepImport') as HTMLButtonElement | null],
    ['analysis', $('flowStepAnalyze') as HTMLButtonElement | null],
    ['recommend', $('flowStepRecommend') as HTMLButtonElement | null],
    ['apply', $('flowStepApply') as HTMLButtonElement | null],
    ['export', $('flowStepExport') as HTMLButtonElement | null],
  ];

  for (const [step, button] of stepButtons) {
    if (!button) continue;
    const index = FLOW_STEP_ORDER.indexOf(step);
    button.classList.toggle('active', step === importFlowState.step);
    button.classList.toggle('done', deckLoaded && index < activeIndex);
    const locked = step !== 'import' && !deckLoaded;
    button.disabled = importFlowState.status === 'loading' || locked;
  }

  const retryBtn = $('btnFlowRetry') as HTMLButtonElement | null;
  if (retryBtn) {
    retryBtn.hidden = !(importFlowState.status === 'error' && retryImportAction !== null);
    retryBtn.disabled = retryImportAction === null;
  }

  const primaryBtn = $('btnFlowPrimaryCta') as HTMLButtonElement | null;
  if (primaryBtn) {
    if (importFlowState.status === 'loading') {
      primaryBtn.textContent = 'Working...';
      primaryBtn.disabled = true;
      return;
    }

    if (!deckLoaded) {
      primaryBtn.textContent = 'Import Deck';
      primaryBtn.disabled = false;
      return;
    }

    const labels: Record<ImportFlowStep, string> = {
      import: 'Continue to Analyze',
      analysis: 'Continue to Top 3',
      recommend: 'Continue to Apply',
      apply: 'Continue to Export',
      export: 'Copy Export',
    };
    primaryBtn.textContent = labels[importFlowState.step];
    primaryBtn.disabled = false;
  }
}

function formatMetricPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function formatMetricDuration(valueMs: number | null): string {
  if (valueMs === null || !Number.isFinite(valueMs)) return 'n/a';
  const totalSeconds = Math.max(0, Math.trunc(valueMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function normalizeFeedbackCategory(raw: string): FeedbackCategory | null {
  const value = raw.trim().toLowerCase();
  if (value === 'bug' || value === 'ux' || value === 'feature' || value === 'performance' || value === 'other') {
    return value;
  }
  return null;
}

function formatStepLabel(step: string): string {
  return step
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function createDashboardMetricCard(label: string, value: string, detail: string): HTMLElement {
  return h('div', { className: 'beta-kpi-card' },
    h('div', { className: 'beta-kpi-label' }, label),
    h('div', { className: 'beta-kpi-value' }, value),
    h('div', { className: 'beta-kpi-detail' }, detail),
  );
}

function createFeedbackContextProperties(): Record<string, unknown> {
  const props: Record<string, unknown> = {
    context_page: 'mtg_beta_dashboard',
    funnel_step: importFlowState.step,
    has_deck: Boolean(currentDeck),
    recommendation_count: recommendationAnalysisContext.recommendationCount,
    ...getMetaContextProperties(),
  };

  if (recommendationAnalysisContext.analysisId) {
    props.analysis_id = recommendationAnalysisContext.analysisId;
    props.analysis_tool = 'recommendations';
  }

  if (recommendationAnalysisContext.status !== 'idle') {
    props.analysis_status = recommendationAnalysisContext.status === 'running'
      ? 'pending'
      : recommendationAnalysisContext.status;
  }

  return props;
}

function renderBetaDashboardLoading(message: string): void {
  const container = $('betaDashboardContent');
  if (!container) return;
  replaceChildren(container, h('p', { className: 'tool-empty' }, message));
}

function renderBetaDashboard(data: AnalyticsDashboardResponse): void {
  const container = $('betaDashboardContent');
  if (!container) return;

  const activation = data.metrics.activation;
  const actionRate = data.metrics.actionRate;
  const retention = data.metrics.retentionProxy7d;
  const feedback = data.feedback;

  const funnelRows = data.funnel.map((row) => h('tr', {},
    h('td', {}, formatStepLabel(row.name)),
    h('td', {}, String(row.sessions)),
    h('td', {}, formatMetricPercent(row.conversionFromPrevious)),
    h('td', {}, formatMetricPercent(row.conversionFromStart)),
  ));

  const feedbackRows = feedback.recent.slice(0, 8).map((entry) => {
    const contextBits: string[] = [];
    if (entry.analysisId) contextBits.push(`Analysis: ${entry.analysisId}`);
    if (entry.funnelStep) contextBits.push(`Step: ${entry.funnelStep}`);
    if (entry.analysisStatus) contextBits.push(`Status: ${entry.analysisStatus}`);
    if (entry.recommendationCount !== null) contextBits.push(`Recs: ${entry.recommendationCount}`);

    return h('li', { className: 'beta-feedback-item' },
      h('div', { className: 'beta-feedback-head' },
        h('span', { className: 'beta-feedback-category' }, entry.category || 'other'),
        h('span', { className: 'beta-feedback-time' }, new Date(entry.occurredAt).toLocaleString()),
      ),
      h('p', { className: 'beta-feedback-message' }, entry.message || '(empty)'),
      h('div', { className: 'beta-feedback-meta' },
        `Session ${entry.sessionRef} | User ${entry.userRef}${contextBits.length > 0 ? ` | ${contextBits.join(' | ')}` : ''}`,
      ),
    );
  });

  const categorySummary = Object.entries(feedback.byCategory || {})
    .filter(([, count]) => typeof count === 'number')
    .map(([category, count]) => `${category}: ${count}`)
    .join(' | ');

  replaceChildren(container,
    h('div', { className: 'beta-kpi-grid' },
      createDashboardMetricCard(
        'Activation (p50)',
        formatMetricDuration(activation.p50Ms),
        `p90 ${formatMetricDuration(activation.p90Ms)} • n=${activation.sampleSize}`,
      ),
      createDashboardMetricCard(
        'Action Rate',
        formatMetricPercent(actionRate.value),
        `${actionRate.numerator}/${actionRate.denominator} sessions`,
      ),
      createDashboardMetricCard(
        'Retention Proxy (7d)',
        formatMetricPercent(retention.value),
        `${retention.returnedUsers}/${retention.eligibleUsers} users`,
      ),
      createDashboardMetricCard(
        'Feedback Volume',
        String(feedback.total),
        categorySummary || 'No categories yet',
      ),
    ),
    h('div', { className: 'beta-funnel-card' },
      h('h4', {}, `MVP Funnel (${data.window.days}d)`),
      h('table', { className: 'beta-funnel-table' },
        h('thead', {},
          h('tr', {},
            h('th', {}, 'Step'),
            h('th', {}, 'Sessions'),
            h('th', {}, 'Conv Prev'),
            h('th', {}, 'Conv Start'),
          ),
        ),
        h('tbody', {}, ...funnelRows),
      ),
      h('p', { className: 'beta-dashboard-note' },
        `Window: ${new Date(data.window.from).toLocaleString()} - ${new Date(data.window.to).toLocaleString()} | Generated: ${new Date(data.generatedAt).toLocaleString()}`,
      ),
    ),
    h('div', { className: 'beta-feedback-list-card' },
      h('h4', {}, 'Recent Beta Feedback'),
      feedbackRows.length > 0
        ? h('ul', { className: 'beta-feedback-list' }, ...feedbackRows)
        : h('p', { className: 'tool-empty' }, 'No feedback captured yet.'),
    ),
  );
}

export async function refreshBetaDashboard(days = 7): Promise<void> {
  if (analyticsDashboardLoading) return;
  analyticsDashboardLoading = true;
  renderBetaDashboardLoading('Loading beta KPI dashboard...');

  try {
    const response = await fetchRobust(`/api/analytics/dashboard?days=${days}`, {
      method: 'GET',
      timeoutMs: 8000,
      retries: 1,
    });
    const payload = await response.json() as AnalyticsDashboardResponse;
    analyticsDashboardCache = payload;
    renderBetaDashboard(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load beta dashboard.';
    renderBetaDashboardLoading(message);
  } finally {
    analyticsDashboardLoading = false;
  }
}

export function submitBetaFeedback(): void {
  const input = $('betaFeedbackInput') as HTMLTextAreaElement | null;
  const categoryInput = $('betaFeedbackCategory') as HTMLSelectElement | null;
  const submitBtn = $('btnSubmitBetaFeedback') as HTMLButtonElement | null;
  if (!input) return;

  const text = input.value.trim();
  if (text.length < 2) {
    showToast('Please enter at least 2 characters of feedback');
    input.focus();
    return;
  }

  if (text.length > FEEDBACK_TEXT_MAX_CHARS) {
    showToast(`Feedback too long (max ${FEEDBACK_TEXT_MAX_CHARS} chars)`);
    input.focus();
    return;
  }

  if (submitBtn) submitBtn.disabled = true;

  const category = normalizeFeedbackCategory(categoryInput?.value || '');
  const context = createFeedbackContextProperties();

  trackAnalyticsEvent('feedback_submitted', {
    feedback_text: text,
    ...(category ? { feedback_category: category } : {}),
    ...context,
  }, {
    dedupeKey: `feedback_submitted:${text.toLowerCase().slice(0, 80)}:${category || 'none'}:${recommendationAnalysisContext.analysisId || 'no_analysis'}`,
    dedupeWindowMs: 1500,
  });

  input.value = '';
  if (categoryInput) categoryInput.value = '';
  showToast('Thanks! Feedback captured for weekly triage.');

  setTimeout(() => {
    if (submitBtn) submitBtn.disabled = false;
    void refreshBetaDashboard();
  }, 350);
}

function focusImportPanel(): void {
  $('importPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function ensurePanelOpen(panelId: string, open: boolean): void {
  const panel = $(panelId);
  if (!panel) return;
  if (open) panel.classList.add('active');
  else panel.classList.remove('active');
}

function moveAnalysisPanelToBody(open: boolean): HTMLElement | null {
  const panel = $('analysisPanel');
  if (!panel) return null;

  if (open) {
    if (!analysisPanelHomeParent) {
      analysisPanelHomeParent = panel.parentElement;
      analysisPanelHomeNextSibling = panel.nextSibling;
    }
    if (panel.parentElement !== document.body) {
      document.body.appendChild(panel);
    }
    return panel;
  }

  if (analysisPanelHomeParent && panel.parentElement === document.body) {
    if (analysisPanelHomeNextSibling && analysisPanelHomeNextSibling.parentNode === analysisPanelHomeParent) {
      analysisPanelHomeParent.insertBefore(panel, analysisPanelHomeNextSibling);
    } else {
      analysisPanelHomeParent.appendChild(panel);
    }
  }

  analysisPanelHomeParent = null;
  analysisPanelHomeNextSibling = null;
  return panel;
}

function setFlowAnalysisSpotlight(open: boolean): void {
  const panel = moveAnalysisPanelToBody(open);
  const backdrop = $('flowAnalysisBackdrop');
  if (!panel || !backdrop) {
    flowAnalysisSpotlightOpen = false;
    return;
  }

  flowAnalysisSpotlightOpen = open;
  panel.classList.toggle('flow-analysis-spotlight', open);
  backdrop.classList.toggle('active', open);
  backdrop.setAttribute('aria-hidden', open ? 'false' : 'true');
  document.body.classList.toggle('flow-analysis-open', open);

  if (open) {
    panel.classList.add('active');
    panel.scrollTop = 0;
  } else {
    panel.classList.remove('flow-analysis-spotlight');
  }
}

function setFlowApplyHighlightNames(cardNames: string[]): void {
  const normalized = cardNames
    .map((name) => normalizeHistoryCardKey(name))
    .filter(Boolean);
  const next = new Set(normalized);

  let changed = next.size !== flowApplyHighlightNames.size;
  if (!changed) {
    for (const name of next) {
      if (!flowApplyHighlightNames.has(name)) {
        changed = true;
        break;
      }
    }
  }

  if (!changed) return;

  flowApplyHighlightNames = next;
  if (currentDeck) renderDeck();
}

function clearFlowApplyHighlights(): void {
  if (flowApplyHighlightNames.size === 0) return;
  flowApplyHighlightNames = new Set();
  if (currentDeck) renderDeck();
}

function clearFlowApplyVisualState(): void {
  if (flowApplyVisualTimeout) {
    clearTimeout(flowApplyVisualTimeout);
    flowApplyVisualTimeout = null;
  }

  if (!flowApplyVisualState.active) return;

  flowApplyVisualState = {
    active: false,
    addedCardKey: null,
    removedCardKey: null,
  };

  if (currentDeck) renderDeck();
}

function setFlowApplyVisualState(addedCardName: string, removedCardName: string | null): void {
  if (flowApplyVisualTimeout) {
    clearTimeout(flowApplyVisualTimeout);
    flowApplyVisualTimeout = null;
  }

  flowApplyVisualState = {
    active: true,
    addedCardKey: normalizeHistoryCardKey(addedCardName),
    removedCardKey: removedCardName ? normalizeHistoryCardKey(removedCardName) : null,
  };

  flowApplyVisualTimeout = setTimeout(() => {
    flowApplyVisualTimeout = null;
    clearFlowApplyVisualState();
  }, 14000);
}

function getFlowTopRecommendations(limit = 3): RecommendationItem[] {
  const visible = getRecommendationCollectionView().visibleItems;
  const source = visible.length > 0 ? visible : recommendationItemsCache;
  return source.slice(0, Math.max(1, limit));
}

function setFlowApplyHighlightsFromRecommendations(
  limit = 3,
  options: { includeCuts?: boolean } = {},
): number {
  const includeCuts = options.includeCuts === true;
  const highlights: string[] = [];
  for (const recommendation of getFlowTopRecommendations(limit)) {
    highlights.push(recommendation.cardName);
    if (includeCuts && recommendation.suggestedCutName) highlights.push(recommendation.suggestedCutName);
  }
  setFlowApplyHighlightNames(highlights);
  return flowApplyHighlightNames.size;
}

function activateToolsTab(tabId: string): void {
  const targetTab = document.querySelector(`.tools-tab[data-tool-tab="${tabId}"]`) as HTMLElement | null;
  const targetContent = $(`tool-${tabId}`);
  if (!targetTab || !targetContent) return;

  document.querySelectorAll('.tools-tab').forEach((tab) => tab.classList.remove('active'));
  document.querySelectorAll('.tools-content').forEach((content) => content.classList.remove('active'));

  targetTab.classList.add('active');
  targetContent.classList.add('active');
}

function setActiveExportButton(format: string): void {
  document.querySelectorAll<HTMLElement>('[data-export]').forEach((button) => {
    const isActive = button.getAttribute('data-export') === format;
    button.classList.toggle('active', isActive);
  });
}

function resetDeckPanelsForLoading(): void {
  const content = $('deckContent');
  if (content) {
    replaceChildren(content);
  }
  hide($('deckOverview'));
  hide($('toolbar'));
  hide($('analysisPanel'));
  hide($('exportPanel'));
}

function showLoader(message: string): void {
  const text = $('loaderText');
  if (text) {
    text.textContent = message;
  }
  const fill = $('progressFill');
  if (fill) {
    fill.style.width = '0%';
  }
  show($('loader'));
}

function setLoaderProgress(done: number, total: number, message: string): void {
  const fill = $('progressFill');
  if (fill) {
    const pct = total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    fill.style.width = `${pct}%`;
  }
  const text = $('loaderText');
  if (text) {
    text.textContent = message;
  }
}

function hideLoader(): void {
  hide($('loader'));
}

function handleImportFailure(message: string): void {
  hideLoader();
  showError(message);
  setImportFlowState('error', 'import', message);
}

function deckTotalCards(deck: Deck): number {
  return deck.main.reduce((sum, entry) => sum + entry.qty, 0)
    + deck.sideboard.reduce((sum, entry) => sum + entry.qty, 0)
    + deck.commander.reduce((sum, entry) => sum + entry.qty, 0);
}

function autoDetectFormat(deck: Deck): void {
  const sel = document.getElementById('formatSelect') as HTMLSelectElement | null;
  if (!sel) return;
  const hasCommander = deck.commander.length > 0;
  const total = deck.main.reduce((s, e) => s + e.qty, 0) + deck.commander.reduce((s, e) => s + e.qty, 0);
  if (hasCommander || total === 100) sel.value = 'commander';
  else if (total === 60) sel.value = 'modern';
  else if (total === 40) sel.value = 'standard';
}

function deckUniqueCards(deck: Deck): number {
  const all = new Set<string>();
  for (const entry of [...deck.main, ...deck.sideboard, ...deck.commander]) {
    all.add(entry.name.toLowerCase());
  }
  return all.size;
}

function deckSignature(deck: Deck): string {
  const lines = [...deck.main, ...deck.sideboard, ...deck.commander]
    .map((entry) => `${entry.qty}x${entry.name.toLowerCase()}`)
    .sort();
  return lines.join('|').slice(0, 900);
}

function emitDeckImportedEvent(source: string, deck: Deck, details: Record<string, unknown> = {}): void {
  const signature = deckSignature(deck);
  trackAnalyticsEvent('deck_imported', {
    source,
    deck_name: currentDeckName,
    total_cards: deckTotalCards(deck),
    unique_cards: deckUniqueCards(deck),
    main_count: deck.main.reduce((sum, entry) => sum + entry.qty, 0),
    sideboard_count: deck.sideboard.reduce((sum, entry) => sum + entry.qty, 0),
    commander_count: deck.commander.reduce((sum, entry) => sum + entry.qty, 0),
    ...details,
  }, {
    dedupeKey: `deck_imported:${source}:${signature}`,
    dedupeWindowMs: 2500,
  });
}

function emitExportClickedEvent(format: string, trigger: string): void {
  trackAnalyticsEvent('export_clicked', {
    format,
    trigger,
    deck_name: currentDeckName,
    has_deck: Boolean(currentDeck),
    total_cards: currentDeck ? deckTotalCards(currentDeck) : 0,
  }, {
    dedupeKey: `export_clicked:${trigger}:${format}`,
    dedupeWindowMs: 600,
  });
}

function emitWizardStepEvent(step: ImportFlowStep, phase: 'entered' | 'completed'): void {
  trackAnalyticsEvent('analysis_started', {
    tool: 'wizard',
    wizard_event: 'step',
    step,
    phase,
    status: importFlowState.status,
    has_deck: Boolean(currentDeck),
    recommendation_count: recommendationItemsCache.length,
    applied_count: appliedRecommendationIds.size,
    ...getMetaContextProperties(),
  }, {
    dedupeKey: `wizard_step:${step}:${phase}:${Boolean(currentDeck)}:${recommendationItemsCache.length}:${appliedRecommendationIds.size}`,
    dedupeWindowMs: 900,
  });
}

function canonicalIdForScryfallCard(card: ScryfallCard): string {
  if (card.oracle_id) return `oracle:${card.oracle_id}`;
  return `scryfall:${card.id}`;
}

function fallbackCollectionNameFromId(id: string): string {
  if (id.startsWith('name:')) {
    return id.slice('name:'.length);
  }
  return id;
}

function createCollectionStoragePayload(): CollectionStorageV2 {
  const items: CollectionStorageEntry[] = Object.entries(userCollection).map(([id, qty]) => ({
    id,
    name: userCollectionNames[id] || fallbackCollectionNameFromId(id),
    qty,
  }));

  return {
    version: 2,
    items,
    unresolved: unresolvedCollectionRows,
  };
}

function saveCollectionState(): void {
  storageSet(STORAGE_KEYS.MTG_COLLECTION, createCollectionStoragePayload());
}

function loadCollectionState(): void {
  const raw = storageGet<unknown>(STORAGE_KEYS.MTG_COLLECTION, {});

  userCollection = {};
  userCollectionNames = {};
  unresolvedCollectionRows = [];

  if (raw && typeof raw === 'object' && 'version' in raw && 'items' in raw) {
    const parsed = raw as CollectionStorageV2;
    for (const item of parsed.items || []) {
      if (!item || typeof item !== 'object') continue;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const qty = Number.isFinite(item.qty) ? Math.max(0, Math.trunc(item.qty)) : 0;
      if (!id || qty <= 0) continue;
      userCollection[id] = (userCollection[id] || 0) + qty;
      userCollectionNames[id] = typeof item.name === 'string' && item.name.trim()
        ? item.name.trim()
        : fallbackCollectionNameFromId(id);
    }

    if (Array.isArray(parsed.unresolved)) {
      unresolvedCollectionRows = parsed.unresolved.filter((row): row is CollectionImportUnresolvedRow => {
        return Boolean(
          row
          && typeof row.line === 'number'
          && typeof row.qty === 'number'
          && typeof row.rawName === 'string'
          && typeof row.normalizedName === 'string'
          && typeof row.reason === 'string'
          && typeof row.message === 'string',
        );
      });
    }

    return;
  }

  // Migration path from legacy { [name]: qty }
  if (raw && typeof raw === 'object') {
    for (const [legacyName, qtyRaw] of Object.entries(raw as Record<string, unknown>)) {
      const qty = Number.isFinite(qtyRaw) ? Math.max(0, Math.trunc(Number(qtyRaw))) : 0;
      if (qty <= 0) continue;

      const normalizedName = normalizeCollectionCardName(legacyName);
      if (!normalizedName) continue;

      const id = createFallbackCollectionCardId(normalizedName);
      userCollection[id] = (userCollection[id] || 0) + qty;
      userCollectionNames[id] = normalizedName;
    }
  }

  saveCollectionState();
}

function getOwnedCountForCard(card: ScryfallCard): number {
  const candidates = [
    canonicalIdForScryfallCard(card),
    createFallbackCollectionCardId(card.name),
    card.name.toLowerCase(), // legacy key support
  ];

  for (const id of candidates) {
    const qty = userCollection[id];
    if (qty && qty > 0) return qty;
  }

  return 0;
}

function getOwnedCountForCardName(cardName: string): number {
  const resolvedCard = resolveCard(cardName);
  if (resolvedCard) {
    return getOwnedCountForCard(resolvedCard);
  }

  const normalizedName = normalizeCollectionCardName(cardName);
  const fallbackId = createFallbackCollectionCardId(normalizedName || cardName);
  const legacyKey = (normalizedName || cardName).toLowerCase();
  const fallbackQty = userCollection[fallbackId] || 0;
  const legacyQty = userCollection[legacyKey] || 0;
  return Math.max(fallbackQty, legacyQty, 0);
}

function getCollectionCanonicalCardsFromCache(): CollectionCanonicalCard[] {
  const byId = new Map<string, CollectionCanonicalCard>();

  for (const card of Object.values(cardData)) {
    const id = canonicalIdForScryfallCard(card);
    if (byId.has(id)) continue;

    const aliases: string[] = [];
    for (const face of card.card_faces || []) {
      if (face.name && face.name !== card.name) aliases.push(face.name);
    }

    byId.set(id, {
      id,
      name: card.name,
      aliases,
    });
  }

  for (const [id, name] of Object.entries(userCollectionNames)) {
    if (!byId.has(id)) {
      byId.set(id, { id, name });
    }
  }

  return [...byId.values()];
}

function applyMappedCollectionItems(items: CollectionImportMappedItem[], mode: 'replace' | 'merge'): void {
  if (mode === 'replace') {
    userCollection = {};
    userCollectionNames = {};
  }

  for (const item of items) {
    const id = item.id.trim();
    if (!id) continue;
    userCollection[id] = (userCollection[id] || 0) + item.qty;
    userCollectionNames[id] = item.name;
  }
}

async function resolveCollectionRowsFromScryfall(rows: CollectionImportParsedRow[]): Promise<CollectionCanonicalCard[]> {
  const uniqueNames = [...new Set(rows.map((row) => normalizeCollectionCardName(row.name)).filter(Boolean))];
  if (uniqueNames.length === 0) return [];

  const candidates: CollectionCanonicalCard[] = [];
  const chunks = chunkBySize(uniqueNames, 75);

  for (const chunk of chunks) {
    const body = { identifiers: chunk.map((name) => ({ name })) };
    try {
      const resp = await fetchRobust('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: 15000,
        retries: 3,
        backoffMs: 200,
      });

      const data = await resp.json() as { data?: ScryfallCard[] };
      for (const card of data.data || []) {
        cardData[card.name.toLowerCase()] = card;
        candidates.push({
          id: canonicalIdForScryfallCard(card),
          name: card.name,
          aliases: (card.card_faces || []).map((face) => face.name).filter(Boolean),
        });
      }
    } catch (error) {
      console.warn('[MTG Collection] Failed to resolve chunk:', error);
    }
  }

  return candidates;
}

function unresolvedReasonLabel(reason: CollectionImportUnresolvedRow['reason']): string {
  if (reason === 'invalid_quantity') return 'Invalid quantity';
  if (reason === 'missing_name') return 'Missing name';
  return 'Unknown card';
}

function renderCollectionUnresolvedRows(): void {
  const panel = $('collUnresolved');
  const list = $('collUnresolvedList');
  if (!panel || !list) return;

  if (unresolvedCollectionRows.length === 0) {
    panel.setAttribute('hidden', 'true');
    replaceChildren(list);
    return;
  }

  panel.removeAttribute('hidden');
  replaceChildren(
    list,
    ...unresolvedCollectionRows.map((row, index) => {
      return h(
        'div',
        { className: 'coll-unresolved-item' },
        h(
          'div',
          { className: 'coll-unresolved-head' },
          h('span', { className: 'coll-unresolved-line' }, `Line ${row.line}`),
          h('span', { className: 'coll-unresolved-reason' }, unresolvedReasonLabel(row.reason)),
          h('span', { className: 'coll-unresolved-qty' }, `Qty ${row.qty}`),
        ),
        h('div', { className: 'coll-unresolved-msg' }, row.message),
        h('div', { className: 'coll-unresolved-actions' },
          h('input', {
            id: `collUnresolvedQty-${index}`,
            className: 'cc-qty',
            type: 'number',
            min: '1',
            value: row.qty > 0 ? String(row.qty) : '',
            placeholder: 'Qty',
          }),
          h('input', {
            id: `collUnresolvedInput-${index}`,
            className: 'coll-search',
            type: 'text',
            value: row.rawName || row.normalizedName,
            placeholder: 'Correct card name and resolve',
          }),
          h(
            'button',
            {
              className: 'hand-btn',
              'data-action': 'resolve-coll-row',
              'data-row-index': String(index),
            },
            'Resolve',
          ),
          h(
            'button',
            {
              className: 'hand-btn',
              'data-action': 'dismiss-coll-row',
              'data-row-index': String(index),
            },
            'Dismiss',
          ),
        ),
      );
    }),
  );
}

function updateDeckHeaderProminence(): void {
  if (!currentDeck) return;

  const title = $('deckTitle');
  if (title) {
    title.textContent = currentDeckName || 'Deck';
  }

  const autoBadge = $('autoDeckNameBadge');
  if (autoBadge) {
    if (deckNameAutoDetected && currentDeckName) {
      autoBadge.textContent = `Auto Name: ${currentDeckName}`;
      autoBadge.classList.add('active', 'auto-name');
    } else {
      autoBadge.classList.remove('active', 'auto-name');
    }
  }

  const commanderBadge = $('commanderDetectBadge');
  if (commanderBadge) {
    const cmdrCount = currentDeck.commander.reduce((a, e) => a + e.qty, 0);
    if (cmdrCount > 0) {
      const commanderNames = currentDeck.commander.map(e => e.name).slice(0, 2).join(', ');
      commanderBadge.textContent = cmdrCount === 1
        ? `Commander: ${commanderNames}`
        : `Commanders: ${cmdrCount}`;
      commanderBadge.classList.add('active', 'commander');
    } else {
      commanderBadge.classList.remove('active', 'commander');
    }
  }
}

const MTG_COLOR_NAMES: Record<string, string> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
  C: 'colorless',
  S: 'snow',
};

const MTG_SYMBOL_EXPLANATIONS: Record<string, string> = {
  T: 'Tap this permanent.',
  Q: 'Untap this permanent.',
  C: 'Add one colorless mana.',
  W: 'Add one white mana.',
  U: 'Add one blue mana.',
  B: 'Add one black mana.',
  R: 'Add one red mana.',
  G: 'Add one green mana.',
  S: 'Spend one snow mana.',
  X: 'Variable mana cost chosen while casting.',
  Y: 'Variable mana cost chosen while casting.',
  Z: 'Variable mana cost chosen while casting.',
  E: 'Get one energy counter.',
  CHAOS: 'Chaos symbol (Planechase).',
};

function explainMtgSymbol(rawToken: string): string {
  const token = rawToken.trim().toUpperCase();
  if (!token) return 'Magic symbol.';

  if (MTG_SYMBOL_EXPLANATIONS[token]) {
    return MTG_SYMBOL_EXPLANATIONS[token];
  }

  if (/^\d+$/.test(token)) {
    return `${token} generic mana.`;
  }

  if (token.includes('/')) {
    const [left, right] = token.split('/');

    if (right === 'P' && MTG_COLOR_NAMES[left]) {
      return `Pay one ${MTG_COLOR_NAMES[left]} mana or 2 life.`;
    }

    if (left === '2' && MTG_COLOR_NAMES[right]) {
      return `Pay two generic mana or one ${MTG_COLOR_NAMES[right]} mana.`;
    }

    if (MTG_COLOR_NAMES[left] && MTG_COLOR_NAMES[right]) {
      return `Pay one ${MTG_COLOR_NAMES[left]} or ${MTG_COLOR_NAMES[right]} mana.`;
    }

    return `Hybrid symbol ${token}.`;
  }

  return `Magic symbol ${token}.`;
}

function renderMtgSymbolText(text: string): Array<Node | string> {
  const result: Array<Node | string> = [];
  const lines = text.split('\n');

  lines.forEach((line, lineIdx) => {
    const parts = line.split(/(\{[^}]+\})/g).filter(Boolean);
    for (const part of parts) {
      const match = part.match(/^\{([^}]+)\}$/);
      if (match && match[1]) {
        const token = match[1];
        const explanation = explainMtgSymbol(token);
        result.push(
          h(
            'span',
            {
              className: 'mtg-symbol-token',
              'aria-label': explanation,
              'data-tip': explanation,
              tabindex: '0',
            },
            `{${token}}`
          )
        );
      } else {
        result.push(part);
      }
    }

    if (lineIdx < lines.length - 1) {
      result.push(h('br'));
    }
  });

  return result;
}

// ==================== UTILITIES ====================
// NOTE: escapeHtml and sanitizeUrl imported from ../shared/utils.js

// NOTE: Using shared fetchRobust from ../shared/fetch.js instead of local implementation
// fetchRobust provides: timeout (8s), retry on 429/503/504, exponential backoff, generic errors

// ==================== SEARCH FILTERING ====================
const SEARCH_DEBOUNCE_MS = 150;

/**
 * Build cached lowercase index of card names for fast searching.
 * Called when deck is loaded/changed.
 */
function buildCardNameIndex(): void {
  cardNameIndex.clear();
  if (!currentDeck) return;
  
  for (const section of [currentDeck.main, currentDeck.sideboard, currentDeck.commander]) {
    for (const entry of section) {
      if (!cardNameIndex.has(entry.name)) {
        cardNameIndex.set(entry.name, entry.name.toLowerCase());
      }
    }
  }
}

/**
 * Filter cards by search term (debounced).
 * Matches against card name (case-insensitive substring match).
 * 
 * @param term - Search term from input
 */
export function filterCards(term: string): void {
  // Clear existing timer
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer);
  }
  
  // Debounce the actual filtering
  searchDebounceTimer = setTimeout(() => {
    searchTerm = term.toLowerCase().trim();
    renderDeck();
  }, SEARCH_DEBOUNCE_MS);
}

/**
 * Clear search filter.
 */
export function clearSearch(): void {
  searchTerm = '';
  const searchBox = $('searchBox') as HTMLInputElement | null;
  if (searchBox) {
    searchBox.value = '';
  }
  renderDeck();
}

/**
 * Check if a deck entry matches the current search term.
 * Uses cached lowercase index for performance.
 */
function matchesSearch(entry: DeckEntry): boolean {
  if (!searchTerm) return true;
  
  // Check name (using cached lowercase)
  const lowerName = cardNameIndex.get(entry.name) || entry.name.toLowerCase();
  if (lowerName.includes(searchTerm)) return true;
  
  // Also check card type if we have card data
  const card = cardData[lowerName];
  if (card) {
    const lowerType = card.type_line?.toLowerCase() || '';
    if (lowerType.includes(searchTerm)) return true;
    
    // Check oracle text for advanced search
    const lowerText = card.oracle_text?.toLowerCase() || '';
    if (lowerText.includes(searchTerm)) return true;
  }
  
  return false;
}

// ==================== CARD HELPERS ====================
// Clean card name for Scryfall lookup
function cleanCardName(name: string): string {
  return name
    // Remove // and everything after (split cards)
    .split(' // ')[0]
    // Remove set codes like (pdp12), (plst), (khm)
    .replace(/\s*\([a-z0-9]+\)\s*/gi, ' ')
    // Remove collector numbers like 123, CM2-122
    .replace(/\s+[A-Z]*\d+[-]?\d*[a-z]?\s*$/i, '')
    // Remove promo markers like *F*, *E*
    .replace(/\s*\*[A-Z]\*\s*/gi, '')
    // Remove foil markers
    .replace(/\s+\d+\s*$/g, '')
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveCard(name: string): ScryfallCard | null {
  // Try exact match first
  const l = name.toLowerCase();
  if (cardData[l]) return cardData[l];
  
  // Try cleaned name
  const cleaned = cleanCardName(name).toLowerCase();
  if (cardData[cleaned]) return cardData[cleaned];
  
  // Try first part of split card
  const s = l.split(' // ')[0].trim();
  if (cardData[s]) return cardData[s];
  
  // Try cleaned first part
  const cleanedS = cleanCardName(s).toLowerCase();
  if (cardData[cleanedS]) return cardData[cleanedS];
  
  // Try fuzzy match - first 10 chars
  const prefix = cleanedS.substring(0, 10);
  for (const key of Object.keys(cardData)) {
    if (key.startsWith(prefix)) {
      debugLog('[MTG] Fuzzy match:', name, '->', cardData[key].name);
      return cardData[key];
    }
  }
  
  console.warn('[MTG] Card not in cardData:', name, '(cleaned:', cleaned, ')');
  return null;
}

function getCardImage(c: ScryfallCard | null): string {
  if (!c) return '';
  if (c.image_uris) return c.image_uris.normal || c.image_uris.small || '';
  if (c.card_faces?.[0]?.image_uris) return c.card_faces[0].image_uris.normal || c.card_faces[0].image_uris.small || '';
  return '';
}

// Placeholder for missing card images
const PLACEHOLDER_IMG = 'data:image/svg+xml,' + encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="146" height="204" viewBox="0 0 146 204">
  <rect fill="#1a1a2e" width="146" height="204" rx="8"/>
  <text x="73" y="102" fill="#666" font-family="sans-serif" font-size="12" text-anchor="middle">No Image</text>
</svg>
`);

function getCardImageSmall(c: ScryfallCard | null): string {
  if (!c) {
    debugLog('[MTG] getCardImageSmall: card is null');
    return PLACEHOLDER_IMG;
  }
  if (c.image_uris) {
    const url = c.image_uris.small || c.image_uris.normal || '';
    if (url) return url;
  }
  if (c.card_faces?.[0]?.image_uris) {
    const url = c.card_faces[0].image_uris.small || c.card_faces[0].image_uris.normal || '';
    if (url) return url;
  }
  debugLog('[MTG] getCardImageSmall: no image_uris for', c.name);
  return PLACEHOLDER_IMG;
}

function getCardPrice(c: ScryfallCard | null): number {
  if (!c?.prices) return 0;
  return parseFloat(c.prices.eur || c.prices.usd || '0');
}


// ==================== PARSING ====================
function parseDecklistDetailed(text: string): DeckParseResult {
  const result = parseDeckInput(text);
  debugLog('[MTG Parser] Parsed format:', result.format, 'cards:', {
    main: result.deck.main.length,
    sideboard: result.deck.sideboard.length,
    commander: result.deck.commander.length,
    errors: result.errors.length,
    warnings: result.warnings.length,
  });
  return result;
}

function parseDecklist(text: string): Deck {
  return parseDeckInputUnsafe(text);
}

// ==================== FILE HANDLING ====================
const FILE_MAX_BYTES = 2 * 1024 * 1024; // 2MB

export function handleFile(file: File): void {
  debugLog('[MTG] handleFile called:', file?.name);
  if (!file) return;
  if (file.size > FILE_MAX_BYTES) {
    handleImportFailure(`File too large (max ${FILE_MAX_BYTES / 1024 / 1024}MB).`);
    return;
  }

  setRetryImportAction(() => handleFile(file));
  clearError();
  setImportFlowState('loading', 'import', `Reading ${file.name}...`);
  showLoader(`Reading ${file.name}...`);
  const startedAt = Date.now();

  currentDeckName = file.name.replace(/\.(dec|txt|dek|mwDeck|csv|json)$/i, '');
  deckNameAutoDetected = false;
  const r = new FileReader();
  r.onload = async (e) => {
    const text = e.target?.result as string;
    debugLog('[MTG] File content loaded, length:', text?.length);
    const parsed = parseDecklistDetailed(text);
    if (parsed.errors.length > 0) {
      handleImportFailure(formatDeckParseErrors(parsed.errors));
      return;
    }
    const d = parsed.deck;
    if (d.main.length === 0 && d.commander.length === 0) {
      handleImportFailure('Could not parse any cards.');
      return;
    }
    if (parsed.warnings.length > 0) {
      showToast(`Parsed with ${parsed.warnings.length} warning(s)`);
    }
    await processDeck(d);
    emitDeckImportedEvent('file', d, {
      file_name: file.name,
      file_size_bytes: file.size,
      parsed_format: parsed.format,
      parse_warnings_count: parsed.warnings.length,
      import_duration_ms: Date.now() - startedAt,
    });
  };
  r.onerror = () => {
    handleImportFailure('Failed to read file. Please select the file again.');
  };
  r.readAsText(file);
}

export function triggerFileInput(): void {
  const input = $('deckFileInput') as HTMLInputElement | null;
  input?.click();
}

// ==================== IMPORT ====================
const PASTE_MAX_CHARS = 200_000;

async function importDecklistText(text: string, fallbackName: string, source: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    handleImportFailure('Please paste a decklist.');
    focusImportPanel();
    return;
  }
  if (trimmed.length > PASTE_MAX_CHARS) {
    handleImportFailure(`Input too large (max ${PASTE_MAX_CHARS.toLocaleString()} characters).`);
    return;
  }

  clearError();
  setImportFlowState('loading', 'import', 'Parsing decklist and preparing analysis...');
  showLoader('Parsing decklist...');
  const startedAt = Date.now();

  const parsed = parseDecklistDetailed(trimmed);
  if (parsed.errors.length > 0) {
    handleImportFailure(formatDeckParseErrors(parsed.errors));
    return;
  }
  const d = parsed.deck;
  if (d.main.length === 0 && d.commander.length === 0) {
    handleImportFailure('Could not parse any cards. Check format: "4 Card Name" or "4x Card Name".');
    return;
  }

  const firstLine = trimmed.split('\n')[0].trim();
  if (firstLine && !firstLine.match(/^\d/) && firstLine.length < 50) {
    currentDeckName = firstLine.replace(/^(deck|name|title):\s*/i, '').trim() || fallbackName;
    deckNameAutoDetected = true;
  } else {
    currentDeckName = fallbackName;
    deckNameAutoDetected = fallbackName !== 'Imported Deck';
  }

  const total = d.main.reduce((a, e) => a + e.qty, 0) +
                d.sideboard.reduce((a, e) => a + e.qty, 0) +
                d.commander.reduce((a, e) => a + e.qty, 0);
  showToast(`Parsed ${total} cards (${d.main.length} unique)`);

  if (parsed.warnings.length > 0) {
    showToast(`Parsed with ${parsed.warnings.length} warning(s)`);
    console.warn('[MTG Parser warnings]', parsed.warnings);
  }

  await processDeck(d);
  emitDeckImportedEvent(source, d, {
    parsed_format: parsed.format,
    parse_warnings_count: parsed.warnings.length,
    auto_named: deckNameAutoDetected,
    import_duration_ms: Date.now() - startedAt,
  });
}

function deckToDecklistText(deck: Deck): string {
  return serializeDeckForExport(deck, { format: 'text', deckName: currentDeckName });
}

function normalizeExportFormat(format: string): DeckExportFormat {
  if (format === 'arena' || format === 'mtgo' || format === 'csv' || format === 'json' || format === 'moxfield') {
    return format;
  }
  return 'text';
}

function refreshExportOutputForCurrentState(): void {
  if (!currentDeck) return;
  const output = $('exportOutput') as HTMLTextAreaElement | null;
  if (!output) return;

  // Keep preview synced when user has already generated export content
  // or the export panel is open.
  const exportPanelOpen = Boolean($('exportPanel')?.classList.contains('active'));
  if (exportPanelOpen || output.value.trim().length > 0) {
    exportDeck(currentExportFormat);
  }
}

function isLikelyDecklistText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^https?:\/\//i.test(trimmed)) return false;

  const parsed = parseDecklist(trimmed);
  const totalCards = parsed.main.reduce((a, e) => a + e.qty, 0) +
    parsed.sideboard.reduce((a, e) => a + e.qty, 0) +
    parsed.commander.reduce((a, e) => a + e.qty, 0);

  return totalCards >= 5 || parsed.main.length >= 3 || parsed.commander.length > 0;
}

export function importPaste(): void {
  debugLog('[MTG] importPaste called');
  setRetryImportAction(() => importPaste());
  const textarea = $('pasteArea') as HTMLTextAreaElement | null;
  const text = textarea?.value || '';
  void importDecklistText(text, 'Imported Deck', 'paste');
}

export async function importUrlAutoPaste(): Promise<void> {
  const input = $('urlInput') as HTMLInputElement | null;
  const pasteArea = $('pasteArea') as HTMLTextAreaElement | null;
  const url = input?.value.trim() || '';
  if (!url) {
    handleImportFailure('Please enter a deck URL.');
    focusImportPanel();
    return;
  }

  setRetryImportAction(() => importUrlAutoPaste());

  const label = getUrlLabel(url);
  clearError();
  setImportFlowState('loading', 'import', `Importing deck from ${label}...`);
  showLoader(`Importing deck from ${label}...`);
  const startedAt = Date.now();

  const existingPaste = (pasteArea?.value || '').trim();

  try {
    if (navigator.clipboard?.readText) {
      const clip = (await navigator.clipboard.readText()).trim();
      if (clip && clip !== existingPaste) {
        if (isLikelyDecklistText(clip)) {
          if (pasteArea) {
            pasteArea.value = clip;
            pasteArea.dispatchEvent(new Event('input', { bubbles: true }));
          }
          showToast('Clipboard decklist detected. Importing...');
          await importDecklistText(clip, `${label} Deck`, 'url_autopaste_clipboard');
          setImportSuccessBadge(label);
          if (input) input.value = '';
          return;
        }
      }
    }
  } catch {
    // Ignore clipboard errors and continue with URL fetch.
  }

  try {
    const result = await importDeckFromUrl(url);

    if (pasteArea) {
      pasteArea.value = deckToDecklistText(result.deck);
      pasteArea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    currentDeckName = result.name;
    deckNameAutoDetected = true;

    if (input) input.value = '';
    await processDeck(result.deck);
    emitDeckImportedEvent('url_autopaste_fetch', result.deck, {
      provider: label,
      import_duration_ms: Date.now() - startedAt,
    });
    setImportSuccessBadge(label);
    showToast(`Imported "${result.name}" from ${label}`);
    return;
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to import deck';

    if (label === 'Moxfield') {
      const lowered = message.toLowerCase();
      if (lowered.includes('moxfield') || lowered.includes('json') || lowered.includes('cloudflare') || lowered.includes('cors')) {
        startMoxfieldClipboardWatch('Moxfield Deck');
        handleImportFailure('Moxfield API blocked. Copy Moxfield export text manually, then click "Paste Clipboard".');
        return;
      }
    }

    if (label === 'Archidekt') {
      const lowered = message.toLowerCase();
      if (lowered.includes('archidekt') || lowered.includes('json') || lowered.includes('cors')) {
        startMoxfieldClipboardWatch('Archidekt Deck');
        handleImportFailure('Archidekt API blocked. Copy Archidekt export text manually, then click "Paste Clipboard".');
        return;
      }
    }

    handleImportFailure(message);
    console.error('[MTG] URL autopaste import failed:', e);
    return;
  }
}

// URL Validation - local version for UI display (label extraction)
// NOTE: Actual validation + fetch is handled by shared/api.ts importDeckFromUrl
const ALLOWED_HOSTS: Record<string, { pathPrefix: string; label: string }> = {
  'www.moxfield.com': { pathPrefix: '/decks/', label: 'Moxfield' },
  'moxfield.com': { pathPrefix: '/decks/', label: 'Moxfield' },
  'archidekt.com': { pathPrefix: '/decks/', label: 'Archidekt' },
  'www.archidekt.com': { pathPrefix: '/decks/', label: 'Archidekt' },
};

function getUrlLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const config = ALLOWED_HOSTS[parsed.hostname];
    return config?.label || 'deck site';
  } catch {
    return 'deck site';
  }
}

function stopMoxfieldClipboardWatch(): void {
  if (!moxfieldClipboardWatchActive) return;
  moxfieldClipboardWatchActive = false;
  window.removeEventListener('focus', onMoxfieldClipboardWatch);
  document.removeEventListener('visibilitychange', onMoxfieldClipboardWatch);
  if (moxfieldClipboardWatchTimeout) {
    clearTimeout(moxfieldClipboardWatchTimeout);
    moxfieldClipboardWatchTimeout = null;
  }
  if (moxfieldClipboardWatchInterval) {
    clearInterval(moxfieldClipboardWatchInterval);
    moxfieldClipboardWatchInterval = null;
  }
  clipboardWatchSourceLabel = '';
}

async function tryImportClipboardDecklist(defaultName: string, source: string): Promise<boolean> {
  if (!navigator.clipboard?.readText) return false;

  try {
    const clip = (await navigator.clipboard.readText()).trim();
    if (!clip || clip === lastClipboardText) return false;
    if (!isLikelyDecklistText(clip)) return false;
    lastClipboardText = clip;

    const pasteArea = $('pasteArea') as HTMLTextAreaElement | null;
    if (pasteArea) {
      pasteArea.value = clip;
      pasteArea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    await importDecklistText(clip, defaultName, source);
    if (clipboardWatchSourceLabel) {
      setImportSuccessBadge(clipboardWatchSourceLabel);
    }
    stopMoxfieldClipboardWatch();
    return true;
  } catch {
    return false;
  }
}

function onMoxfieldClipboardWatch(): void {
  if (!moxfieldClipboardWatchActive) return;
  if (document.visibilityState === 'hidden') return;
  void tryImportClipboardDecklist(clipboardWatchDeckName, 'clipboard_watch');
}

function startMoxfieldClipboardWatch(defaultName: string): void {
  if (moxfieldClipboardWatchActive) return;
  clipboardWatchDeckName = defaultName;
  clipboardWatchSourceLabel = defaultName.includes('Archidekt') ? 'Archidekt' : 'Moxfield';
  moxfieldClipboardWatchActive = true;
  window.addEventListener('focus', onMoxfieldClipboardWatch);
  document.addEventListener('visibilitychange', onMoxfieldClipboardWatch);
  moxfieldClipboardWatchInterval = setInterval(() => {
    void onMoxfieldClipboardWatch();
  }, 1500);
  void onMoxfieldClipboardWatch();

  moxfieldClipboardWatchTimeout = setTimeout(() => {
    stopMoxfieldClipboardWatch();
  }, 120000);
}

export async function importClipboardNow(): Promise<void> {
  setRetryImportAction(() => importClipboardNow());
  clearError();
  setImportFlowState('loading', 'import', 'Reading decklist from clipboard...');
  showLoader('Reading decklist from clipboard...');
  const input = $('urlInput') as HTMLInputElement | null;
  const label = getUrlLabel(input?.value.trim() || '');
  const imported = await tryImportClipboardDecklist(`${label === 'deck site' ? 'Imported' : label} Deck`, 'clipboard_manual');
  if (!imported) {
    handleImportFailure('No valid decklist found in clipboard. Copy exported deck text first.');
  }
}

export async function importUrl(): Promise<void> {
  const input = $('urlInput') as HTMLInputElement | null;
  const url = input?.value.trim() || '';
  if (!url) { 
    handleImportFailure('Please enter a deck URL.'); 
    focusImportPanel();
    return; 
  }

  setRetryImportAction(() => importUrl());
  const label = getUrlLabel(url);
  clearError();
  setImportFlowState('loading', 'import', `Importing deck from ${label}...`);
  showLoader(`Importing deck from ${label}...`);
  showToast(`Importing from ${label}...`);
  const startedAt = Date.now();
  
  try {
    // Use shared API - handles validation, fetch, and error messages
    const result = await importDeckFromUrl(url);
    
    // Set deck name from import
    currentDeckName = result.name;
    deckNameAutoDetected = true;
    
    // Clear input
    if (input) input.value = '';
    
    // Process the imported deck
    await processDeck(result.deck);
    emitDeckImportedEvent('url_fetch', result.deck, {
      provider: label,
      import_duration_ms: Date.now() - startedAt,
    });
    setImportSuccessBadge(label);
    
    showToast(`Imported "${result.name}" from ${label}`);
  } catch (e) {
    // importDeckFromUrl throws user-friendly errors
    const message = e instanceof Error ? e.message : 'Failed to import deck';
    if (label === 'Moxfield') {
      const lowered = message.toLowerCase();
      if (lowered.includes('moxfield') || lowered.includes('json') || lowered.includes('cloudflare') || lowered.includes('cors')) {
        handleImportFailure('Moxfield API blocked. Use "Fetch + AutoPaste" for guided import.');
        console.error('[MTG] URL import failed:', e);
        return;
      }
    }
    if (label === 'Archidekt') {
      const lowered = message.toLowerCase();
      if (lowered.includes('archidekt') || lowered.includes('json') || lowered.includes('cors')) {
        handleImportFailure('Archidekt API blocked. Use "Fetch + AutoPaste" for guided import.');
        console.error('[MTG] URL import failed:', e);
        return;
      }
    }
    handleImportFailure(message);
    console.error('[MTG] URL import failed:', e);
  }
}

// ==================== PROCESS DECK ====================
async function processDeck(deck: Deck): Promise<void> {
  const totalCards = deck.main.reduce((a, e) => a + e.qty, 0)
    + deck.sideboard.reduce((a, e) => a + e.qty, 0)
    + deck.commander.reduce((a, e) => a + e.qty, 0);

  if (totalCards === 0) {
    handleImportFailure('No cards found in the imported deck.');
    return;
  }

  currentDeck = deck;
  clearError();
  resetDeckPanelsForLoading();
  setImportFlowState('loading', 'import', 'Loading card data and preparing analysis...');
  showLoader('Loading card data...');

  const allNames = collectUniqueDeckCardNames(deck);
  let loadedWithPartialData = false;

  // Fetch card data from Scryfall (best effort)
  try {
    await fetchCardsFromScryfall(allNames);
  } catch (e) {
    loadedWithPartialData = true;
    showError('Some card data could not be loaded. Showing partial data.');
    console.error(e);
  }

  buildCardNameIndex(); // Build search index after loading cards
  clearSearch(); // Clear any existing search when loading new deck
  autoDetectFormat(deck);
  document.getElementById('onboardState')?.remove();
  renderDeck();
  refreshExportOutputForCurrentState();
  updateToolsState(); // Update all tools when deck is loaded
  hideLoader();

  ensurePanelOpen('analysisPanel', true);
  ensurePanelOpen('exportPanel', false);
  setImportFlowState(
    'ready',
    'analysis',
    loadedWithPartialData
      ? 'Deck loaded with partial card data. Continue with analysis, then recommendations.'
      : 'Deck loaded. Continue with analysis, then recommendations.',
  );
  emitWizardStepEvent('import', 'completed');
}

async function fetchCardsFromScryfall(names: string[]): Promise<void> {
  const cleanedNames = names.map((name) => cleanCardName(name).toLowerCase());
  const missing = cleanedNames.filter((name) => !cardData[name]);
  if (missing.length === 0) {
    setLoaderProgress(1, 1, 'Using cached card data...');
    return;
  }
  
  const uniqueMissing = [...new Set(missing)];

  const chunks = chunkBySize(uniqueMissing, 75);
  const failedNames: string[] = [];
  let completedCards = 0;

  setLoaderProgress(0, uniqueMissing.length, `Loading card data... 0/${uniqueMissing.length}`);

  await processWithConcurrency(
    chunks,
    async (chunk) => {
      const body = { identifiers: chunk.map((name) => ({ name })) };
      try {
        const resp = await fetchRobust('https://api.scryfall.com/cards/collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs: 15000,
          retries: 4,
          backoffMs: 200,
        });

        const data = await resp.json() as { data?: ScryfallCard[]; not_found?: Array<{ name?: string }> };

        debugLog('[MTG Scryfall] Batch response:', {
          found: data.data?.length || 0,
          not_found: data.not_found?.length || 0,
        });

        if (data.not_found?.length) {
          console.warn('[MTG Scryfall] Not found:', data.not_found.map((card) => card.name));
        }

        for (const card of data.data || []) {
          cardData[card.name.toLowerCase()] = card;
          if (!card.image_uris && !card.card_faces?.[0]?.image_uris) {
            debugLog('[MTG Scryfall] Card without images:', card.name);
          }
        }
      } catch (error) {
        failedNames.push(...chunk);
        console.warn('[MTG Scryfall] Batch failed:', error);
      } finally {
        completedCards += chunk.length;
        const loaded = Math.min(completedCards, uniqueMissing.length);
        setLoaderProgress(loaded, uniqueMissing.length, `Loading card data... ${loaded}/${uniqueMissing.length}`);
      }
    },
    3,
  );

  persistCardCache();

  if (failedNames.length > 0) {
    throw new Error(`Failed to fetch ${failedNames.length} card(s) from Scryfall`);
  }

  setLoaderProgress(uniqueMissing.length, uniqueMissing.length, 'Card data loaded.');
}

// ==================== RENDER ====================
// ==================== ZONE MANAGEMENT ====================

/**
 * Move a card between deck zones (main/sideboard/commander).
 * Moves 1 copy at a time. If last copy, removes the entry entirely.
 */
export function moveCardZone(cardName: string, from: string, to: string): void {
  if (!currentDeck) return;
  const fromKey = from as keyof Deck;
  const toKey = to as keyof Deck;
  if (!currentDeck[fromKey] || !currentDeck[toKey]) return;
  
  const idx = currentDeck[fromKey].findIndex(e => e.name === cardName);
  if (idx === -1) return;
  
  const entry = currentDeck[fromKey][idx];
  
  // Remove 1 copy from source
  if (entry.qty > 1) {
    entry.qty--;
  } else {
    currentDeck[fromKey].splice(idx, 1);
  }
  
  // Add 1 copy to target (merge if already there)
  const existing = currentDeck[toKey].find(e => e.name === cardName);
  if (existing) {
    existing.qty++;
  } else {
    currentDeck[toKey].push({ name: cardName, qty: 1, set: entry.set, num: entry.num });
  }
  
  const labels: Record<string, string> = { main: 'Main Deck', sideboard: 'Sideboard', commander: 'Commander' };
  showToast(`${cardName} → ${labels[to] || to}`);
  closeCardMenu();
  renderDeck();
}

/**
 * Change a card's quantity in its current zone.
 */
export function changeCardQty(cardName: string, zone: string, delta: number): void {
  if (!currentDeck) return;
  const key = zone as keyof Deck;
  if (!currentDeck[key]) return;
  
  const entry = currentDeck[key].find(e => e.name === cardName);
  if (!entry) return;
  
  entry.qty += delta;
  if (entry.qty <= 0) {
    currentDeck[key].splice(currentDeck[key].indexOf(entry), 1);
    showToast(`Removed ${cardName}`);
  } else {
    showToast(`${cardName}: ${entry.qty}x`);
  }
  closeCardMenu();
  renderDeck();
}

/**
 * Remove all copies of a card from a zone.
 */
export function removeCard(cardName: string, zone: string): void {
  if (!currentDeck) return;
  const key = zone as keyof Deck;
  if (!currentDeck[key]) return;
  
  const idx = currentDeck[key].findIndex(e => e.name === cardName);
  if (idx === -1) return;
  
  currentDeck[key].splice(idx, 1);
  showToast(`Removed ${cardName}`);
  closeCardMenu();
  renderDeck();
}

// ==================== CARD CONTEXT MENU ====================

let _activeMenu: HTMLElement | null = null;

export function closeCardMenu(): void {
  if (_activeMenu) {
    _activeMenu.remove();
    _activeMenu = null;
  }
}

export function openCardMenu(cardName: string, zone: string, anchorEl: HTMLElement): void {
  // Close any existing menu
  closeCardMenu();
  
  if (!currentDeck) return;
  const key = zone as keyof Deck;
  const entry = currentDeck[key]?.find(e => e.name === cardName);
  if (!entry) return;
  
  const zones = ['main', 'sideboard', 'commander'] as const;
  const labels: Record<string, string> = { main: '📋 Main Deck', sideboard: '📁 Sideboard', commander: '👑 Commander' };
  const moveTargets = zones.filter(z => z !== zone);
  
  // Build menu items
  const items: HTMLElement[] = [];
  
  // Quantity controls
  items.push(
    h('div', { className: 'cm-qty' },
      h('button', { 
        className: 'cm-qty-btn',
        'data-action': 'card-qty', 
        'data-card': cardName, 
        'data-zone': zone, 
        'data-delta': '-1'
      }, '−'),
      h('span', { className: 'cm-qty-val' }, `${entry.qty}x`),
      h('button', { 
        className: 'cm-qty-btn',
        'data-action': 'card-qty', 
        'data-card': cardName, 
        'data-zone': zone, 
        'data-delta': '1'
      }, '+')
    )
  );
  
  items.push(h('div', { className: 'cm-divider' }));
  
  // Move options
  for (const target of moveTargets) {
    items.push(h('button', { 
      className: 'cm-item',
      'data-action': 'move-zone', 
      'data-card': cardName, 
      'data-from': zone, 
      'data-to': target
    }, `→ ${labels[target]}`));
  }
  
  items.push(h('div', { className: 'cm-divider' }));
  
  // Remove
  items.push(h('button', { 
    className: 'cm-item cm-item--danger',
    'data-action': 'remove-card', 
    'data-card': cardName, 
    'data-zone': zone
  }, '🗑 Remove'));
  
  const menu = h('div', { className: 'card-menu' }, ...items);
  
  // Position relative to anchor
  document.body.appendChild(menu);
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  
  // Default: below-right of the button
  let top = rect.bottom + 4;
  let left = rect.left;
  
  // Flip up if would overflow bottom
  if (top + menuRect.height > window.innerHeight - 8) {
    top = rect.top - menuRect.height - 4;
  }
  // Flip left if would overflow right
  if (left + menuRect.width > window.innerWidth - 8) {
    left = rect.right - menuRect.width;
  }
  // Clamp
  top = Math.max(4, top);
  left = Math.max(4, left);
  
  menu.style.top = `${top}px`;
  menu.style.left = `${left}px`;
  
  _activeMenu = menu;
  
  // Close on outside click or scroll
  requestAnimationFrame(() => {
    const cleanup = () => {
      document.removeEventListener('click', closeOnOutside, true);
      window.removeEventListener('scroll', closeOnScroll, true);
    };
    const closeOnOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        closeCardMenu();
        cleanup();
      }
    };
    const closeOnScroll = () => {
      closeCardMenu();
      cleanup();
    };
    document.addEventListener('click', closeOnOutside, true);
    window.addEventListener('scroll', closeOnScroll, true);
  });
}

// ==================== RENDER ====================
function renderDeck(): void {
  if (!currentDeck) return;
  
  const content = $('deckContent');
  if (!content) return;
  
  // Clear content using DOM API
  replaceChildren(content);
  
  const sections: Array<{ key: keyof Deck; label: string }> = [
    { key: 'main', label: 'Main Deck' },
    { key: 'sideboard', label: 'Sideboard' },
    { key: 'commander', label: 'Commander' },
  ];
  
  // Track if we have any results
  let totalMatches = 0;
  
  // Helper: context menu trigger button for a card
  const menuBtn = (sectionKey: string, cardName: string): HTMLElement => {
    return h('button', { 
      className: 'card-menu-btn',
      title: 'Card options',
      'data-action': 'open-card-menu',
      'data-card': cardName,
      'data-zone': sectionKey
    }, '⋮');
  };

  const flowDeckClassName = (baseClass: string, cardName: string): string => {
    const cardKey = normalizeHistoryCardKey(cardName);
    const classes = [baseClass];

    if (flowApplyHighlightNames.has(cardKey)) {
      classes.push('flow-apply-highlight');
    }

    if (flowApplyVisualState.active) {
      if (flowApplyVisualState.addedCardKey === cardKey) {
        classes.push('flow-just-added');
      } else if (flowApplyVisualState.removedCardKey === cardKey) {
        classes.push('flow-just-cut');
      } else {
        classes.push('flow-existing-muted');
      }
    }

    return classes.join(' ');
  };
  
  for (const section of sections) {
    const allEntries = currentDeck[section.key];
    if (allEntries.length === 0) continue;
    
    // Filter entries by search term
    const entries = allEntries.filter(matchesSearch);
    totalMatches += entries.length;
    
    if (entries.length === 0) continue; // Skip empty filtered sections
    
    const totalCount = entries.reduce((a, e) => a + e.qty, 0);
    const allCount = allEntries.reduce((a, e) => a + e.qty, 0);
    
    // Build section based on current view
    let gridEl: HTMLElement;
    
    if (currentView === 'grid') {
      // Grid view - large card images only
      gridEl = h('div', { className: 'card-grid-img' },
        ...entries.map(entry => {
          const card = resolveCard(entry.name);
          const img = getCardImageSmall(card);
          return h('div', { 
            className: flowDeckClassName('gcard', entry.name),
            'data-card': entry.name,
            'data-action': 'open-modal'
          },
            h('img', { 
              src: sanitizeUrl(img), 
              alt: entry.name, 
              loading: 'lazy'
            }),
            entry.qty > 1 ? h('span', { className: 'gqty' }, `${entry.qty}x`) : null,
            menuBtn(section.key, entry.name)
          );
        })
      );
    } else if (currentView === 'table') {
      // Table view - list format
      gridEl = h('table', { className: 'deck-table' },
        h('thead', {},
          h('tr', {},
            h('th', {}, 'Qty'),
            h('th', {}, 'Name'),
            h('th', {}, 'Type'),
            h('th', {}, 'Cost'),
            h('th', {}, 'Price'),
            h('th', { className: 'table-actions-col' }, '')
          )
        ),
        h('tbody', {},
          ...entries.map(entry => {
            const card = resolveCard(entry.name);
            return h('tr', { 
              'data-card': entry.name,
              'data-action': 'open-modal',
              className: flowDeckClassName('clickable', entry.name)
            },
              h('td', {}, `${entry.qty}`),
              h('td', {}, entry.name),
              h('td', {}, card?.type_line?.split('—')[0]?.trim() || ''),
              h('td', {}, card?.mana_cost || ''),
              h('td', {}, card?.prices?.eur ? `€${card.prices.eur}` : ''),
              h('td', {}, menuBtn(section.key, entry.name))
            );
          })
        )
      );
    } else {
      // Card view (default) - card with small image and text
      gridEl = h('div', { className: 'card-grid' },
        ...entries.map(entry => {
          const card = resolveCard(entry.name);
          const img = getCardImageSmall(card);
          
          return h('div', { 
            className: flowDeckClassName('card-item', entry.name),
            'data-card': entry.name,
            'data-action': 'open-modal'
          },
            h('img', { 
              src: sanitizeUrl(img), 
              alt: entry.name, 
              loading: 'lazy'
            }),
            h('span', { className: 'qty' }, `${entry.qty}x`),
            h('span', { className: 'name' }, entry.name),
            menuBtn(section.key, entry.name)
          );
        })
      );
    }
    
    // Show filtered/total in header when searching
    const headerText = searchTerm && totalCount !== allCount
      ? `${section.label} (${totalCount}/${allCount})`
      : `${section.label} (${totalCount})`;
    
    const sectionEl = h('div', { className: 'deck-section' },
      h('h3', {}, headerText),
      gridEl
    );
    
    content.appendChild(sectionEl);
  }
  
  // Show "no results" message if searching with no matches
  if (searchTerm && totalMatches === 0) {
    const noResults = h('div', { className: 'empty-state empty-state-center' },
      h('p', {}, `No cards matching "${escapeHtml(searchTerm)}"`),
      h('button', { 
        className: 'btn btn-secondary empty-state-action',
        onclick: clearSearch 
      }, 'Clear Search')
    );
    content.appendChild(noResults);
  }
  
  // Show deck overview
  show($('deckOverview'));
  show($('toolbar'));
  
  // Update stats
  updateStats();
  
  // Render analysis panels
  renderManaCurve();
  renderColorDistribution();
  renderTypeBars();
  renderManaBaseAnalysis();
  renderFormatLegality();
}

// ==================== ANALYSIS ====================
function renderManaCurve(): void {
  if (!currentDeck) return;
  const el = $('manaCurve');
  if (!el) return;
  
  const curve: number[] = [0, 0, 0, 0, 0, 0, 0, 0]; // 0-7+
  
  for (const entry of currentDeck.main) {
    const card = resolveCard(entry.name);
    if (!card || card.type_line?.toLowerCase().includes('land')) continue;
    const cmc = Math.min(card.cmc || 0, 7);
    curve[cmc] += entry.qty;
  }
  
  const max = Math.max(...curve, 1);
  
  replaceChildren(el, ...curve.map((count, idx) => {
    const height = Math.round((count / max) * 100);
    const label = idx === 7 ? '7+' : String(idx);
    return h('div', { className: 'mana-bar-col' },
      h('div', { className: 'mana-bar-count' }, count > 0 ? String(count) : ''),
      h('div', { className: 'mana-bar', style: `height:${Math.max(height, 2)}%;` }),
      h('div', { className: 'mana-bar-label' }, label)
    );
  }));
}

function renderColorDistribution(): void {
  if (!currentDeck) return;
  const el = $('colorDist');
  if (!el) return;
  
  const colors: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const colorNames: Record<string, string> = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green', C: 'Colorless' };
  const colorHex: Record<string, string> = { W: '#f0e6b2', U: '#60a5fa', B: '#c084fc', R: '#f87171', G: '#4ade80', C: '#a1a1aa' };
  
  for (const entry of currentDeck.main) {
    const card = resolveCard(entry.name);
    if (!card) continue;
    
    const identity = card.color_identity || [];
    if (identity.length === 0) {
      colors.C += entry.qty;
    } else {
      for (const c of identity) {
        if (colors[c] !== undefined) colors[c] += entry.qty;
      }
    }
  }
  
  const entries = Object.entries(colors).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(([, v]) => v), 1);
  
  if (entries.length === 0) {
    replaceChildren(el, h('div', { className: 'tool-empty' }, 'No cards'));
    return;
  }
  
  replaceChildren(el, ...entries.map(([color, count]) => {
    const pct = Math.round((count / max) * 100);
    return h('div', { className: 'color-row' },
      h('span', { className: 'color-swatch', style: `background:${colorHex[color]};` }),
      h('span', { className: 'color-name' }, colorNames[color]),
      h('div', { className: 'color-bar-track' },
        h('div', { className: 'color-bar-fill', style: `width:${pct}%; background:${colorHex[color]};` })
      ),
      h('span', { className: 'color-count' }, String(count))
    );
  }));
}

function renderTypeBars(): void {
  if (!currentDeck) return;
  const el = $('typeBars');
  if (!el) return;
  
  const types: Record<string, number> = {};
  const typeColors: Record<string, string> = {
    'Creature': 'var(--creature)',
    'Instant': 'var(--instant)',
    'Sorcery': 'var(--sorcery)',
    'Enchantment': 'var(--enchantment)',
    'Artifact': 'var(--artifact)',
    'Planeswalker': 'var(--planeswalker)',
    'Land': 'var(--land)',
  };
  
  for (const entry of currentDeck.main) {
    const card = resolveCard(entry.name);
    if (!card) continue;
    
    const typeLine = card.type_line || '';
    for (const t of ['Creature', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Planeswalker', 'Land']) {
      if (typeLine.includes(t)) {
        types[t] = (types[t] || 0) + entry.qty;
        break;
      }
    }
  }
  
  const entries = Object.entries(types).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map(([, v]) => v), 1);
  
  if (entries.length === 0) {
    replaceChildren(el, h('div', { className: 'tool-empty' }, 'No cards'));
    return;
  }
  
  replaceChildren(el, ...entries.map(([type, count]) => {
    const pct = Math.round((count / max) * 100);
    const color = typeColors[type] || 'var(--gold)';
    return h('div', { className: 'type-bar-row' },
      h('span', { className: 'type-bar-label' }, type),
      h('div', { className: 'type-bar-track' },
        h('div', { className: 'type-bar-fill', style: `width:${pct}%; background:${color};` },
          h('span', {}, String(count))
        )
      )
    );
  }));
}

function renderManaBaseAnalysis(): void {
  if (!currentDeck) return;
  const el = $('manaBaseAnalysis');
  if (!el) return;
  
  let lands = 0;
  let nonlands = 0;
  
  for (const entry of currentDeck.main) {
    const card = resolveCard(entry.name);
    if (!card) continue;
    
    if (card.type_line?.toLowerCase().includes('land')) {
      lands += entry.qty;
    } else {
      nonlands += entry.qty;
    }
  }
  
  const total = lands + nonlands;
  const landPct = total > 0 ? Math.round((lands / total) * 100) : 0;
  const ideal = total >= 60 ? 24 : Math.round(total * 0.4); // ~40% for limited
  const diff = lands - ideal;
  
  let status = 'good';
  let statusText = 'On target';
  if (diff < -3) { status = 'bad'; statusText = `${Math.abs(diff)} lands short`; }
  else if (diff > 3) { status = 'warn'; statusText = `${diff} lands over`; }
  else if (diff !== 0) { status = 'warn'; statusText = diff > 0 ? `${diff} over` : `${Math.abs(diff)} under`; }
  
  replaceChildren(el,
    h('div', { className: 'mana-summary' },
      h('div', { className: 'big-num' }, String(lands)),
      h('div', { className: 'big-label' }, `Lands (${landPct}%)`),
      h('div', { className: 'sub-info' }, `${nonlands} non-land spells`)
    ),
    h('div', { className: 'mana-recs' },
      h('div', { className: 'mana-rec-row' },
        h('span', { className: 'mana-rec-label' }, 'Recommended'),
        h('span', { className: 'mana-rec-val' }, String(ideal))
      ),
      h('div', { className: 'mana-rec-row' },
        h('span', { className: 'mana-rec-label' }, 'Status'),
        h('span', { className: `mana-rec-val ${status}` }, statusText)
      )
    )
  );
  
  // Color sources
  renderColorSources();
}

function renderColorSources(): void {
  if (!currentDeck) return;
  const el = $('colorSources');
  if (!el) return;
  
  const sources: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  const colorNames: Record<string, string> = { W: '☀️', U: '💧', B: '💀', R: '🔥', G: '🌲' };
  const needs: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  
  // Count pips needed in mana costs
  for (const entry of currentDeck.main) {
    const card = resolveCard(entry.name);
    if (!card || !card.mana_cost) continue;
    
    const cost = card.mana_cost;
    for (const c of ['W', 'U', 'B', 'R', 'G']) {
      const regex = new RegExp(`{${c}}`, 'g');
      const matches = cost.match(regex);
      if (matches) needs[c] += matches.length * entry.qty;
    }
  }
  
  // Count sources from lands
  for (const entry of currentDeck.main) {
    const card = resolveCard(entry.name);
    if (!card || !card.type_line?.toLowerCase().includes('land')) continue;
    
    const identity = card.color_identity || [];
    const text = card.oracle_text || '';
    
    for (const c of identity) {
      if (sources[c] !== undefined) sources[c] += entry.qty;
    }
    
    // Basic land types
    if (text.includes('Plains') || card.name === 'Plains') sources.W += entry.qty;
    if (text.includes('Island') || card.name === 'Island') sources.U += entry.qty;
    if (text.includes('Swamp') || card.name === 'Swamp') sources.B += entry.qty;
    if (text.includes('Mountain') || card.name === 'Mountain') sources.R += entry.qty;
    if (text.includes('Forest') || card.name === 'Forest') sources.G += entry.qty;
  }
  
  // Only show colors we need
  const needed = Object.entries(needs).filter(([, v]) => v > 0);
  
  if (needed.length === 0) {
    replaceChildren(el, h('div', { className: 'tool-empty' }, 'No colored pips detected'));
    return;
  }
  
  replaceChildren(el,
    h('div', { className: 'source-grid' },
      ...needed.map(([color]) => {
        const have = sources[color] || 0;
        const need = Math.ceil((needs[color] || 0) / 4); // Simplified: need ~1 source per 4 pips
        let status = 'sc-ok';
        if (have < need - 2) status = 'sc-bad';
        else if (have < need) status = 'sc-warn';
        
        return h('div', { className: `source-card ${status}` },
          h('div', { className: 'sc-pip' }, colorNames[color]),
          h('div', { className: 'sc-have' }, String(have)),
          h('div', { className: 'sc-need' }, `need ~${need}`)
        );
      })
    )
  );
}

function renderFormatLegality(): void {
  if (!currentDeck) return;
  const el = $('formatLegality');
  if (!el) return;
  
  // Collect all card legalities
  const formats = ['standard', 'pioneer', 'modern', 'legacy', 'vintage', 'commander', 'pauper'];
  const formatLabels: Record<string, string> = {
    standard: 'Standard', pioneer: 'Pioneer', modern: 'Modern',
    legacy: 'Legacy', vintage: 'Vintage', commander: 'Commander', pauper: 'Pauper'
  };
  
  const results: Record<string, string> = {};
  
  for (const fmt of formats) {
    results[fmt] = 'legal';
  }
  
  for (const entry of [...currentDeck.main, ...currentDeck.sideboard, ...currentDeck.commander]) {
    const card = resolveCard(entry.name);
    if (!card?.legalities) continue;
    
    for (const fmt of formats) {
      const status = card.legalities[fmt];
      if (status === 'banned' || status === 'not_legal') {
        results[fmt] = status;
      } else if (status === 'restricted' && results[fmt] !== 'banned' && results[fmt] !== 'not_legal') {
        results[fmt] = 'restricted';
      }
    }
  }
  
  replaceChildren(el, ...formats.map(fmt => {
    const status = results[fmt];
    return h('div', { className: 'format-row' },
      h('span', { className: 'fl-name' }, formatLabels[fmt]),
      h('span', { className: `fl-badge fl-${status}` }, status.replace('_', ' '))
    );
  }));
}

function updateStats(): void {
  if (!currentDeck) return;
  
  const totalMain = currentDeck.main.reduce((a, e) => a + e.qty, 0);
  const totalSB = currentDeck.sideboard.reduce((a, e) => a + e.qty, 0);
  const totalCmdr = currentDeck.commander.reduce((a, e) => a + e.qty, 0);
  const totalCards = totalMain + totalSB + totalCmdr;
  
  const statsEl = $('statsRow');
  if (statsEl) {
    const chips: Array<{ label: string; value: number; color: string }> = [
      { label: 'Main', value: totalMain, color: '#60a5fa' },
      { label: 'Sideboard', value: totalSB, color: '#8b5cf6' },
      { label: 'Commander', value: totalCmdr, color: '#f8d56a' },
      { label: 'Total', value: totalCards, color: '#4ade80' },
    ];

    replaceChildren(
      statsEl,
      ...chips
        .filter(chip => chip.value > 0 || chip.label === 'Main' || chip.label === 'Total')
        .map(chip =>
          h(
            'div',
            { className: 'stat-chip' },
            h('span', { className: 'stat-dot', style: `background:${chip.color};color:${chip.color};` }),
            h('span', {}, `${chip.label}:`),
            h('span', { className: 'num' }, String(chip.value))
          )
        )
    );
  }

  const colorPipsEl = $('colorPips');
  if (colorPipsEl) {
    const weights: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
    const order = ['W', 'U', 'B', 'R', 'G', 'C'];

    for (const entry of [...currentDeck.main, ...currentDeck.commander]) {
      const card = resolveCard(entry.name);
      if (!card) continue;

      const ids = card.color_identity && card.color_identity.length > 0
        ? card.color_identity
        : (card.colors || []);

      if (ids.length === 0) {
        weights.C += entry.qty;
        continue;
      }

      for (const c of ids) {
        if (weights[c] !== undefined) {
          weights[c] += entry.qty;
        }
      }
    }

    const pips = order.filter(c => weights[c] > 0);
    replaceChildren(
      colorPipsEl,
      ...pips.map(c =>
        h('span', { className: `color-pip pip-${c}`, title: `${weights[c]} cards` }, c)
      )
    );
  }
  
  // Calculate total price
  let totalPrice = 0;
  for (const entry of [...currentDeck.main, ...currentDeck.sideboard, ...currentDeck.commander]) {
    const card = resolveCard(entry.name);
    totalPrice += getCardPrice(card) * entry.qty;
  }
  
  const priceEl = $('deckPrice');
  if (priceEl) {
    priceEl.textContent = `€${totalPrice.toFixed(2)}`;
  }

  updateDeckHeaderProminence();
}

// ==================== MODAL ====================
export function openModal(cardName: string): void {
  const card = resolveCard(cardName);
  if (!card) return;

  hidePreview();
  hideSymbolTooltip();

  const modal = $('modal');
  if (!modal) return;

  const modalImg = $('modalImg') as HTMLImageElement | null;
  const modalName = $('modalName');
  const modalType = $('modalType');
  const modalMana = $('modalMana');
  const modalStats = $('modalStats');
  const modalPrice = $('modalPrice');
  const modalLegality = $('modalLegality');
  const modalBuyLinks = $('modalBuyLinks');
  const modalOwnedInfo = $('modalOwnedInfo');
  const modalDesc = $('modalDesc');

  const img = getCardImage(card);
  if (modalImg) {
    modalImg.src = sanitizeUrl(img);
    modalImg.alt = card.name;
  }
  if (modalName) modalName.textContent = card.name;
  if (modalType) modalType.textContent = card.type_line || '';
  if (modalMana) {
    replaceChildren(modalMana, ...(card.mana_cost ? renderMtgSymbolText(card.mana_cost) : []));
  }

  if (modalStats) {
    const statsNodes: HTMLElement[] = [];
    statsNodes.push(h('div', { className: 'mstat' }, h('span', {}, 'CMC'), h('strong', {}, String(card.cmc ?? 0))));
    const colorText = (card.colors && card.colors.length > 0) ? card.colors.join(' ') : 'Colorless';
    statsNodes.push(h('div', { className: 'mstat' }, h('span', {}, 'Colors'), h('strong', {}, colorText)));
    if (card.power && card.toughness) {
      statsNodes.push(h('div', { className: 'mstat' }, h('span', {}, 'P/T'), h('strong', {}, `${card.power}/${card.toughness}`)));
    }
    if (card.loyalty) {
      statsNodes.push(h('div', { className: 'mstat' }, h('span', {}, 'Loyalty'), h('strong', {}, card.loyalty)));
    }
    replaceChildren(modalStats, ...statsNodes);
  }

  if (modalPrice) {
    replaceChildren(
      modalPrice,
      h('span', {}, 'Price: '),
      h('strong', {}, `EUR ${getCardPrice(card).toFixed(2)}`)
    );
  }

  if (modalLegality) {
    const formats = ['commander', 'modern', 'pioneer', 'legacy', 'vintage', 'standard'];
    const labels: Record<string, string> = {
      commander: 'Commander',
      modern: 'Modern',
      pioneer: 'Pioneer',
      legacy: 'Legacy',
      vintage: 'Vintage',
      standard: 'Standard',
    };
    replaceChildren(
      modalLegality,
      ...formats.map(fmt => {
        const state = card.legalities?.[fmt] || 'unknown';
        const cls = state === 'legal' ? 'fl-legal' : state === 'restricted' ? 'fl-restricted' : 'fl-banned';
        return h('span', { className: `fl-badge ${cls}` }, `${labels[fmt]} ${state === 'legal' ? 'legal' : state}`);
      })
    );
  }

  if (modalBuyLinks) {
    const links: Array<{ key: string; label: string }> = [
      { key: 'cardmarket', label: 'Cardmarket' },
      { key: 'tcgplayer', label: 'TCGplayer' },
      { key: 'cardhoarder', label: 'Cardhoarder' },
    ];
    const nodes = links
      .map(link => {
        const href = card.purchase_uris?.[link.key];
        if (!href) return null;
        return h(
          'a',
          {
            href: sanitizeUrl(href),
            target: '_blank',
            rel: 'noopener noreferrer',
            className: 'chip-btn tool-link-btn',
          },
          link.label
        );
      })
      .filter((n): n is HTMLElement => Boolean(n));
    replaceChildren(modalBuyLinks, ...nodes);
  }

  if (modalOwnedInfo) {
    const owned = getOwnedCountForCard(card);
    modalOwnedInfo.textContent = owned > 0 ? `Owned: ${owned}` : 'Owned: 0';
  }

  if (modalDesc) {
    replaceChildren(
      modalDesc,
      card.oracle_text
        ? h('div', { className: 'oracle-rich' }, ...renderMtgSymbolText(card.oracle_text))
        : h('div', {}, 'No oracle text.'),
      card.flavor_text ? h('span', { className: 'flavor' }, card.flavor_text) : null
    );
  }

  show(modal);
}

export function closeModal(): void {
  hide($('modal'));
  hideSymbolTooltip();
}

// ==================== PREVIEW ====================
export function showPreview(cardName: string, e: MouseEvent): void {
  if (!window.matchMedia('(hover: hover)').matches) return;
  const card = resolveCard(cardName);
  if (!card) return;

  const preview = $('hoverPreview');
  if (!preview) return;

  if (hoverPreviewCardName !== cardName) {
    const img = getCardImage(card);
    const hoverImg = $('hoverImg') as HTMLImageElement | null;
    if (hoverImg) {
      hoverImg.src = sanitizeUrl(img);
      hoverImg.alt = card.name;
    }
    hoverPreviewCardName = cardName;
  }

  movePreview(e);
  preview.classList.add('visible');
}

export function hidePreview(): void {
  const preview = $('hoverPreview');
  preview?.classList.remove('visible');
  hoverPreviewCardName = '';
}

export function movePreview(e: MouseEvent): void {
  const preview = $('hoverPreview');
  if (!preview || !preview.classList.contains('visible')) return;

  const margin = 14;
  const width = preview.offsetWidth || 230;
  const height = preview.offsetHeight || 322;
  let x = e.clientX + 18;
  let y = e.clientY - 110;

  if (x + width > window.innerWidth - margin) {
    x = e.clientX - width - 18;
  }
  if (y + height > window.innerHeight - margin) {
    y = window.innerHeight - height - margin;
  }
  if (y < margin) y = margin;
  if (x < margin) x = margin;

  preview.style.left = `${x}px`;
  preview.style.top = `${y}px`;
}

function positionSymbolTooltip(x: number, y: number): void {
  const tooltip = $('symbolTooltip');
  if (!tooltip) return;

  const margin = 10;
  const rect = tooltip.getBoundingClientRect();
  let left = x + 14;
  let top = y + 16;

  if (left + rect.width > window.innerWidth - margin) {
    left = window.innerWidth - rect.width - margin;
  }
  if (left < margin) left = margin;

  if (top + rect.height > window.innerHeight - margin) {
    top = y - rect.height - 14;
  }
  if (top < margin) top = margin;

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

export function showSymbolTooltip(text: string, e?: MouseEvent, anchor?: HTMLElement): void {
  const tooltip = $('symbolTooltip');
  if (!tooltip || !text) return;

  tooltip.textContent = text;
  tooltip.classList.add('visible');
  symbolTooltipVisible = true;

  if (e) {
    positionSymbolTooltip(e.clientX, e.clientY);
    return;
  }

  if (anchor) {
    const r = anchor.getBoundingClientRect();
    positionSymbolTooltip(r.left + r.width / 2, r.top - 8);
  }
}

export function moveSymbolTooltip(e: MouseEvent): void {
  if (!symbolTooltipVisible) return;
  positionSymbolTooltip(e.clientX, e.clientY);
}

export function hideSymbolTooltip(): void {
  const tooltip = $('symbolTooltip');
  tooltip?.classList.remove('visible');
  symbolTooltipVisible = false;
}

// ==================== THEME ====================
export function toggleTheme(): void {
  const isDark = !document.documentElement.hasAttribute('data-theme');
  if (isDark) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  
  const btn = $('btnTheme');
  if (btn) btn.textContent = isDark ? '☀️' : '🌙';
}

// ==================== PANELS ====================
export function goToFlowStep(step: ImportFlowStep): void {
  emitWizardStepEvent(step, 'entered');

  if (step === 'import') {
    setFlowAnalysisSpotlight(false);
    closeFlowTop3ModalInternal();
    clearFlowApplyHighlights();
    clearFlowApplyVisualState();
    focusImportPanel();
    if (currentDeck) {
      setImportFlowState('ready', 'import', 'Import another deck or continue with the guided optimization flow.');
    } else {
      setImportFlowState('empty', 'import', 'Start with Step 1: import a deck list or file.');
    }
    return;
  }

  if (!currentDeck) {
    setFlowAnalysisSpotlight(false);
    closeFlowTop3ModalInternal();
    clearFlowApplyHighlights();
    clearFlowApplyVisualState();
    setImportFlowState('empty', 'import', 'Step 1 required: import a deck before analysis and recommendations.');
    showToast('Import a deck first');
    focusImportPanel();
    return;
  }

  if (step === 'analysis') {
    ensurePanelOpen('analysisPanel', true);
    setFlowAnalysisSpotlight(true);
    closeFlowTop3ModalInternal();
    clearFlowApplyHighlights();
    clearFlowApplyVisualState();
    setImportFlowState('ready', 'analysis', 'Analysis opened in focus mode. Close it when you are ready for Top 3.');
    emitWizardStepEvent('analysis', 'completed');
    return;
  }

  if (step === 'recommend') {
    setFlowAnalysisSpotlight(false);
    clearFlowApplyHighlights();
    clearFlowApplyVisualState();
    ensurePanelOpen('analysisPanel', true);
    activateToolsTab('recs');
    if (recommendationItemsCache.length === 0) {
      setImportFlowState('loading', 'recommend', 'Generating top recommendations...');
      void getCardSuggestions().then(() => {
        const count = recommendationItemsCache.length;
        setImportFlowState(
          'ready',
          'recommend',
          count > 0
            ? `Top recommendations ready (${count}). Review the Top 3 swap popup, then continue to Apply.`
            : 'No recommendations yet. Adjust settings and retry.',
        );
        if (count > 0) openFlowTop3Modal();
        emitWizardStepEvent('recommend', 'completed');
      });
    } else {
      setImportFlowState('ready', 'recommend', 'Recommendations ready. Review the Top 3 swap popup.');
      openFlowTop3Modal();
      emitWizardStepEvent('recommend', 'completed');
    }
    return;
  }

  if (step === 'apply') {
    setFlowAnalysisSpotlight(false);
    closeFlowTop3ModalInternal();
    ensurePanelOpen('analysisPanel', false);
    activateToolsTab('recs');
    const finalizeApplyStep = (): void => {
      const highlightedCount = setFlowApplyHighlightsFromRecommendations(3, { includeCuts: false });
      $('deckContent')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setImportFlowState(
        'ready',
        'apply',
        highlightedCount > 0
          ? 'Deck focus active: new recommendation cards are marked with a green frame.'
          : 'Apply mode active. Click Go to Apply from Top 3 to execute swaps automatically.',
      );
    };
    if (recommendationItemsCache.length === 0) {
      setImportFlowState('loading', 'apply', 'Preparing recommendations before apply...');
      void getCardSuggestions().then(() => {
        finalizeApplyStep();
      });
    } else {
      finalizeApplyStep();
    }
    return;
  }

  setFlowAnalysisSpotlight(false);
  closeFlowTop3ModalInternal();
  clearFlowApplyHighlights();
  clearFlowApplyVisualState();
  ensurePanelOpen('analysisPanel', true);
  activateToolsTab('recs');
  ensurePanelOpen('exportPanel', true);
  if (!(($('exportOutput') as HTMLTextAreaElement | null)?.value.trim())) {
    exportDeck('text');
    setActiveExportButton('text');
  }
  setImportFlowState('ready', 'export', 'Export is ready. Copy to clipboard or download.');
  emitWizardStepEvent('export', 'completed');
}

export function retryLastImport(): void {
  if (!retryImportAction) {
    setImportFlowState('empty', 'import', 'No previous import attempt found. Start a new import.');
    focusImportPanel();
    return;
  }

  const action = retryImportAction;
  clearError();
  setImportFlowState('loading', 'import', 'Retrying import...');
  showLoader('Retrying import...');

  try {
    const maybePromise = action();
    if (maybePromise instanceof Promise) {
      void maybePromise.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Retry failed. Please try importing again.';
        handleImportFailure(message);
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Retry failed. Please try importing again.';
    handleImportFailure(message);
  }
}

export function handleFlowPrimaryAction(): void {
  if (importFlowState.status === 'loading') return;

  if (!currentDeck) {
    focusImportPanel();
    showToast('Step 1: load a deck first');
    return;
  }

  if (importFlowState.step === 'import') {
    goToFlowStep('analysis');
    return;
  }

  if (importFlowState.step === 'analysis') {
    goToFlowStep('recommend');
    return;
  }

  if (importFlowState.step === 'recommend') {
    goToFlowStep('apply');
    return;
  }

  if (importFlowState.step === 'apply') {
    goToFlowStep('export');
    return;
  }

  // export step primary action
  copyExport();
}

export function togglePanel(name: string): void {
  debugLog('[MTG] togglePanel called:', name);
  
  // Try direct panel ID first, then fallback to mapped names
  const panelMap: Record<string, string> = {
    hand: 'handSim',
    testHand: 'handSim',
    testHandPanel: 'handSim',
    analysis: 'analysisPanel',
    analysisPanel: 'analysisPanel',
    export: 'exportPanel',
    exportPanel: 'exportPanel',
    tools: 'toolsPanel',
    toolsPanel: 'toolsPanel',
    beta: 'betaDashboardPanel',
    betaDashboard: 'betaDashboardPanel',
    betaDashboardPanel: 'betaDashboardPanel',
  };
  
  // Check if name is already a valid panel ID
  let panel = $(name);
  debugLog('[MTG] Direct panel lookup:', name, !!panel);
  
  // If not found, try the map
  if (!panel) {
    const panelId = panelMap[name];
    if (panelId) {
      panel = $(panelId);
      debugLog('[MTG] Mapped panel lookup:', panelId, !!panel);
    }
  }
  
  if (!panel) {
    console.warn('[togglePanel] Panel not found:', name);
    return;
  }

  if (flowAnalysisSpotlightOpen && panel.id !== 'analysisPanel') {
    setFlowAnalysisSpotlight(false);
  }

  const needsDeck = panel.id === 'analysisPanel' || panel.id === 'exportPanel' || panel.id === 'handSim';
  if (needsDeck && !currentDeck) {
    setImportFlowState('empty', 'import', 'Step 1 required: import a deck before opening analysis or export.');
    showToast('Import a deck first');
    focusImportPanel();
    return;
  }
  
  debugLog('[MTG] Toggling panel:', panel.id, 'currently active:', panel.classList.contains('active'));
  
  if (panel.classList.contains('active')) {
    panel.classList.remove('active');
  } else {
    panel.classList.add('active');
  }

  if (!panel.classList.contains('active') && panel.id === 'analysisPanel') {
    setFlowAnalysisSpotlight(false);
  }

  const isOpen = panel.classList.contains('active');
  if (isOpen && panel.id === 'analysisPanel') {
    setImportFlowState('ready', 'analysis', 'Review analysis, then continue to export.');
  } else if (!isOpen && panel.id === 'analysisPanel') {
    setImportFlowState('ready', 'import', 'Analysis hidden. Reopen it with Analyze when needed.');
  }

  if (isOpen && panel.id === 'exportPanel') {
    const output = $('exportOutput') as HTMLTextAreaElement | null;
    if (!output || !output.value.trim()) {
      exportDeck('text');
      setActiveExportButton('text');
    }
    setImportFlowState('ready', 'export', 'Export is ready. Choose a format, then copy or download.');
  } else if (!isOpen && panel.id === 'exportPanel') {
    const analysisOpen = $('analysisPanel')?.classList.contains('active') ?? false;
    setImportFlowState(
      'ready',
      analysisOpen ? 'analysis' : 'import',
      analysisOpen
        ? 'Export hidden. Continue in analysis or reopen export.'
        : 'Export hidden. Open analysis or import another deck.',
    );
  }

  if (isOpen && panel.id === 'betaDashboardPanel') {
    if (analyticsDashboardCache) {
      renderBetaDashboard(analyticsDashboardCache);
    } else {
      renderBetaDashboardLoading('Loading beta KPI dashboard...');
    }
    void refreshBetaDashboard();
  }
}

// ==================== VIEW ====================
export function setView(view: string): void {
  currentView = view;
  renderDeck();
}

// ==================== HAND SIMULATOR ====================
export function drawTestHand(): void {
  if (!currentDeck || currentDeck.main.length < 7) {
    showToast('Need at least 7 cards in main deck');
    return;
  }
  
  // Shuffle and draw 7
  const pool: string[] = [];
  for (const entry of currentDeck.main) {
    for (let i = 0; i < entry.qty; i++) pool.push(entry.name);
  }
  
  // Fisher-Yates shuffle
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  
  handState.cards = pool.slice(0, 7);
  handState.phase = 'mulligan';
  renderHand();
}

export function handleMulligan(): void {
  handState.mulligans++;
  drawTestHand();
}

export function keepHand(): void {
  handState.phase = 'idle';
  showToast(`Kept hand after ${handState.mulligans} mulligan(s)`);
}

function renderHand(): void {
  const el = $('handCards');
  if (!el) return;
  
  if (handState.cards.length === 0) {
    // Empty state using h() - XSS-safe
    replaceChildren(el,
      h('div', { className: 'empty' }, 'Click "Draw" to draw a test hand')
    );
    return;
  }
  
  // Build hand cards using h() - XSS-safe by design
  replaceChildren(el,
    ...handState.cards.map(name => {
      const card = resolveCard(name);
      const img = getCardImageSmall(card);
      return h('div', { className: 'hand-card' },
        h('img', { src: sanitizeUrl(img), alt: name })
      );
    })
  );
  
  const statsEl = $('handStats');
  if (statsEl) {
    statsEl.textContent = `Cards: ${handState.cards.length} | Mulligans: ${handState.mulligans}`;
  }
}

// ==================== EXPORT ====================
export function exportDeck(format: string, options: { trackEvent?: boolean; trigger?: string } = {}): void {
  if (!currentDeck) {
    setImportFlowState('empty', 'import', 'Import a deck first to unlock export.');
    showToast('No deck loaded');
    focusImportPanel();
    return;
  }

  const exportFormat = normalizeExportFormat(format);
  currentExportFormat = exportFormat;

  const text = serializeDeckForExport(currentDeck, {
    format: exportFormat,
    deckName: currentDeckName,
  });
  
  // Write to export output textarea
  const output = $('exportOutput') as HTMLTextAreaElement;
  if (output) {
    output.value = text;
  }

  setActiveExportButton(exportFormat);
  if ($('exportPanel')?.classList.contains('active')) {
    setImportFlowState('ready', 'export', 'Export is ready. Choose a format, then copy or download.');
  }

  if (options.trackEvent) {
    emitExportClickedEvent(exportFormat, options.trigger || 'format_button');
  }
}

export function copyExport(): void {
  const output = $('exportOutput') as HTMLTextAreaElement | null;

  if (!currentDeck) {
    setImportFlowState('empty', 'import', 'Import a deck first to copy exports.');
    showToast('No deck loaded');
    focusImportPanel();
    return;
  }

  // Always regenerate from current deck state to avoid stale exports
  // after apply/undo or other live deck mutations.
  exportDeck(currentExportFormat);

  if (!output || !output.value.trim()) {
    showToast('Select an export format first');
    ensurePanelOpen('exportPanel', true);
    setImportFlowState('ready', 'export', 'Choose an export format, then copy or download.');
    return;
  }
  
  navigator.clipboard.writeText(output.value).then(() => {
    showToast('Copied to clipboard');
    setImportFlowState('ready', 'export', 'Copied. You can now paste or download another format.');
    emitExportClickedEvent('copy', 'copy_button');
    emitWizardStepEvent('export', 'completed');
  }).catch(() => {
    showError('Failed to copy');
  });
}

export function downloadExport(): void {
  const output = $('exportOutput') as HTMLTextAreaElement | null;

  if (!currentDeck) {
    setImportFlowState('empty', 'import', 'Import a deck first to download exports.');
    showToast('No deck loaded');
    focusImportPanel();
    return;
  }

  // Always regenerate from current deck state to avoid stale exports
  // after apply/undo or other live deck mutations.
  exportDeck(currentExportFormat);

  if (!output || !output.value.trim()) {
    showToast('Select an export format first');
    ensurePanelOpen('exportPanel', true);
    setImportFlowState('ready', 'export', 'Choose an export format, then copy or download.');
    return;
  }
  
  const blob = new Blob([output.value], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${currentDeckName || 'deck'}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast(`Downloaded ${currentDeckName || 'deck'}.txt`);
  setImportFlowState('ready', 'export', 'Download complete. You can export another format anytime.');
  emitExportClickedEvent('download', 'download_button');
  emitWizardStepEvent('export', 'completed');
}

export function copyDeckToClipboard(): void {
  exportDeck('text');
  copyExport();
}

// ==================== VERSIONS ====================
interface VersionEntry {
  name: string;
  deck: Deck;
  timestamp: number;
}

function getVersions(): VersionEntry[] {
  return storageGet<VersionEntry[]>(STORAGE_KEYS.MTG_VERSIONS, []);
}

function saveVersions(versions: VersionEntry[]): void {
  storageSet(STORAGE_KEYS.MTG_VERSIONS, versions);
}

export function saveVersion(): void {
  if (!currentDeck) return;
  
  const versions = getVersions();
  versions.push({
    name: currentDeckName,
    deck: currentDeck,
    timestamp: Date.now(),
  });
  saveVersions(versions);
  showToast('Version saved');
}

export function loadVersion(idx: string): void {
  const versions = getVersions();
  const v = versions[parseInt(idx)];
  if (!v) return;
  
  currentDeck = v.deck;
  currentDeckName = v.name;
  renderDeck();
  refreshExportOutputForCurrentState();
  updateToolsState();
  ensurePanelOpen('analysisPanel', true);
  setImportFlowState('ready', 'analysis', 'Version loaded. Review analysis, then continue to export.');
  showToast('Version loaded');
}

export function deleteVersion(idx: string): void {
  const versions = getVersions();
  versions.splice(parseInt(idx), 1);
  saveVersions(versions);
  showToast('Version deleted');
}

// ==================== ADVANCED TOOLS ====================

// DNA Analysis - Deck Archetype Detection
export function calculateDNA(): void {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }
  
  const dna = analyzeDeckDNA(currentDeck.main, (name) => resolveCard(name) ?? undefined);
  const labels: DNAArchetype[] = ['aggro', 'control', 'combo', 'midrange', 'ramp', 'tempo'];
  
  // Update UI
  const grid = $('dnaResult');
  if (grid) {
    replaceChildren(grid, fragment(
      ...labels.map(l => 
        h('div', { className: 'dna-row' },
          h('div', { className: 'dna-row-top' },
            h('span', {}, l.charAt(0).toUpperCase() + l.slice(1)),
            h('span', { className: 'dna-row-val' }, `${dna.normalized[l]}%`),
          ),
          h('div', { className: 'dna-progress' },
            h('div', { className: 'dna-progress-fill', style: `width:${dna.normalized[l]}%;` }),
          ),
        )
      )
    ));
  }
  
  showToast('DNA analyzed');
}

// Power Level Calculator
function analyzeDeckPower(deck: Deck): { score: number; label: string; factors: string[] } {
  let power = 5;
  const factors: string[] = [];

  for (const entry of deck.main) {
    const card = resolveCard(entry.name);
    if (!card) continue;

    const text = (card.oracle_text || '').toLowerCase();
    const price = parseFloat(card.prices?.eur || '0');

    if (text.includes('extra turn')) {
      power += 0.5;
      factors.push('Extra turns');
    }
    if (text.includes('infinite')) {
      power += 0.3;
      factors.push('Infinite potential');
    }
    if (text.includes('tutor') || text.includes('search your library')) {
      power += 0.2;
    }
    if (price > 20) {
      power += 0.1;
    }

    const normalizedName = card.name.toLowerCase();
    if (normalizedName.includes('sol ring')) {
      power += 0.5;
      factors.push('Sol Ring');
    }
    if (normalizedName.includes('mana crypt')) {
      power += 0.8;
      factors.push('Mana Crypt');
    }
  }

  const score = Math.min(10, Math.max(1, power));
  const labels = ['Jank', 'Casual', 'Focused', 'Optimized', 'Competitive', 'cEDH'];
  const idx = Math.min(Math.floor(score / 2), 5);

  return {
    score,
    label: labels[idx],
    factors,
  };
}

export function calculatePower(): void {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }

  const analysis = analyzeDeckPower(currentDeck);
  
  const scoreEl = $('powerScore');
  const labelEl = $('powerLabel');
  const factorsEl = $('powerFactors');
  
  if (scoreEl) scoreEl.textContent = analysis.score.toFixed(1);
  if (labelEl) {
    labelEl.textContent = analysis.label;
  }
  if (factorsEl && analysis.factors.length > 0) {
    replaceChildren(factorsEl,
      h('strong', {}, 'Power factors: '),
      document.createTextNode([...new Set(analysis.factors)].slice(0, 5).join(', ')),
    );
  }
  
  showToast('Power calculated');
}

// Salt Score Calculator
export function calculateSalt(): void {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }
  
  const analysis = calculateSaltAnalysis(currentDeck.main, (name) => resolveCard(name) ?? undefined);
  
  const scoreEl = $('saltScore');
  const labelEl = $('saltLabel');
  const cardsEl = $('saltCards');
  
  if (scoreEl) {
    scoreEl.textContent = analysis.score.toFixed(1);
    scoreEl.style.color = analysis.score > 7 ? 'var(--banned)' : analysis.score > 4 ? 'var(--gold)' : 'var(--legal)';
  }
  if (labelEl) {
    labelEl.textContent = analysis.label;
  }
  if (cardsEl && analysis.saltyCards.length > 0) {
    const uniqueSalty = analysis.saltyCards.slice(0, 8);
    replaceChildren(cardsEl,
      h('strong', {}, 'Salty cards:'),
      ...uniqueSalty.map(name => h('div', { className: 'tool-empty' }, name)),
    );
  } else if (cardsEl) {
    replaceChildren(cardsEl, h('p', { className: 'tool-empty' }, 'No obvious salt triggers found.'));
  }
  
  showToast('Salt calculated');
}

// Find Synergies
export function findSynergies(): void {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }
  
  const synergies = detectDeckSynergies(currentDeck.main, (name) => resolveCard(name) ?? undefined, 10);
  
  const resultEl = $('synergyResult');
  if (resultEl) {
    if (synergies.length > 0) {
      replaceChildren(
        resultEl,
        h(
          'div',
          { className: 'tool-result-list' },
          ...synergies.slice(0, 10).map(s =>
            h('div', { className: 'tool-result-item compact' }, `🔗 ${s}`)
          )
        )
      );
    } else {
      replaceChildren(resultEl,
        h('p', { className: 'tool-empty' }, "No obvious synergies detected. This doesn't mean your deck lacks synergy!")
      );
    }
  }
  
  showToast('Synergies analyzed');
}

function setMatchupGuidePlaceholder(message: string): void {
  const resultEl = $('matchupResult');
  if (!resultEl) return;
  replaceChildren(
    resultEl,
    h('p', { className: 'tool-empty' }, message),
    renderMatchupModeButtons(),
  );
}

function normalizeMatchupMetaMode(mode: string): MatchupMetaMode {
  if (mode === 'local') return 'local';
  if (mode === 'commander-pod') return 'commander-pod';
  return 'fnm';
}

function renderMatchupModeButtons(): HTMLElement {
  return h(
    'div',
    { style: 'display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap;margin-top:0.5rem;' },
    h('span', { className: 'tool-note', style: 'margin:0;' }, 'Meta mode:'),
    ...MATCHUP_META_MODE_ORDER.map((mode) =>
      h(
        'button',
        {
          className: matchupMetaMode === mode ? 'hand-btn primary' : 'hand-btn',
          type: 'button',
          'data-action': 'set-matchup-meta-mode',
          'data-mode': mode,
          title: `Switch matchup mode to ${MATCHUP_META_MODE_LABEL[mode]}`,
        },
        MATCHUP_META_MODE_LABEL[mode],
      ),
    ),
  );
}

function matchupLabel(matchup: MatchupArchetype): string {
  if (matchup === 'aggro') return 'Aggro';
  if (matchup === 'control') return 'Control';
  return 'Combo';
}

function renderMatchupMoveList(title: string, moves: MatchupMove[], emptyMessage: string): HTMLElement {
  return h(
    'div',
    { style: 'margin-top:0.45rem;' },
    h('div', { className: 'tool-note', style: 'margin:0 0 0.25rem 0;font-weight:600;' }, title),
    moves.length > 0
      ? h(
        'div',
        { className: 'tool-result-list' },
        ...moves.map((move) =>
          h(
            'div',
            { className: 'tool-result-item' },
            h('span', {}, `${move.qty}x ${move.card}`),
            h('span', { className: 'tool-result-value' }, move.reason),
          ),
        ),
      )
      : h('p', { className: 'tool-empty' }, emptyMessage),
  );
}

function renderMatchupStepList(title: string, steps: string[]): HTMLElement {
  return h(
    'div',
    { style: 'margin-top:0.5rem;' },
    h('div', { className: 'tool-note', style: 'margin:0 0 0.25rem 0;font-weight:600;' }, title),
    h(
      'div',
      { className: 'tool-result-list' },
      ...steps.map((step, index) =>
        h('div', { className: 'tool-result-item compact' }, `${index + 1}. ${step}`),
      ),
    ),
  );
}

function renderMatchupFallbackBlock(matchup: MatchupArchetype, plan: MatchupGuide['plans'][number]): HTMLElement {
  const fallback = plan.sideboard.fallback;
  if (!fallback) {
    return h('p', { className: 'tool-empty' }, `No sideboard plan available for ${matchupLabel(matchup)}.`);
  }

  return h(
    'div',
    { style: 'margin-top:0.45rem;' },
    h('div', { className: 'tool-note', style: 'margin:0 0 0.25rem 0;font-weight:600;' }, 'No sideboard fallback'),
    renderMatchupStepList('Mulligan', fallback.mulligan),
    renderMatchupStepList('Priorities', fallback.priorities),
    renderMatchupStepList('Interaction windows', fallback.interactionWindows),
  );
}

function renderMatchupGuidePanels(): void {
  const resultEl = $('matchupResult');
  if (!resultEl) return;
  const guide = matchupGuideCache;
  if (!guide) {
    setMatchupGuidePlaceholder('Run matchup guide to generate sideboard and gameplan instructions.');
    return;
  }

  const roleBiasOrder: Array<keyof MatchupGuide['recommendationRoleBias']> = [
    'interaction',
    'removal',
    'draw',
    'ramp',
    'protection',
    'finisher',
  ];

  const roleBiasRows = roleBiasOrder
    .map((role) => ({ role, value: guide.recommendationRoleBias[role] }))
    .filter((entry) => entry.value > 0)
    .map((entry) => `${entry.role}: ${Math.round(entry.value * 100)}%`);

  const fallbackLabel = guide.fallbackReasons.length > 0
    ? guide.fallbackReasons.join(', ')
    : 'none';

  replaceChildren(
    resultEl,
    h('p', { className: 'tool-lead' }, 'Top matchup guide with threats, wincons, phase plan, sequencing, and interaction priorities.'),
    renderMatchupModeButtons(),
    h('div', { className: 'tool-note' }, `Mode: ${MATCHUP_META_MODE_LABEL[guide.metaMode]} | Schema: ${guide.schemaVersion} | Coverage: ${Math.round(guide.cardDataCoverage * 100)}%`),
    h('div', { className: 'tool-note' }, `Relevance weights -> mode: ${Math.round(guide.weights.modeWeight * 100)}%, role gap: ${Math.round(guide.weights.roleGap * 100)}%, curve pressure: ${Math.round(guide.weights.curvePressure * 100)}%, data quality: ${Math.round(guide.weights.dataQuality * 100)}%`),
    h('div', { className: 'tool-note' }, `Fallbacks: ${fallbackLabel}`),
    roleBiasRows.length > 0
      ? h('div', { className: 'tool-note' }, `Recommendation-role bias: ${roleBiasRows.join(' | ')}`)
      : h('div', { className: 'tool-note' }, 'Recommendation-role bias unavailable (low card data coverage).'),
    h(
      'div',
      { className: 'tool-result-list', style: 'margin-top:0.55rem;' },
      ...guide.inOutRulebook.map((rule, index) => h('div', { className: 'tool-result-item compact' }, `${index + 1}. ${rule}`)),
    ),
    h(
      'div',
      { style: 'margin-top:0.65rem;display:grid;gap:0.6rem;' },
      ...guide.plans.map((plan) =>
        h(
          'div',
          {
            style: 'border:1px solid var(--border);border-radius:8px;padding:0.65rem;background:var(--bg-2);',
          },
          h('h5', { style: 'margin:0 0 0.35rem 0;font-size:0.9rem;' }, `${plan.title} (${plan.relevanceScore})`),
          renderMatchupStepList('Threats', plan.threats),
          renderMatchupStepList('Opponent wincons', plan.wincons),
          renderMatchupStepList('Core plan - early', plan.corePlan.early),
          renderMatchupStepList('Core plan - mid', plan.corePlan.mid),
          renderMatchupStepList('Core plan - late', plan.corePlan.late),
          renderMatchupStepList('Sequencing priorities', plan.sequencingPriorities),
          renderMatchupStepList('Interaction priorities', plan.interactionPriorities),
          plan.sideboard.available
            ? h(
              'div',
              {},
              renderMatchupMoveList('Cards in', plan.sideboard.in, 'No clear sideboard additions found.'),
              renderMatchupMoveList('Cards out', plan.sideboard.out, 'No clear cuts found for this plan.'),
            )
            : renderMatchupFallbackBlock(plan.matchup, plan),
          renderMatchupStepList('Pre-board plan', plan.preBoardPlan),
          renderMatchupStepList('Post-board plan', plan.postBoardPlan),
        ),
      ),
    ),
  );
}

export function generateMatchupGuide(): void {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }

  setMatchupGuidePlaceholder('Generating matchup guide from deck profile...');

  matchupGuideCache = buildMatchupGuide({
    deck: {
      main: currentDeck.main.map((entry) => ({ name: entry.name, qty: entry.qty })),
      sideboard: currentDeck.sideboard.map((entry) => ({ name: entry.name, qty: entry.qty })),
      commander: currentDeck.commander.map((entry) => ({ name: entry.name, qty: entry.qty })),
    },
    resolveCard: (name) => resolveCard(name) ?? undefined,
    maxSideboardMovesPerMatchup: 6,
    metaMode: matchupMetaMode,
    minPlans: 3,
  });

  renderMatchupGuidePanels();

  showToast(matchupGuideCache.hasSideboard
    ? `Matchup guide generated (${MATCHUP_META_MODE_LABEL[matchupMetaMode]})`
    : `Matchup fallback generated (${MATCHUP_META_MODE_LABEL[matchupMetaMode]}, no sideboard)`);
}

export function setMatchupMetaMode(mode: string): void {
  const normalized = normalizeMatchupMetaMode(mode);
  if (matchupMetaMode === normalized) return;

  matchupMetaMode = normalized;
  storageSet(STORAGE_KEYS.MTG_MATCHUP_META_MODE, matchupMetaMode);

  if (currentDeck) {
    generateMatchupGuide();
    return;
  }

  setMatchupGuidePlaceholder('Load a deck and run matchup guide.');
  showToast(`Matchup mode: ${MATCHUP_META_MODE_LABEL[matchupMetaMode]}`);
}

// Find Budget Alternatives  
export function findBudgetAlternatives(): void {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }
  
  const expensive: Array<{name: string, price: number}> = [];
  
  for (const entry of currentDeck.main) {
    const card = resolveCard(entry.name);
    if (!card) continue;
    
    const price = parseFloat(card.prices?.eur || '0');
    if (price > 5) {
      expensive.push({ name: card.name, price });
    }
  }
  
  expensive.sort((a, b) => b.price - a.price);
  
  const resultEl = $('budgetResult');
  if (resultEl) {
    if (expensive.length > 0) {
      replaceChildren(
        resultEl,
        h('p', { className: 'tool-lead' }, 'Most expensive cards to consider replacing:'),
        h(
          'div',
          { className: 'tool-result-list' },
          ...expensive.slice(0, 8).map(c =>
            h('div', { className: 'tool-result-item' },
              h('span', {}, c.name),
              h('span', { className: 'tool-result-value' }, `€${c.price.toFixed(2)}`),
            )
          )
        )
      );
    } else {
      replaceChildren(resultEl,
        h('p', { className: 'tool-empty' }, 'No expensive cards found (€5+). Your deck is already budget-friendly!')
      );
    }
  }
  
  showToast('Budget analysis complete');
}

function formatSignedDelta(amount: number): string {
  if (amount === 0) return 'EUR 0.00';
  const sign = amount > 0 ? '+' : '-';
  return `${sign}${formatPriceAmount(Math.abs(amount), 'EUR')}`;
}

function formatRecommendationPrice(quote: PriceQuote): string {
  if (quote.amount === null || quote.currency === null) return 'N/A';
  return formatPriceAmount(quote.amount, quote.currency);
}

function recommendationImpactClass(label: RecommendationItem['powerImpactLabel']): string {
  if (label === 'high') return 'rc-impact high';
  if (label === 'medium') return 'rc-impact medium';
  return 'rc-impact low';
}

function formatRecommendationTag(tag: RecommendationLogicTag): string {
  if (tag === 'curve-fix') return 'Curve Fix';
  if (tag === 'mana-fix') return 'Mana Fix';
  if (tag === 'meta-answer') return 'Meta Answer';
  if (tag === 'card-advantage') return 'Card Advantage';
  if (tag === 'board-control') return 'Board Control';
  if (tag === 'protection') return 'Protection';
  return 'Synergy';
}

function formatConfidencePercent(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

function getRecommendationCollectionView() {
  return buildRecommendationCollectionView({
    recommendations: recommendationItemsCache,
    getOwnedCount: (cardName) => getOwnedCountForCardName(cardName),
    includeMissingCards: recommendationIncludeMissingCards,
    strongBuildSize: STRONG_RECOMMENDATION_BUILD_SIZE,
    strongBuildLabel: `Top ${STRONG_RECOMMENDATION_BUILD_SIZE}`,
  });
}

const META_MODE_SELECT_IDS = ['metaModeSelect', 'metaModeSelectPanel'] as const;

function syncMetaModeSelectors(): void {
  for (const id of META_MODE_SELECT_IDS) {
    const select = $(id) as HTMLSelectElement | null;
    if (select) {
      select.value = recommendationMetaMode;
    }
  }
}

async function rebuildRecommendationCacheForMetaMode(): Promise<void> {
  if (!currentDeck || recommendationItemsCache.length === 0) return;

  const adapter = createPriceAdapter({
    resolveCard: (cardName) => resolveCard(cardName),
    source: 'scryfall.prices',
    asOf: lastPriceSyncAt,
    preferredCurrency: 'EUR',
    fallbackCurrency: 'USD',
    staleAfterMs: 1000 * 60 * 60 * 24 * 2,
  });

  if (useDynamicDiscovery) {
    recommendationDiscoveryLoading = true;
    renderRecommendationPanels(); // Show loading state

    try {
      const result = await buildRecommendationsDynamic({
        deckMain: currentDeck.main.map((entry) => ({ name: entry.name, qty: entry.qty })),
        getCard: (cardName) => resolveCard(cardName),
        getPrice: (cardName) => adapter.getPrice(cardName),
        metaMode: recommendationMetaMode,
        maxRecommendations: 8,
        useDynamicDiscovery: true,
        useMLPersonalization: true,
        detectedArchetypes: currentArchetypeDetection?.primaryArchetype 
          ? [currentArchetypeDetection.primaryArchetype, ...currentArchetypeDetection.secondaryArchetypes.map(a => a.id)]
          : undefined,
        discoveryConfig: {
          maxCardsPerQuery: 15,
          maxTotalCards: 100,
          maxQueries: 5,
          minConfidence: 0.3,
        },
      });

      recommendationItemsCache = result.items;
      recommendationDiscoveryStats = result.discoveryStats || null;
    } catch (error) {
      console.error('Dynamic discovery failed, falling back to static:', error);
      // Fallback to static recommendations
      recommendationItemsCache = buildRecommendations({
        deckMain: currentDeck.main.map((entry) => ({ name: entry.name, qty: entry.qty })),
        getCard: (cardName) => resolveCard(cardName),
        getPrice: (cardName) => adapter.getPrice(cardName),
        metaMode: recommendationMetaMode,
        maxRecommendations: 8,
      });
      recommendationDiscoveryStats = null;
    } finally {
      recommendationDiscoveryLoading = false;
    }
  } else {
    // Use static recommendations only
    recommendationItemsCache = buildRecommendations({
      deckMain: currentDeck.main.map((entry) => ({ name: entry.name, qty: entry.qty })),
      getCard: (cardName) => resolveCard(cardName),
      getPrice: (cardName) => adapter.getPrice(cardName),
      metaMode: recommendationMetaMode,
      maxRecommendations: 8,
    });
    recommendationDiscoveryStats = null;
  }

  const validIds = new Set(recommendationItemsCache.map((item) => item.id));
  appliedRecommendationIds = new Set(
    [...appliedRecommendationIds].filter((id) => validIds.has(id)),
  );
  appliedRecommendationMutations = new Map(
    [...appliedRecommendationMutations.entries()].filter(([id]) => validIds.has(id)),
  );
  if (lastRecommendationApplyAction && !validIds.has(lastRecommendationApplyAction.recommendationId)) {
    lastRecommendationApplyAction = null;
  }
}

function getMetaContextProperties() {
  return createMetaContextProperties(recommendationMetaMode);
}

export async function setMetaMode(mode: string): Promise<void> {
  const nextMode = normalizeMetaMode(mode);
  if (recommendationMetaMode === nextMode) {
    syncMetaModeSelectors();
    return;
  }

  recommendationMetaMode = nextMode;
  persistMetaModePreference(recommendationMetaMode);
  syncMetaModeSelectors();
  await rebuildRecommendationCacheForMetaMode();
  renderRecommendationPanels();

  showToast(`Meta mode: ${formatMetaModeLabel(recommendationMetaMode)}`);
}

function renderRecommendationPanels(): void {
  const containers: HTMLElement[] = [];
  const recsResult = $('recsResult');
  const recsContent = $('recsContent');
  if (recsResult) containers.push(recsResult);
  if (recsContent) containers.push(recsContent);
  if (containers.length === 0) return;

  if (recommendationItemsCache.length === 0) {
    for (const container of containers) {
      replaceChildren(container,
        h('p', { className: 'tool-empty' }, 'No recommendation candidates found for this deck profile.')
      );
    }
    return;
  }

  const collectionView = getRecommendationCollectionView();
  const visibleRecommendations = collectionView.visibleItems;
  const gapHint = formatRecommendationGapHint(collectionView.gap);

  const overallSummary = summarizeRecommendations(visibleRecommendations);
  const selectedSummary = summarizeRecommendations(visibleRecommendations, appliedRecommendationIds);
  const anySelected = selectedSummary.itemCount > 0;
  const visibleSummary = anySelected ? selectedSummary : overallSummary;

  const priceSource = recommendationItemsCache[0]?.unitPrice.source || 'scryfall.prices';
  const sourceTimestamp = recommendationItemsCache[0]?.unitPrice.asOf ?? lastPriceSyncAt;
  const asOfLabel = formatPriceAsOfTimestamp(sourceTimestamp);
  const swapModeEnabled = recommendationApplyMode === 'swap';
  const metaModeLabel = formatMetaModeLabel(recommendationMetaMode);
  const modeButtonLabel = swapModeEnabled ? '1:1 Swap: On' : '1:1 Swap: Off';
  const modeHint = swapModeEnabled
    ? '+ adds recommendation and cuts the suggested card.'
    : '+ only adds recommendation to Main Deck.';
  const includeMissingButtonLabel = recommendationIncludeMissingCards
    ? 'Missing Cards: On'
    : 'Missing Cards: Off';
  const collectionModeHint = recommendationIncludeMissingCards
    ? 'Owned + missing cards are visible.'
    : 'Owned-only is active (collection-first default).';
  const canUndoLastApply = lastRecommendationApplyAction !== null;
  const latestUndoRecommendationId = lastRecommendationApplyAction?.recommendationId || null;
  const latestUndoLabel = canUndoLastApply
    ? `Last apply: +${lastRecommendationApplyAction?.mutation.addedCardName}`
    : 'No apply action to undo yet.';
  const commanderNames = getCommanderNames(currentDeck);
  const deviceProfile = getOrCreateDeviceProfile();
  const deckRecommendationHistory = getDeckRecommendationHistory(currentDeckName, commanderNames);
  const historyLookup = new Map<string, RecommendationHistoryEntry>();
  for (const historyEntry of deckRecommendationHistory?.entries || []) {
    historyLookup.set(normalizeHistoryCardKey(historyEntry.cardName), historyEntry);
  }
  const previouslyWorkedMatches = visibleRecommendations
    .map((item) => {
      const historyEntry = historyLookup.get(normalizeHistoryCardKey(item.cardName));
      if (!historyEntry) return null;
      return { item, historyEntry };
    })
    .filter((value): value is { item: RecommendationItem; historyEntry: RecommendationHistoryEntry } => Boolean(value))
    .sort((a, b) => b.historyEntry.applyCount - a.historyEntry.applyCount || b.historyEntry.lastAppliedAt - a.historyEntry.lastAppliedAt);

  const createCardNode = (item: RecommendationItem): HTMLElement => {
    const applied = appliedRecommendationIds.has(item.id);
    const canUndoThisRecommendation = applied && latestUndoRecommendationId === item.id;
    const ownedCount = getOwnedCountForCardName(item.cardName);
    const collectionLabel = ownedCount > 0 ? `Owned: ${ownedCount}` : 'Missing from collection';
    const unitPriceLabel = formatRecommendationPrice(item.unitPrice);
    const confidenceLabel = formatConfidencePercent(item.confidence);
    const signalConfidenceLabel = formatConfidencePercent(item.confidenceBreakdown.signalStrength);
    const dataCoverageLabel = formatConfidencePercent(item.confidenceBreakdown.dataCoverage);
    const consensusLabel = formatConfidencePercent(item.confidenceBreakdown.heuristicConsensus);
    const unitFallback = item.unitPrice.status !== 'ok'
      ? 'Price unavailable - fallback active.'
      : (item.unitPrice.stale ? 'Price may be stale.' : '');
    const historyEntry = historyLookup.get(normalizeHistoryCardKey(item.cardName));

    const cutPriceLabel = item.suggestedCutPrice ? formatRecommendationPrice(item.suggestedCutPrice) : 'N/A';
    const cutLabel = item.suggestedCutName
      ? `${item.suggestedCutName} (${cutPriceLabel})`
      : 'No cut suggestion available';

    const deltaLabel = item.deltaPrice !== null
      ? formatSignedDelta(item.deltaPrice)
      : 'N/A';

    return h(
      'div',
      { className: 'rec-card' },
      h(
        'div',
        { className: 'rc-info' },
        h('div', { className: 'rc-name' }, item.cardName),
        h('div', { className: 'rc-type' }, item.roles.join(' / ')),
        h('div', { className: recommendationImpactClass(item.powerImpactLabel) }, `Power impact: ${item.powerImpactLabel.toUpperCase()} (+${item.powerImpactScore})`),
        h('details', { className: 'rc-confidence-details' },
          h('summary', { className: 'rc-confidence-summary' }, `Confidence: ${confidenceLabel}`),
          h('div', { className: 'rc-confidence-breakdown' },
            h('div', { className: 'rc-confidence-row' }, h('span', {}, 'Signal strength'), h('strong', {}, signalConfidenceLabel)),
            h('div', { className: 'rc-confidence-row' }, h('span', {}, 'Data coverage'), h('strong', {}, dataCoverageLabel)),
            h('div', { className: 'rc-confidence-row' }, h('span', {}, 'Heuristic consensus'), h('strong', {}, consensusLabel)),
          ),
          h('div', { className: 'rc-confidence-weight' }, 'Weighted score: 50% signal, 30% data, 20% consensus.'),
        ),
        h('div', { className: 'rc-tags' }, ...item.logicTags.map((tag) => h('span', { className: 'rc-tag' }, formatRecommendationTag(tag)))),
        h('div', { className: 'rc-reason' }, item.reason),
        historyEntry
          ? h('div', { className: 'rc-history-badge' }, `Previously worked for you · ${historyEntry.applyCount}x`)
          : null,
        historyEntry
          ? h('div', { className: 'rc-history-meta' }, `Last applied ${formatElapsedTimeAgo(historyEntry.lastAppliedAt)}`)
          : null,
        h('div', { className: 'rc-price rc-meta-line' }, h('span', {}, 'Collection'), `: ${collectionLabel}`),
        h('div', { className: 'rc-price rc-meta-line' }, h('span', {}, 'Unit'), `: ${unitPriceLabel}`),
        h('div', { className: 'rc-price rc-meta-line' }, h('span', {}, 'Delta'), `: ${deltaLabel}`),
        h('div', { className: 'rc-price rc-meta-line' }, h('span', {}, 'Suggested cut'), `: ${cutLabel}`),
        unitFallback
          ? h('div', { className: 'tool-note' }, unitFallback)
          : null,
      ),
      h(
        'button',
        {
          className: applied ? 'rc-add applied' : 'rc-add',
          'data-action': 'toggle-rec-apply',
          'data-rec-id': item.id,
          disabled: applied && !canUndoThisRecommendation,
          title: applied
            ? (canUndoThisRecommendation
                ? 'Undo last recommendation apply'
                : 'Only the latest apply action can be undone')
            : (swapModeEnabled ? 'Apply 1:1 swap to deck' : 'Add recommendation to deck'),
        },
        applied ? '-' : '+',
      ),
      // Feedback buttons
      h('div', { className: 'rc-feedback', style: 'display:flex;gap:0.5rem;margin-top:0.5rem;' },
        h('button', {
          className: 'feedback-btn thumbs-up',
          'data-action': 'feedback-thumbs-up',
          'data-rec-id': item.id,
          'data-card-name': item.cardName,
          title: 'This recommendation is helpful',
          style: 'background:rgba(31,168,85,0.2);border:1px solid rgba(31,168,85,0.4);border-radius:4px;padding:0.25rem 0.5rem;cursor:pointer;',
        }, '👍'),
        h('button', {
          className: 'feedback-btn thumbs-down',
          'data-action': 'feedback-thumbs-down',
          'data-rec-id': item.id,
          'data-card-name': item.cardName,
          title: 'This recommendation is not helpful',
          style: 'background:rgba(168,32,53,0.2);border:1px solid rgba(168,32,53,0.4);border-radius:4px;padding:0.25rem 0.5rem;cursor:pointer;',
        }, '👎'),
      ),
    );
  };

  for (const container of containers) {
    replaceChildren(container,
      h('div', { className: 'recs-summary' },
        h('div', { className: 'recs-summary-title' }, anySelected ? `Selected recommendations: ${selectedSummary.itemCount}` : `Top recommendations: ${overallSummary.itemCount}`),
        h('div', { style: 'display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap;margin-bottom:0.45rem;' },
          h('button', {
            className: useDynamicDiscovery ? 'hand-btn primary' : 'hand-btn',
            type: 'button',
            'data-action': 'toggle-dynamic-discovery',
            'data-mode': useDynamicDiscovery ? 'static' : 'dynamic',
            title: useDynamicDiscovery
              ? 'Dynamic discovery: queries Scryfall for cards (slower, more variety)'
              : 'Static mode: uses predefined card list (faster)',
          }, useDynamicDiscovery ? 'Dynamic Discovery: On' : 'Dynamic Discovery: Off'),
          h('button', {
            className: useArchetypeDetection ? 'hand-btn primary' : 'hand-btn',
            type: 'button',
            'data-action': 'toggle-archetype-detection',
            'data-mode': useArchetypeDetection ? 'off' : 'on',
            title: useArchetypeDetection
              ? 'Archetype detection: analyzes deck and shows counter-cards'
              : 'Enable archetype detection for anti-meta recommendations',
          }, useArchetypeDetection ? '🎯 Archetype Detection: On' : '🎯 Archetype Detection: Off'),
          h('button', {
            className: 'hand-btn',
            type: 'button',
            'data-action': 'show-trend-dashboard',
            title: 'View meta trends and your analytics',
          }, '📊 Trends'),
          h('button', {
            className: 'hand-btn',
            type: 'button',
            'data-action': 'open-community-page',
            title: 'Open dedicated community page',
          }, '🧭 Community'),
          h('button', {
            className: 'hand-btn',
            type: 'button',
            'data-action': 'community-share-deck',
            title: 'Share current deck to community feed',
          }, '🌍 Share Deck'),
          h('button', {
            className: 'hand-btn',
            type: 'button',
            'data-action': 'community-refresh',
            title: 'Refresh community feed and realtime meta',
          }, '⟳ Live Meta'),
          h('button', {
            className: swapModeEnabled ? 'hand-btn primary' : 'hand-btn',
            type: 'button',
            'data-action': 'toggle-rec-mode',
            'data-mode': swapModeEnabled ? 'add' : 'swap',
            title: 'Toggle 1:1 swap mode for suggestions',
          }, modeButtonLabel),
          h('button', {
            className: recommendationIncludeMissingCards ? 'hand-btn primary' : 'hand-btn',
            type: 'button',
            'data-action': 'toggle-rec-missing',
            'data-mode': recommendationIncludeMissingCards ? 'owned-only' : 'include-missing',
            title: 'Toggle missing cards in recommendation results',
          }, includeMissingButtonLabel),
          h('button', {
            className: canUndoLastApply ? 'hand-btn primary' : 'hand-btn',
            type: 'button',
            'data-action': 'undo-rec-apply',
            disabled: !canUndoLastApply,
            title: canUndoLastApply
              ? 'Undo the latest recommendation apply action'
              : 'No recommendation apply action to undo',
          }, 'Undo Last Apply'),
          h('span', { className: 'tool-note', style: 'margin:0;' }, useDynamicDiscovery ? 'Discovers cards from Scryfall database in real-time.' : 'Uses static card list for faster results.'),
          h('span', { className: 'tool-note', style: 'margin:0;' }, modeHint),
          h('span', { className: 'tool-note', style: 'margin:0;' }, collectionModeHint),
          h('span', { className: 'tool-note', style: 'margin:0;' }, latestUndoLabel),
        ),
        h('div', { className: 'recs-summary-grid' },
          h('div', { className: 'recs-summary-cell' }, `Unit total: ${formatPriceAmount(visibleSummary.totalKnownUnitPrice, 'EUR')}`),
          h('div', { className: 'recs-summary-cell' }, `Cut value: ${formatPriceAmount(visibleSummary.totalKnownCutValue, 'EUR')}`),
          h('div', { className: 'recs-summary-cell' }, `Net delta: ${formatSignedDelta(visibleSummary.totalKnownDelta)}`),
          h('div', { className: 'recs-summary-cell' }, `Impact total: +${visibleSummary.totalPowerImpact}`),
          h('div', { className: 'recs-summary-cell' }, `Avg confidence: ${formatConfidencePercent(visibleSummary.averageConfidence)}`),
        ),
        h('div', { className: 'tool-note' }, `Owned recommendations: ${collectionView.ownedItems.length} | Missing recommendations: ${collectionView.missingItems.length}`),
        h('div', { className: 'tool-note' }, `Meta mode: ${metaModeLabel}`),
        h('div', { className: 'tool-note' }, `Device profile: ${formatDeviceProfileId(deviceProfile.id)} (local-only)`),
        h('div', { className: 'recs-history-summary' },
          h('div', { className: 'recs-history-title' }, 'Previously worked for you'),
          previouslyWorkedMatches.length > 0
            ? h('div', { className: 'recs-history-list' },
                ...previouslyWorkedMatches.slice(0, 5).map(({ item, historyEntry }) =>
                  h('div', { className: 'recs-history-item' },
                    h('strong', {}, item.cardName),
                    h('span', {}, `${historyEntry.applyCount}x · ${formatElapsedTimeAgo(historyEntry.lastAppliedAt)}`),
                  )
                )
              )
            : deckRecommendationHistory && deckRecommendationHistory.entries.length > 0
              ? h('div', { className: 'tool-note', style: 'margin:0;' }, 'You have apply history for this deck, but none are in the current top list.')
              : h('div', { className: 'tool-note', style: 'margin:0;' }, 'Apply recommendations to build personal history for this deck.'),
        ),
        gapHint
          ? h('div', { className: 'tool-note' }, gapHint)
          : null,
        h('div', { className: 'tool-note' },
          `Price source: ${priceSource} | As of: ${asOfLabel}`,
        ),
        h('div', { className: 'tool-note' },
          'Confidence formula: 50% signal strength, 30% data coverage, 20% heuristic consensus.',
        ),
        visibleSummary.missingPriceCount > 0
          ? h('div', { className: 'tool-note' }, `${visibleSummary.missingPriceCount} recommendation(s) have missing prices.`)
          : null,
        visibleSummary.nonEurPriceCount > 0
          ? h('div', { className: 'tool-note' }, `${visibleSummary.nonEurPriceCount} recommendation(s) only have non-EUR pricing and are excluded from totals.`)
          : null,
        visibleSummary.unknownDeltaCount > 0
          ? h('div', { className: 'tool-note' }, `${visibleSummary.unknownDeltaCount} recommendation(s) have unknown delta.`)
          : null,
        recommendationDiscoveryStats
          ? h('div', { className: 'tool-note', style: 'margin-top:0.5rem;padding-top:0.5rem;border-top:1px solid rgba(255,255,255,0.1);' },
              `Dynamic discovery: ${recommendationDiscoveryStats.totalFound} cards found (${recommendationDiscoveryStats.fromCache} cached, ${recommendationDiscoveryStats.fromScryfall} from Scryfall) in ${recommendationDiscoveryStats.durationMs}ms via ${recommendationDiscoveryStats.queriesExecuted} queries.`
            )
          : null,
        // Archetype Detection Display (only if enabled and detected)
        useArchetypeDetection && currentArchetypeDetection?.primaryArchetype
          ? h('div', { className: 'archetype-detection', style: 'margin-top:1rem;padding:0.75rem;background:rgba(201,168,76,0.1);border-radius:8px;border:1px solid rgba(201,168,76,0.3);' },
              h('div', { style: 'font-weight:600;color:var(--gold);margin-bottom:0.5rem;' }, '🎯 Detected Archetype'),
              h('div', { style: 'font-size:1.1rem;margin-bottom:0.25rem;' }, 
                getArchetypeById(currentArchetypeDetection.primaryArchetype)?.name || currentArchetypeDetection.primaryArchetype
              ),
              currentArchetypeDetection.secondaryArchetypes.length > 0
                ? h('div', { style: 'font-size:0.85rem;color:var(--text-secondary);' },
                    `Also: ${currentArchetypeDetection.secondaryArchetypes.map(a => getArchetypeById(a.id)?.name || a.id).join(', ')}`
                  )
                : null,
              currentArchetypeDetection.hybridArchetype
                ? h('div', { style: 'font-size:0.8rem;color:var(--gold);margin-top:0.25rem;' }, '(Hybrid Strategy)')
                : null
            )
          : null,
        // Anti-Meta Recommendations (only if enabled and available)
        useArchetypeDetection && currentAntiMetaRecommendations.length > 0
          ? h('div', { className: 'anti-meta-section', style: 'margin-top:1rem;' },
              h('div', { style: 'font-weight:600;color:var(--crimson-glow);margin-bottom:0.5rem;' }, '🛡️ Anti-Meta Recommendations'),
              ...currentAntiMetaRecommendations.map(rec => 
                h('div', { 
                  className: 'anti-meta-item',
                  style: 'padding:0.5rem;background:rgba(168,32,53,0.1);border-radius:6px;margin-bottom:0.5rem;border:1px solid rgba(168,32,53,0.2);'
                },
                  h('div', { style: 'font-weight:500;margin-bottom:0.25rem;' }, 
                    `vs ${rec.archetypeName} (${Math.round(rec.metaShare * 100)}% of meta)`
                  ),
                  h('div', { style: 'font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.25rem;' }, rec.reason),
                  rec.counterCards.slice(0, 3).map(counter => 
                    h('div', { 
                      key: counter.cardName,
                      style: `font-size:0.8rem;padding:0.25rem 0.5rem;margin:0.25rem 0;border-radius:4px;display:inline-block;margin-right:0.5rem;${counter.fitsColorIdentity ? 'background:rgba(31,168,85,0.2);' : 'background:rgba(255,255,255,0.05);'}`,
                    },
                      `${counter.cardName} ${counter.fitsColorIdentity ? '✓' : '⚠'}`,
                      h('span', { style: 'font-size:0.7rem;color:var(--text-dim);margin-left:0.25rem;' }, `${counter.effectiveness}%`)
                    )
                  )
                )
              )
            )
          : null,
        realtimeMetaSnapshot
          ? (() => {
              const age = realtimeMetaSnapshot.freshness.ageMinutes;
              const freshnessLabel = age <= 0 ? 'just now' : `${age}m ago`;
              const state = realtimeMetaSnapshot.freshness.state;
              const confidenceLabel = `${formatConfidencePercent(realtimeMetaSnapshot.confidence.score)} (${realtimeMetaSnapshot.confidence.band.toUpperCase()})`;

              return h('div', { className: 'meta-status-bar' },
                h('span', { className: `meta-freshness meta-freshness-${state}` },
                  h('span', { className: 'meta-freshness-dot' }),
                  ` Meta: ${state} \u00B7 ${freshnessLabel}`,
                ),
                h('span', { className: 'meta-confidence-pill' }, `Confidence: ${confidenceLabel}`),
                realtimeMetaSnapshot.quality.degraded
                  ? h('span', { className: 'meta-fallback-label' },
                      '\u26A0 ',
                      realtimeMetaSnapshot.quality.fallbackMode === 'snapshot-fallback'
                        ? 'Fallback mode \u2014 recommendations based on archetype patterns'
                        : `Limited data \u2014 ${realtimeMetaSnapshot.quality.label}`,
                    )
                  : null,
              );
            })()
          : null,
        communityDeckFeed.length > 0
          ? h('div', { className: 'community-feed', style: 'margin-top:0.75rem;' },
              h('div', { style: 'font-weight:600;margin-bottom:0.35rem;' }, 'Community Decks'),
              ...communityDeckFeed.slice(0, 3).map((deck) =>
                h('div', { className: 'tool-note', style: 'display:flex;align-items:center;justify-content:space-between;gap:0.6rem;margin:0.2rem 0;padding:0.35rem 0.45rem;border:1px solid rgba(255,255,255,0.1);border-radius:6px;' },
                  h('span', {}, `${deck.name} — ${deck.commander} (${deck.archetype})`),
                  h('button', {
                    className: 'hand-btn',
                    type: 'button',
                    'data-action': 'community-upvote',
                    'data-deck-id': deck.id,
                    title: 'Upvote this deck',
                  }, `▲ ${deck.upvotes}`)
                )
              )
            )
          : null,
      ),
      visibleRecommendations.length > 0
        ? h('div', { className: 'recs-grid' }, ...visibleRecommendations.map((item) => createCardNode(item)))
        : h('p', { className: 'tool-empty' }, 'No owned recommendation cards available. Toggle missing cards to review full build options.'),
    );
  }
}

function setRecommendationLoading(message: string): void {
  const recsResult = $('recsResult');
  const recsContent = $('recsContent');
  if (recsResult) {
    replaceChildren(recsResult, h('p', { className: 'recs-loading' }, message));
  }
  if (recsContent) {
    replaceChildren(recsContent, h('p', { className: 'recs-loading' }, message));
  }
}

export function setRecommendationApplyMode(mode: string): void {
  const nextMode: RecommendationApplyMode = mode === 'swap' ? 'swap' : 'add';
  if (recommendationApplyMode === nextMode) return;

  recommendationApplyMode = nextMode;
  storageSet(STORAGE_KEYS.MTG_RECOMMENDATION_APPLY_MODE, recommendationApplyMode);

  renderRecommendationPanels();
  showToast(nextMode === 'swap'
    ? 'Suggestion mode: 1:1 swap (add + cut)'
    : 'Suggestion mode: add only');
}

export function setRecommendationCollectionMode(mode: string): void {
  const includeMissing = mode === 'include-missing';
  if (recommendationIncludeMissingCards === includeMissing) return;

  recommendationIncludeMissingCards = includeMissing;
  storageSet(STORAGE_KEYS.MTG_RECOMMENDATION_INCLUDE_MISSING, recommendationIncludeMissingCards);

  renderRecommendationPanels();
  showToast(includeMissing
    ? 'Suggestion mode: including missing cards'
    : 'Suggestion mode: owned cards only');
}

export async function toggleDynamicDiscovery(mode: string): Promise<void> {
  const enableDynamic = mode === 'dynamic';
  if (useDynamicDiscovery === enableDynamic) return;

  useDynamicDiscovery = enableDynamic;
  storageSet(STORAGE_KEYS.MTG_USE_DYNAMIC_DISCOVERY, useDynamicDiscovery);

  renderRecommendationPanels();
  showToast(useDynamicDiscovery
    ? 'Dynamic discovery enabled: queries Scryfall for cards'
    : 'Static mode enabled: uses predefined card list');

  // If we have a deck loaded, refresh recommendations
  if (currentDeck && recommendationItemsCache.length > 0) {
    await getCardSuggestions();
  }
}

export async function toggleArchetypeDetection(mode: string): Promise<void> {
  const enableArchetype = mode === 'on';
  if (useArchetypeDetection === enableArchetype) return;

  useArchetypeDetection = enableArchetype;
  storageSet(STORAGE_KEYS.MTG_USE_ARCHETYPE_DETECTION, useArchetypeDetection);

  renderRecommendationPanels();
  showToast(useArchetypeDetection
    ? '🎯 Archetype detection enabled: analyzes deck for anti-meta recommendations'
    : '🎯 Archetype detection disabled');

  // If we have a deck loaded, refresh recommendations
  if (currentDeck && recommendationItemsCache.length > 0) {
    await getCardSuggestions();
  }
}

export function trackRecommendationFeedback(
  recommendationId: string,
  cardName: string,
  rating: 'up' | 'down'
): void {
  const feedback = getUserFeedbackSystem();
  
  // Find the recommendation item
  const recommendation = recommendationItemsCache.find(r => r.id === recommendationId);
  if (!recommendation) return;

  // Track the feedback
  feedback.trackRating(
    recommendation,
    rating,
    {
      detectedArchetypes: currentArchetypeDetection 
        ? [currentArchetypeDetection.primaryArchetype!].filter(Boolean) 
        : [],
      metaMode: recommendationMetaMode,
      commanderName: currentDeck?.commander[0]?.name,
      deckId: currentDeckName,
    }
  );

  // Show toast
  showToast(rating === 'up' 
    ? `👍 Thanks for the feedback! We'll recommend more cards like ${cardName}.`
    : `👎 Thanks for the feedback! We'll recommend fewer cards like ${cardName}.`
  );

  // Update button appearance
  const btn = document.querySelector(`[data-rec-id="${recommendationId}"].feedback-btn.${rating === 'up' ? 'thumbs-up' : 'thumbs-down'}`) as HTMLButtonElement;
  if (btn) {
    btn.style.opacity = '0.5';
    btn.disabled = true;
  }
}

function commitRecommendationDeckState(nextDeck: Deck): void {
  currentDeck = nextDeck;
  renderDeck();
  refreshExportOutputForCurrentState();
  renderRecommendationPanels();
}

export function undoLastRecommendationApply(): void {
  if (!currentDeck || !lastRecommendationApplyAction) {
    showToast('No recommendation apply action to undo');
    return;
  }

  const action = lastRecommendationApplyAction;
  const undoResult = undoRecommendationApply(currentDeck, action);
  if (!undoResult.ok) {
    if (undoResult.code === 'deck_state_mismatch') {
      showToast('Undo blocked: deck changed after apply');
    } else {
      showToast('No recommendation apply action to undo');
    }
    return;
  }

  appliedRecommendationIds.delete(action.recommendationId);
  appliedRecommendationMutations.delete(action.recommendationId);
  lastRecommendationApplyAction = null;

  recordRecommendationUndoHistory({
    deckName: currentDeckName,
    commanderNames: getCommanderNames(currentDeck),
    cardName: action.mutation.addedCardName,
  });

  const recommendation = recommendationItemsCache.find((item) => item.id === action.recommendationId);
  if (recommendation) {
    const feedback = getUserFeedbackSystem();
    feedback.trackRemoved(
      recommendation,
      {
        detectedArchetypes: currentArchetypeDetection
          ? [currentArchetypeDetection.primaryArchetype!].filter(Boolean)
          : [],
        metaMode: recommendationMetaMode,
        commanderName: currentDeck?.commander[0]?.name,
        deckId: currentDeckName,
      },
    );
  }

  clearFlowApplyVisualState();
  commitRecommendationDeckState(undoResult.deck as Deck);

  if (action.mutation.removedCutName) {
    showToast(`Undo complete: -${action.mutation.addedCardName}, +${action.mutation.removedCutName}`);
  } else {
    showToast(`Undo complete: removed ${action.mutation.addedCardName}`);
  }
}

export function showTrendDashboard(): void {
  import('./trend-dashboard.js').then(({ getTrendDashboard }) => {
    let host = document.getElementById('trendDashboard');
    if (!host) {
      host = document.createElement('div');
      host.id = 'trendDashboard';
      host.className = 'trend-dashboard-host';
      document.body.appendChild(host);
    }
    const dashboard = getTrendDashboard('trendDashboard');
    dashboard.show();
  }).catch(error => {
    console.error('Failed to load trend dashboard:', error);
    showToast('Failed to open trend dashboard');
  });
}

export function openCommunityPage(): void {
  window.open('/community.html', '_blank', 'noopener,noreferrer');
}

export async function refreshCommunityFeatures(): Promise<void> {
  try {
    const [feed, snapshot] = await Promise.all([
      fetchCommunityDecks({ limit: 8 }),
      fetchRealtimeMeta(),
    ]);
    communityDeckFeed = feed;
    realtimeMetaSnapshot = snapshot;
  } catch (error) {
    console.warn('[Community] Failed to refresh community/meta data:', error);
  }
  renderRecommendationPanels();
}

export async function shareCurrentDeckToCommunity(): Promise<void> {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }

  const commander = currentDeck.commander[0]?.name || 'Unknown Commander';
  const archetype = currentArchetypeDetection?.primaryArchetype || 'unknown';
  const decklist = [
    ...currentDeck.commander.map((e) => `${e.qty} ${e.name}`),
    ...currentDeck.main.map((e) => `${e.qty} ${e.name}`),
    ...currentDeck.sideboard.map((e) => `${e.qty} ${e.name}`),
  ].join('\n');

  try {
    await createCommunityDeck({
      name: currentDeckName || 'DeckLens Shared Deck',
      format: recommendationMetaMode === 'fnm' ? 'cedh' : 'commander',
      commander,
      archetype: String(archetype),
      decklist,
      notes: `Shared from DeckLens on ${new Date().toISOString()}`,
    });
    showToast('Deck shared to community feed');
    await refreshCommunityFeatures();
  } catch (error) {
    console.error('[Community] Share failed:', error);
    showToast('Could not share deck right now');
  }
}

export async function upvoteCommunityDeckById(deckId: string): Promise<void> {
  if (!deckId) return;
  try {
    const upvotes = await upvoteCommunityDeck(deckId);
    communityDeckFeed = communityDeckFeed.map((deck) => (
      deck.id === deckId ? { ...deck, upvotes } : deck
    ));
    renderRecommendationPanels();
    showToast('Upvoted community deck');
  } catch (error) {
    console.error('[Community] Upvote failed:', error);
    showToast('Could not upvote right now');
  }
}

function startRealtimeMetaPolling(): void {
  if (realtimeMetaPollTimer) {
    clearInterval(realtimeMetaPollTimer);
  }
  realtimeMetaPollTimer = setInterval(() => {
    void refreshCommunityFeatures();
  }, 30_000);
}

function formatCmc(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return Number(value.toFixed(2)).toString();
}

function normalizeHistoryCardKey(cardName: string): string {
  return cardName.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getCommanderNames(deck: Deck | null): string[] {
  if (!deck) return [];
  return deck.commander
    .map((entry) => entry.name.trim())
    .filter(Boolean);
}

function formatDeviceProfileId(profileId: string): string {
  const clean = profileId.trim();
  if (clean.length <= 18) return clean;
  return `${clean.slice(0, 10)}...${clean.slice(-6)}`;
}

function formatElapsedTimeAgo(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'just now';
  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs < 60_000) return 'just now';
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function getConfidenceBand(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.75) return 'high';
  if (confidence >= 0.5) return 'medium';
  return 'low';
}

function formatConfidenceBand(band: 'high' | 'medium' | 'low'): string {
  const labels = { high: 'High', medium: 'Medium', low: 'Low' };
  return labels[band];
}

function formatLogicTag(tag: RecommendationLogicTag): string {
  const labels: Record<RecommendationLogicTag, string> = {
    synergy: 'Synergy Boost',
    'curve-fix': 'Curve Fix',
    'mana-fix': 'Mana Fix',
    'meta-answer': 'Meta Counter',
    'card-advantage': 'Card Advantage',
    protection: 'Protection',
    'board-control': 'Board Control',
  };
  return labels[tag] || tag;
}

function closeFlowTop3ModalInternal(): void {
  const modal = $('flowTop3Modal');
  if (!modal) return;
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
}

function renderFlowTop3ModalContent(items: RecommendationItem[]): void {
  const container = $('flowTop3Content');
  if (!container) return;

  if (items.length === 0) {
    replaceChildren(container, h('p', { className: 'tool-empty' }, 'No recommendations available yet.'));
    return;
  }

  replaceChildren(container,
    h('div', { className: 'flow-top3-list' },
      ...items.map((item, index) =>
        h('div', { className: 'flow-top3-item' },
          h('div', { className: 'flow-top3-rank' }, `#${index + 1}`),
          h('div', { className: 'flow-top3-main' },
            h('div', { className: 'flow-top3-add' }, `+ ${item.cardName}`),
            h('div', { className: 'flow-top3-cut' }, item.suggestedCutName ? `- ${item.suggestedCutName}` : '- no cut suggestion (add-only)')
          ),
          h('div', { className: 'flow-top3-meta' },
            h('span', {}, `Impact +${item.powerImpactScore}`),
            h('span', {}, `Confidence ${formatConfidencePercent(item.confidence)}`),
          ),
        )
      )
    )
  );
}

function openFlowTop3Modal(): void {
  const modal = $('flowTop3Modal');
  if (!modal) return;

  const topRecommendations = getFlowTopRecommendations(3);
  renderFlowTop3ModalContent(topRecommendations);

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
}

export function closeFlowTop3Modal(): void {
  closeFlowTop3ModalInternal();
}

export function closeFlowTop3OnOverlay(eventTarget: EventTarget | null): void {
  const modal = $('flowTop3Modal');
  if (!modal) return;
  if (eventTarget === modal) {
    closeFlowTop3ModalInternal();
  }
}

export function continueFlowFromTop3Modal(): void {
  const topRecommendations = getFlowTopRecommendations(3);
  closeFlowTop3ModalInternal();

  if (!currentDeck) {
    goToFlowStep('import');
    return;
  }

  let appliedCount = 0;
  const appliedCardNames: string[] = [];
  for (const recommendation of topRecommendations) {
    const modeOverride: RecommendationApplyMode = recommendation.suggestedCutName ? 'swap' : 'add';
    const ok = applyRecommendationById(recommendation.id, {
      modeOverride,
      silent: true,
      ignoreVisibilityGate: true,
      skipFlowStateUpdate: true,
    });
    if (ok) {
      appliedCount += 1;
      appliedCardNames.push(recommendation.cardName);
    }
  }

  goToFlowStep('apply');

  if (appliedCount > 0) {
    setFlowApplyHighlightNames(appliedCardNames);
    setImportFlowState('ready', 'apply', `${appliedCount} Top recommendations applied. New cards are highlighted, previous cards are muted.`);
    showToast(`Applied ${appliedCount} Top recommendation${appliedCount === 1 ? '' : 's'}`);
  } else {
    setImportFlowState('ready', 'apply', 'Top recommendations could not be auto-applied. Use + buttons to apply manually.');
    showToast('No Top recommendations were applied');
  }
}

export function closeFlowAnalysisSpotlight(): void {
  setFlowAnalysisSpotlight(false);
}

export function closeFlowAnalysisOnBackdrop(eventTarget: EventTarget | null): void {
  const backdrop = $('flowAnalysisBackdrop');
  if (!backdrop) return;
  if (eventTarget === backdrop) {
    setFlowAnalysisSpotlight(false);
  }
}

function closeRecommendationApplyModal(): void {
  recommendationApplyPreviewState = null;
  const modal = $('recApplyModal');
  if (!modal) return;
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
}

function renderDiffPreview(container: HTMLElement, diff: DeckDiff, options: {
  cardName: string;
  cutName: string | null;
  mode: RecommendationApplyMode;
}): void {
  const { cardName, cutName, mode } = options;
  
  // Filter to only show the relevant changes
  const relevantChanges: DiffEntry[] = [];
  
  // Add the added card
  const mainAdded = diff.main.find(d => d.status === 'added' && d.name.toLowerCase() === cardName.toLowerCase());
  if (mainAdded) {
    relevantChanges.push(mainAdded);
  }
  
  // Add the cut card if it's a swap
  if (mode === 'swap' && cutName) {
    const mainRemoved = diff.main.find(d => d.status === 'removed' && d.name.toLowerCase() === cutName.toLowerCase());
    if (mainRemoved) {
      relevantChanges.push(mainRemoved);
    }
  }
  
  const content = h('div', { className: 'rec-diff-preview' },
    h('h4', { className: 'rec-diff-preview__title' }, 'What will change:'),
    relevantChanges.length > 0 ? h('div', { className: 'rec-diff-preview__changes' },
      ...relevantChanges.map(change => {
        const statusClass = change.status === 'added' ? 'rec-diff-preview__change--added' : 'rec-diff-preview__change--removed';
        const icon = change.status === 'added' ? '+' : '-';
        const card = resolveCard(change.name);
        const cmc = card && typeof card.cmc === 'number' ? formatCmc(card.cmc) : '?';
        const price = card ? formatPriceAmount(getCardPrice(card), null) : '?';
        const qty = change.status === 'added' ? change.diff : -change.diff;
        
        return h('div', { className: `rec-diff-preview__change ${statusClass}` },
          h('div', { className: 'rec-diff-preview__change-icon' }, icon),
          h('div', { className: 'rec-diff-preview__change-info' },
            h('div', { className: 'rec-diff-preview__change-name' }, change.name),
            h('div', { className: 'rec-diff-preview__change-details' },
              h('span', {}, `CMC: ${cmc}`),
              change.status === 'added' && price ? h('span', { style: 'margin-left: 1rem;' }, `Price: ${price}`) : null
            )
          ),
          h('div', { className: 'rec-diff-preview__change-qty' },
            `${icon}${Math.abs(qty)}`
          )
        );
      })
    ) : h('div', { className: 'tool-note' }, 'No changes to display'),
    
    // Summary stats
    h('div', { className: 'rec-diff-preview__summary' },
      h('div', { className: 'rec-diff-preview__summary-item' },
        h('span', {}, 'Total Cards'),
        h('strong', {}, `${diff.stats.totalAdded} added, ${diff.stats.totalRemoved} removed`)
      ),
      diff.stats.totalAdded > 0 && h('div', { className: 'rec-diff-preview__summary-item' },
        h('span', {}, 'Main Deck Size'),
        h('strong', {}, `${diff.stats.cardsAddedB} cards`)
      )
    )
  );
  
  replaceChildren(container, content);
}

function openRecommendationApplyModal(preview: RecommendationApplyPreviewState): void {
  recommendationApplyPreviewState = preview;
  const modal = $('recApplyModal');
  if (!modal) return;

  const titleEl = $('recApplyTitle');
  if (titleEl) {
    titleEl.textContent = preview.mode === 'swap'
      ? `Apply 1:1 swap: +${preview.cardName}${preview.cutName ? ` / -${preview.cutName}` : ''}`
      : `Apply add-only change: +${preview.cardName}`;
  }

  const statsEl = $('recApplyStats');
  if (statsEl) {
    const confidenceBand = getConfidenceBand(preview.confidence);
    const confidenceBandClass = `rec-confidence-band--${confidenceBand}`;
    
    const rows = [
      // Confidence band with visual indicator
      h('div', { className: 'rc-confidence-row' }, 
        h('span', {}, 'Confidence'),
        h('strong', { className: confidenceBandClass }, formatConfidenceBand(confidenceBand))
      ),
      
      // Existing stats
      h('div', { className: 'rc-confidence-row' }, h('span', {}, 'Add CMC'), h('strong', {}, formatCmc(preview.addCmc))),
      h('div', { className: 'rc-confidence-row' }, h('span', {}, 'Cut CMC'), h('strong', {}, formatCmc(preview.cutCmc))),
      h('div', { className: 'rc-confidence-row' }, h('span', {}, 'Curve Delta'), h('strong', {}, preview.curveDelta === null ? 'n/a' : formatSignedDelta(preview.curveDelta))),
      h('div', { className: 'rc-confidence-row' }, h('span', {}, 'Price Delta'), h('strong', {}, preview.priceDelta === null ? 'n/a' : formatSignedDelta(preview.priceDelta))),
      h('div', { className: 'rc-confidence-row' }, h('span', {}, 'Power Impact'), h('strong', {}, `${preview.powerImpactLabel.toUpperCase()} (+${preview.powerImpactScore})`)),
      h('div', { className: 'rc-confidence-row' }, h('span', {}, 'Mode'), h('strong', {}, preview.mode === 'swap' ? '1:1 Swap' : 'Add Only')),
    ];
    
    replaceChildren(statsEl, ...rows);
    
    // Add source attribution section after stats
    const sourceSection = h('div', { id: 'recApplySourceAttribution', className: 'rec-source-attribution', style: 'margin-top: 1rem;' },
      h('h4', { className: 'rec-source-attribution__title' }, 'Why this recommendation:'),
      h('div', { className: 'rec-source-attribution__tags' },
        ...preview.logicTags.map(tag => 
          h('span', { className: 'rec-source-attribution__tag' }, formatLogicTag(tag))
        )
      ),
      h('div', { className: 'rec-source-attribution__breakdown', style: 'margin-top: 0.5rem; font-size: 0.78rem; color: var(--text-dim);' },
        h('div', {}, `Signal Strength: ${Math.round(preview.confidenceBreakdown.signalStrength * 100)}%`),
        h('div', {}, `Data Coverage: ${Math.round(preview.confidenceBreakdown.dataCoverage * 100)}%`),
        h('div', {}, `Heuristic Consensus: ${Math.round(preview.confidenceBreakdown.heuristicConsensus * 100)}%`)
      )
    );
    
    // Insert after stats but before reason
    const existingSourceSection = $('recApplySourceAttribution');
    if (existingSourceSection && existingSourceSection.parentElement) {
      existingSourceSection.replaceWith(sourceSection);
    } else {
      statsEl.insertAdjacentElement('afterend', sourceSection);
    }
  }

  const reasonEl = $('recApplyReason');
  if (reasonEl) {
    reasonEl.textContent = preview.reason;
  }

  // Add diff preview section
  const diffPreviewEl = $('recApplyDiffPreview');
  if (diffPreviewEl && currentDeck) {
    // Create preview deck state to show diff
    const applyResult = applyRecommendationAtomically({
      deck: currentDeck,
      recommendationId: preview.recommendationId,
      recommendationCardName: preview.cardName,
      suggestedCutName: preview.cutName,
      mode: preview.mode,
    });

    if (applyResult.ok) {
      const diff = compareDecksDiff(currentDeck, applyResult.deck);
      renderDiffPreview(diffPreviewEl, diff, {
        cardName: preview.cardName,
        cutName: preview.cutName,
        mode: preview.mode
      });
    } else {
      replaceChildren(diffPreviewEl, 
        h('div', { className: 'tool-note' }, 'Unable to preview changes')
      );
    }
  }

  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
}

function buildRecommendationApplyPreview(recommendation: RecommendationItem): RecommendationApplyPreviewState {
  const addCard = resolveCard(recommendation.cardName);
  const cutCard = recommendation.suggestedCutName ? resolveCard(recommendation.suggestedCutName) : null;
  const addCmc = typeof addCard?.cmc === 'number' ? addCard.cmc : null;
  const cutCmc = typeof cutCard?.cmc === 'number' ? cutCard.cmc : null;

  let curveDelta: number | null = null;
  if (addCmc !== null && cutCmc !== null) curveDelta = addCmc - cutCmc;
  else if (addCmc !== null && recommendationApplyMode === 'add') curveDelta = addCmc;

  return {
    recommendationId: recommendation.id,
    cardName: recommendation.cardName,
    cutName: recommendation.suggestedCutName ?? null,
    mode: recommendationApplyMode,
    addCmc,
    cutCmc,
    curveDelta,
    priceDelta: recommendation.deltaPrice,
    powerImpactScore: recommendation.powerImpactScore,
    powerImpactLabel: recommendation.powerImpactLabel,
    reason: recommendation.reason,
    confidence: recommendation.confidence,
    confidenceBreakdown: recommendation.confidenceBreakdown,
    logicTags: recommendation.logicTags,
  };
}

function applyRecommendationById(
  recId: string,
  options: {
    modeOverride?: RecommendationApplyMode;
    silent?: boolean;
    ignoreVisibilityGate?: boolean;
    skipFlowStateUpdate?: boolean;
  } = {},
): boolean {
  if (!recId || !currentDeck) return false;

  const recommendation = recommendationItemsCache.find((item) => item.id === recId);
  if (!recommendation) return false;

  const applyMode = options.modeOverride || recommendationApplyMode;
  const visibleIds = new Set(getRecommendationCollectionView().visibleItems.map((item) => item.id));
  if (!options.ignoreVisibilityGate && !visibleIds.has(recId)) {
    if (!options.silent) {
      showToast('Enable missing cards to apply this recommendation');
    }
    return false;
  }

  const applyResult = applyRecommendationAtomically({
    deck: currentDeck,
    recommendationId: recommendation.id,
    recommendationCardName: recommendation.cardName,
    suggestedCutName: recommendation.suggestedCutName,
    mode: applyMode,
  });

  if (!applyResult.ok) {
    if (!options.silent) {
      if (applyResult.code === 'missing_cut_suggestion') {
        showToast('Swap failed: recommendation has no cut suggestion');
      } else if (applyResult.code === 'suggested_cut_not_found') {
        showToast(`Swap failed: cut target not found (${recommendation.suggestedCutName || 'n/a'})`);
      } else {
        showToast('Could not apply recommendation right now');
      }
    }
    return false;
  }

  appliedRecommendationIds.add(recId);
  appliedRecommendationMutations.set(recId, applyResult.mutation);
  lastRecommendationApplyAction = applyResult.action;

  setFlowApplyVisualState(
    applyResult.mutation.addedCardName,
    applyResult.mutation.removedCutName,
  );
  commitRecommendationDeckState(applyResult.deck as Deck);
  $('deckContent')?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (importFlowState.step === 'apply') {
    setFlowApplyHighlightsFromRecommendations(3, { includeCuts: false });
  }

  const feedback = getUserFeedbackSystem();
  feedback.trackApplied(
    recommendation,
    {
      detectedArchetypes: currentArchetypeDetection
        ? [currentArchetypeDetection.primaryArchetype!].filter(Boolean)
        : [],
      metaMode: recommendationMetaMode,
      commanderName: currentDeck?.commander[0]?.name,
      deckId: currentDeckName,
    },
  );

  recordRecommendationApplyHistory({
    deckName: currentDeckName,
    commanderNames: getCommanderNames(currentDeck),
    recommendationId: recommendation.id,
    cardName: recommendation.cardName,
    mode: applyMode,
    cutName: recommendation.suggestedCutName ?? null,
    reason: recommendation.reason,
    powerImpactLabel: recommendation.powerImpactLabel,
    logicTags: recommendation.logicTags,
  });

  trackAnalyticsEvent('recommendation_applied', {
    recommendation_id: recommendation.id,
    recommendation_card: recommendation.cardName,
    suggested_cut: recommendation.suggestedCutName,
    delta_price: recommendation.deltaPrice,
    power_impact_score: recommendation.powerImpactScore,
    power_impact_label: recommendation.powerImpactLabel,
    selected_count: appliedRecommendationIds.size,
    apply_mode: applyMode,
    cut_applied: applyResult.mutation.removedCutName !== null,
    action_id: applyResult.action.actionId,
    deck_signature_before: applyResult.deckSignatureBefore,
    deck_signature_after: applyResult.deckSignatureAfter,
    main_count_before: applyResult.mainCountBefore,
    main_count_after: applyResult.mainCountAfter,
    undo_depth: lastRecommendationApplyAction ? 1 : 0,
    deck_name: currentDeckName,
    ...getMetaContextProperties(),
  }, {
    dedupeKey: `recommendation_applied:${applyResult.action.actionId}`,
    dedupeWindowMs: 1200,
  });

  if (!options.silent) {
    if (applyMode === 'swap') {
      const removedCutLabel = applyResult.mutation.removedCutName
        || recommendation.suggestedCutName
        || 'unknown cut';
      showToast(`Swapped: +${applyResult.mutation.addedCardName}, -${removedCutLabel}`);
    } else {
      showToast(`Added ${applyResult.mutation.addedCardName} to Main Deck`);
    }
  }

  if (!options.skipFlowStateUpdate) {
    setImportFlowState('ready', 'apply', 'Change applied. Continue to Export to copy/download your updated list.');
    emitWizardStepEvent('apply', 'completed');
  }

  return true;
}

export function confirmRecommendationApply(): void {
  const pending = recommendationApplyPreviewState;
  if (!pending) {
    showToast('No pending recommendation preview');
    return;
  }
  closeRecommendationApplyModal();
  applyRecommendationById(pending.recommendationId);
}

export function cancelRecommendationApply(): void {
  closeRecommendationApplyModal();
}

export function closeRecommendationApplyOnOverlay(eventTarget: EventTarget | null): void {
  const modal = $('recApplyModal');
  if (!modal) return;
  if (eventTarget === modal) {
    closeRecommendationApplyModal();
  }
}

export function toggleRecommendationApplied(recId: string): void {
  if (!recId || !currentDeck) return;

  const recommendation = recommendationItemsCache.find((item) => item.id === recId);
  if (!recommendation) return;

  const visibleIds = new Set(getRecommendationCollectionView().visibleItems.map((item) => item.id));
  if (!appliedRecommendationIds.has(recId) && !visibleIds.has(recId)) {
    showToast('Enable missing cards to apply this recommendation');
    return;
  }

  if (appliedRecommendationIds.has(recId)) {
    if (!lastRecommendationApplyAction || lastRecommendationApplyAction.recommendationId !== recId) {
      showToast('Only the latest apply action can be undone');
      return;
    }

    undoLastRecommendationApply();
    return;
  }

  const preview = buildRecommendationApplyPreview(recommendation);
  openRecommendationApplyModal(preview);
}

export async function getCardSuggestions(): Promise<void> {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }

  setRecommendationLoading('Calculating recommendations with price and impact data...');
  const startedAt = Date.now();
  const analysisId = `analysis_${startedAt}_${Math.random().toString(36).slice(2, 8)}`;
  const metaContextProperties = getMetaContextProperties();
  recommendationAnalysisContext = {
    analysisId,
    status: 'running',
    recommendationCount: 0,
    startedAt,
    completedAt: null,
  };

  trackAnalyticsEvent('analysis_started', {
    analysis_id: analysisId,
    deck_name: currentDeckName,
    total_cards: deckTotalCards(currentDeck),
    unique_cards: deckUniqueCards(currentDeck),
    tool: 'recommendations',
    ...metaContextProperties,
  }, {
    dedupeKey: `analysis_started:${analysisId}`,
    dedupeWindowMs: 500,
  });

  try {
    const adapter = createPriceAdapter({
      resolveCard: (cardName) => resolveCard(cardName),
      source: 'scryfall.prices',
      asOf: lastPriceSyncAt,
      preferredCurrency: 'EUR',
      fallbackCurrency: 'USD',
      staleAfterMs: 1000 * 60 * 60 * 24 * 2,
    });

    if (useDynamicDiscovery) {
      setRecommendationLoading('Discovering cards from Scryfall database...');
      
      try {
        const result = await buildRecommendationsDynamic({
          deckMain: currentDeck.main.map((entry) => ({ name: entry.name, qty: entry.qty })),
          getCard: (cardName) => resolveCard(cardName),
          getPrice: (cardName) => adapter.getPrice(cardName),
          metaMode: recommendationMetaMode,
          maxRecommendations: 8,
          useDynamicDiscovery: true,
          useMLPersonalization: true,
          detectedArchetypes: currentArchetypeDetection?.primaryArchetype 
            ? [currentArchetypeDetection.primaryArchetype, ...currentArchetypeDetection.secondaryArchetypes.map(a => a.id)]
            : undefined,
          discoveryConfig: {
            maxCardsPerQuery: 15,
            maxTotalCards: 100,
            maxQueries: 5,
            minConfidence: 0.3,
          },
        });

        recommendationItemsCache = result.items;
        recommendationDiscoveryStats = result.discoveryStats || null;
        
        if (result.discoveryStats) {
          console.log('[Dynamic Discovery] Stats:', result.discoveryStats);
        }
      } catch (error) {
        console.error('[Dynamic Discovery] Failed, falling back to static:', error);
        // Fallback to static recommendations
        recommendationItemsCache = buildRecommendations({
          deckMain: currentDeck.main.map((entry) => ({ name: entry.name, qty: entry.qty })),
          getCard: (cardName) => resolveCard(cardName),
          getPrice: (cardName) => adapter.getPrice(cardName),
          metaMode: recommendationMetaMode,
          maxRecommendations: 8,
        });
        recommendationDiscoveryStats = null;
      }
    } else {
      // Use static recommendations only
      const recommendationNames = getRecommendationCatalogCardNames();
      try {
        await fetchCardsFromScryfall(recommendationNames);
      } catch (error) {
        console.warn('[MTG Recs] Price preload partially failed:', error);
      }

      recommendationItemsCache = buildRecommendations({
        deckMain: currentDeck.main.map((entry) => ({ name: entry.name, qty: entry.qty })),
        getCard: (cardName) => resolveCard(cardName),
        getPrice: (cardName) => adapter.getPrice(cardName),
        metaMode: recommendationMetaMode,
        maxRecommendations: 8,
      });
      recommendationDiscoveryStats = null;
    }

    const validIds = new Set(recommendationItemsCache.map((item) => item.id));
    appliedRecommendationIds = new Set(
      [...appliedRecommendationIds].filter((id) => validIds.has(id)),
    );
    appliedRecommendationMutations = new Map(
      [...appliedRecommendationMutations.entries()].filter(([id]) => validIds.has(id)),
    );
    if (lastRecommendationApplyAction && !validIds.has(lastRecommendationApplyAction.recommendationId)) {
      lastRecommendationApplyAction = null;
    }

    // Archetype Detection (only if enabled) - Using Web Worker
    if (useArchetypeDetection) {
      try {
        const workerManager = getWorkerManager();
        
        // Build card data map for worker
        const cardData: Record<string, { name: string; type_line?: string; oracle_text?: string; color_identity?: string[] }> = {};
        for (const entry of [...currentDeck.main, ...currentDeck.sideboard, ...currentDeck.commander]) {
          const card = resolveCard(entry.name);
          if (card) {
            cardData[entry.name.toLowerCase()] = {
              name: card.name,
              type_line: card.type_line,
              oracle_text: card.oracle_text,
              color_identity: card.color_identity,
            };
          }
        }
        
        // Use Web Worker for detection
        const workerResult = await workerManager.detectArchetypes(currentDeck, cardData);
        
        // Convert worker result to app format
        currentArchetypeDetection = {
          primaryArchetype: workerResult.primaryArchetype,
          secondaryArchetypes: workerResult.secondaryArchetypes,
          allScores: workerResult.allScores,
          detectedCards: new Map(Object.entries(workerResult.detectedCards)) as Map<ArchetypeId, string[]>,
          counterCards: workerResult.counterCards,
          hybridArchetype: workerResult.hybridArchetype,
        };
        
        console.log('[Archetype Detection] Via Worker:', currentArchetypeDetection);
      } catch (error) {
        console.error('[Archetype Detection] Worker failed:', error);
        currentArchetypeDetection = null;
      }

      // Anti-Meta Recommendations
      if (currentArchetypeDetection) {
        try {
          currentAntiMetaRecommendations = generateAntiMetaRecommendations(
            currentDeck,
            currentArchetypeDetection,
            'commander',
            (cardName) => {
              const card = resolveCard(cardName);
              return card ? { color_identity: card.color_identity } : undefined;
            }
          );
          console.log('[Anti-Meta]', currentAntiMetaRecommendations);
        } catch (error) {
          console.error('[Anti-Meta] Failed:', error);
          currentAntiMetaRecommendations = [];
        }
      }
    } else {
      // Reset archetype data if disabled
      currentArchetypeDetection = null;
      currentAntiMetaRecommendations = [];
    }

    renderRecommendationPanels();

    const collectionView = getRecommendationCollectionView();
    const summary = summarizeRecommendations(collectionView.visibleItems);
    recommendationAnalysisContext = {
      analysisId,
      status: 'ok',
      recommendationCount: collectionView.visibleItems.length,
      startedAt,
      completedAt: Date.now(),
    };
    trackAnalyticsEvent('analysis_completed', {
      analysis_id: analysisId,
      tool: 'recommendations',
      status: 'ok',
      recommendation_count: collectionView.visibleItems.length,
      recommendation_candidates: recommendationItemsCache.length,
      owned_recommendation_count: collectionView.ownedItems.length,
      missing_recommendation_count: collectionView.missingItems.length,
      strong_build_missing_count: collectionView.gap?.missingCount || 0,
      duration_ms: Date.now() - startedAt,
      missing_price_count: summary.missingPriceCount,
      stale_price_count: summary.stalePriceCount,
      unknown_delta_count: summary.unknownDeltaCount,
      total_power_impact: summary.totalPowerImpact,
      ...metaContextProperties,
    }, {
      dedupeKey: `analysis_completed:${analysisId}`,
      dedupeWindowMs: 500,
    });

    trackAnalyticsEvent('recommendation_viewed', {
      analysis_id: analysisId,
      recommendation_count: collectionView.visibleItems.length,
      recommendation_candidates: recommendationItemsCache.length,
      owned_recommendation_count: collectionView.ownedItems.length,
      missing_recommendation_count: collectionView.missingItems.length,
      strong_build_missing_count: collectionView.gap?.missingCount || 0,
      include_missing_cards: recommendationIncludeMissingCards,
      missing_price_count: summary.missingPriceCount,
      stale_price_count: summary.stalePriceCount,
      total_known_delta: summary.totalKnownDelta,
      deck_name: currentDeckName,
      ...metaContextProperties,
    }, {
      dedupeKey: `recommendation_viewed:${analysisId}`,
      dedupeWindowMs: 500,
    });

    showToast('Recommendations ready');
    setImportFlowState(
      'ready',
      'recommend',
      collectionView.visibleItems.length > 0
        ? `Top recommendations ready (${collectionView.visibleItems.length}). Continue to Apply to commit your first change.`
        : 'No recommendation candidates found. Try changing meta mode or include missing cards.',
    );
    if ($('betaDashboardPanel')?.classList.contains('active')) {
      void refreshBetaDashboard();
    }
  } catch (error) {
    trackAnalyticsEvent('analysis_completed', {
      analysis_id: analysisId,
      tool: 'recommendations',
      status: 'error',
      duration_ms: Date.now() - startedAt,
      ...metaContextProperties,
    }, {
      dedupeKey: `analysis_completed:${analysisId}`,
      dedupeWindowMs: 500,
    });

    recommendationAnalysisContext = {
      analysisId,
      status: 'error',
      recommendationCount: 0,
      startedAt,
      completedAt: Date.now(),
    };

    console.error('[MTG Recs] Failed to generate recommendations:', error);
    showError('Could not generate recommendation impact right now. Try again.');
    setRecommendationLoading('Recommendation engine failed. Retry in a moment.');
    setImportFlowState('error', 'recommend', 'Recommendation step failed. Retry from Top 3.');
    if ($('betaDashboardPanel')?.classList.contains('active')) {
      void refreshBetaDashboard();
    }
  }
}

// ==================== TOOLS STATE UPDATE ====================
// Called when a deck is loaded to update all tool placeholders
function updateToolsState(): void {
  if (!currentDeck) return;

  recommendationItemsCache = [];
  appliedRecommendationIds.clear();
  appliedRecommendationMutations.clear();
  lastRecommendationApplyAction = null;
  recommendationAnalysisContext = {
    analysisId: null,
    status: 'idle',
    recommendationCount: 0,
    startedAt: null,
    completedAt: null,
  };
  matchupGuideCache = null;
  
  const deckSize = currentDeck.main.reduce((a, e) => a + e.qty, 0);
  debugLog('[MTG] Updating tools state, deck size:', deckSize);
  
  // Update Tokens placeholder
  const tokensEl = $('tokensList');
  if (tokensEl) {
    const tokenCards: string[] = [];
    for (const entry of currentDeck.main) {
      const card = resolveCard(entry.name);
      if (card?.oracle_text?.toLowerCase().includes('create') && 
          card?.oracle_text?.toLowerCase().includes('token')) {
        tokenCards.push(card.name);
      }
    }
    if (tokenCards.length > 0) {
      replaceChildren(
        tokensEl,
        h(
          'div',
          { className: 'tool-result-list' },
          ...tokenCards.map(t => h('div', { className: 'tool-result-item compact' }, `🎭 ${t}`))
        )
      );
    } else {
      replaceChildren(tokensEl,
        h('p', { className: 'tool-empty' }, 'No token-creating cards found.')
      );
    }
  }
  
  // Update Combos - lazy-load database + detect
  const combosEl = $('combosList');
  if (combosEl) {
    replaceChildren(combosEl,
      h('p', { className: 'tool-empty' }, '⏳ Loading combo database (3,900+ combos)...')
    );
  }
  const combosContent = $('combosContent');
  if (combosContent) {
    replaceChildren(combosContent,
      h('p', { className: 'tool-empty' }, '⏳ Loading combo database...')
    );
  }
  loadAndDetectCombos();
  
  // Update Buy placeholder
  const buyEl = $('buyOptions');
  if (buyEl) {
    const totalPrice = currentDeck.main.reduce((sum, entry) => {
      const card = resolveCard(entry.name);
      return sum + (parseFloat(card?.prices?.eur || '0') * entry.qty);
    }, 0);
    
    buyEl.textContent = '';
    buyEl.appendChild(fragment(
      h('div', { className: 'tool-callout' },
        h('div', { className: 'tool-callout-value' }, `€${totalPrice.toFixed(2)}`),
        h('div', { className: 'tool-callout-label' }, 'Estimated deck value'),
      ),
      h('div', { className: 'tool-links-row' },
        Object.assign(
          h('a', { className: 'hand-btn tool-link-btn' }, 'Cardmarket'),
          { href: 'https://www.cardmarket.com/en/Magic', target: '_blank', rel: 'noopener noreferrer' }
        ),
        Object.assign(
          h('a', { className: 'hand-btn tool-link-btn' }, 'TCGPlayer'),
          { href: 'https://www.tcgplayer.com/', target: '_blank', rel: 'noopener noreferrer' }
        ),
      ),
    ));
  }
  
  // Update Wishlist placeholder
  const wishlistEl = $('wishlistContent');
  if (wishlistEl) {
    replaceChildren(wishlistEl,
      h('p', { className: 'tool-empty' }, 'Click cards in your deck list to add them to wishlist.')
    );
  }
  
  // Update Collection stats
  const collStats = $('collStats2');
  if (collStats) {
    replaceChildren(collStats,
      h('p', { className: 'tool-empty' }, `Deck loaded: ${deckSize} cards. Import your collection to check buildability.`)
    );
  }

  const recsResult = $('recsResult');
  if (recsResult) {
    replaceChildren(recsResult,
      h('p', { className: 'tool-empty' }, 'Run suggestions to see price + power impact recommendations.')
    );
  }

  const recsContent = $('recsContent');
  if (recsContent) {
    replaceChildren(recsContent,
      h('p', { className: 'tool-empty' }, 'Run suggestions to see price + power impact recommendations.')
    );
  }

  setMatchupGuidePlaceholder('Run matchup guide to generate sideboard and gameplan instructions.');
  
  // Update Hypergeometric defaults based on deck
  const hyperDeck = $('hyperDeck') as HTMLInputElement | null;
  if (hyperDeck) {
    hyperDeck.value = String(deckSize);
  }
  
  // Auto-run DNA analysis
  calculateDNA();
}

// ==================== COMBO DETECTION (Lazy-loaded Commander Spellbook DB) ====================

interface ComboDBEntry {
  c: string[];  // card names
  r: string[];  // results/produces
  id: string;   // spellbook ID
}

interface ComboMatch {
  combo: ComboDBEntry;
  missingCards: string[];
}

// Category definitions for filtering
const COMBO_CATEGORIES: Record<string, { label: string; icon: string; keywords: string[] }> = {
  mana:    { label: 'Infinite Mana',     icon: '💎', keywords: ['infinite mana', 'infinite colored mana', 'infinite colorless mana'] },
  damage:  { label: 'Infinite Damage',   icon: '💀', keywords: ['infinite damage', 'infinite lifeloss', 'win the game'] },
  tokens:  { label: 'Infinite Tokens',   icon: '👥', keywords: ['infinite creature tokens', 'infinite tokens', 'infinite etb'] },
  draw:    { label: 'Card Draw',         icon: '📖', keywords: ['infinite card draw', 'infinite draw', 'exile your library'] },
  mill:    { label: 'Mill',              icon: '📚', keywords: ['infinite mill', 'mill', 'exile'] },
  turns:   { label: 'Extra Turns',       icon: '⏰', keywords: ['infinite turns'] },
  combat:  { label: 'Combat',            icon: '⚔️', keywords: ['infinite combat phases', 'infinite combat'] },
  lock:    { label: 'Lock / Stax',       icon: '🔒', keywords: ['lock', 'opponents can'] },
};

function categorizeCombo(results: string[]): string[] {
  const cats: string[] = [];
  const lower = results.map(r => r.toLowerCase());
  for (const [key, def] of Object.entries(COMBO_CATEGORIES)) {
    if (def.keywords.some(kw => lower.some(r => r.includes(kw)))) {
      cats.push(key);
    }
  }
  return cats.length > 0 ? cats : ['other'];
}

// Combo database cache
let comboDBCache: ComboDBEntry[] | null = null;
// Set of card names that are part of found combos (for deck-list highlighting)
let comboCardNames: Set<string> = new Set();

async function loadComboDB(): Promise<ComboDBEntry[]> {
  if (comboDBCache) return comboDBCache;
  try {
    const resp = await fetch('./combos.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    comboDBCache = await resp.json();
    debugLog(`[MTG] Combo DB loaded: ${comboDBCache!.length} combos`);
    return comboDBCache!;
  } catch (err) {
    console.error('[MTG] Failed to load combo DB:', err);
    return [];
  }
}

function detectCombos(db: ComboDBEntry[]): { found: ComboMatch[]; nearMiss: ComboMatch[] } {
  if (!currentDeck) return { found: [], nearMiss: [] };

  const deckCardNames = new Set<string>();
  for (const e of [...currentDeck.main, ...currentDeck.sideboard, ...currentDeck.commander]) {
    deckCardNames.add(e.name.toLowerCase());
    // Handle split cards: "Bonecrusher Giant // Stomp"
    const splitIdx = e.name.indexOf(' // ');
    if (splitIdx > 0) {
      deckCardNames.add(e.name.substring(0, splitIdx).toLowerCase());
    }
  }

  const found: ComboMatch[] = [];
  const nearMiss: ComboMatch[] = [];

  for (const combo of db) {
    const missing = combo.c.filter(c => !deckCardNames.has(c.toLowerCase()));
    if (missing.length === 0) {
      found.push({ combo, missingCards: [] });
    } else if (missing.length === 1) {
      nearMiss.push({ combo, missingCards: missing });
    }
  }

  // Sort: found by number of results (more interesting first), near-miss limited
  found.sort((a, b) => b.combo.r.length - a.combo.r.length);
  nearMiss.sort((a, b) => b.combo.r.length - a.combo.r.length);

  return { found, nearMiss: nearMiss.slice(0, 15) };
}

async function loadAndDetectCombos(): Promise<void> {
  const db = await loadComboDB();
  // Fallback to hardcoded if fetch fails
  const results = db.length > 0 ? detectCombos(db) : detectCombosHardcoded();

  // Track combo card names for highlighting
  comboCardNames.clear();
  for (const m of results.found) {
    for (const c of m.combo.c ?? m.combo.c) {
      comboCardNames.add(c.toLowerCase());
    }
  }

  // Render in both panels
  const combosEl = $('combosList');
  if (combosEl) replaceChildren(combosEl, renderComboResults(results));
  const combosContent = $('combosContent');
  if (combosContent) replaceChildren(combosContent, renderComboResults(results));

  // Update combo highlighting in card list
  highlightComboCards();
}

// Hardcoded fallback (top ~30 combos for offline mode)
function detectCombosHardcoded(): { found: ComboMatch[]; nearMiss: ComboMatch[] } {
  const FALLBACK: ComboDBEntry[] = [
    { c: ['Dramatic Reversal', 'Isochron Scepter'], r: ['Infinite mana', 'Infinite storm count'], id: '' },
    { c: ['Thassa\'s Oracle', 'Demonic Consultation'], r: ['Win the game'], id: '' },
    { c: ['Thassa\'s Oracle', 'Tainted Pact'], r: ['Win the game'], id: '' },
    { c: ['Exquisite Blood', 'Sanguine Bond'], r: ['Infinite damage', 'Infinite life'], id: '' },
    { c: ['Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts'], r: ['Infinite hasty tokens'], id: '' },
    { c: ['Kiki-Jiki, Mirror Breaker', 'Restoration Angel'], r: ['Infinite hasty tokens'], id: '' },
    { c: ['Kiki-Jiki, Mirror Breaker', 'Felidar Guardian'], r: ['Infinite hasty tokens'], id: '' },
    { c: ['Heliod, Sun-Crowned', 'Walking Ballista'], r: ['Infinite damage'], id: '' },
    { c: ['Basalt Monolith', 'Rings of Brighthearth'], r: ['Infinite colorless mana'], id: '' },
    { c: ['Basalt Monolith', 'Power Artifact'], r: ['Infinite colorless mana'], id: '' },
    { c: ['Deadeye Navigator', 'Peregrine Drake'], r: ['Infinite mana'], id: '' },
    { c: ['Mikaeus, the Unhallowed', 'Triskelion'], r: ['Infinite damage'], id: '' },
    { c: ['Niv-Mizzet, Parun', 'Curiosity'], r: ['Infinite damage', 'Infinite draw'], id: '' },
    { c: ['Gravecrawler', 'Phyrexian Altar'], r: ['Infinite death triggers'], id: '' },
    { c: ['Squirrel Nest', 'Earthcraft'], r: ['Infinite Squirrel tokens'], id: '' },
    { c: ['Devoted Druid', 'Vizier of Remedies'], r: ['Infinite green mana'], id: '' },
    { c: ['Grand Architect', 'Pili-Pala'], r: ['Infinite mana of any color'], id: '' },
    { c: ['Food Chain', 'Eternal Scourge'], r: ['Infinite creature mana'], id: '' },
    { c: ['Aggravated Assault', 'Savage Ventmaw'], r: ['Infinite combat phases'], id: '' },
    { c: ['Painter\'s Servant', 'Grindstone'], r: ['Mill entire library'], id: '' },
    { c: ['Helm of Obedience', 'Rest in Peace'], r: ['Exile target library'], id: '' },
    { c: ['Mindcrank', 'Bloodchief Ascension'], r: ['Infinite mill', 'Infinite life loss'], id: '' },
    { c: ['Spike Feeder', 'Archangel of Thune'], r: ['Infinite life', 'Infinite +1/+1 counters'], id: '' },
    { c: ['Worldgorger Dragon', 'Animate Dead'], r: ['Infinite mana', 'Infinite ETB'], id: '' },
    { c: ['Dockside Extortionist', 'Temur Sabertooth'], r: ['Infinite mana', 'Infinite ETB'], id: '' },
  ];

  if (!currentDeck) return { found: [], nearMiss: [] };
  const deckCardNames = new Set<string>();
  for (const e of [...currentDeck.main, ...currentDeck.sideboard, ...currentDeck.commander]) {
    deckCardNames.add(e.name.toLowerCase());
  }

  const found: ComboMatch[] = [];
  const nearMiss: ComboMatch[] = [];
  for (const combo of FALLBACK) {
    const missing = combo.c.filter(c => !deckCardNames.has(c.toLowerCase()));
    if (missing.length === 0) found.push({ combo, missingCards: [] });
    else if (missing.length === 1) nearMiss.push({ combo, missingCards: missing });
  }
  return { found, nearMiss: nearMiss.slice(0, 8) };
}

// Active category filter
let activeComboFilter: string | null = null;
let lastComboResults: { found: ComboMatch[]; nearMiss: ComboMatch[] } | null = null;

function renderComboResults(results: { found: ComboMatch[]; nearMiss: ComboMatch[] }): HTMLElement {
  lastComboResults = results;
  const container = h('div', {});

  // --- Combo Density Score ---
  if (currentDeck) {
    const deckSize = currentDeck.main.reduce((a, e) => a + e.qty, 0);
    const comboCardCount = comboCardNames.size;
    const density = deckSize > 0 ? ((comboCardCount / deckSize) * 100) : 0;
    const densityLabel = density >= 15 ? 'High' : density >= 5 ? 'Medium' : density > 0 ? 'Low' : 'None';
    const densityColor = density >= 15 ? 'var(--banned)' : density >= 5 ? 'var(--gold)' : 'var(--text-dim)';

    container.appendChild(h('div', { className: 'combo-density-card' },
      h('div', { className: 'combo-density-score-wrap' },
        h('div', { className: 'combo-density-score', style: `color:${densityColor};` }, `${density.toFixed(0)}%`),
        h('div', { className: 'combo-density-caption' }, 'Combo Density'),
      ),
      h('div', { className: 'combo-density-text' },
        `${results.found.length} combo${results.found.length !== 1 ? 's' : ''} found using ${comboCardNames.size} unique cards. Density: ${densityLabel}.`
      ),
    ));
  }

  // --- Category filter buttons ---
  if (results.found.length > 2) {
    const allCats = new Set<string>();
    for (const m of results.found) {
      for (const cat of categorizeCombo(m.combo.r)) allCats.add(cat);
    }

    if (allCats.size > 1) {
      const filterRow = h('div', { className: 'combo-filter-row' });
      // "All" button
      const allBtn = h('button', {
        className: `combo-filter-btn ${!activeComboFilter ? 'active' : ''}`,
      }, 'All');
      allBtn.addEventListener('click', () => { activeComboFilter = null; reRenderCombos(); });
      filterRow.appendChild(allBtn);

      for (const cat of allCats) {
        const def = COMBO_CATEGORIES[cat] || { label: 'Other', icon: '🔮' };
        const isActive = activeComboFilter === cat;
        const btn = h('button', {
          className: `combo-filter-btn ${isActive ? 'active' : ''}`,
        }, `${def.icon} ${def.label}`);
        btn.addEventListener('click', () => { activeComboFilter = cat; reRenderCombos(); });
        filterRow.appendChild(btn);
      }
      container.appendChild(filterRow);
    }
  }

  // Filter combos by category
  let filteredFound = results.found;
  let filteredNearMiss = results.nearMiss;
  if (activeComboFilter) {
    filteredFound = results.found.filter(m => categorizeCombo(m.combo.r).includes(activeComboFilter!));
    filteredNearMiss = results.nearMiss.filter(m => categorizeCombo(m.combo.r).includes(activeComboFilter!));
  }

  // --- Found combos ---
  if (filteredFound.length > 0) {
    container.appendChild(
      h('div', { className: 'combo-section-title' },
        `♾️ ${filteredFound.length} Combo${filteredFound.length > 1 ? 's' : ''} in Your Deck`)
    );
    for (const match of filteredFound) {
      container.appendChild(renderComboItem(match, false));
    }
  }

  // --- Near-miss combos ---
  if (filteredNearMiss.length > 0) {
    container.appendChild(
      h('div', { className: 'combo-section-title muted' },
        `💡 ${filteredNearMiss.length} Near-Miss Combo${filteredNearMiss.length > 1 ? 's' : ''} (add 1 card)`)
    );
    for (const match of filteredNearMiss) {
      container.appendChild(renderComboItem(match, true));
    }
  }

  // --- No combos ---
  if (filteredFound.length === 0 && filteredNearMiss.length === 0) {
    container.appendChild(
      h('p', { className: 'tool-empty' },
        activeComboFilter ? 'No combos in this category.' : 'No known combos detected in this deck.')
    );
  }

  // --- Commander Spellbook link ---
  const csLink = h('div', { className: 'combo-footer' });
  const btn = h('button', {
    className: 'combo-open-btn',
  }, '🔍 Full Search on Commander Spellbook');
  btn.addEventListener('click', () => {
    if (currentDeck) {
      const lines: string[] = [];
      for (const e of currentDeck.commander) lines.push(`1 ${e.name}`);
      for (const e of currentDeck.main) lines.push(`${e.qty} ${e.name}`);
      navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
      showToast('Decklist copied! Paste it on Commander Spellbook.');
    }
    window.open('https://commanderspellbook.com/find-my-combos/', '_blank', 'noopener');
  });
  csLink.appendChild(btn);
  csLink.appendChild(
    h('p', { className: 'tool-note-small' },
      'Copies decklist & opens Commander Spellbook for 3+ card combo search.')
  );
  container.appendChild(csLink);

  // --- DB info ---
  container.appendChild(
    h('p', { className: 'combo-db-note' },
      `Database: ${comboDBCache ? comboDBCache.length.toLocaleString() : '25'} two-card combos from Commander Spellbook`)
  );

  return container;
}

function reRenderCombos(): void {
  if (!lastComboResults) return;
  const combosEl = $('combosList');
  if (combosEl) replaceChildren(combosEl, renderComboResults(lastComboResults));
  const combosContent = $('combosContent');
  if (combosContent) replaceChildren(combosContent, renderComboResults(lastComboResults));
}

function renderComboItem(match: ComboMatch, isNearMiss: boolean): HTMLElement {
  const { combo, missingCards } = match;
  const missingSet = new Set(missingCards.map(c => c.toLowerCase()));

  const item = h('div', { className: `combo-item ${isNearMiss ? 'near-miss' : ''}` });

  // Category badges + result line
  const cats = categorizeCombo(combo.r);
  const badgeRow = h('div', { className: 'combo-badge-row' });
  for (const cat of cats) {
    const def = COMBO_CATEGORIES[cat] || { icon: '🔮', label: 'Other' };
    badgeRow.appendChild(h('span', { className: 'combo-cat-icon', title: def.label }, def.icon));
  }
  badgeRow.appendChild(
    h('span', { className: 'combo-result combo-result-inline' }, combo.r.join(' + '))
  );
  item.appendChild(badgeRow);

  // Card chips
  const chipsRow = h('div', { className: 'combo-cards' });
  for (const name of combo.c) {
    const isMissing = missingSet.has(name.toLowerCase());
    const chip = h('span', {
      className: `combo-card-chip ${isMissing ? 'missing' : ''}`,
      title: isMissing ? `Not in your deck` : name,
    }, (isMissing ? '+ ' : '') + name);
    chipsRow.appendChild(chip);
  }
  item.appendChild(chipsRow);

  // "Add to Deck" button for near-miss
  if (isNearMiss && missingCards.length > 0) {
    const addBtn = h('button', {
      className: 'combo-add-btn',
    }, `➕ Add ${missingCards[0]} to deck`);
    addBtn.addEventListener('click', () => {
      if (!currentDeck) return;
      // Add missing card to main deck
      const existing = currentDeck.main.find(e => e.name.toLowerCase() === missingCards[0].toLowerCase());
      if (existing) {
        existing.qty += 1;
      } else {
        currentDeck.main.push({ name: missingCards[0], qty: 1 });
      }
      showToast(`Added ${missingCards[0]} to deck`);
      // Re-run combo detection
      loadAndDetectCombos();
    });
    item.appendChild(addBtn);
  }

  // Spellbook link (only if we have an ID)
  if (combo.id) {
    item.appendChild(h('a', {
      href: `https://commanderspellbook.com/combo/${combo.id}/`,
      target: '_blank',
      rel: 'noopener',
      className: 'combo-detail-link',
    }, '↗ Details'));
  }

  return item;
}

// ==================== COMBO CARD HIGHLIGHTING ====================

function highlightComboCards(): void {
  // Add ♾️ indicator to cards in the deck list that are part of combos
  const cardElements = document.querySelectorAll('[data-card-name]');
  for (const el of cardElements) {
    const name = (el as HTMLElement).dataset.cardName?.toLowerCase() || '';
    const existingBadge = el.querySelector('.combo-badge');
    if (comboCardNames.has(name) && !existingBadge) {
      const badge = h('span', {
        className: 'combo-badge',
        title: 'Part of a combo — check Combos tab',
      }, '♾️');
      el.appendChild(badge);
    } else if (!comboCardNames.has(name) && existingBadge) {
      existingBadge.remove();
    }
  }
}

// Export for use by other modules
export function isComboCard(cardName: string): boolean {
  return comboCardNames.has(cardName.toLowerCase());
}

// ==================== DECK COMPARISON (shared module) ====================

export function runDeckCompare(): void {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }

  // Try tool-panel textareas first (btnRunCompare2), then full panel (btnRunCompare)
  let textA = ($('compareDeck1') as HTMLTextAreaElement)?.value.trim() || '';
  let textB = ($('compareDeck2') as HTMLTextAreaElement)?.value.trim() || '';

  // Fallback: full compare panel
  if (!textA && !textB) {
    textA = ($('compareA') as HTMLTextAreaElement)?.value.trim() || '';
    textB = ($('compareB') as HTMLTextAreaElement)?.value.trim() || '';
  }

  // If A is empty, use current deck
  if (!textA && currentDeck) {
    const lines = currentDeck.main.map(e => `${e.qty} ${e.name}`);
    textA = lines.join('\n');
  }

  if (!textB) {
    showToast('Paste a deck to compare against');
    return;
  }

  const deckA = parseDecklist(textA || '');
  const deckB = parseDecklist(textB);

  const zonesA: CompDeckZones = {
    main: deckA.main.map(e => ({ name: e.name, qty: e.qty })),
    sideboard: deckA.sideboard.map(e => ({ name: e.name, qty: e.qty })),
    commander: deckA.commander.map(e => ({ name: e.name, qty: e.qty })),
  };
  const zonesB: CompDeckZones = {
    main: deckB.main.map(e => ({ name: e.name, qty: e.qty })),
    sideboard: deckB.sideboard.map(e => ({ name: e.name, qty: e.qty })),
    commander: deckB.commander.map(e => ({ name: e.name, qty: e.qty })),
  };

  const diff = compareDecksDiff(zonesA, zonesB);
  injectComparisonStyles();

  // Render in whichever results container is visible
  const resultsEl = $('compareResults2') || $('compareResults');
  if (resultsEl) {
    renderDeckComparison(resultsEl, diff, {
      deckNameA: currentDeckName || 'Deck A',
      deckNameB: 'Deck B',
      showUnchanged: true,
    });
  }
  showToast(createDiffSummary(diff));
}

// ==================== PRINT PROXY (shared module) ====================

export function openProxy(): void {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }

  const entries: ProxyCard[] = [];
  for (const entry of currentDeck.main) {
    const card = resolveCard(entry.name);
    entries.push({
      name: entry.name,
      qty: entry.qty,
      imageUrl: card?.image_uris?.normal || card?.card_faces?.[0]?.image_uris?.normal,
      type: card?.type_line,
    });
  }
  for (const entry of currentDeck.sideboard) {
    const card = resolveCard(entry.name);
    entries.push({
      name: entry.name,
      qty: entry.qty,
      imageUrl: card?.image_uris?.normal || card?.card_faces?.[0]?.image_uris?.normal,
      type: card?.type_line,
    });
  }

  if (entries.length === 0) {
    showToast('No cards to proxy');
    return;
  }

  const showNames = ($('proxyLabels') as HTMLInputElement)?.checked ?? false;
  const duplicates = ($('proxyDuplicates') as HTMLInputElement)?.checked ?? true;

  const expandedEntries = duplicates
    ? entries.flatMap(e => Array.from({ length: e.qty }, () => ({ ...e, qty: 1 })))
    : entries;

  const html = generatePrintHTML(expandedEntries, {
    title: currentDeckName || 'MTG Proxy Sheet',
    showNames,
    showCutGuides: true,
    showCount: true,
    quality: 'normal',
  });

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    showError('Popup blocked. Please allow popups for this site.');
    return;
  }
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.onload = () => {
    printWindow.focus();
    showToast('Proxy sheet ready! Press Ctrl+P to print.');
  };
}

export function closeProxy(): void {
  const overlay = $('proxyOverlay');
  if (overlay) overlay.classList.remove('active');
}

export function printProxy(): void {
  openProxy();
}

// ==================== SHARE URL ====================

const REPORT_RECOMMENDATION_COUNT = 3;

function summarizeReportRecommendationReason(reason: string): string {
  const compact = reason.replace(/\s+/g, ' ').trim();
  if (!compact) return 'Directional upgrade for this deck profile.';
  if (compact.length <= 180) return compact;
  return `${compact.slice(0, 177).trimEnd()}...`;
}

function scoreLabelFromTier(tier: PublicReportCardPayload['score']['tier']): string {
  if (tier === 'A') return 'Tournament-ready shell';
  if (tier === 'B') return 'Strong and cohesive';
  if (tier === 'C') return 'Playable with clear upgrades';
  if (tier === 'D') return 'Work in progress';
  return 'Needs foundational tuning';
}

function getReportRecommendations(deck: Deck): RecommendationItem[] {
  if (recommendationItemsCache.length > 0) {
    return recommendationItemsCache.slice(0, REPORT_RECOMMENDATION_COUNT);
  }

  const adapter = createPriceAdapter({
    resolveCard: (cardName) => resolveCard(cardName),
    source: 'scryfall.prices',
    asOf: lastPriceSyncAt,
    preferredCurrency: 'EUR',
    fallbackCurrency: 'USD',
    staleAfterMs: 1000 * 60 * 60 * 24 * 2,
  });

  return buildRecommendations({
    deckMain: deck.main.map((entry) => ({ name: entry.name, qty: entry.qty })),
    getCard: (cardName) => resolveCard(cardName),
    getPrice: (cardName) => adapter.getPrice(cardName),
    metaMode: recommendationMetaMode,
    maxRecommendations: REPORT_RECOMMENDATION_COUNT,
  }).slice(0, REPORT_RECOMMENDATION_COUNT);
}

function buildPublicReportCardPayload(deck: Deck): PublicReportCardPayload {
  const recommendationItems = getReportRecommendations(deck);
  const recommendationSummary = summarizeRecommendations(recommendationItems);
  const powerAnalysis = analyzeDeckPower(deck);
  const saltAnalysis = calculateSaltAnalysis(deck.main, (name) => resolveCard(name) ?? undefined);

  const confidenceScore = recommendationSummary.itemCount > 0
    ? recommendationSummary.averageConfidence
    : 0.55;
  const normalizedImpact = recommendationSummary.itemCount > 0
    ? Math.min(1, recommendationSummary.totalPowerImpact / (recommendationSummary.itemCount * 32))
    : 0.35;
  const normalizedSalt = Math.max(0, Math.min(1, 1 - (saltAnalysis.score / 10)));

  const compositeScore = Math.round(
    (powerAnalysis.score / 10) * 42
    + confidenceScore * 30
    + normalizedImpact * 18
    + normalizedSalt * 10,
  );
  const boundedScore = Math.max(0, Math.min(100, compositeScore));
  const scoreTier = gradePublicReportScore(boundedScore);

  const recommendations: PublicReportRecommendation[] = recommendationItems
    .slice(0, REPORT_RECOMMENDATION_COUNT)
    .map((item) => ({
      cardName: item.cardName,
      reason: summarizeReportRecommendationReason(item.reason),
      impact: item.powerImpactLabel,
    }));

  return {
    version: REPORT_CARD_SCHEMA_VERSION,
    deckName: (currentDeckName || 'Untitled Deck').trim().slice(0, 100),
    totalCards: deckTotalCards(deck),
    metaMode: recommendationMetaMode,
    generatedAt: new Date().toISOString(),
    score: {
      value: boundedScore,
      tier: scoreTier,
      label: scoreLabelFromTier(scoreTier),
    },
    recommendations,
  };
}

function activatePublicReportMode(): void {
  if (publicReportMode) return;
  publicReportMode = true;
  document.body.classList.add('public-report-mode');
  hide($('shareBar'));
  hide($('deckOverview'));
  hide($('toolbar'));
  hide($('analysisPanel'));
  hide($('exportPanel'));
}

function reportMetaModeLabel(mode: PublicReportCardPayload['metaMode']): string {
  return formatMetaModeLabel(normalizeMetaMode(mode));
}

function renderPublicReportCard(report: PublicReportCardPayload): void {
  const container = $('publicReportCard');
  if (!container) return;

  const generatedDate = new Date(report.generatedAt);
  const generatedLabel = Number.isNaN(generatedDate.getTime())
    ? 'Unknown'
    : generatedDate.toLocaleString();

  replaceChildren(
    container,
    h('section', { className: 'public-report-shell', 'aria-label': 'Public deck report card' },
      h('div', { className: 'public-report-header' },
        h('span', { className: 'public-report-kicker' }, 'Public Read-Only Report'),
        h('h2', { className: 'public-report-title' }, report.deckName),
        h('p', { className: 'public-report-subtitle' },
          `${report.totalCards} cards • Meta mode: ${reportMetaModeLabel(report.metaMode)} • Generated: ${generatedLabel}`,
        ),
      ),
      h('div', { className: 'public-report-grid' },
        h('article', { className: 'public-report-score-card' },
          h('span', { className: `public-report-tier tier-${report.score.tier.toLowerCase()}` }, `Tier ${report.score.tier}`),
          h('div', { className: 'public-report-score' }, `${report.score.value}`),
          h('div', { className: 'public-report-score-caption' }, '/ 100 Deck Score'),
          h('p', { className: 'public-report-score-label' }, report.score.label),
        ),
        h('article', { className: 'public-report-recs-card' },
          h('h3', { className: 'public-report-section-title' }, `Top ${report.recommendations.length} recommendations`),
          report.recommendations.length > 0
            ? h('ol', { className: 'public-report-rec-list' },
                ...report.recommendations.map((recommendation) =>
                  h('li', { className: 'public-report-rec-item' },
                    h('div', { className: 'public-report-rec-top' },
                      h('strong', { className: 'public-report-rec-name' }, recommendation.cardName),
                      h('span', { className: `public-report-impact impact-${recommendation.impact}` }, recommendation.impact),
                    ),
                    h('p', { className: 'public-report-rec-reason' }, recommendation.reason),
                  ),
                ),
              )
            : h('p', { className: 'tool-empty' }, 'No recommendations available for this report.'),
        ),
      ),
    ),
  );
  show(container);
}

function renderPublicReportError(message: string): void {
  const container = $('publicReportCard');
  if (!container) return;

  replaceChildren(
    container,
    h('section', { className: 'public-report-shell public-report-shell-error', 'aria-label': 'Public report error' },
      h('span', { className: 'public-report-kicker' }, 'Public Read-Only Report'),
      h('h2', { className: 'public-report-title' }, 'Could not load this report link'),
      h('p', { className: 'public-report-subtitle' }, message),
      h('p', { className: 'tool-note' }, 'Check the URL or ask the owner to create a new share link.'),
    ),
  );
  show(container);
}

async function handleSharedReportUrl(token: string): Promise<void> {
  activatePublicReportMode();

  try {
    const report = await fetchPublicReport(token);
    renderPublicReportCard(report);
    hideLoader();
    clearError();
    setImportFlowState('ready', 'analysis', 'Public report loaded. This view is read-only.');
  } catch (error) {
    hideLoader();
    const message = error instanceof Error ? error.message : 'Invalid public report link.';
    showError('Invalid public report link');
    renderPublicReportError(message);
    setImportFlowState('error', 'analysis', 'Invalid public report link.');
  }
}

export async function copyShareUrl(): Promise<void> {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }

  try {
    const reportPayload = buildPublicReportCardPayload(currentDeck);
    const response = await createPublicReportShare(reportPayload);
    const shareLink = buildPublicReportUrl(response.data.token, 'mtg');

    const shareUrl = $('shareUrl') as HTMLInputElement | null;
    if (shareUrl) {
      shareUrl.value = shareLink;
    }

    const shareBar = $('shareBar');
    if (shareBar) {
      const label = shareBar.querySelector('span');
      if (label) {
        label.textContent = 'Public report link';
      }
      show(shareBar);
    }

    navigator.clipboard.writeText(shareLink).then(() => {
      showToast('Share URL copied!');
      trackAnalyticsEvent('report_shared', {
        channel: 'clipboard',
        deck_name: currentDeckName,
        total_cards: currentDeck ? deckTotalCards(currentDeck) : 0,
        share_type: 'public_report',
      }, {
        dedupeKey: `report_shared:${response.data.token}`,
        dedupeWindowMs: 1000,
      });
    }).catch(() => {
      showToast('URL generated – copy from the share bar');
      trackAnalyticsEvent('report_shared', {
        channel: 'share_bar',
        deck_name: currentDeckName,
        total_cards: currentDeck ? deckTotalCards(currentDeck) : 0,
        share_type: 'public_report',
      }, {
        dedupeKey: `report_shared:${response.data.token}`,
        dedupeWindowMs: 1000,
      });
    });
  } catch (e) {
    showError(e instanceof Error ? e.message : 'Failed to generate share URL');
  }
}

// ==================== COLLECTION MANAGEMENT ====================

function getCollectionImportText(): string {
  return ($('collPasteArea') as HTMLTextAreaElement | null)?.value.trim()
    || ($('collInput') as HTMLTextAreaElement | null)?.value.trim()
    || '';
}

function mergeMappedCollectionItems(items: CollectionImportMappedItem[]): CollectionImportMappedItem[] {
  const merged = new Map<string, CollectionImportMappedItem>();

  for (const item of items) {
    const existing = merged.get(item.id);
    if (existing) {
      existing.qty += item.qty;
      existing.lines.push(...item.lines);
    } else {
      merged.set(item.id, {
        id: item.id,
        name: item.name,
        qty: item.qty,
        lines: [...item.lines],
      });
    }
  }

  return [...merged.values()];
}

async function importCollectionInternal(mode: 'replace' | 'merge'): Promise<void> {
  const startedAt = Date.now();
  const text = getCollectionImportText();
  if (!text) {
    showToast(mode === 'replace' ? 'Paste your collection first' : 'Paste cards to merge');
    return;
  }

  if (text.length > 500_000) {
    showError('Collection too large (max 500,000 characters)');
    return;
  }

  const parsed = parseCollectionCsv(text);
  const localCards = getCollectionCanonicalCardsFromCache();
  const firstPass = mapCollectionRowsToCanonical(parsed.rows, localCards);

  const unknownRows: CollectionImportParsedRow[] = firstPass.unresolved
    .filter((row) => row.reason === 'unknown_card')
    .map((row) => ({
      line: row.line,
      qty: row.qty > 0 ? row.qty : 1,
      name: row.normalizedName || row.rawName,
      values: row.values,
    }));

  let remapped: CollectionImportMappedItem[] = [];
  let unresolvedUnknown = firstPass.unresolved;

  if (unknownRows.length > 0) {
    const remoteCards = await resolveCollectionRowsFromScryfall(unknownRows);
    if (remoteCards.length > 0) {
      const secondPass = mapCollectionRowsToCanonical(unknownRows, remoteCards);
      remapped = secondPass.mapped;
      unresolvedUnknown = secondPass.unresolved;
    }
  }

  const finalMapped = mergeMappedCollectionItems([...firstPass.mapped, ...remapped]);
  const finalUnresolved = [...parsed.unresolved, ...unresolvedUnknown];
  const totalRows = parsed.rows.length + parsed.unresolved.length;
  const mappedRows = parsed.rows.length - unresolvedUnknown.length;
  const autoMapRate = totalRows === 0 ? 1 : mappedRows / totalRows;

  if (finalMapped.length === 0 && finalUnresolved.length > 0) {
    unresolvedCollectionRows = finalUnresolved;
    saveCollectionState();
    renderCollectionUnresolvedRows();
    showError('No rows could be mapped. Please correct unresolved rows and retry.');
    updateCollectionDisplay();
    return;
  }

  applyMappedCollectionItems(finalMapped, mode);
  unresolvedCollectionRows = finalUnresolved;
  saveCollectionState();
  updateCollectionDisplay();
  renderCollectionUnresolvedRows();

  const modeLabel = mode === 'replace' ? 'Imported' : 'Merged';
  const autoMapPct = Math.round(autoMapRate * 100);
  const unresolvedLabel = finalUnresolved.length > 0
    ? `, ${finalUnresolved.length} unresolved`
    : '';

  showToast(`${modeLabel} ${mappedRows}/${Math.max(totalRows, 1)} rows (${autoMapPct}% auto-mapped${unresolvedLabel})`);
  trackAnalyticsEvent('collection_imported', {
    mode,
    total_rows: totalRows,
    mapped_rows: mappedRows,
    unresolved_rows: finalUnresolved.length,
    auto_map_rate: Number(autoMapRate.toFixed(4)),
    unique_cards_after: Object.keys(userCollection).length,
    duration_ms: Date.now() - startedAt,
  }, {
    dedupeKey: `collection_imported:${mode}:${mappedRows}:${totalRows}:${finalUnresolved.length}`,
    dedupeWindowMs: 1200,
  });
}

export async function importCollection(): Promise<void> {
  await importCollectionInternal('replace');
}

export async function mergeCollection(): Promise<void> {
  await importCollectionInternal('merge');
}

export function clearCollection(): void {
  userCollection = {};
  userCollectionNames = {};
  unresolvedCollectionRows = [];
  saveCollectionState();
  showToast('Collection cleared');
  updateCollectionDisplay();
  renderCollectionUnresolvedRows();
}

export function exportCollection(): void {
  const lines = Object.entries(userCollection).map(([id, qty]) => {
    const name = userCollectionNames[id] || fallbackCollectionNameFromId(id);
    return `${qty} ${name}`;
  });
  if (lines.length === 0) {
    showToast('Collection is empty');
    return;
  }

  const output = $('exportOutput') as HTMLTextAreaElement | null;
  if (output) {
    output.value = lines.join('\n');
    showToast('Collection exported to export area');
  } else {
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      showToast('Collection copied to clipboard');
    });
  }
}

export function uploadCollectionFile(): void {
  const input = document.getElementById('collFileInput') as HTMLInputElement | null;
  input?.click();
}

export function handleCollectionFile(file: File): void {
  if (file.size > 2 * 1024 * 1024) {
    showError('File too large (max 2MB)');
    return;
  }
  file.text().then((text) => {
    const textarea = ($('collPasteArea') as HTMLTextAreaElement) || ($('collInput') as HTMLTextAreaElement);
    if (textarea) textarea.value = text;
    void importCollection();
  });
}

export async function resolveCollectionRow(indexRaw: string): Promise<void> {
  const index = Number.parseInt(indexRaw, 10);
  if (!Number.isInteger(index) || index < 0 || index >= unresolvedCollectionRows.length) return;

  const row = unresolvedCollectionRows[index];
  if (!row) return;

  const input = $(`collUnresolvedInput-${index}`) as HTMLInputElement | null;
  const qtyInput = $(`collUnresolvedQty-${index}`) as HTMLInputElement | null;
  const candidateName = normalizeCollectionCardName(input?.value || row.rawName || row.normalizedName);
  const qtyRaw = qtyInput?.value?.trim() || String(row.qty || 1);
  const parsedQty = Number.parseInt(qtyRaw, 10);
  const qty = Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 0;

  if (qty <= 0) {
    showError('Please enter a valid quantity (>= 1).');
    return;
  }

  if (!candidateName) {
    showError('Please provide a card name before resolving this row.');
    return;
  }

  const parsedRow: CollectionImportParsedRow = {
    line: row.line,
    qty,
    name: candidateName,
    values: row.values,
  };

  const localResult = mapCollectionRowsToCanonical([parsedRow], getCollectionCanonicalCardsFromCache());
  let mapped = localResult.mapped;

  if (mapped.length === 0) {
    const remoteCards = await resolveCollectionRowsFromScryfall([parsedRow]);
    if (remoteCards.length > 0) {
      mapped = mapCollectionRowsToCanonical([parsedRow], remoteCards).mapped;
    }
  }

  if (mapped.length === 0) {
    unresolvedCollectionRows[index] = {
      ...row,
      rawName: candidateName,
      normalizedName: normalizeCollectionCardName(candidateName),
      reason: 'unknown_card',
      message: `Could not map "${candidateName}" to a known card ID.`,
    };
    saveCollectionState();
    renderCollectionUnresolvedRows();
    showError(`Card not found: ${candidateName}`);
    return;
  }

  applyMappedCollectionItems(mapped, 'merge');
  unresolvedCollectionRows.splice(index, 1);
  saveCollectionState();
  updateCollectionDisplay();
  renderCollectionUnresolvedRows();
  showToast(`Resolved: ${mapped[0]?.name}`);
}

export function dismissCollectionRow(indexRaw: string): void {
  const index = Number.parseInt(indexRaw, 10);
  if (!Number.isInteger(index) || index < 0 || index >= unresolvedCollectionRows.length) return;

  unresolvedCollectionRows.splice(index, 1);
  saveCollectionState();
  renderCollectionUnresolvedRows();
  updateCollectionDisplay();
  showToast('Unresolved row dismissed');
}

function updateCollectionDisplay(): void {
  const count = Object.keys(userCollection).length;
  const total = Object.values(userCollection).reduce((a, b) => a + b, 0);
  const unresolvedCount = unresolvedCollectionRows.length;

  const statsEls = [
    $('collStats'), $('collStats2'),
  ];
  for (const el of statsEls) {
    if (el) {
      replaceChildren(el,
        h('div', { className: 'tool-result-list' },
          h('p', { className: 'tool-empty' },
            count > 0
              ? `Collection: ${count} unique cards, ${total} total`
              : 'No collection loaded'
          ),
          unresolvedCount > 0
            ? h('p', { className: 'tool-note' }, `${unresolvedCount} row(s) need manual correction.`)
            : null,
        ),
      );
    }
  }

  if (recommendationItemsCache.length > 0) {
    renderRecommendationPanels();
  }
}

// ==================== VERSION RENDERING ====================

export function renderVersionsList(): void {
  const container = $('versionsList2');
  if (!container) return;

  const versions = getVersions();
  if (versions.length === 0) {
    replaceChildren(container,
      h('p', { className: 'versions-empty' }, 'No saved versions yet.')
    );
    return;
  }

  const items = versions.map((v, i) => {
    const date = new Date(v.timestamp).toLocaleString();
    const cardCount = v.deck.main.reduce((a, e) => a + e.qty, 0);
    return h('div', { className: 'version-row' },
      h('div', {},
        h('strong', {}, escapeHtml(v.name)),
        h('span', { className: 'version-meta' }, `${cardCount} cards · ${date}`)
      ),
      h('div', { className: 'version-actions' },
        h('button', {
          className: 'hand-btn version-btn',
          'data-action': 'load-version',
          'data-idx': String(i),
        }, 'Load'),
        h('button', {
          className: 'hand-btn version-btn danger',
          'data-action': 'delete-version',
          'data-idx': String(i),
        }, '✕'),
      )
    );
  });

  replaceChildren(container, fragment(...items));
}

// ==================== MOXFIELD EXPORT ====================

export function exportMoxfield(): void {
  if (!currentDeck) {
    showToast('Load a deck first');
    return;
  }

  const text = serializeDeckForExport(currentDeck, {
    format: 'moxfield',
    deckName: currentDeckName,
  });
  currentExportFormat = 'moxfield';

  const output = $('exportOutput') as HTMLTextAreaElement | null;
  if (output) {
    output.value = text;
  }

  emitExportClickedEvent('moxfield', 'moxfield_button');

  navigator.clipboard.writeText(text).then(() => {
    showToast('Moxfield format copied! Paste in Moxfield → Import');
  }).catch(() => {
    showToast('Exported to textarea – copy from there');
  });
}

// ==================== INIT ====================
export function init(): void {
  debugLog('[MTG] App initialized');

  getOrCreateDeviceProfile();
  recommendationMetaMode = loadMetaModePreference();
  syncMetaModeSelectors();
  publicReportMode = false;
  document.body.classList.remove('public-report-mode');
  hide($('publicReportCard'));

  const params = new URLSearchParams(window.location.search);
  const reportParam = params.get('report');
  const deckParam = params.get('deck');

  loadCardCache();
  hideLoader();
  clearError();
  setRetryImportAction(null);
  updateImportFlowUI();

  if (reportParam) {
    setImportFlowState('loading', 'analysis', 'Loading public report...');
    showLoader('Loading public report...');
    void handleSharedReportUrl(reportParam);
    return;
  }

  loadCollectionState();
  updateCollectionDisplay();
  renderCollectionUnresolvedRows();
  renderBetaDashboardLoading('Open Beta Dashboard to load KPI funnel and feedback queue.');
  void refreshCommunityFeatures();
  startRealtimeMetaPolling();

  if (deckParam) {
    setImportFlowState('loading', 'import', 'Loading shared deck...');
    showLoader('Loading shared deck...');
    void handleSharedDeckUrl(deckParam);
    return;
  }

  setImportFlowState('empty', 'import', 'Start with Step 1: import a deck list or file.');
}

/**
 * Handle shared deck URL parameter.
 * 
 * SECURITY FLOW:
 * 1. Decode and validate share data (limits enforced)
 * 2. Convert to Deck format
 * 3. Process deck (re-fetches card data from API)
 * 4. Clear URL params (prevents sharing sensitive data in browser history)
 * 5. Show generic errors (no URL echo)
 */
async function handleSharedDeckUrl(encoded: string): Promise<void> {
  try {
    // Step 1: Decode and validate (enforces limits, schema version, structure)
    const decoded = decodeSharedDeck(encoded);
    
    // Step 2: Convert to Deck format
    const deck = sharedDeckToDeck(decoded);
    
    // Step 3: Set deck name (escaped for display in title)
    currentDeckName = decoded.deckName || 'Shared Deck';
    
    // Step 4: Process deck (fetches card data from Scryfall API)
    await processDeck(deck);
    emitDeckImportedEvent('shared_link', deck, {
      import_duration_ms: 0,
    });
    
    // Step 5: Clear URL params (keep clean URL in browser)
    history.replaceState(null, '', window.location.pathname);
    
    showToast('Shared deck loaded');
  } catch (e) {
    // SECURITY: Generic error messages, no URL/data echo
    if (e instanceof InvalidShareLinkError) {
      showError('Invalid share link');
      console.warn('[MTG] Share link validation failed:', e.message);
      setImportFlowState('error', 'import', 'Invalid share link. Import a deck to continue.');
    } else {
      showError('Failed to load shared deck');
      console.error('[MTG] Share deck error:', e);
      setImportFlowState('error', 'import', 'Failed to load shared deck. Import a deck to continue.');
    }

    hideLoader();
    
    // Clear URL params even on error
    history.replaceState(null, '', window.location.pathname);
  }
}

/**
 * Convert decoded shared deck to internal Deck format.
 */
function sharedDeckToDeck(decoded: DecodedSharedDeck): Deck {
  const convertEntries = (entries: Array<{ name: string; qty: number }>): DeckEntry[] => {
    return entries.map(e => ({
      name: e.name,
      qty: e.qty,
      set: null,
      num: null,
    }));
  };
  
  return {
    main: convertEntries(decoded.cardNames.main),
    sideboard: convertEntries(decoded.cardNames.sideboard),
    commander: convertEntries(decoded.cardNames.commander),
  };
}
