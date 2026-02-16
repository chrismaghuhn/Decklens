import { STORAGE_KEYS, storageGet, storageSet } from '../shared/storage.js';
import type { RecommendationLogicTag } from './recommendation-impact.js';
import type { RecommendationApplyMode } from './recommendation-apply.js';

const HISTORY_VERSION = 1;
const MAX_DECK_HISTORY = 40;
const MAX_ENTRIES_PER_DECK = 60;

export interface DeviceProfile {
  id: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface RecommendationHistoryEntry {
  cardName: string;
  applyCount: number;
  lastAppliedAt: number;
  lastRecommendationId: string;
  lastMode: RecommendationApplyMode;
  lastCutName: string | null;
  lastReason: string;
  lastPowerImpactLabel: string;
  logicTags: RecommendationLogicTag[];
}

export interface DeckRecommendationHistory {
  deckKey: string;
  deckName: string;
  commanderNames: string[];
  updatedAt: number;
  entries: RecommendationHistoryEntry[];
}

interface RecommendationHistoryState {
  version: number;
  profile: DeviceProfile;
  updatedAt: number;
  decks: DeckRecommendationHistory[];
}

export interface RecordRecommendationApplyHistoryInput {
  deckName: string;
  commanderNames: string[];
  recommendationId: string;
  cardName: string;
  mode: RecommendationApplyMode;
  cutName: string | null;
  reason: string;
  powerImpactLabel: string;
  logicTags: RecommendationLogicTag[];
  appliedAt?: number;
}

export interface RecordRecommendationUndoHistoryInput {
  deckName: string;
  commanderNames: string[];
  cardName: string;
}

let cachedProfile: DeviceProfile | null = null;
let cachedState: RecommendationHistoryState | null = null;

function createId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeCommanderNames(commanderNames: string[]): string[] {
  return [...new Set(
    commanderNames
      .map((name) => name.trim())
      .filter(Boolean),
  )].slice(0, 4);
}

function isRecommendationApplyMode(value: unknown): value is RecommendationApplyMode {
  return value === 'add' || value === 'swap';
}

function isRecommendationLogicTag(value: unknown): value is RecommendationLogicTag {
  return value === 'synergy'
    || value === 'curve-fix'
    || value === 'mana-fix'
    || value === 'meta-answer'
    || value === 'card-advantage'
    || value === 'protection'
    || value === 'board-control';
}

function cloneEntry(entry: RecommendationHistoryEntry): RecommendationHistoryEntry {
  return {
    ...entry,
    logicTags: [...entry.logicTags],
  };
}

function cloneDeckHistory(deck: DeckRecommendationHistory): DeckRecommendationHistory {
  return {
    ...deck,
    commanderNames: [...deck.commanderNames],
    entries: deck.entries.map(cloneEntry),
  };
}

function createDeviceProfile(now: number): DeviceProfile {
  return {
    id: createId('profile'),
    createdAt: now,
    lastSeenAt: now,
  };
}

function isDeviceProfile(value: unknown): value is DeviceProfile {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DeviceProfile>;
  return typeof candidate.id === 'string'
    && candidate.id.trim().length > 0
    && typeof candidate.createdAt === 'number'
    && Number.isFinite(candidate.createdAt)
    && typeof candidate.lastSeenAt === 'number'
    && Number.isFinite(candidate.lastSeenAt);
}

function sanitizeHistoryEntry(raw: unknown): RecommendationHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<RecommendationHistoryEntry>;
  const cardName = typeof candidate.cardName === 'string' ? candidate.cardName.trim() : '';
  const recommendationId = typeof candidate.lastRecommendationId === 'string'
    ? candidate.lastRecommendationId.trim()
    : '';
  const applyCount = typeof candidate.applyCount === 'number' && Number.isFinite(candidate.applyCount)
    ? Math.max(0, Math.trunc(candidate.applyCount))
    : 0;
  const lastAppliedAt = typeof candidate.lastAppliedAt === 'number' && Number.isFinite(candidate.lastAppliedAt)
    ? candidate.lastAppliedAt
    : 0;
  const lastMode = isRecommendationApplyMode(candidate.lastMode) ? candidate.lastMode : 'add';
  const lastCutName = typeof candidate.lastCutName === 'string'
    ? candidate.lastCutName.trim() || null
    : null;
  const lastReason = typeof candidate.lastReason === 'string' ? candidate.lastReason.trim() : '';
  const lastPowerImpactLabel = typeof candidate.lastPowerImpactLabel === 'string'
    ? candidate.lastPowerImpactLabel
    : 'low';
  const logicTags = Array.isArray(candidate.logicTags)
    ? candidate.logicTags.filter(isRecommendationLogicTag)
    : [];

