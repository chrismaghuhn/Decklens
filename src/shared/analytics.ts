import { STORAGE_KEYS } from './storage.js';

export type AnalyticsEventName =
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
  | 'api_call_made'
  // Activation funnel events
  | 'wizard_opened'
  | 'wizard_step_reached'
  | 'wizard_completed'
  | 'funnel_step'
  | 'rec_interaction'
  | 'recommendation_distrusted'
  // Community events
  | 'community_page_viewed'
  | 'community_deck_shared'
  | 'community_deck_upvoted'
  | 'community_deck_flagged'
  | 'community_filter_changed'
  | 'community_search_performed'
  | 'community_moderation_action'
  // Monetization funnel events
  | 'upgrade_prompt_shown'
  | 'upgrade_prompt_clicked'
  | 'community_deck_published';

export interface AnalyticsEventPayload {
  name: AnalyticsEventName;
  eventId: string;
  occurredAt: string;
  app: string;
  page: string;
  userId: string;
  sessionId: string;
  properties: Record<string, unknown>;
}

export interface TrackEventOptions {
  dedupeKey?: string;
  dedupeWindowMs?: number;
}

interface AnalyticsClientOptions {
  endpoint: string;
  app: string;
  now: () => number;
  getPagePath: () => string;
  send: (endpoint: string, payload: AnalyticsEventPayload) => Promise<boolean>;
}

const DEFAULT_DEDUPE_MS = 1200;
const dedupeMap = new Map<string, number>();

let fallbackUserId: string | null = null;
let fallbackSessionId: string | null = null;

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

function readStorage(storage: Storage | null, key: string): string | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

function writeStorage(storage: Storage | null, key: string, value: string): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Ignore storage write failures.
  }
}

function getLocalStorage(): Storage | null {
  if (typeof localStorage === 'undefined') return null;
  return localStorage;
}

function getSessionStorage(): Storage | null {
  if (typeof sessionStorage === 'undefined') return null;
  return sessionStorage;
}

function getOrCreateUserId(): string {
  const storage = getLocalStorage();
  const existing = readStorage(storage, STORAGE_KEYS.ANALYTICS_USER_ID);
  if (existing) return existing;

  if (fallbackUserId) return fallbackUserId;
  const created = createId('u');
  fallbackUserId = created;
  writeStorage(storage, STORAGE_KEYS.ANALYTICS_USER_ID, created);
  return created;
}

function getOrCreateSessionId(): string {
  const storage = getSessionStorage();
  const existing = readStorage(storage, STORAGE_KEYS.ANALYTICS_SESSION_ID);
  if (existing) return existing;

  if (fallbackSessionId) return fallbackSessionId;
  const created = createId('s');
  fallbackSessionId = created;
  writeStorage(storage, STORAGE_KEYS.ANALYTICS_SESSION_ID, created);
  return created;
}

function shouldDedupe(dedupeKey: string | undefined, nowMs: number, windowMs: number): boolean {
  if (!dedupeKey) return false;
  const previous = dedupeMap.get(dedupeKey);
  if (previous !== undefined && (nowMs - previous) < windowMs) {
    return true;
  }
  dedupeMap.set(dedupeKey, nowMs);
  return false;
}

async function defaultSend(endpoint: string, payload: AnalyticsEventPayload): Promise<boolean> {
  const body = JSON.stringify(payload);

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([body], { type: 'application/json' });
      const accepted = navigator.sendBeacon(endpoint, blob);
      if (accepted) return true;
    }
  } catch {
    // Fall back to fetch.
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    });
    return response.ok;
  } catch {
    return false;
  }
}

function createClient(options: AnalyticsClientOptions): {
  track: (name: AnalyticsEventName, properties?: Record<string, unknown>, trackOptions?: TrackEventOptions) => Promise<boolean>;
} {
  const endpoint = options.endpoint;
  const app = options.app;

  return {
    async track(name, properties = {}, trackOptions = {}) {
      const nowMs = options.now();
      const dedupeWindowMs = trackOptions.dedupeWindowMs ?? DEFAULT_DEDUPE_MS;
      if (shouldDedupe(trackOptions.dedupeKey, nowMs, dedupeWindowMs)) {
        return false;
      }

      const payload: AnalyticsEventPayload = {
        name,
        eventId: createId('evt'),
        occurredAt: new Date(nowMs).toISOString(),
        app,
        page: options.getPagePath(),
        userId: getOrCreateUserId(),
        sessionId: getOrCreateSessionId(),
        properties,
      };

      return options.send(endpoint, payload);
    },
  };
}

const analyticsClient = createClient({
  endpoint: '/api/analytics/events',
  app: 'decklens',
  now: () => Date.now(),
  getPagePath: () => {
    if (typeof location === 'undefined') return '/';
    return location.pathname || '/';
  },
  send: defaultSend,
});

export function trackAnalyticsEvent(
  name: AnalyticsEventName,
  properties: Record<string, unknown> = {},
  options: TrackEventOptions = {},
): void {
  void analyticsClient.track(name, properties, options);
}

// Test-only utility: instantiate an isolated client with custom transport.
export function createAnalyticsClientForTest(options: {
  endpoint?: string;
  app?: string;
  now?: () => number;
  getPagePath?: () => string;
  send: (endpoint: string, payload: AnalyticsEventPayload) => Promise<boolean>;
}) {
  return createClient({
    endpoint: options.endpoint || '/api/analytics/events',
    app: options.app || 'decklens',
    now: options.now || (() => Date.now()),
    getPagePath: options.getPagePath || (() => '/'),
    send: options.send,
  });
}