  if (!cardName || !recommendationId || applyCount <= 0 || lastAppliedAt <= 0) return null;

  return {
    cardName,
    applyCount,
    lastAppliedAt,
    lastRecommendationId: recommendationId,
    lastMode,
    lastCutName,
    lastReason,
    lastPowerImpactLabel,
    logicTags,
  };
}

function sanitizeDeckHistory(raw: unknown): DeckRecommendationHistory | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<DeckRecommendationHistory>;
  const deckKey = typeof candidate.deckKey === 'string' ? candidate.deckKey.trim() : '';
  const deckName = typeof candidate.deckName === 'string' ? candidate.deckName.trim() : '';
  const commanderNames = Array.isArray(candidate.commanderNames)
    ? normalizeCommanderNames(candidate.commanderNames.filter((name): name is string => typeof name === 'string'))
    : [];
  const updatedAt = typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
    ? candidate.updatedAt
    : 0;
  const entries = Array.isArray(candidate.entries)
    ? candidate.entries
      .map((entry) => sanitizeHistoryEntry(entry))
      .filter((entry): entry is RecommendationHistoryEntry => Boolean(entry))
      .sort((a, b) => b.lastAppliedAt - a.lastAppliedAt)
      .slice(0, MAX_ENTRIES_PER_DECK)
    : [];

  if (!deckKey || !deckName || updatedAt <= 0 || entries.length === 0) return null;

  return {
    deckKey,
    deckName,
    commanderNames,
    updatedAt,
    entries,
  };
}

function createEmptyState(profile: DeviceProfile): RecommendationHistoryState {
  return {
    version: HISTORY_VERSION,
    profile,
    updatedAt: Date.now(),
    decks: [],
  };
}

function loadState(): RecommendationHistoryState {
  const profile = getOrCreateDeviceProfile();
  if (cachedState) {
    if (cachedState.profile.id !== profile.id) {
      cachedState.profile = { ...profile };
    }
    return cachedState;
  }

  const parsed = storageGet<unknown>(STORAGE_KEYS.MTG_RECOMMENDATION_HISTORY, null);
  if (!parsed || typeof parsed !== 'object') {
    const initial = createEmptyState(profile);
    cachedState = initial;
    return initial;
  }

  const candidate = parsed as Partial<RecommendationHistoryState>;
  const decks = Array.isArray(candidate.decks)
    ? candidate.decks
      .map((deck) => sanitizeDeckHistory(deck))
      .filter((deck): deck is DeckRecommendationHistory => Boolean(deck))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_DECK_HISTORY)
    : [];

  const state: RecommendationHistoryState = {
    version: HISTORY_VERSION,
    profile,
    updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : Date.now(),
    decks,
  };

  cachedState = state;
  return state;
}

function saveState(state: RecommendationHistoryState): void {
  cachedState = state;
  storageSet(STORAGE_KEYS.MTG_RECOMMENDATION_HISTORY, state);
}

export function buildDeckHistoryKey(deckName: string, commanderNames: string[]): string {
  const deckNameKey = normalizeName(deckName || 'Untitled Deck') || 'untitled deck';
  const commanderKey = normalizeCommanderNames(commanderNames)
    .map((name) => normalizeName(name))
    .filter(Boolean)
    .sort()
    .join('|') || 'no-commander';
  return `${deckNameKey}::${commanderKey}`;
}

export function getOrCreateDeviceProfile(): DeviceProfile {
  if (cachedProfile) return cachedProfile;

  const now = Date.now();
  const existing = storageGet<unknown>(STORAGE_KEYS.MTG_DEVICE_PROFILE, null);
  if (isDeviceProfile(existing)) {
    const profile: DeviceProfile = {
      ...existing,
      lastSeenAt: now,
    };
    cachedProfile = profile;
    storageSet(STORAGE_KEYS.MTG_DEVICE_PROFILE, profile);
    return profile;
  }

  const created = createDeviceProfile(now);
  cachedProfile = created;
  storageSet(STORAGE_KEYS.MTG_DEVICE_PROFILE, created);
  return created;
}

export function recordRecommendationApplyHistory(input: RecordRecommendationApplyHistoryInput): RecommendationHistoryEntry {
  const state = loadState();
  const appliedAt = input.appliedAt ?? Date.now();
  const deckKey = buildDeckHistoryKey(input.deckName, input.commanderNames);
  const normalizedCard = normalizeName(input.cardName);

  let deckHistory = state.decks.find((deck) => deck.deckKey === deckKey);
  if (!deckHistory) {
    deckHistory = {
      deckKey,
      deckName: input.deckName || 'Untitled Deck',
      commanderNames: normalizeCommanderNames(input.commanderNames),
      updatedAt: appliedAt,
      entries: [],
    };
    state.decks.unshift(deckHistory);
  }

  deckHistory.deckName = input.deckName || deckHistory.deckName;
  deckHistory.commanderNames = normalizeCommanderNames(input.commanderNames);
  deckHistory.updatedAt = appliedAt;

  let entry = deckHistory.entries.find((item) => normalizeName(item.cardName) === normalizedCard);
  if (!entry) {
    entry = {
      cardName: input.cardName,
      applyCount: 0,
      lastAppliedAt: appliedAt,
      lastRecommendationId: input.recommendationId,
      lastMode: input.mode,
      lastCutName: input.cutName,
      lastReason: input.reason,
      lastPowerImpactLabel: input.powerImpactLabel,
      logicTags: [...input.logicTags],
    };
    deckHistory.entries.push(entry);
  }

  entry.cardName = input.cardName;
  entry.applyCount += 1;
  entry.lastAppliedAt = appliedAt;
  entry.lastRecommendationId = input.recommendationId;
  entry.lastMode = input.mode;
  entry.lastCutName = input.cutName;
  entry.lastReason = input.reason;
  entry.lastPowerImpactLabel = input.powerImpactLabel;
  entry.logicTags = [...input.logicTags];

  deckHistory.entries.sort((a, b) => b.applyCount - a.applyCount || b.lastAppliedAt - a.lastAppliedAt);
  if (deckHistory.entries.length > MAX_ENTRIES_PER_DECK) {
    deckHistory.entries = deckHistory.entries.slice(0, MAX_ENTRIES_PER_DECK);
  }

  state.decks.sort((a, b) => b.updatedAt - a.updatedAt);
  if (state.decks.length > MAX_DECK_HISTORY) {
    state.decks = state.decks.slice(0, MAX_DECK_HISTORY);
  }

  state.updatedAt = appliedAt;
  saveState(state);

  return cloneEntry(entry);
}

export function recordRecommendationUndoHistory(input: RecordRecommendationUndoHistoryInput): void {
  const state = loadState();
  const deckKey = buildDeckHistoryKey(input.deckName, input.commanderNames);
  const deckHistory = state.decks.find((deck) => deck.deckKey === deckKey);
  if (!deckHistory) return;

  const normalizedCard = normalizeName(input.cardName);
  const entry = deckHistory.entries.find((item) => normalizeName(item.cardName) === normalizedCard);
  if (!entry) return;

  if (entry.applyCount <= 1) {
    deckHistory.entries = deckHistory.entries.filter((item) => normalizeName(item.cardName) !== normalizedCard);
  } else {
    entry.applyCount -= 1;
  }

  if (deckHistory.entries.length === 0) {
    state.decks = state.decks.filter((deck) => deck.deckKey !== deckKey);
  } else {
    deckHistory.updatedAt = Date.now();
    deckHistory.entries.sort((a, b) => b.applyCount - a.applyCount || b.lastAppliedAt - a.lastAppliedAt);
  }

  state.updatedAt = Date.now();
  saveState(state);
}

export function getDeckRecommendationHistory(deckName: string, commanderNames: string[]): DeckRecommendationHistory | null {
  const state = loadState();
  const deckKey = buildDeckHistoryKey(deckName, commanderNames);
  const deckHistory = state.decks.find((deck) => deck.deckKey === deckKey);
  return deckHistory ? cloneDeckHistory(deckHistory) : null;
}

export function resetRecommendationHistoryForTest(): void {
  cachedProfile = null;
  cachedState = null;
}
