import {
  createCommunityDeck,
  createDeckbuilderShareSnapshot,
  fetchDeckbuilderAutocomplete,
  fetchRecommendations,
  fetchSpellbookCombos,
  resolveDeckbuilderCards,
  searchDeckbuilderCards,
  syncDeckToCloud,
  type CommunityDeckInput,
  type DeckbuilderSearchCard,
  type DeckbuilderShareDeckPayload,
  type SpellbookCombosResponse,
} from '../shared/api.js';
import type { Deck } from '../shared/types.js';
import { trackAnalyticsEvent } from '../shared/analytics.js';
import { trackPremiumFeatureUse } from './premium-usage.js';
import { evaluateEdhRules } from './edh-rules.js';
import {
  mergeBoards,
  parseDeckbuilderImportText,
  resolveParsedImportLines,
  toBoardsFromResolvedImport,
  type ImportResolvedLine,
} from './import-resolver.js';
import {
  buildCardmarketWantsListText,
  buildDeckCsvExport,
  buildTcgplayerMassEntryText,
  computeDeckPriceSummary,
  getTopExpensiveCards,
  buildCardmarketCardUrl,
  buildTcgplayerCardUrl,
  buildCardmarketDeckUrl,
  buildTcgplayerDeckUrl,
} from './pricing.js';
import { getStoredCurrencyPreference, setStoredCurrencyPreference, type PriceCurrency } from './geo-currency.js';
import { normalizeNameKey } from '../shared/utils.js';
import { createDeck, createEmptyDeck, getDeckById, listDecks, setLastOpenedDeckId, upsertDeck } from './storage.js';
import { compareDecksDiff, renderDeckComparison, type DeckZones } from '../shared/features/deck-comparison.js';
import { STORAGE_KEYS, storageGet, storageSet } from '../shared/storage.js';
import { renderCommanderStatsWidget } from './commander-stats-widget.js';
import type { DeckBoard, DeckFormat, DeckbuilderCardEntry, DeckbuilderDeck, DeckbuilderImportUnresolved, EdhRuleIssue } from './types.js';
import {
  getViewMode,
  setViewMode,
  getPileSortMode,
  setPileSortMode,
  getListSortMode,
  setListSortMode,
  getCardDensity,
  setCardDensity,
  loadViewModePreference,
  renderActiveView,
  renderFilterBadge,
  type ViewMode,
  type ListSortMode,
  type CardDensity,
  type ViewModeContext,
  type ChartFilter,
  invalidateViewMemo,
} from './view-modes.js';
import { initDragDrop, makeDropZone, makeSearchResultDraggable } from './drag-drop.js';
import { initCardPreview, showHoverPreview, showHoverPreviewByName, hideHoverPreview, showDetailModal } from './card-preview.js';
import { initContextMenu, showContextMenu } from './context-menu.js';
import { initUndoStack, pushSnapshot, undo, redo } from './undo-stack.js';
import { analyzeDeckDNA, calculateSaltAnalysis, type AnalyzerCardView } from '../mtg/engine/analyzers.js';
import { initHandTester, closeHandTester } from './hand-tester.js';
import { loadCollection, isOwned, toggleOwned } from './collection.js';
import { downloadDeckImage } from './deck-image.js';
import { renderHealthScore, calculateDeckHealth } from './health-score.js';
import { renderDeckFingerprint } from './deck-fingerprint.js';
import { generatePrintHTML } from '../shared/features/print-proxy.js';
import { renderMatchupPanel, invalidateMatchupCache } from './matchup-panel.js';
import { renderManaCalc, analyzeManaBase } from './mana-calc.js';
import { renderSynergyMap } from './synergy-map.js';
import { renderSmartRecs as renderSmartRecsView } from './smart-recs.js';
import { calculateBracket, renderBracketResult } from './bracket-calc.js';
import { loadMetaData, getMetaBadge, isMetaLoaded } from './meta-badges.js';
import { renderBudgetOptimizer } from './budget-optimizer.js';
import { renderBudgetAlternatives } from './budget-alternatives.js';
import { renderCollectionPanel } from './collection-panel.js';
import { renderDeckHistory, autoSnapshotIfNeeded, createSnapshot } from './deck-diff.js';
import { renderVersionPanel } from './version-panel.js';
import { hasSyntaxPrefixes, parseSearchSyntax } from './search-syntax.js';
import { attachCardAutocomplete, type CardAutocompleteController } from './card-autocomplete.js';
import { openGoldfishPlaytest } from './goldfish.js';
import { showMultiplayerLaunchModal } from './goldfish-mp-launch.js';
import { initToastContainer, showToast, showBatchableToast } from './toast.js';
import { showPromptModal, showConfirmModal } from './confirm-modal.js';
import { shouldShowOnboarding, startOnboarding } from './onboarding.js';
import { getAutoTagForEntry, categorizeCard } from './auto-categories.js';
import { getFormatRules } from './live-validation.js';
import { renderEdhrecPanel, invalidateEdhrecCache } from './edhrec-panel.js';
import { renderMarkdown } from './markdown-lite.js';
import { getTemplateByKey } from './primer-templates.js';
import { initShortcutHelp } from './shortcut-help.js';
import { renderDrawProbability } from './draw-probability.js';
import { detectDeckArchetype, type ArchetypeDetectionResult } from '../mtg/engine/archetype-detector.js';
import { getArchetypeById } from '../mtg/engine/archetype-catalog.js';
import type { MatchupMetaMode } from '../mtg/engine/matchup-guide.js';
import type { MetaMode } from '../mtg/engine/recommendation-v1.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';
import {
  initCollabUI,
  checkCollabUrlParam,
  startCollabSession,
  joinCollabSession,
  isCollabActive,
  isCurrentUserViewer,
} from './collab-ui.js';
import { initCollabCursors } from './collab-cursors.js';
import { initCollabDrawing } from './collab-drawing.js';
import { initCollabChat } from './collab-chat.js';
import { initCollabPing, sendCardPing, initCollabVoting, setVoteRenderCallback, createVoteWidget } from './collab-tools.js';
import { sendPresenceUpdate } from './collab-presence.js';
import { isCardLocked, requestLockFromHolder } from './collab-locking.js';
import { openOptimizationWizard, closeOptimizationWizard } from './optimization-wizard.js';
import { trackFunnelStep, trackWizardOpen, trackRecApplied, resetFunnel } from './activation-funnel.js';
import { recordRecommendationApplyHistory } from '../mtg/recommendation-history.js';
import { categoryToLogicTags } from './smart-recs.js';
import { renderRecHistoryPanel } from './rec-history-panel.js';
import type { RecommendationV1Item } from '../mtg/engine/recommendation-v1.js';
import { initPanelLayout, refreshAllWidgets, autoFitCardsWidget } from './panel-layout.js';
import { initRepoPanel, onRepoTabActive } from './repo-panel.js';
import { initCommandPalette } from './cmd-palette.js';
import { renderMatchupStrategyWidget } from './matchup-strategy-widget.js';
import { renderDeckSolverWidget } from './deck-solver-widget.js';
import { renderCutSuggestionsWidget } from './cut-suggestions-widget.js';
import { renderSimulationWidget } from './simulation-widget.js';
import { svgMarkup } from './line-icons.js';

const BOARD_ORDER: DeckBoard[] = ['commander', 'mainboard', 'maybeboard', 'sideboard'];
const BOARD_LABEL: Record<DeckBoard, string> = {
  commander: 'Commander',
  mainboard: 'Mainboard',
  maybeboard: 'Maybeboard',
  sideboard: 'Sideboard',
};

import {
  diagnoseDeck,
  renderDoctorModal
} from './deck-doctor.js';

// ... existing imports ...

// Helper for Doctor Fixes
function setSearchQuery(query: string): void {
  const input = document.getElementById('searchInput') as HTMLInputElement;
  if (!input) return;
  input.value = query;
  // Direct search execution to avoid autocomplete errors on syntax queries
  void runSearch(query);
  input.focus();
}

let currentDeck: DeckbuilderDeck | null = null;
let activeBoard: DeckBoard = 'mainboard';
let searchDebounce: ReturnType<typeof setTimeout> | null = null;
let selectedSearchIndex = -1;

/** Flag to prevent echo loops: when true, mutations came from a remote collaborator and should NOT be re-broadcast. */
let isRemoteUpdate = false;
let searchResults: DeckbuilderSearchCard[] = [];
let allSearchResults: DeckbuilderSearchCard[] = []; // Full results from API
let displayedSearchCount = 25; // How many to show initially
let unresolvedImportRows: DeckbuilderImportUnresolved[] = [];
let resolvedCardByName: Record<string, DeckbuilderSearchCard | undefined> = {};
let resolveInFlight = false;
let spellbookCombos: SpellbookCombosResponse | null = null;
let spellbookInFlight = false;
let spellbookError: string | null = null;
let spellbookLastHash: string | null = null;
let sidebarOpen = false;
let activeChartFilter: ChartFilter = null;
let lastSnapshotCardCount = 0;
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let autoFitDebounce: ReturnType<typeof setTimeout> | null = null;
let saveIndicatorEl: HTMLElement | null = null;
let searchAbortController: AbortController | null = null;
let searchAutocomplete: CardAutocompleteController | null = null;
let deferredRenderTimer: ReturnType<typeof setTimeout> | null = null;
let deckFilterText = '';
let cloudSyncTimer: ReturnType<typeof setTimeout> | null = null;

// ==================== Layout Mode ====================
type LayoutMode = 'classic' | 'grid';
let currentLayoutMode: LayoutMode = 'classic';

function getLayoutMode(): LayoutMode {
  return storageGet<LayoutMode>(STORAGE_KEYS.DECKBUILDER_LAYOUT_MODE, 'classic');
}

function setLayoutMode(mode: LayoutMode): void {
  currentLayoutMode = mode;
  storageSet(STORAGE_KEYS.DECKBUILDER_LAYOUT_MODE, mode);
  applyLayoutMode(mode, true); // true = animate transition
  renderLayoutToggle();
}

function applyLayoutMode(mode: LayoutMode, animate = false): void {
  const editorMain = document.querySelector<HTMLElement>('.editor-main');
  const editorLeft = document.querySelector<HTMLElement>('.editor-left');
  const editorRight = document.querySelector<HTMLElement>('.editor-right');

  if (!editorMain) return;

  if (animate) {
    editorMain.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
    if (editorRight) editorRight.style.transition = 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
  }

  if (mode === 'grid') {
    // Show grid, hide classic sidebar
    editorMain.classList.add('layout-active');
    if (editorLeft) editorLeft.style.display = 'none';
    if (editorRight) editorRight.style.display = 'none';

    // Init grid system if not already initialized
    if (typeof initPanelLayout === 'function') {
      initPanelLayout();
    }

    // Show grid widgets
    const widgets = document.querySelectorAll('.layout-widget');
    widgets.forEach(w => (w as HTMLElement).style.display = '');

    // Refresh all widget contents with latest data
    setTimeout(() => {
      if (typeof refreshAllWidgets === 'function') {
        refreshAllWidgets();
      }
      // Auto-fit is now safe - flickering fixed via differential rendering
      if (typeof autoFitCardsWidget === 'function') {
        autoFitCardsWidget();
      }
    }, 100);
  } else {
    // Show classic, hide grid
    editorMain.classList.remove('layout-active');
    if (editorLeft) editorLeft.style.display = '';
    if (editorRight) editorRight.style.display = '';

    // Hide grid widgets
    const widgets = document.querySelectorAll('.layout-widget');
    widgets.forEach(w => (w as HTMLElement).style.display = 'none');
  }

  // Clear transitions after animation completes
  setTimeout(() => {
    editorMain.style.transition = '';
    if (editorRight) editorRight.style.transition = '';
  }, 400);
}

function renderLayoutToggle(): void {
  const classicBtn = document.querySelector('[data-mode="classic"]');
  const gridBtn = document.querySelector('[data-mode="grid"]');

  if (classicBtn && gridBtn) {
    classicBtn.classList.toggle('active', currentLayoutMode === 'classic');
    gridBtn.classList.toggle('active', currentLayoutMode === 'grid');
  }
}

function initLayoutMode(): void {
  // Load saved preference
  currentLayoutMode = getLayoutMode();

  // Apply layout mode (without animation on initial load)
  applyLayoutMode(currentLayoutMode, false);

  // Render toggle buttons
  renderLayoutToggle();

  // Show onboarding if first time
  showLayoutModeOnboarding();
}

function showLayoutModeOnboarding(): void {
  // Always treat as object, never boolean
  const stored = storageGet(STORAGE_KEYS.DECKBUILDER_ONBOARDING, {});
  const hasSeenOnboarding = typeof stored === 'object' && stored !== null ? stored : {};

  if (!hasSeenOnboarding.layoutMode) {
    showToast({
      message: 'New: Switch between Classic and Grid layouts using the toggle in the header!',
      type: 'info',
      duration: 8000,
    });

    // Safely update onboarding state
    const current = typeof stored === 'object' && stored !== null ? {...stored} : {};
    current.layoutMode = true;
    storageSet(STORAGE_KEYS.DECKBUILDER_ONBOARDING, current);
  }

  // Show preset picker on first grid mode activation
  if (currentLayoutMode === 'grid' && !hasSeenOnboarding.gridPreset) {
    setTimeout(() => showPresetPicker(), 500);
  }
}

function showPresetPicker(): void {
  const modal = document.getElementById('presetPickerModal');
  if (!modal) return;

  // Import presets dynamically
  import('./panel-layout.js').then(({ LAYOUT_PRESETS, applyPreset }) => {
    const grid = document.getElementById('presetGrid');
    if (!grid) return;

    // Clear existing content
    grid.innerHTML = '';

    // Render preset cards
    for (const preset of LAYOUT_PRESETS) {
      const card = document.createElement('button');
      card.className = 'preset-card';
      card.innerHTML = `
        <div class="preset-icon">${svgMarkup(preset.id)}</div>
        <div class="preset-name">${preset.name}</div>
        <div class="preset-desc">${preset.description}</div>
      `;
      card.onclick = () => {
        applyPreset(preset.id);
        closePresetPicker();
        showToast({
          message: `Applied "${preset.name}" layout`,
          type: 'success',
          duration: 3000,
        });
      };
      grid.appendChild(card);
    }

    // Show modal
    modal.style.display = 'flex';

    // Setup close handlers
    const closeBtn = document.getElementById('btnClosePresetPicker');
    const cancelBtn = document.getElementById('btnCancelPreset');
    const overlay = modal.querySelector('.preset-modal-overlay');

    const closeHandler = () => closePresetPicker();
    closeBtn?.addEventListener('click', closeHandler);
    cancelBtn?.addEventListener('click', closeHandler);
    overlay?.addEventListener('click', closeHandler);

    // Mark as seen
    const current = storageGet<Record<string, boolean>>(STORAGE_KEYS.DECKBUILDER_ONBOARDING, {});
    current.gridPreset = true;
    storageSet(STORAGE_KEYS.DECKBUILDER_ONBOARDING, current);
  }).catch(err => {
    console.error('[Deckbuilder] Failed to load presets:', err);
  });
}

function closePresetPicker(): void {
  const modal = document.getElementById('presetPickerModal');
  if (modal) modal.style.display = 'none';
}

// ==================== Cloud Sync ====================

function getDeviceFingerprint(): string {
  let fp = storageGet<string>(STORAGE_KEYS.DECKBUILDER_DEVICE_FP, '');
  if (!fp) {
    fp = `fp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    storageSet(STORAGE_KEYS.DECKBUILDER_DEVICE_FP, fp);
  }
  return fp;
}

function isCloudSyncEnabled(): boolean {
  return storageGet<boolean>(STORAGE_KEYS.DECKBUILDER_CLOUD_SYNC, false);
}

function setCloudSyncEnabled(enabled: boolean): void {
  storageSet(STORAGE_KEYS.DECKBUILDER_CLOUD_SYNC, enabled);
}

function scheduleDebouncedCloudSync(): void {
  if (!isCloudSyncEnabled() || !currentDeck) return;
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null;
    void performCloudSync();
  }, 3000); // 3s debounce
}

async function performCloudSync(): Promise<void> {
  if (!currentDeck || !isCloudSyncEnabled()) return;
  updateSaveIndicator('saving');
  try {
    await syncDeckToCloud(currentDeck, getDeviceFingerprint());
    updateSaveIndicator('saved');
  } catch (err) {
    console.warn('[cloud-sync] Failed:', err);
    updateSaveIndicator('saved'); // Still saved locally
  }
}

// ==================== Analytics Memoization ====================
let analyticsCache: {
  hash: string;
  data: ReturnType<typeof computeAnalyticsData>;
} | null = null;

let powerLevelCache: {
  hash: string;
  data: ReturnType<typeof estimatePowerLevel>;
} | null = null;

function deckContentHash(deck: DeckbuilderDeck): string {
  // Fast hash based on card names + quantities + resolved card data count
  const parts: string[] = [];
  let resolvedCount = 0;
  for (const board of [deck.boards.commander, deck.boards.mainboard, deck.boards.sideboard]) {
    for (const e of board) {
      parts.push(`${e.name}:${e.qty}`);
      if (resolvedCardByName[normalizeNameKey(e.name)]) {
        resolvedCount++;
      }
    }
  }
  parts.push(`resolved:${resolvedCount}`);
  return parts.join('|');
}

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDeckIdFromPath(): string | null {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts.length >= 3 && parts[0] === 'decks' && parts[1] === 'id') {
    return decodeURIComponent(parts[2]);
  }
  if (parts.length >= 2 && parts[0] === 'decks') {
    const second = parts[1] || '';
    if (second && second !== 'public') return decodeURIComponent(second);
  }

  const fallback = new URLSearchParams(window.location.search).get('id');
  return fallback && fallback.trim() ? fallback.trim() : null;
}

function showStatus(message: string, mode: 'muted' | 'danger' = 'muted'): void {
  const el = byId<HTMLDivElement>('editorStatus');
  el.textContent = message;
  el.className = `header-status ${mode}`;
}

function saveCurrentDeck(): void {
  if (!currentDeck) return;
  currentDeck.updatedAt = new Date().toISOString();

  try {
    upsertDeck(currentDeck);
    updateSaveIndicator('saved');
    lastSaveError = null;
    scheduleDebouncedCloudSync();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[Deckbuilder] Failed to save deck:', err);
    lastSaveError = errorMsg;
    updateSaveIndicator('error');
    showToast('Failed to save deck: ' + errorMsg, 'error', 5000);
  }
}

type SaveState = 'saved' | 'saving' | 'unsaved' | 'error';
let lastSaveError: string | null = null;

function initSaveIndicator(): void {
  const dot = document.createElement('span');
  dot.className = 'save-indicator__dot';
  const text = document.createElement('span');
  text.className = 'save-indicator__text';
  text.textContent = 'Saved';
  saveIndicatorEl = document.createElement('div');
  saveIndicatorEl.className = 'save-indicator save-indicator--saved';
  saveIndicatorEl.appendChild(dot);
  saveIndicatorEl.appendChild(text);
  // Append save indicator to the header row (parent of deckNameInput)
  const headerRow = byId<HTMLInputElement>('deckNameInput').closest('.editor-header');
  if (headerRow) headerRow.appendChild(saveIndicatorEl);
}

function updateSaveIndicator(state: SaveState): void {
  if (!saveIndicatorEl) return;
  saveIndicatorEl.className = `save-indicator save-indicator--${state}`;
  const textEl = saveIndicatorEl.querySelector('.save-indicator__text');
  if (textEl) {
    const labels: Record<SaveState, string> = {
      saved: 'Saved',
      saving: 'Saving...',
      unsaved: 'Unsaved changes',
      error: 'Save failed'
    };
    textEl.textContent = labels[state];
  }

  // Set tooltip for error state
  if (state === 'error' && lastSaveError) {
    saveIndicatorEl.title = lastSaveError;
  } else {
    saveIndicatorEl.title = '';
  }
}

function scheduleAutosave(): void {
  updateSaveIndicator('unsaved');
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    updateSaveIndicator('saving');
    saveCurrentDeck();
  }, 2000);
}

function totalCards(entries: DeckbuilderCardEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.qty, 0);
}

function allDeckNames(deck: DeckbuilderDeck): string[] {
  return [
    ...deck.boards.commander.map((entry) => entry.name),
    ...deck.boards.mainboard.map((entry) => entry.name),
    ...deck.boards.sideboard.map((entry) => entry.name),
    ...deck.boards.maybeboard.map((entry) => entry.name),
  ];
}

/** Get the currently active board (exported for drawing scoping) */
export function getActiveBoard(): DeckBoard {
  return activeBoard;
}

function setActiveBoard(board: DeckBoard): void {
  activeBoard = board;
  for (const key of BOARD_ORDER) {
    const btn = byId<HTMLButtonElement>(`boardBtn-${key}`);
    btn.classList.toggle('active', key === board);
    btn.setAttribute('aria-selected', String(key === board));
  }
  // F2: Persist preferred board per deck
  if (currentDeck) {
    try {
      localStorage.setItem(`dl_board_${currentDeck.id}`, board);
    } catch (err) {
      console.error('[Deckbuilder] Failed to persist board preference:', err);
      showToast('Warning: Board preference not saved', 'warning', 3000);
    }
  }
  // Send presence update when switching boards (Phase 3)
  if (isCollabActive()) {
    sendPresenceUpdate(board);
  }
  // Notify drawing module of board change
  window.dispatchEvent(new CustomEvent('deckbuilder-board-changed', { detail: { board } }));
  scheduleRenderBoardRows();
}

function findEntry(board: DeckBoard, cardName: string): DeckbuilderCardEntry | null {
  if (!currentDeck) return null;
  const key = normalizeNameKey(cardName);
  return currentDeck.boards[board].find((entry) => normalizeNameKey(entry.name) === key) || null;
}

function upsertEntry(board: DeckBoard, cardName: string, qtyDelta: number, cardMeta?: DeckbuilderSearchCard): void {
  if (!currentDeck) return;
  // Lock check (Phase 3) — skip for remote updates
  if (!isRemoteUpdate && isCollabActive()) {
    const lockInfo = isCardLocked(board, cardName);
    if (lockInfo.locked) {
      // D2: Actionable lock contention toast with "Request Lock"
      showToast({
 message: `◆ Locked by ${lockInfo.by}`,
        type: 'error',
        duration: 8000,
        action: {
          label: 'Request Lock',
          onClick: () => {
            const sent = requestLockFromHolder(board, cardName);
            showToast({ message: sent ? 'Lock request sent.' : 'Please wait before requesting again.', type: sent ? 'info' : 'warning' });
          },
        },
      });
      return;
    }
  }
  const key = normalizeNameKey(cardName);
  const list = currentDeck.boards[board];
  const existing = list.find((entry) => normalizeNameKey(entry.name) === key);
  if (existing) {
    existing.qty = Math.max(1, Math.min(99, existing.qty + qtyDelta));
    // Broadcast to collab session (update existing card)
    if (!isRemoteUpdate && isCollabActive()) {
      const idx = list.indexOf(existing);
      getCollabManager().sendCardUpdate(board, idx, existing);
    }
  } else {
    const newEntry: DeckbuilderCardEntry = {
      name: cardMeta?.name || cardName,
      qty: Math.max(1, Math.min(99, qtyDelta)),
      set: cardMeta?.set || null,
      collectorNumber: cardMeta?.collector_number || null,
      tags: [],
      addedAt: Date.now(), // Timestamp for "recently added" highlight
    };
    list.push(newEntry);
    list.sort((a, b) => a.name.localeCompare(b.name));
    // Broadcast to collab session (add new card)
    if (!isRemoteUpdate && isCollabActive()) {
      getCollabManager().sendCardAdd(board, newEntry);
    }
  }
}

function removeEntry(board: DeckBoard, cardName: string): void {
  if (!currentDeck) return;
  // Lock check (Phase 3) — skip for remote updates
  if (!isRemoteUpdate && isCollabActive()) {
    const lockInfo = isCardLocked(board, cardName);
    if (lockInfo.locked) {
      // D2: Actionable lock contention toast
      showToast({
 message: `◆ Locked by ${lockInfo.by}`,
        type: 'error',
        duration: 8000,
        action: {
          label: 'Request Lock',
          onClick: () => {
            const sent = requestLockFromHolder(board, cardName);
            showToast({ message: sent ? 'Lock request sent.' : 'Please wait before requesting again.', type: sent ? 'info' : 'warning' });
          },
        },
      });
      return;
    }
  }
  const key = normalizeNameKey(cardName);
  // Find index before removing — needed for collab broadcast
  const idx = currentDeck.boards[board].findIndex((entry) => normalizeNameKey(entry.name) === key);
  currentDeck.boards[board] = currentDeck.boards[board].filter((entry) => normalizeNameKey(entry.name) !== key);
  // Broadcast to collab session
  if (!isRemoteUpdate && isCollabActive() && idx >= 0) {
    getCollabManager().sendCardRemove(board, idx);
  }
}

function moveEntry(fromBoard: DeckBoard, toBoard: DeckBoard, cardName: string): void {
  if (!currentDeck || fromBoard === toBoard) return;
  // Lock check (Phase 3) — skip for remote updates
  if (!isRemoteUpdate && isCollabActive()) {
    const lockInfo = isCardLocked(fromBoard, cardName);
    if (lockInfo.locked) {
      // D2: Actionable lock contention toast
      showToast({
 message: `◆ Locked by ${lockInfo.by}`,
        type: 'error',
        duration: 8000,
        action: {
          label: 'Request Lock',
          onClick: () => {
            const sent = requestLockFromHolder(fromBoard, cardName);
            showToast({ message: sent ? 'Lock request sent.' : 'Please wait before requesting again.', type: sent ? 'info' : 'warning' });
          },
        },
      });
      return;
    }
  }
  const key = normalizeNameKey(cardName);
  const source = currentDeck.boards[fromBoard];
  const entry = source.find((item) => normalizeNameKey(item.name) === key);
  if (!entry) return;
  removeEntry(fromBoard, cardName);
  upsertEntry(toBoard, entry.name, entry.qty, resolvedCardByName[key]);
}

/**
 * A4: Smart Commander Detection — after import, if no commander is set,
 * identify legendary creatures in mainboard and prompt user to promote one.
 */
function detectAndPromoteCommander(
  deck: DeckbuilderDeck,
  cardMap: Record<string, DeckbuilderSearchCard | undefined>,
): void {
  // Gather all legendary creatures with qty 1 in mainboard
  const candidates: { name: string; card: DeckbuilderSearchCard }[] = [];
  for (const entry of deck.boards.mainboard) {
    const key = normalizeNameKey(entry.name);
    const card = cardMap[key];
    if (!card) continue;
    // Check type_line on main card and card_faces
    const isLegendaryCreature =
      card.type_line?.toLowerCase().includes('legendary creature') ||
      card.card_faces?.some((f) => f.type_line?.toLowerCase().includes('legendary creature'));
    if (isLegendaryCreature && entry.qty === 1) {
      candidates.push({ name: entry.name, card });
    }
  }

  if (candidates.length === 0) return;

  // If exactly 1 candidate, show a simple toast prompt
  if (candidates.length === 1) {
    const candidate = candidates[0];
    showToast({
      message: `Is "${candidate.name}" your commander?`,
      type: 'info',
      duration: 12000,
      action: {
        label: 'Yes, set as Commander',
        onClick: () => {
          moveEntry('mainboard', 'commander', candidate.name);
          saveAndRender();
          showToast({ message: `${candidate.name} set as commander.`, type: 'success' });
        },
      },
    });
    return;
  }

  // Multiple candidates — show confirm modal for the top one (by EDHREC rank or first found)
  // Sort by edhrec_rank (lower = more popular), fallback to original order
  candidates.sort((a, b) => (a.card.edhrec_rank ?? 99999) - (b.card.edhrec_rank ?? 99999));
  const top = candidates[0];

  // Show toast for top candidate, with option to pick another
  showToast({
    message: `Commander detected: "${top.name}". Set as commander?`,
    type: 'info',
    duration: 15000,
    action: {
      label: 'Yes',
      onClick: () => {
        moveEntry('mainboard', 'commander', top.name);
        saveAndRender();
        showToast({ message: `${top.name} set as commander.`, type: 'success' });
      },
    },
  });

  // If there are other candidates, show a second toast with alternatives
  if (candidates.length > 1) {
    const others = candidates.slice(1, 4).map((c) => c.name).join(', ');
    showToast({
      message: `Other legendary creatures: ${others}. Use right-click → Move to Commander.`,
      type: 'info',
      duration: 10000,
    });
  }
}

function updateEntryTags(board: DeckBoard, cardName: string, rawTags: string): void {
  const entry = findEntry(board, cardName);
  if (!entry) return;
  const tags = rawTags
    .split(',')
    .map((tag) => tag.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 12);
  entry.tags = Array.from(new Set(tags));
}

// ==================== Multi-Select State ====================

const selectedCards = new Set<string>();
let lastClickedCard: string | null = null;

function getSelectedCards(): Set<string> {
  return selectedCards;
}

function clearSelection(): void {
  selectedCards.clear();
  lastClickedCard = null;
  updateBulkBar();
}

function handleCardSelect(cardName: string, event: MouseEvent): void {
  const key = normalizeNameKey(cardName);
  const allVisible = currentDeck
    ? currentDeck.boards[activeBoard].map((e) => normalizeNameKey(e.name))
    : [];

  if (event.ctrlKey || event.metaKey) {
    if (selectedCards.has(key)) selectedCards.delete(key);
    else selectedCards.add(key);
    lastClickedCard = key;
  } else if (event.shiftKey && lastClickedCard) {
    const startIdx = allVisible.indexOf(lastClickedCard);
    const endIdx = allVisible.indexOf(key);
    if (startIdx >= 0 && endIdx >= 0) {
      const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      for (let i = lo; i <= hi; i++) selectedCards.add(allVisible[i]);
    }
  } else {
    if (!selectedCards.has(key)) {
      selectedCards.clear();
      selectedCards.add(key);
    }
    lastClickedCard = key;
  }

  updateBulkBar();
  scheduleRenderBoardRows();
}

function updateBulkBar(): void {
  const bar = byId<HTMLDivElement>('bulkBar');
  const count = byId<HTMLSpanElement>('bulkCount');
  if (selectedCards.size > 0) {
    bar.classList.add('active');
    count.textContent = `${selectedCards.size} card(s) selected`;
  } else {
    bar.classList.remove('active');
  }
}

// ==================== Board Rendering ====================

/** Helper for injecting collab vote widgets into the view mode context */
function createVoteWidgetForCtx(board: DeckBoard, cardName: string): HTMLElement {
  return createVoteWidget(board, cardName);
}

function buildViewModeContext(): ViewModeContext {
  return {
    deck: currentDeck!,
    activeBoard,
    resolvedCardByName,
    boardLabels: BOARD_LABEL,
    boardOrder: BOARD_ORDER,
    chartFilter: activeChartFilter,
    deckFilter: deckFilterText,
    onQtyChange: (board, name, delta) => {
      if (delta < 0) {
        const entry = findEntry(board, name);
        if (entry && entry.qty <= 1) { removeEntry(board, name); }
        else { upsertEntry(board, name, delta); }
      } else {
        upsertEntry(board, name, delta);
      }
      deferredSaveAndRender();
    },
    onRemove: (board, name) => { removeEntry(board, name); saveAndRender(); },
    onMove: (from, to, name) => { moveEntry(from, to, name); saveAndRender(); },
    onTagsChange: (board, name, tags) => { updateEntryTags(board, name, tags); saveAndRender(); },
    onCardClick: (name, e) => {
      const key = normalizeNameKey(name);
      const card = resolvedCardByName[key];
      if (!card) return;
      const entry = findEntry(activeBoard, name);
      showDetailModal(name, card, entry, activeBoard);
    },
    onCardContextMenu: (name, e) => { showContextMenu(name, activeBoard, e); },
    onCardMouseEnter: (name, e) => {
      const card = resolvedCardByName[normalizeNameKey(name)];
      if (card) showHoverPreview(card, e);
    },
    onCardMouseLeave: () => { hideHoverPreview(); },
    getSelectedCards,
    onCardSelect: handleCardSelect,
    getVoteWidget: isCollabActive()
      ? (board: DeckBoard, cardName: string) => createVoteWidgetForCtx(board, cardName)
      : undefined,
  };
}

function setChartFilter(filter: ChartFilter): void {
  activeChartFilter = filter;
  scheduleRenderBoardRows();
  renderAnalytics(); // re-render to update active states
}

function injectMetaBadges(container: HTMLElement): void {
  if (!isMetaLoaded()) return;
  const cardElements = container.querySelectorAll<HTMLElement>('[data-card-name]');
  for (const el of cardElements) {
    const name = el.dataset.cardName;
    if (!name) continue;
    const badge = getMetaBadge(name);
    if (!badge) continue;
    // Don't double-inject
    if (el.querySelector('.meta-badge')) continue;
    const badgeEl = document.createElement('span');
    badgeEl.className = `meta-badge ${badge.cssClass}`;
    badgeEl.textContent = badge.label;
    el.appendChild(badgeEl);
  }
}

// Coalesces rapid renderBoardRows() calls within a single animation frame
let renderBoardRowsScheduled = false;
function scheduleRenderBoardRows(): void {
  if (renderBoardRowsScheduled) return;
  renderBoardRowsScheduled = true;
  requestAnimationFrame(() => {
    renderBoardRowsScheduled = false;
    renderBoardRows();
  });
}

function renderBoardRows(): void {
  const container = byId<HTMLDivElement>('boardRows');
  if (!currentDeck) {
    container.textContent = '';
    return;
  }
  renderActiveView(container, buildViewModeContext());
  renderFilterBadge(container, activeChartFilter, () => setChartFilter(null));
  injectMetaBadges(container);

  // Update accessibility live region
  const liveRegion = document.getElementById('boardLiveRegion');
  if (liveRegion && currentDeck) {
    const count = currentDeck.boards[activeBoard].length;
    liveRegion.textContent = `${BOARD_LABEL[activeBoard]}: ${count} unique cards`;
  }

  // NOTE: Auto-fit is now only called on actual deck mutations (add/remove/load), not on every render
  // This prevents flickering when clicking on cards or switching views
}

function updateBoardBadges(): void {
  if (!currentDeck) return;
  const formatRules = getFormatRules(currentDeck.format || 'commander');
  const counts: Record<DeckBoard, number> = {
    commander: totalCards(currentDeck.boards.commander),
    mainboard: totalCards(currentDeck.boards.mainboard),
    sideboard: totalCards(currentDeck.boards.sideboard),
    maybeboard: totalCards(currentDeck.boards.maybeboard),
  };
  const deckTotal = counts.commander + counts.mainboard;

  for (const board of BOARD_ORDER) {
    const btn = byId<HTMLButtonElement>(`boardBtn-${board}`);
    btn.textContent = `${BOARD_LABEL[board]} (${counts[board]})`;
    
    // Logic for warnings
    let isWarn = false;
    let isDanger = false;
    let title = '';

    if (board === 'mainboard') {
      if (deckTotal > formatRules.maxDeckSize) {
        isDanger = true;
        title = `Deck exceeds size limit (${deckTotal}/${formatRules.maxDeckSize})`;
      } else if (deckTotal < formatRules.minDeckSize) {
        if (currentDeck.format === 'commander') {
          isWarn = true;
          title = `Commander deck needs exactly 100 cards (currently ${deckTotal})`;
        } else {
          isWarn = true;
          title = `Deck is below minimum size (${deckTotal}/${formatRules.minDeckSize})`;
        }
      }
    } else if (board === 'commander') {
      if (formatRules.commanderRequired && counts.commander === 0) {
        isDanger = true;
        title = 'Commander required';
      } else if (currentDeck.format === 'commander' && counts.commander > 2) {
        isDanger = true;
        title = 'Too many commanders (max 2 with Partner)';
      }
    } else if (board === 'sideboard') {
      if (counts.sideboard > formatRules.sideboardMax) {
        isDanger = true;
        title = `Sideboard exceeds limit (${counts.sideboard}/${formatRules.sideboardMax})`;
      }
    }

    btn.classList.toggle('board-badge--warn', isWarn);
    btn.classList.toggle('board-badge--danger', isDanger);
    if (title) btn.setAttribute('title', title);
    else btn.removeAttribute('title');
  }
}

function renderDeckOverview(): void {
  if (!currentDeck) return;
  byId<HTMLInputElement>('deckNameInput').value = currentDeck.name;
  byId<HTMLSelectElement>('deckVisibility').value = currentDeck.visibility;
  byId<HTMLSelectElement>('deckFormat').value = currentDeck.format || 'commander';

  const commanderCount = totalCards(currentDeck.boards.commander);
  const mainCount = totalCards(currentDeck.boards.mainboard);
  const sideCount = totalCards(currentDeck.boards.sideboard);
  const maybeCount = totalCards(currentDeck.boards.maybeboard);
  const deckTotal = commanderCount + mainCount;

  // B4: Visual deck overview summary card
  const countsEl = byId<HTMLDivElement>('deckCounts');
  countsEl.textContent = '';

  // Commander thumbnail
  const commanderName = currentDeck.boards.commander[0]?.name;
  const commanderCard = commanderName ? resolvedCardByName[normalizeNameKey(commanderName)] : undefined;
  const cmdImgUrl = commanderCard?.image_uris?.small;
  if (cmdImgUrl) {
    const cmdImg = document.createElement('img');
    cmdImg.src = cmdImgUrl;
    cmdImg.alt = commanderName || '';
    cmdImg.className = 'overview-cmd-thumb';
    cmdImg.loading = 'lazy';
    countsEl.appendChild(cmdImg);
  }

  // Progress bar: X/100 cards
  const progressPct = Math.min(100, Math.round((deckTotal / 100) * 100));
  const progressColor = deckTotal > 100 ? '#f87171' : deckTotal >= 99 ? '#34d399' : 'var(--cobalt, #c9a84c)';
  const progressWrap = document.createElement('div');
  progressWrap.className = 'overview-progress';
  progressWrap.innerHTML =
    `<div class="overview-progress-bar" style="width:${progressPct}%;background:${progressColor}"></div>` +
    `<span class="overview-progress-label">${deckTotal}/100</span>`;
  countsEl.appendChild(progressWrap);

  // Color identity as mana pips
  if (commanderCard?.color_identity && commanderCard.color_identity.length > 0) {
    const pips = document.createElement('span');
    pips.className = 'overview-colors';
    for (const c of commanderCard.color_identity) {
      const pip = document.createElement('span');
      pip.className = `color-pip ${c}`;
      pip.textContent = c;
      pips.appendChild(pip);
    }
    countsEl.appendChild(pips);
  }

  // Avg CMC
  let cmcSum = 0, cmcCount = 0;
  for (const entry of currentDeck.boards.mainboard) {
    const card = resolvedCardByName[normalizeNameKey(entry.name)];
    if (!card || (card.type_line || '').toLowerCase().includes('land')) continue;
    cmcSum += (card.cmc || 0) * entry.qty;
    cmcCount += entry.qty;
  }
  const avgCmc = cmcCount > 0 ? (cmcSum / cmcCount).toFixed(2) : '—';
  const cmcEl = document.createElement('span');
  cmcEl.className = 'overview-stat';
  cmcEl.innerHTML = `<span class="overview-stat-val">${avgCmc}</span><span class="overview-stat-lbl">CMC</span>`;
  countsEl.appendChild(cmcEl);

  // Price (use preferred currency)
  try {
    const priceSummary = computeDeckPriceSummary(currentDeck, resolvedCardByName);
    const pref = getStoredCurrencyPreference();
    const price = pref === 'EUR' ? priceSummary.eurTotal : priceSummary.usdTotal;
    const symbol = pref === 'EUR' ? '\u20AC' : '$';
    if (price > 0) {
      const priceEl = document.createElement('span');
      priceEl.className = 'overview-stat';
      priceEl.innerHTML = `<span class="overview-stat-val">${symbol}${price.toFixed(0)}</span><span class="overview-stat-lbl">Price</span>`;
      countsEl.appendChild(priceEl);
    }
  } catch { /* pricing may fail silently */ }

  updateBoardBadges();
}

function renderRuleChecks(): void {
  if (!currentDeck) return;
  const result = evaluateEdhRules(currentDeck, resolvedCardByName);
  const container = byId<HTMLDivElement>('rulesPanel');
  container.textContent = '';

  if (result.issues.length === 0) {
    const ok = document.createElement('div');
    ok.className = 'ok';
    ok.textContent = 'No EDH rule warnings detected.';
    container.append(ok);
    return;
  }

  for (const issue of result.issues) {
    const box = document.createElement('div');
    box.className = issue.severity === 'error' ? 'rule-issue error' : 'rule-issue warning';
    const title = document.createElement('div');
    title.textContent = issue.message;
    box.append(title);
    if (issue.cards && issue.cards.length > 0) {
      const detail = document.createElement('div');
      detail.className = 'muted';
      detail.textContent = issue.cards.join(', ');
      box.append(detail);
    }
    // Render replacement suggestions
    if (issue.suggestions && issue.suggestions.length > 0) {
      const sugBox = document.createElement('div');
      sugBox.className = 'rule-suggestions';
      const sugTitle = document.createElement('div');
      sugTitle.className = 'rule-suggestions-title';
      sugTitle.textContent = 'Suggested replacements:';
      sugBox.append(sugTitle);
      for (const sug of issue.suggestions) {
        const row = document.createElement('div');
        row.className = 'rule-suggestion-row';
        const info = document.createElement('span');
        info.className = 'rule-suggestion-info';
        info.innerHTML = `<strong>${sug.cardName}</strong> \u2192 ${sug.replacement} <span class="muted">\u2014 ${sug.reason}</span>`;
        const btn = document.createElement('button');
        btn.className = 'btn small';
        btn.textContent = 'Swap';
        btn.addEventListener('click', () => {
          if (!currentDeck) return;
          // Try to remove from mainboard first, then commander
          const mainKey = normalizeNameKey(sug.cardName);
          const inMainboard = currentDeck.boards.mainboard.some((e) => normalizeNameKey(e.name) === mainKey);
          if (inMainboard) {
            removeEntry('mainboard', sug.cardName);
            upsertEntry('mainboard', sug.replacement, 1);
          } else {
            removeEntry('commander', sug.cardName);
            upsertEntry('commander', sug.replacement, 1);
          }
          saveAndRender();
          showToast({ message: `Replaced ${sug.cardName} with ${sug.replacement}`, type: 'success' });
        });
        row.append(info, btn);
        sugBox.append(row);
      }
      box.append(sugBox);
    }
    container.append(box);
  }

  // B2: Inject inline violation indicators on board cards
  injectRuleViolationIndicators(result.issues);
}

/** B2: Mark violating cards in the board view with visual indicators + tooltips */
function injectRuleViolationIndicators(issues: EdhRuleIssue[]): void {
  // Clear existing indicators
  const existing = document.querySelectorAll('.rule-violation-indicator');
  for (const el of existing) el.remove();
  const existingMarked = document.querySelectorAll('.rule-violation');
  for (const el of existingMarked) el.classList.remove('rule-violation');

  // Build map: normalized card name → violation messages
  const violationMap = new Map<string, string[]>();
  for (const issue of issues) {
    if (!issue.cards) continue;
    for (const cardName of issue.cards) {
      const key = normalizeNameKey(cardName);
      const msgs = violationMap.get(key) || [];
      msgs.push(issue.message);
      violationMap.set(key, msgs);
    }
  }

  if (violationMap.size === 0) return;

  // Find all card elements in the board view and mark violating ones
  const boardContainer = document.getElementById('boardRows');
  if (!boardContainer) return;
  const cardEls = boardContainer.querySelectorAll<HTMLElement>('[data-card-name]');
  for (const el of cardEls) {
    const name = el.getAttribute('data-card-name') ?? '';
    const key = normalizeNameKey(name);
    const msgs = violationMap.get(key);
    if (!msgs) continue;

    el.classList.add('rule-violation');
    // Add tooltip indicator
    const indicator = document.createElement('span');
    indicator.className = 'rule-violation-indicator';
 indicator.textContent = '!';
    indicator.title = msgs.join(' | ');
    el.appendChild(indicator);
  }
}

// ───── C5: Format Legality Check ─────

/** Map DeckFormat values to Scryfall legality keys */
const FORMAT_TO_SCRYFALL_KEY: Record<string, string> = {
  commander: 'commander',
  standard: 'standard',
  modern: 'modern',
  pioneer: 'pioneer',
  legacy: 'legacy',
  pauper: 'pauper',
};

/** Pretty-print format names for display */
const FORMAT_DISPLAY_NAME: Record<string, string> = {
  commander: 'Commander',
  standard: 'Standard',
  modern: 'Modern',
  pioneer: 'Pioneer',
  legacy: 'Legacy',
  pauper: 'Pauper',
};

function renderFormatLegalityCheck(): void {
  if (!currentDeck) return;

  const format = currentDeck.format;
  const panel = document.getElementById('formatLegalityPanel');

  // If no format selected, clear panel and return
  if (!format || format === 'none') {
    if (panel) {
      panel.textContent = '';
      panel.style.display = 'none';
    }
    // Also clear any inline badges
    const existingBadges = document.querySelectorAll('.format-legality-badge');
    for (const el of existingBadges) el.remove();
    return;
  }

  const formatKey = FORMAT_TO_SCRYFALL_KEY[format];
  if (!formatKey) return;

  const displayName = FORMAT_DISPLAY_NAME[format] || format;

  // Collect all cards across all boards (except maybeboard — it's aspirational)
  const allEntries: DeckbuilderCardEntry[] = [
    ...currentDeck.boards.commander,
    ...currentDeck.boards.mainboard,
    ...currentDeck.boards.sideboard,
  ];

  // Deduplicate by name
  const seenNames = new Set<string>();
  const banned: string[] = [];
  const notLegal: string[] = [];
  const restricted: string[] = [];

  for (const entry of allEntries) {
    const key = normalizeNameKey(entry.name);
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    const card = resolvedCardByName[key];
    if (!card) continue; // Card data not yet resolved

    const legality = card.legalities?.[formatKey];
    if (!legality || legality === 'legal') continue;

    if (legality === 'banned') {
      banned.push(entry.name);
    } else if (legality === 'not_legal') {
      notLegal.push(entry.name);
    } else if (legality === 'restricted') {
      restricted.push(entry.name);
    }
  }

  // Get or create panel
  let container = document.getElementById('formatLegalityPanel');
  if (!container) {
    container = document.createElement('div');
    container.id = 'formatLegalityPanel';
    const rulesPanel = document.getElementById('rulesPanel');
    if (rulesPanel && rulesPanel.parentElement) {
      rulesPanel.parentElement.insertBefore(container, rulesPanel.nextSibling);
    }
  }
  container.textContent = '';
  container.style.display = '';

  // All cards legal
  if (banned.length === 0 && notLegal.length === 0 && restricted.length === 0) {
    const ok = document.createElement('div');
    ok.className = 'format-legal-ok';
 ok.textContent = `✓ All cards legal in ${displayName}`;
    container.appendChild(ok);
    injectFormatLegalityBadges(formatKey);
    return;
  }

  // Render issue sections
  if (banned.length > 0) {
    const section = document.createElement('div');
    section.className = 'format-legal-section';
    const header = document.createElement('div');
    header.className = 'format-legal-section-header banned';
    header.textContent = `Banned in ${displayName} (${banned.length})`;
    section.appendChild(header);
    const cards = document.createElement('div');
    cards.className = 'format-legal-cards';
    cards.textContent = banned.join(', ');
    section.appendChild(cards);
    container.appendChild(section);
  }

  if (notLegal.length > 0) {
    const section = document.createElement('div');
    section.className = 'format-legal-section';
    const header = document.createElement('div');
    header.className = 'format-legal-section-header not-legal';
    header.textContent = `Not legal in ${displayName} (${notLegal.length})`;
    section.appendChild(header);
    const cards = document.createElement('div');
    cards.className = 'format-legal-cards';
    cards.textContent = notLegal.join(', ');
    section.appendChild(cards);
    container.appendChild(section);
  }

  if (restricted.length > 0) {
    const section = document.createElement('div');
    section.className = 'format-legal-section';
    const header = document.createElement('div');
    header.className = 'format-legal-section-header restricted';
    header.textContent = `Restricted in ${displayName} (${restricted.length})`;
    section.appendChild(header);
    const cards = document.createElement('div');
    cards.className = 'format-legal-cards';
    cards.textContent = restricted.join(', ');
    section.appendChild(cards);
    container.appendChild(section);
  }

  injectFormatLegalityBadges(formatKey);
}

/** C5: Inject inline legality badges on card rows in the board view */
function injectFormatLegalityBadges(formatKey: string): void {
  // Remove any existing badges
  const existing = document.querySelectorAll('.format-legality-badge');
  for (const el of existing) el.remove();

  const boardContainer = document.getElementById('boardRows');
  if (!boardContainer) return;

  const cardEls = boardContainer.querySelectorAll<HTMLElement>('[data-card-name]');
  for (const el of cardEls) {
    const name = el.getAttribute('data-card-name') ?? '';
    const key = normalizeNameKey(name);
    const card = resolvedCardByName[key];
    if (!card) continue;

    const legality = card.legalities?.[formatKey];
    if (!legality || legality === 'legal') continue;

    const badge = document.createElement('span');
    badge.className = 'format-legality-badge';

    if (legality === 'banned') {
      badge.classList.add('banned');
      badge.textContent = 'BANNED';
    } else if (legality === 'not_legal') {
      badge.classList.add('not-legal');
      badge.textContent = 'NOT LEGAL';
    } else if (legality === 'restricted') {
      badge.classList.add('restricted');
      badge.textContent = 'RESTRICTED';
    } else {
      continue;
    }

    el.appendChild(badge);
  }
}

function computeAnalyticsData(deck: DeckbuilderDeck): {
  curve: Record<string, number>;
  colors: Record<string, number>;
  types: Record<string, number>;
  tags: Record<string, number>;
  landCount: number;
} {
  const curve: Record<string, number> = {};
  const colors: Record<string, number> = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  const types: Record<string, number> = {
    creature: 0, instant: 0, sorcery: 0, enchantment: 0,
    artifact: 0, land: 0, planeswalker: 0, battle: 0,
  };
  const tags: Record<string, number> = {};

  const allEntries = [...deck.boards.mainboard, ...deck.boards.commander];

  for (const entry of allEntries) {
    const key = normalizeNameKey(entry.name);
    const card = resolvedCardByName[key];
    if (!card) continue;

    const typeLine = (card.type_line || '').toLowerCase();

    // Exclude lands from mana curve
    if (!typeLine.includes('land')) {
      const cmc = typeof card.cmc === 'number' && Number.isFinite(card.cmc) ? Math.trunc(card.cmc) : 0;
      curve[String(cmc)] = (curve[String(cmc)] || 0) + entry.qty;
    }

    const identity = Array.isArray(card?.color_identity) ? card?.color_identity : [];
    if (identity.length === 0) {
      colors.C += entry.qty;
    } else {
      for (const c of identity) {
        const v = c.toUpperCase();
        if (v in colors) colors[v] += entry.qty;
      }
    }
    if (typeLine.includes('creature')) types.creature += entry.qty;
    if (typeLine.includes('instant')) types.instant += entry.qty;
    if (typeLine.includes('sorcery')) types.sorcery += entry.qty;
    if (typeLine.includes('enchantment')) types.enchantment += entry.qty;
    if (typeLine.includes('artifact')) types.artifact += entry.qty;
    if (typeLine.includes('land')) types.land += entry.qty;
    if (typeLine.includes('planeswalker')) types.planeswalker += entry.qty;
    if (typeLine.includes('battle')) types.battle += entry.qty;

    if (entry.tags.length > 0) {
      for (const tag of entry.tags) {
        tags[tag] = (tags[tag] || 0) + entry.qty;
      }
    } else {
      // Auto-categorize if no manual tags
      const autoTag = getAutoTagForEntry(entry, resolvedCardByName);
      tags[autoTag] = (tags[autoTag] || 0) + entry.qty;
    }
  }

  return { curve, colors, types, tags, landCount: types.land };
}

function computeAnalyticsDataCached(deck: DeckbuilderDeck): ReturnType<typeof computeAnalyticsData> {
  const hash = deckContentHash(deck);
  if (analyticsCache && analyticsCache.hash === hash) return analyticsCache.data;
  const data = computeAnalyticsData(deck);
  analyticsCache = { hash, data };
  return data;
}

function estimatePowerLevelCached(deck: DeckbuilderDeck): ReturnType<typeof estimatePowerLevel> {
  const hash = deckContentHash(deck);
  if (powerLevelCache && powerLevelCache.hash === hash) return powerLevelCache.data;
  const data = estimatePowerLevel(deck);
  powerLevelCache = { hash, data };
  return data;
}

function renderManaCurveChart(curve: Record<string, number>): void {
  const container = byId<HTMLDivElement>('manaCurveChart');
  container.textContent = '';

  // Build buckets 0–7+
  const buckets: { label: string; count: number }[] = [];
  for (let i = 0; i <= 6; i++) buckets.push({ label: String(i), count: curve[String(i)] || 0 });
  const sevenPlus = Object.entries(curve)
    .filter(([k]) => Number(k) >= 7)
    .reduce((sum, [, v]) => sum + v, 0);
  buckets.push({ label: '7+', count: sevenPlus });

  const max = Math.max(1, ...buckets.map((b) => b.count));

  for (const bucket of buckets) {
    const cmcValue = bucket.label === '7+' ? 7 : Number(bucket.label);
    const isActive = activeChartFilter?.type === 'cmc' && activeChartFilter.value === cmcValue;

    const wrap = document.createElement('div');
    wrap.className = `mc-bar-wrap${isActive ? ' chart-active' : ''}`;
    wrap.style.cursor = 'pointer';
    wrap.addEventListener('click', () => {
      if (activeChartFilter?.type === 'cmc' && activeChartFilter.value === cmcValue) {
        setChartFilter(null);
      } else {
        setChartFilter({ type: 'cmc', value: cmcValue });
      }
    });

    const count = document.createElement('div');
    count.className = 'mc-bar-count';
    count.textContent = bucket.count > 0 ? String(bucket.count) : '';

    const bar = document.createElement('div');
    bar.className = 'mc-bar';
    bar.style.height = `${Math.max(2, (bucket.count / max) * 90)}%`;

    const label = document.createElement('div');
    label.className = 'mc-bar-label';
    label.textContent = bucket.label;

    wrap.append(count, bar, label);
    container.appendChild(wrap);
  }

  // Average CMC
  const totalCards = buckets.reduce((s, b) => s + b.count, 0);
  const weightedSum = buckets.reduce((s, b) => {
    const cmc = b.label === '7+' ? 7 : Number(b.label);
    return s + cmc * b.count;
  }, 0);
  const avgEl = document.getElementById('manaCurveAvg');
  if (avgEl) {
    avgEl.textContent = totalCards > 0 ? `Avg CMC: ${(weightedSum / totalCards).toFixed(2)}` : '';
  }
}

function renderColorDonut(colors: Record<string, number>): void {
  const container = byId<HTMLDivElement>('colorDonutChart');
  container.textContent = '';

  const COLOR_MAP: Record<string, { hex: string; name: string }> = {
    W: { hex: '#f9faf4', name: 'White' },
    U: { hex: '#0e68ab', name: 'Blue' },
    B: { hex: '#5a5053', name: 'Black' },
    R: { hex: '#d3202a', name: 'Red' },
    G: { hex: '#00733e', name: 'Green' },
    C: { hex: '#98928b', name: 'Colorless' },
  };

  const entries = Object.entries(colors).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);

  if (total === 0) {
    container.innerHTML = '<span class="muted" style="font-size:0.78rem;">No cards in mainboard</span>';
    return;
  }

  // SVG donut
  const size = 100;
  const radius = 38;
  const circumference = 2 * Math.PI * radius;

  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);

  let offset = 0;
  for (const [key, count] of entries) {
    const isActive = activeChartFilter?.type === 'color' && activeChartFilter.value === key;
    const pct = count / total;
    const dash = pct * circumference;
    const circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('cx', '50');
    circle.setAttribute('cy', '50');
    circle.setAttribute('r', String(radius));
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', COLOR_MAP[key]?.hex || '#666');
    circle.setAttribute('stroke-width', isActive ? '16' : '12');
    circle.setAttribute('stroke-dasharray', `${dash} ${circumference - dash}`);
    circle.setAttribute('stroke-dashoffset', String(-offset));
    circle.setAttribute('transform', `rotate(-90 50 50)`);
    circle.style.cursor = 'pointer';
    circle.style.opacity = isActive ? '1' : (activeChartFilter?.type === 'color' ? '0.4' : '1');
    circle.addEventListener('click', () => {
      if (activeChartFilter?.type === 'color' && activeChartFilter.value === key) {
        setChartFilter(null);
      } else {
        setChartFilter({ type: 'color', value: key });
      }
    });
    svg.appendChild(circle);
    offset += dash;
  }

  // Center total
  const centerText = document.createElementNS(svgNs, 'text');
  centerText.setAttribute('x', '50');
  centerText.setAttribute('y', '50');
  centerText.setAttribute('text-anchor', 'middle');
  centerText.setAttribute('dominant-baseline', 'central');
  centerText.setAttribute('fill', 'var(--text)');
  centerText.setAttribute('font-size', '14');
  centerText.setAttribute('font-weight', '700');
  centerText.setAttribute('font-family', "'JetBrains Mono', monospace");
  centerText.textContent = String(total);
  svg.appendChild(centerText);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'donut-legend';
  for (const [key, count] of entries) {
    const isActive = activeChartFilter?.type === 'color' && activeChartFilter.value === key;
    const item = document.createElement('div');
    item.className = `donut-legend-item${isActive ? ' chart-active' : ''}`;
    item.style.cursor = 'pointer';
    item.addEventListener('click', () => {
      if (activeChartFilter?.type === 'color' && activeChartFilter.value === key) {
        setChartFilter(null);
      } else {
        setChartFilter({ type: 'color', value: key });
      }
    });
    const swatch = document.createElement('span');
    swatch.className = 'donut-legend-swatch';
    swatch.style.background = COLOR_MAP[key]?.hex || '#666';
    const label = document.createElement('span');
    label.textContent = COLOR_MAP[key]?.name || key;
    const val = document.createElement('span');
    val.className = 'donut-val';
    val.textContent = `${count} (${Math.round((count / total) * 100)}%)`;
    item.append(swatch, label, val);
    legend.appendChild(item);
  }

  container.append(svg, legend);
}

function renderTypeDistribution(types: Record<string, number>): void {
  const container = byId<HTMLDivElement>('typeDistChart');
  container.textContent = '';

  const entries = Object.entries(types).filter(([, v]) => v > 0);
  if (entries.length === 0) {
    container.innerHTML = '<span class="muted" style="font-size:0.78rem;">No cards found</span>';
    return;
  }

  const max = Math.max(1, ...entries.map(([, v]) => v));
  const totalCards = entries.reduce((s, [, v]) => s + v, 0);

  for (const [typeName, count] of entries) {
    const isActive = activeChartFilter?.type === 'cardType' && activeChartFilter.value === typeName;
    const pct = totalCards > 0 ? Math.round((count / totalCards) * 100) : 0;

    const row = document.createElement('div');
    row.className = `td-row${isActive ? ' chart-active' : ''}`;
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => {
      if (activeChartFilter?.type === 'cardType' && activeChartFilter.value === typeName) {
        setChartFilter(null);
      } else {
        setChartFilter({ type: 'cardType', value: typeName });
      }
    });

    const label = document.createElement('div');
    label.className = 'td-label';
    label.textContent = typeName;

    const track = document.createElement('div');
    track.className = 'td-bar-track';
    const fill = document.createElement('div');
    fill.className = 'td-bar-fill';
    fill.style.width = `${(count / max) * 100}%`;
    track.appendChild(fill);

    const countEl = document.createElement('div');
    countEl.className = 'td-count';
    countEl.textContent = `${count} (${pct}%)`;

    row.append(label, track, countEl);
    container.appendChild(row);
  }
}

interface PowerFactor { label: string; value: number; detail: string; }

function estimatePowerLevel(deck: DeckbuilderDeck): {
  power: number; bracket: number; dominant: string; salt: number; saltLabel: string;
  factors: PowerFactor[]; avgCmc: number; tutorCount: number;
} {
  const entries = deck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty }));
  const resolver = (name: string): AnalyzerCardView | undefined => {
    const card = resolvedCardByName[normalizeNameKey(name)];
    if (!card) return undefined;
    return { name: card.name, cmc: card.cmc, type_line: card.type_line, oracle_text: card.oracle_text };
  };

  const dna = analyzeDeckDNA(entries, resolver);
  const salt = calculateSaltAnalysis(entries, resolver);

  const factors: PowerFactor[] = [];
  let power = 4;
  factors.push({ label: 'Base', value: 4, detail: 'Starting power level' });

  // Avg CMC excluding lands
  let cmcSum = 0;
  let nonlandQty = 0;
  for (const e of entries) {
    const card = resolvedCardByName[normalizeNameKey(e.name)];
    if (card && !(card.type_line || '').toLowerCase().includes('land')) {
      cmcSum += (card.cmc || 0) * e.qty;
      nonlandQty += e.qty;
    }
  }
  const avgCmc = nonlandQty > 0 ? cmcSum / nonlandQty : 3;

  if (avgCmc < 2.5) {
    power += 1.5;
    factors.push({ label: 'Low CMC', value: 1.5, detail: `Avg CMC ${avgCmc.toFixed(1)} is very aggressive` });
  } else if (avgCmc < 3.0) {
    power += 0.5;
    factors.push({ label: 'Low CMC', value: 0.5, detail: `Avg CMC ${avgCmc.toFixed(1)} is below average` });
  } else if (avgCmc > 4.0) {
    power -= 1;
    factors.push({ label: 'High CMC', value: -1, detail: `Avg CMC ${avgCmc.toFixed(1)} is slow` });
  }

  if (dna.normalized.combo > 0.3) {
    power += 1;
    factors.push({ label: 'Combo density', value: 1, detail: `Combo score ${Math.round(dna.normalized.combo * 100)}% \u2014 tutors, draw, untap effects` });
  }
  if (dna.normalized.control > 0.3) {
    power += 0.5;
    factors.push({ label: 'Control density', value: 0.5, detail: `Control score ${Math.round(dna.normalized.control * 100)}% \u2014 removal, counters` });
  }
  if (salt.score > 5) {
    power += 1;
    factors.push({ label: 'Salt', value: 1, detail: `Salt score ${salt.score.toFixed(1)}/10 raises power` });
  }
  if (salt.score > 8) {
    power += 0.5;
    factors.push({ label: 'High salt', value: 0.5, detail: `Salt ${salt.score.toFixed(1)}/10 is very controversial` });
  }

  // Tutor/fast mana detection
  const oracleTexts = entries.flatMap((e) => {
    const card = resolvedCardByName[normalizeNameKey(e.name)];
    return card?.oracle_text ? [card.oracle_text.toLowerCase()] : [];
  });
  const tutorCount = oracleTexts.filter((t) => t.includes('search your library')).length;
  if (tutorCount >= 5) {
    power += 1;
    factors.push({ label: 'Tutors', value: 1, detail: `${tutorCount} tutors found (search your library)` });
  } else if (tutorCount >= 3) {
    power += 0.5;
    factors.push({ label: 'Tutors', value: 0.5, detail: `${tutorCount} tutors found` });
  }

  power = Math.max(1, Math.min(10, Math.round(power * 10) / 10));

  let bracket: number;
  if (power <= 3) bracket = 1;
  else if (power <= 5) bracket = 2;
  else if (power <= 7) bracket = 3;
  else bracket = 4;

  return { power, bracket, dominant: dna.dominant, salt: salt.score, saltLabel: salt.label, factors, avgCmc, tutorCount };
}

interface DeckTip { icon: string; text: string; }

function generateContextualTips(
  est: ReturnType<typeof estimatePowerLevel>,
  health: ReturnType<typeof calculateDeckHealth>,
): DeckTip[] {
  const tips: DeckTip[] = [];
  const bracketLabels = ['', 'casual', 'focused', 'optimized', 'competitive'];

  // Bracket explanation (always first)
  const reasons = est.factors
    .filter((f) => f.label !== 'Base' && f.value !== 0)
    .map((f) => f.detail);
  if (reasons.length > 0) {
    tips.push({
 icon: '◆',
      text: `Bracket ${est.bracket} (${bracketLabels[est.bracket]}): ${reasons.join('. ')}.`,
    });
  }

  // CMC tips
  if (est.avgCmc < 2.5) {
    tips.push({
 icon: '▲',
      text: `Avg CMC ${est.avgCmc.toFixed(1)} is very aggressive. Consider adding card draw to sustain pressure past turn 5.`,
    });
  } else if (est.avgCmc > 4.0) {
    tips.push({
 icon: '▼',
      text: `Avg CMC ${est.avgCmc.toFixed(1)} is high. You'll need strong ramp to keep up. Consider cutting cards above 6 CMC.`,
    });
  }

  // Tutor tip
  if (est.tutorCount >= 5) {
    tips.push({
 icon: '◇',
      text: `${est.tutorCount} tutors detected \u2014 this significantly raises consistency and power level.`,
    });
  }

  // Salt tip
  if (est.salt > 7) {
    tips.push({
 icon: '◆',
      text: `Salt score ${est.salt.toFixed(1)}/10 is very high. Expect focused targeting from opponents. Consider your table's social contract.`,
    });
  }

  // Health tips (low scoring components)
  for (const comp of health.components) {
    if (comp.score < 40 && comp.recommendations.length > 0) {
      tips.push({
 icon: '!',
        text: `${comp.label}: ${comp.recommendations[0].text}`,
      });
    }
  }

  return tips.slice(0, 5);
}

function renderDeckTips(deck: DeckbuilderDeck): void {
  const box = byId<HTMLDivElement>('deckTipsBox');
  box.textContent = '✕';

  if (deck.boards.mainboard.length < 10) return;

  const est = estimatePowerLevelCached(deck);
  const health = calculateDeckHealth(deck, resolvedCardByName);
  const tips = generateContextualTips(est, health);

  for (const tip of tips) {
    const row = document.createElement('div');
    row.className = 'deck-tip';

    const icon = document.createElement('span');
    icon.className = 'tip-icon';
    icon.textContent = tip.icon;

    const text = document.createElement('span');
    text.textContent = tip.text;

    row.append(icon, text);
    box.appendChild(row);
  }
}

function renderPowerBracket(deck: DeckbuilderDeck): void {
  const container = byId<HTMLDivElement>('powerBracketBox');
  container.textContent = '';

  if (deck.boards.mainboard.length === 0) return;

  const est = estimatePowerLevelCached(deck);
  const bracketColors = ['', '#34d399', '#e8c84a', '#f59e0b', '#ef4444'];

  // Wrapper for hover tooltip
  const wrapper = document.createElement('div');
  wrapper.className = 'power-badge-wrap';

  const badge = document.createElement('div');
  badge.className = 'power-badge';
  badge.style.borderColor = bracketColors[est.bracket] || '#666';

  const num = document.createElement('span');
  num.className = 'power-num';
  num.style.color = bracketColors[est.bracket] || '#666';
  num.textContent = String(est.power);

  const info = document.createElement('div');
  info.style.display = 'flex';
  info.style.flexDirection = 'column';
  info.style.gap = '1px';

  const bracketLabel = document.createElement('span');
  bracketLabel.className = 'power-label';
  bracketLabel.textContent = `Bracket ${est.bracket}`;

  const archLabel = document.createElement('span');
  archLabel.className = 'power-label';
  archLabel.style.color = 'var(--cobalt-dim)';
  archLabel.textContent = `${est.dominant} \u00B7 ${est.saltLabel}`;

  info.append(bracketLabel, archLabel);
  badge.append(num, info);

  // Power tooltip with factor breakdown
  const tooltip = document.createElement('div');
  tooltip.className = 'power-tooltip';

  const ttTitle = document.createElement('div');
  ttTitle.className = 'power-tooltip-title';
  ttTitle.textContent = 'Power Breakdown';
  tooltip.appendChild(ttTitle);

  for (const factor of est.factors) {
    const row = document.createElement('div');
    row.className = 'power-tooltip-row';

    const lbl = document.createElement('span');
    lbl.textContent = factor.label;

    const val = document.createElement('span');
    val.className = factor.value > 0 ? 'factor-plus' : factor.value < 0 ? 'factor-minus' : 'factor-neutral';
    val.textContent = factor.value > 0 ? `+${factor.value}` : String(factor.value);

    row.append(lbl, val);
    tooltip.appendChild(row);

    const detail = document.createElement('span');
    detail.className = 'factor-detail';
    detail.textContent = factor.detail;
    tooltip.appendChild(detail);
  }

  const ttTotal = document.createElement('div');
  ttTotal.className = 'power-tooltip-row';
  ttTotal.style.borderTop = '1px solid var(--line)';
  ttTotal.style.marginTop = '4px';
  ttTotal.style.paddingTop = '4px';
  const ttTotalLabel = document.createElement('span');
  ttTotalLabel.style.fontWeight = '600';
  ttTotalLabel.textContent = 'Total';
  const ttTotalVal = document.createElement('span');
  ttTotalVal.style.fontWeight = '600';
  ttTotalVal.style.color = bracketColors[est.bracket] || '#666';
  ttTotalVal.style.fontFamily = "'JetBrains Mono', monospace";
  ttTotalVal.textContent = String(est.power);
  ttTotal.append(ttTotalLabel, ttTotalVal);
  tooltip.appendChild(ttTotal);

  wrapper.append(badge, tooltip);
  container.appendChild(wrapper);

  // Salt Score Bar
  const saltBar = document.createElement('div');
  saltBar.className = 'salt-bar-wrap';
  saltBar.title = `Salt Score: ${est.salt.toFixed(1)}/10 \u2013 How controversial your deck is to play against`;
  saltBar.style.cursor = 'pointer';

  const saltFillColor = est.salt <= 3 ? '#34d399' : est.salt <= 6 ? '#e8c84a' : est.salt <= 8 ? '#f59e0b' : '#ef4444';
  const saltFill = document.createElement('div');
  saltFill.className = 'salt-bar-fill';
  saltFill.style.width = `${Math.min(100, (est.salt / 10) * 100)}%`;
  saltFill.style.background = saltFillColor;
  saltBar.appendChild(saltFill);

  const saltLabel2 = document.createElement('div');
  saltLabel2.className = 'salt-bar-label';
  saltLabel2.textContent = `Salt ${est.salt.toFixed(1)}`;
  saltLabel2.style.color = saltFillColor;

  // Salt breakdown popup on click
  saltBar.addEventListener('click', () => {
    const existing = container.querySelector('.salt-breakdown');
    if (existing) { existing.remove(); return; }

    const entries = deck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty }));
    const resolver = (name: string): AnalyzerCardView | undefined => {
      const card = resolvedCardByName[normalizeNameKey(name)];
      if (!card) return undefined;
      return { name: card.name, cmc: card.cmc, type_line: card.type_line, oracle_text: card.oracle_text };
    };
    const saltData = calculateSaltAnalysis(entries, resolver);

    const popup = document.createElement('div');
    popup.className = 'salt-breakdown';
    const popupTitle = document.createElement('div');
    popupTitle.className = 'salt-breakdown-title';
    popupTitle.textContent = `Salt Breakdown: ${saltData.label}`;
    popup.appendChild(popupTitle);

    if (saltData.saltyCards.length > 0) {
      for (const cardDesc of saltData.saltyCards.slice(0, 8)) {
        const row = document.createElement('div');
        row.className = 'salt-breakdown-row';
        row.textContent = cardDesc;
        popup.appendChild(row);
      }
    } else {
      const noData = document.createElement('div');
      noData.className = 'muted';
      noData.style.fontSize = '0.78rem';
      noData.textContent = 'No salt contributors found. Your deck is friendly!';
      popup.appendChild(noData);
    }
    container.appendChild(popup);
  });

  container.appendChild(saltLabel2);
  container.appendChild(saltBar);

  // Archetype Info Panel (B)
  try {
    const sharedDeck = {
      main: deck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty })),
      sideboard: deck.boards.sideboard.map((e) => ({ name: e.name, qty: e.qty })),
      commander: deck.boards.commander.map((e) => ({ name: e.name, qty: e.qty })),
    };
    const resolver = (name: string) => {
      const card = resolvedCardByName[normalizeNameKey(name)];
      if (!card) return undefined;
      return { name: card.name, type_line: card.type_line, oracle_text: card.oracle_text };
    };
    const archResult = detectDeckArchetype(sharedDeck, resolver);

    if (archResult.primaryArchetype) {
      const archDef = getArchetypeById(archResult.primaryArchetype);
      if (archDef) {
        const archInfo = document.createElement('div');
        archInfo.className = 'archetype-info';

        const planEl = document.createElement('div');
        planEl.className = 'archetype-gameplan';
        planEl.textContent = archDef.gamePlan;
        archInfo.appendChild(planEl);

        if (archResult.counterCards.length > 0) {
          const counterTitle = document.createElement('div');
          counterTitle.className = 'counter-title';
          counterTitle.textContent = 'Watch out for:';
          archInfo.appendChild(counterTitle);

          const counterList = document.createElement('div');
          counterList.className = 'counter-cards';
          for (const cardName of archResult.counterCards.slice(0, 5)) {
            const chip = document.createElement('span');
            chip.className = 'counter-chip';
            chip.textContent = cardName;
            counterList.appendChild(chip);
          }
          archInfo.appendChild(counterList);
        }
        container.appendChild(archInfo);
      }
    }
  } catch { /* non-critical */ }
}

// ==================== Official Bracket Calculator ====================

function renderOfficialBracket(deck: DeckbuilderDeck): void {
  const container = byId<HTMLDivElement>('officialBracketBox');
  container.textContent = '';
  if (deck.boards.mainboard.length === 0 && deck.boards.commander.length === 0) return;
  const result = calculateBracket(deck, resolvedCardByName);
  renderBracketResult(container, result);
}

// ==================== Combo Detection ====================

type ComboCategory = 'Win Con' | 'Infinite Mana' | 'Infinite Damage' | 'Infinite Tokens' | 'Card Advantage' | 'Lock' | 'Infinite Combat';

type ComboSource = 'local' | 'spellbook';

interface KnownCombo {
  cards: string[];
  description: string;
  category: ComboCategory;
}

interface UnifiedCombo {
  source: ComboSource;
  cards: string[];
  description: string;
  category: ComboCategory | 'API';
  present: string[];
  missing: string[];
  spellbookUrl?: string;
  produces?: string[];
}

function mapProducesToCategory(produces: string[]): ComboCategory | 'API' {
  const text = produces.join(' ').toLowerCase();
  if (text.includes('win the game')) return 'Win Con';
  if (text.includes('infinite mana')) return 'Infinite Mana';
  if (text.includes('infinite damage')) return 'Infinite Damage';
  if (text.includes('infinite tokens') || text.includes('infinite creature')) return 'Infinite Tokens';
  if (text.includes('infinite combat')) return 'Infinite Combat';
  if (text.includes('infinite draw') || text.includes('card advantage')) return 'Card Advantage';
  if (text.includes('lock') || text.includes("can't cast")) return 'Lock';
  return 'API';
}

const COMBO_ICONS: Record<ComboCategory | 'API', string> = {
 'Win Con': '▲',
 'Infinite Mana': '◆',
 'Infinite Damage': '▲',
 'Infinite Tokens': '▣',
 'Card Advantage': '■',
 'Lock': '◆',
 'Infinite Combat': '✕',
 'API': '✦',
};

const KNOWN_COMBOS: KnownCombo[] = [
  // ===== Win Con =====
  { cards: ['Thassa\'s Oracle', 'Demonic Consultation'], description: 'Exile library \u2192 win on empty library', category: 'Win Con' },
  { cards: ['Thassa\'s Oracle', 'Tainted Pact'], description: 'Exile library \u2192 win on empty library', category: 'Win Con' },
  { cards: ['Jace, Wielder of Mysteries', 'Demonic Consultation'], description: 'Exile library \u2192 win on empty library draw', category: 'Win Con' },
  { cards: ['Jace, Wielder of Mysteries', 'Tainted Pact'], description: 'Exile library \u2192 win on empty library draw', category: 'Win Con' },
  { cards: ['Laboratory Maniac', 'Demonic Consultation'], description: 'Exile library \u2192 win on next draw', category: 'Win Con' },
  { cards: ['Laboratory Maniac', 'Tainted Pact'], description: 'Exile library \u2192 win on next draw', category: 'Win Con' },
  { cards: ['Sensei\'s Divining Top', 'Bolas\'s Citadel', 'Aetherflux Reservoir'], description: 'Draw deck + gain life \u2192 nuke', category: 'Win Con' },
  { cards: ['Painter\'s Servant', 'Grindstone'], description: 'Mill entire library', category: 'Win Con' },
  { cards: ['Mindcrank', 'Bloodchief Ascension'], description: 'Infinite mill + life drain', category: 'Win Con' },

  // ===== Infinite Mana =====
  { cards: ['Isochron Scepter', 'Dramatic Reversal'], description: 'Infinite mana with 3+ mana from nonland', category: 'Infinite Mana' },
  { cards: ['Deadeye Navigator', 'Peregrine Drake'], description: 'Infinite mana via blink', category: 'Infinite Mana' },
  { cards: ['Basalt Monolith', 'Rings of Brighthearth'], description: 'Infinite colorless mana', category: 'Infinite Mana' },
  { cards: ['Basalt Monolith', 'Power Artifact'], description: 'Infinite colorless mana', category: 'Infinite Mana' },
  { cards: ['Food Chain', 'Squee, the Immortal'], description: 'Infinite creature mana', category: 'Infinite Mana' },
  { cards: ['Food Chain', 'Eternal Scourge'], description: 'Infinite creature mana', category: 'Infinite Mana' },
  { cards: ['Devoted Druid', 'Vizier of Remedies'], description: 'Infinite green mana', category: 'Infinite Mana' },
  { cards: ['Freed from the Real', 'Bloom Tender'], description: 'Infinite mana (2+ colors)', category: 'Infinite Mana' },
  { cards: ['Freed from the Real', 'Faeburrow Elder'], description: 'Infinite mana (2+ colors)', category: 'Infinite Mana' },
  { cards: ['Grand Architect', 'Pili-Pala'], description: 'Infinite colored mana', category: 'Infinite Mana' },
  { cards: ['Grim Monolith', 'Power Artifact'], description: 'Infinite colorless mana', category: 'Infinite Mana' },
  { cards: ['Peregrine Drake', 'Ghostly Flicker', 'Archaeomancer'], description: 'Infinite mana via blink loop', category: 'Infinite Mana' },
  { cards: ['Palinchron', 'Phantasmal Image'], description: 'Infinite mana (7+ lands)', category: 'Infinite Mana' },
  { cards: ['Worldgorger Dragon', 'Animate Dead'], description: 'Infinite mana via flicker loop', category: 'Infinite Mana' },
  { cards: ['Worldgorger Dragon', 'Dance of the Dead'], description: 'Infinite mana via flicker loop', category: 'Infinite Mana' },
  { cards: ['Worldgorger Dragon', 'Necromancy'], description: 'Infinite mana via flicker loop', category: 'Infinite Mana' },

  // ===== Infinite Damage =====
  { cards: ['Exquisite Blood', 'Sanguine Bond'], description: 'Infinite life drain loop', category: 'Infinite Damage' },
  { cards: ['Exquisite Blood', 'Vito, Thorn of the Dusk Rose'], description: 'Infinite life drain loop', category: 'Infinite Damage' },
  { cards: ['Mikaeus, the Unhallowed', 'Triskelion'], description: 'Infinite damage via undying', category: 'Infinite Damage' },
  { cards: ['Heliod, Sun-Crowned', 'Walking Ballista'], description: 'Infinite damage via lifelink loop', category: 'Infinite Damage' },
  { cards: ['Niv-Mizzet, Parun', 'Curiosity'], description: 'Infinite damage + draw', category: 'Infinite Damage' },
  { cards: ['Niv-Mizzet, the Firemind', 'Curiosity'], description: 'Infinite damage + draw', category: 'Infinite Damage' },
  { cards: ['Niv-Mizzet, Parun', 'Ophidian Eye'], description: 'Infinite damage + draw', category: 'Infinite Damage' },
  { cards: ['Niv-Mizzet, Parun', 'Tandem Lookout'], description: 'Infinite damage + draw', category: 'Infinite Damage' },
  { cards: ['Kiki-Jiki, Mirror Breaker', 'Zealous Conscripts'], description: 'Infinite hasty token copies', category: 'Infinite Damage' },
  { cards: ['Kiki-Jiki, Mirror Breaker', 'Pestermite'], description: 'Infinite hasty token copies', category: 'Infinite Damage' },
  { cards: ['Kiki-Jiki, Mirror Breaker', 'Deceiver Exarch'], description: 'Infinite hasty token copies', category: 'Infinite Damage' },
  { cards: ['Kiki-Jiki, Mirror Breaker', 'Felidar Guardian'], description: 'Infinite hasty token copies', category: 'Infinite Damage' },
  { cards: ['Splinter Twin', 'Pestermite'], description: 'Infinite hasty token copies', category: 'Infinite Damage' },
  { cards: ['Splinter Twin', 'Deceiver Exarch'], description: 'Infinite hasty token copies', category: 'Infinite Damage' },
  { cards: ['Dualcaster Mage', 'Ghostly Flicker'], description: 'Infinite ETB triggers', category: 'Infinite Damage' },
  { cards: ['Dualcaster Mage', 'Twinflame'], description: 'Infinite hasty copies', category: 'Infinite Damage' },

  // ===== Infinite Combat =====
  { cards: ['Aggravated Assault', 'Savage Ventmaw'], description: 'Infinite combat steps', category: 'Infinite Combat' },
  { cards: ['Aggravated Assault', 'Sword of Feast and Famine'], description: 'Infinite combat steps', category: 'Infinite Combat' },
  { cards: ['Najeela, the Blade-Blossom', 'Nature\'s Will'], description: 'Infinite combat with warriors', category: 'Infinite Combat' },
  { cards: ['Najeela, the Blade-Blossom', 'Derevi, Empyrial Tactician'], description: 'Infinite combat with warriors', category: 'Infinite Combat' },
  { cards: ['Aurelia, the Warleader', 'Helm of the Host'], description: 'Infinite combat steps', category: 'Infinite Combat' },

  // ===== Infinite Tokens =====
  { cards: ['Sword of the Meek', 'Thopter Foundry'], description: 'Infinite thopters + life (with mana)', category: 'Infinite Tokens' },
  { cards: ['Nim Deathmantle', 'Ashnod\'s Altar'], description: 'Infinite mana/ETB with token producer', category: 'Infinite Tokens' },
  { cards: ['Herd Baloth', 'Ivy Lane Denizen'], description: 'Infinite 4/4 beast tokens', category: 'Infinite Tokens' },
  { cards: ['Scurry Oak', 'Rosie Cotton of South Lane'], description: 'Infinite 1/1 squirrel tokens', category: 'Infinite Tokens' },
  { cards: ['Ghave, Guru of Spores', 'Ashnod\'s Altar', 'Cathars\' Crusade'], description: 'Infinite tokens + counters', category: 'Infinite Tokens' },
  { cards: ['Reveillark', 'Karmic Guide'], description: 'Infinite ETB/death with sac outlet', category: 'Infinite Tokens' },

  // ===== Card Advantage =====
  { cards: ['Birgi, God of Storytelling', 'Grinning Ignus'], description: 'Infinite storm count + ETB triggers', category: 'Card Advantage' },
  { cards: ['Mana Geyser', 'Reiterate'], description: 'Infinite red mana (4+ opponents\' tapped lands)', category: 'Card Advantage' },
  { cards: ['Underworld Breach', 'Brain Freeze', 'Lion\'s Eye Diamond'], description: 'Storm mill from graveyard recursion', category: 'Card Advantage' },
  { cards: ['Grinding Station', 'Underworld Breach', 'Brain Freeze'], description: 'Mill opponents from graveyard recursion', category: 'Card Advantage' },
  { cards: ['Timetwister', 'Narset\'s Reversal'], description: 'Infinite turns with enough mana', category: 'Card Advantage' },

  // ===== Lock =====
  { cards: ['Knowledge Pool', 'Lavinia, Azorius Renegade'], description: 'Opponents can\'t cast spells', category: 'Lock' },
  { cards: ['Possibility Storm', 'Lavinia, Azorius Renegade'], description: 'Opponents can\'t cast spells', category: 'Lock' },
  { cards: ['Drannith Magistrate', 'Knowledge Pool'], description: 'Opponents can\'t cast spells', category: 'Lock' },
  { cards: ['Winter Orb', 'Derevi, Empyrial Tactician'], description: 'Asymmetric land lockdown', category: 'Lock' },
  { cards: ['Stasis', 'Wilderness Reclamation'], description: 'Asymmetric stasis lock', category: 'Lock' },
];

function detectCombos(deck: DeckbuilderDeck): UnifiedCombo[] {
  const allNames = new Set<string>();
  for (const board of [deck.boards.commander, deck.boards.mainboard]) {
    for (const entry of board) allNames.add(normalizeNameKey(entry.name));
  }

  const unified: UnifiedCombo[] = [];

  // 1. Local hardcoded combos
  for (const combo of KNOWN_COMBOS) {
    const present: string[] = [];
    const missing: string[] = [];
    for (const card of combo.cards) {
      if (allNames.has(normalizeNameKey(card))) present.push(card);
      else missing.push(card);
    }
    if (present.length >= Math.ceil(combo.cards.length / 2)) {
      unified.push({
        source: 'local',
        cards: combo.cards,
        description: combo.description,
        category: combo.category,
        present,
        missing,
      });
    }
  }

  // 2. Spellbook API combos (if available)
  if (spellbookCombos) {
    const localFingerprints = new Set(
      unified.map((c) => c.cards.map(normalizeNameKey).sort().join('|')),
    );

    for (const combo of [...spellbookCombos.included, ...spellbookCombos.almostIncluded]) {
      const fingerprint = combo.cards.map(normalizeNameKey).sort().join('|');
      if (localFingerprints.has(fingerprint)) continue;

      const present: string[] = [];
      const missing: string[] = [];
      for (const card of combo.cards) {
        if (allNames.has(normalizeNameKey(card))) present.push(card);
        else missing.push(card);
      }

      // Only show if at least half present
      if (present.length < Math.ceil(combo.cards.length / 2)) continue;

      unified.push({
        source: 'spellbook',
        cards: combo.cards,
        description: combo.description,
        category: mapProducesToCategory(combo.produces),
        present,
        missing,
        spellbookUrl: combo.spellbookUrl,
        produces: combo.produces,
      });
    }
  }

  // Sort: complete combos first, then by fewer missing pieces
  unified.sort((a, b) => a.missing.length - b.missing.length);
  return unified;
}

function renderCombos(deck: DeckbuilderDeck): void {
  const container = byId<HTMLDivElement>('combosPanel');
  container.textContent = '';

  // Loading indicator
  if (spellbookInFlight) {
    const loader = document.createElement('div');
    loader.className = 'combo-loading';
    loader.textContent = 'Checking Commander Spellbook\u2026';
    container.appendChild(loader);
  }

  // Error notice (non-blocking)
  if (spellbookError) {
    const err = document.createElement('div');
    err.className = 'combo-api-error';
    err.textContent = `Spellbook: ${spellbookError}`;
    container.appendChild(err);
  }

  const combos = detectCombos(deck);
  if (combos.length === 0 && !spellbookInFlight) {
    const msg = document.createElement('span');
    msg.className = 'muted';
    msg.style.fontSize = '0.78rem';
    msg.textContent = 'No known combos detected in your deck.';
    container.appendChild(msg);
    return;
  }

  // Group by category
  const byCategory = new Map<ComboCategory | 'API', UnifiedCombo[]>();
  for (const entry of combos) {
    if (!byCategory.has(entry.category)) byCategory.set(entry.category, []);
    byCategory.get(entry.category)!.push(entry);
  }

  for (const [category, catCombos] of byCategory) {
    const header = document.createElement('div');
    header.className = 'combo-category-header';
    header.textContent = `${COMBO_ICONS[category] || ''} ${category}`;
    container.appendChild(header);

    for (const entry of catCombos) {
      const { cards, present, missing, source } = entry;
      const item = document.createElement('div');
      item.className = `combo-item ${missing.length === 0 ? 'complete' : 'partial'}`;

      // Card thumbnail row
      const cardRow = document.createElement('div');
      cardRow.className = 'combo-card-row';
      for (let i = 0; i < cards.length; i++) {
        if (i > 0) {
          const plus = document.createElement('span');
          plus.className = 'combo-card-plus';
          plus.textContent = '+';
          cardRow.appendChild(plus);
        }
        const name = cards[i];
        const isMissing = missing.includes(name);
        const card = resolvedCardByName[normalizeNameKey(name)];
        const imgSrc = card?.image_uris?.small || card?.image_uris?.normal || '';

        if (imgSrc) {
          const img = document.createElement('img');
          img.src = imgSrc;
          img.alt = name;
          img.className = 'combo-card-img';
          img.loading = 'lazy';
          if (isMissing) img.classList.add('combo-card-missing');
          cardRow.appendChild(img);
        } else {
          const pill = document.createElement('span');
          pill.className = isMissing ? 'combo-card-pill missing' : 'combo-card-pill';
          pill.textContent = name;
          cardRow.appendChild(pill);
        }
      }

      // Bottom row: description + source badge + status badge
      const bottom = document.createElement('div');
      bottom.className = 'combo-bottom';

      const desc = document.createElement('div');
      desc.className = 'combo-desc';
      desc.textContent = entry.description;

      const sourceBadge = document.createElement('span');
      sourceBadge.className = source === 'spellbook' ? 'combo-source spellbook' : 'combo-source local';
      sourceBadge.textContent = source === 'spellbook' ? 'Spellbook' : 'Local';

      const status = document.createElement('span');
      status.className = missing.length === 0 ? 'combo-status complete' : 'combo-status partial';
 status.textContent = missing.length === 0 ? ' Complete' : `${present.length}/${cards.length}`;

      bottom.append(desc, sourceBadge, status);
      item.append(cardRow, bottom);

      // "Find missing" button for partial combos
      if (missing.length > 0) {
        const searchBtn = document.createElement('button');
        searchBtn.className = 'combo-search-btn';
        searchBtn.textContent = `Find: ${missing[0]}`;
        searchBtn.addEventListener('click', () => {
          const searchInput = document.getElementById('searchInput') as HTMLInputElement | null;
          if (searchInput) {
            searchInput.value = missing[0];
            searchInput.dispatchEvent(new Event('input'));
            searchInput.focus();
          }
        });
        item.appendChild(searchBtn);
      }

      // Spellbook link for API combos
      if (entry.spellbookUrl) {
        const link = document.createElement('a');
        link.className = 'combo-spellbook-link';
        link.href = entry.spellbookUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'View on Spellbook \u2197';
        item.appendChild(link);
      }

      container.appendChild(item);
    }
  }
}

/**
 * Render Commander Stats Widget (async)
 */
function renderCommanderStatsWidgetAsync(deck: DeckbuilderDeck): void {
  const container = byId<HTMLDivElement>('commanderStatsWidget');
  if (!container) return;

  // Render asynchronously (don't block analytics rendering)
  renderCommanderStatsWidget(container, deck).catch(err => {
    console.error('[Commander Stats] Render error:', err);
    container.innerHTML = `
      <div class="commander-stats-error">
        <div class="error-icon">${svgMarkup("warning")}</div>
        <p class="error-text">Failed to load stats</p>
      </div>
    `;
  });
}

/** B1: Always-visible analytics summary bar */
function renderAnalyticsSummaryBar(
  deck: DeckbuilderDeck,
  data: { curve: Record<string, number>; colors: Record<string, number>; landCount: number },
): void {
  const bar = document.getElementById('analyticsSummaryBar');
  if (!bar) return;
  bar.textContent = '';

  const cardCount = totalCards(deck.boards.mainboard) + totalCards(deck.boards.commander);
  const avgCmc = Object.entries(data.curve).reduce((s, [k, v]) => s + Number(k) * v, 0) /
    Math.max(1, Object.values(data.curve).reduce((s, v) => s + v, 0));
  const topColors = Object.entries(data.colors)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([c]) => c)
    .join('');

  const items: [string, string][] = [
    ['Cards', `${cardCount}/100`],
    ['Avg CMC', avgCmc.toFixed(1)],
    ['Colors', topColors || '\u2014'],
    ['Lands', String(data.landCount)],
  ];

  for (const [label, value] of items) {
    const el = document.createElement('span');
    el.className = 'summary-item';
    el.innerHTML = `${label}: <span class="summary-value">${value}</span>`;
    bar.appendChild(el);
  }
}

function renderAnalytics(): void {
  if (!currentDeck) return;

  // Empty state for analytics
  if (currentDeck.boards.mainboard.length === 0 && currentDeck.boards.commander.length === 0) {
    const container = byId<HTMLDivElement>('manaCurveChart');
    container.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.style.padding = '32px 0';
    empty.innerHTML = '';
    const icon = document.createElement('div');
    icon.className = 'empty-state-icon';
 icon.textContent = '▤';
    const msg = document.createElement('p');
    msg.className = 'empty-state-text';
    msg.textContent = 'Add cards to your deck to see analytics, mana curve, and power level.';
    empty.append(icon, msg);
    container.appendChild(empty);
    return;
  }

  const data = computeAnalyticsDataCached(currentDeck);

  // B1: Render always-visible summary bar
  renderAnalyticsSummaryBar(currentDeck, data);

  // Commander Stats Widget
  renderCommanderStatsWidgetAsync(currentDeck);

  renderManaCurveChart(data.curve);
  renderColorDonut(data.colors);
  renderTypeDistribution(data.types);
  renderPowerBracket(currentDeck);
  renderHealthScore(byId<HTMLDivElement>('healthScoreBox'), currentDeck, resolvedCardByName);
  renderOfficialBracket(currentDeck);
  renderDeckTips(currentDeck);
  renderDeckFingerprint(byId<HTMLDivElement>('fingerprintBox'), currentDeck, resolvedCardByName);
  renderManaCalc(byId<HTMLDivElement>('manaCalcBox'), currentDeck, resolvedCardByName);
  renderSynergyMap(byId<HTMLDivElement>('synergyMapBox'), currentDeck, resolvedCardByName);
  renderCombos(currentDeck);

  // Draw Probability Calculator
  const deckSize = totalCards(currentDeck.boards.mainboard) + totalCards(currentDeck.boards.commander);
  renderDrawProbability(byId<HTMLDivElement>('drawProbabilityBox'), data.tags, deckSize, [
    ...currentDeck.boards.mainboard,
    ...currentDeck.boards.commander,
  ]);

  const nonland = totalCards(currentDeck.boards.mainboard) - data.landCount;
  byId<HTMLDivElement>('analyticsLandSplit').textContent = `Lands ${data.landCount} | Nonlands ${nonland}`;

  const tagText = Object.keys(data.tags).length > 0
    ? Object.entries(data.tags).map(([k, v]) => `${k}:${v}`).join(' | ')
    : 'none';
  
  // Matchup Strategy Widget (for panel-layout system)
  const matchupWidgetContainer = document.getElementById('matchupStrategyWidget');
  if (matchupWidgetContainer && currentDeck) {
    const metaModeSelect = document.getElementById('strategyMetaMode') as HTMLSelectElement | null;
    const metaMode = (metaModeSelect?.value || 'commander-pod') as MatchupMetaMode;
    renderMatchupStrategyWidget(matchupWidgetContainer, currentDeck, resolvedCardByName, metaMode);
  }

  // Deck Solver Widget (for panel-layout system)
  const solverWidgetContainer = document.getElementById('deckSolverWidget');
  if (solverWidgetContainer && currentDeck) {
    renderDeckSolverWidget(solverWidgetContainer, currentDeck, resolvedCardByName);
  }

  // Cut Suggestions Widget (for panel-layout system)
  const cutWidgetContainer = document.getElementById('cutSuggestionsWidget');
  if (cutWidgetContainer && currentDeck) {
    renderCutSuggestionsWidget(cutWidgetContainer, currentDeck, resolvedCardByName);
  }

  // Simulation Widget (for panel-layout system)
  const simulationWidgetContainer = document.getElementById('simulationWidget');
  if (simulationWidgetContainer && currentDeck) {
    renderSimulationWidget(simulationWidgetContainer, currentDeck, resolvedCardByName);
  }
  byId<HTMLDivElement>('analyticsTags').textContent = tagText;
}

function renderPricing(): void {
  if (!currentDeck) return;
  const summary = computeDeckPriceSummary(currentDeck, resolvedCardByName);
  const pref = getStoredCurrencyPreference();

  // Show preferred currency prominently, secondary dimmed
  const eurEl = byId<HTMLSpanElement>('priceEurTotal');
  const usdEl = byId<HTMLSpanElement>('priceUsdTotal');
  eurEl.textContent = `EUR ${summary.eurTotal.toFixed(2)}`;
  usdEl.textContent = `USD ${summary.usdTotal.toFixed(2)}`;

  if (pref === 'EUR') {
    eurEl.style.fontSize = '1.1rem';
    eurEl.style.opacity = '1';
    usdEl.style.fontSize = '0.85rem';
    usdEl.style.opacity = '0.55';
  } else {
    usdEl.style.fontSize = '1.1rem';
    usdEl.style.opacity = '1';
    eurEl.style.fontSize = '0.85rem';
    eurEl.style.opacity = '0.55';
  }

  // Currency toggle
  const toggleContainer = document.getElementById('currencyToggle');
  if (toggleContainer && !toggleContainer.dataset.initialized) {
    toggleContainer.dataset.initialized = 'true';
    toggleContainer.innerHTML = '';
    for (const currency of ['EUR', 'USD'] as PriceCurrency[]) {
      const btn = document.createElement('button');
      btn.className = `currency-btn${pref === currency ? ' active' : ''}`;
      btn.textContent = currency;
      btn.addEventListener('click', () => {
        setStoredCurrencyPreference(currency);
        toggleContainer.dataset.initialized = '';
        renderPricing();
      });
      toggleContainer.appendChild(btn);
    }
  }

  byId<HTMLDivElement>('priceMeta').textContent = `${summary.cardsWithMissingPrice} card(s) missing EUR/USD source pricing.`;

  const expensive = byId<HTMLDivElement>('priceTopExpensive');
  expensive.textContent = '';
  for (const item of getTopExpensiveCards(summary, 10)) {
    const row = document.createElement('div');
    row.className = 'price-top-row';

    const priceText = pref === 'EUR'
      ? `EUR ${(item.eur * item.qty).toFixed(2)} | USD ${(item.usd * item.qty).toFixed(2)}`
      : `USD ${(item.usd * item.qty).toFixed(2)} | EUR ${(item.eur * item.qty).toFixed(2)}`;

    const info = document.createElement('span');
    info.className = 'muted';
    info.textContent = `${item.qty}x ${item.name} — ${priceText}`;

    const links = document.createElement('span');
    links.className = 'price-buy-links';

    const cmLink = document.createElement('a');
    cmLink.className = 'price-buy-link price-buy-cm';
    cmLink.href = buildCardmarketCardUrl(item.name);
    cmLink.target = '_blank';
    cmLink.rel = 'noopener noreferrer';
    cmLink.textContent = 'CM';

    const tcgLink = document.createElement('a');
    tcgLink.className = 'price-buy-link price-buy-tcg';
    tcgLink.href = buildTcgplayerCardUrl(item.name);
    tcgLink.target = '_blank';
    tcgLink.rel = 'noopener noreferrer';
    tcgLink.textContent = 'TCG';

    links.append(cmLink, tcgLink);
    row.append(info, links);
    expensive.append(row);
  }

  // Collection Panel (full-featured replacement for old missing cards list)
  renderCollectionPanel(byId<HTMLDivElement>('collectionMissing'), currentDeck, resolvedCardByName, {
    onCollectionChanged: () => {
      renderPricing();
    },
  });

  // Budget optimizer
  renderBudgetOptimizer(byId<HTMLDivElement>('budgetOptimizerBox'), currentDeck, resolvedCardByName, {
    onSwap: (cutName, addName) => {
      if (!currentDeck) return;
      removeEntry('mainboard', cutName);
      upsertEntry('mainboard', addName, 1);
      saveAndRender();
    },
  });

  // Budget Alternatives with Synergy Impact
  renderBudgetAlternatives(byId<HTMLDivElement>('budgetAlternativesBox'), currentDeck, resolvedCardByName, {
    onSwap: (cutName, addName) => {
      if (!currentDeck) return;
      // Calculate health BEFORE the swap
      const healthBefore = calculateDeckHealth(currentDeck, resolvedCardByName);
      removeEntry('mainboard', cutName);
      upsertEntry('mainboard', addName, 1);
      // Calculate health AFTER the swap
      const healthAfter = calculateDeckHealth(currentDeck, resolvedCardByName);
      const delta = healthAfter.total - healthBefore.total;
      saveAndRender();
      // Show toast with synergy impact
      if (delta > 0) {
        showToast({ message: `Swapped ${cutName} → ${addName} ↑ Health +${delta}`, type: 'success' });
      } else if (delta < 0) {
        showToast({ message: `Swapped ${cutName} → ${addName} ↓ Health ${delta}`, type: 'warning' });
      } else {
        showToast({ message: `Swapped ${cutName} → ${addName}  → Health unchanged`, type: 'info' });
      }
    },
  });
}

function toSharePayload(deck: DeckbuilderDeck): DeckbuilderShareDeckPayload {
  return {
    name: deck.name,
    description: deck.description || undefined,
    boards: {
      commander: deck.boards.commander,
      mainboard: deck.boards.mainboard,
      sideboard: deck.boards.sideboard,
      maybeboard: deck.boards.maybeboard,
    },
  };
}

function buildPlainTextExport(deck: DeckbuilderDeck): string {
  const lines: string[] = [];
  lines.push('Commander:');
  for (const entry of deck.boards.commander) lines.push(`${entry.qty} ${entry.name}`);
  lines.push('');
  lines.push('Mainboard:');
  for (const entry of deck.boards.mainboard) lines.push(`${entry.qty} ${entry.name}`);
  if (deck.boards.sideboard.length > 0) {
    lines.push('');
    lines.push('Sideboard:');
    for (const entry of deck.boards.sideboard) lines.push(`${entry.qty} ${entry.name}`);
  }
  if (deck.boards.maybeboard.length > 0) {
    lines.push('');
    lines.push('Maybeboard:');
    for (const entry of deck.boards.maybeboard) lines.push(`${entry.qty} ${entry.name}`);
  }
  return lines.join('\n').trim();
}

function formatArenaEntry(entry: DeckbuilderCardEntry): string {
  const card = resolvedCardByName[entry.name.trim().toLowerCase().replace(/\s+/g, ' ')];
  if (card?.set && card?.collector_number) {
    return `${entry.qty} ${entry.name} (${card.set.toUpperCase()}) ${card.collector_number}`;
  }
  return `${entry.qty} ${entry.name}`;
}

function buildArenaExport(deck: DeckbuilderDeck): string {
  const lines: string[] = [];
  if (deck.boards.commander.length > 0) {
    lines.push('Commander');
    for (const entry of deck.boards.commander) lines.push(formatArenaEntry(entry));
    lines.push('');
  }
  lines.push('Deck');
  for (const entry of deck.boards.mainboard) lines.push(formatArenaEntry(entry));
  if (deck.boards.sideboard.length > 0) {
    lines.push('');
    lines.push('Sideboard');
    for (const entry of deck.boards.sideboard) lines.push(formatArenaEntry(entry));
  }
  return lines.join('\n').trim();
}

function buildMtgoExport(deck: DeckbuilderDeck): string {
  const lines: string[] = [];
  for (const entry of deck.boards.commander) lines.push(`${entry.qty} ${entry.name}`);
  for (const entry of deck.boards.mainboard) lines.push(`${entry.qty} ${entry.name}`);
  if (deck.boards.sideboard.length > 0) {
    lines.push('');
    lines.push('Sideboard');
    for (const entry of deck.boards.sideboard) lines.push(`${entry.qty} ${entry.name}`);
  }
  return lines.join('\n').trim();
}

/** C2: Persistent import summary banner */
function showImportSummaryBanner(resolvedCount: number, unresolvedCount: number): void {
  // Remove any existing banner
  document.getElementById('importSummaryBanner')?.remove();
  if (resolvedCount === 0 && unresolvedCount === 0) return;

  const banner = document.createElement('div');
  banner.id = 'importSummaryBanner';
  banner.className = `import-summary-banner ${unresolvedCount > 0 ? 'import-summary-banner--warn' : 'import-summary-banner--ok'}`;

  const msg = document.createElement('span');
  msg.textContent = unresolvedCount > 0
    ? `Imported ${resolvedCount}/${resolvedCount + unresolvedCount} cards. ${unresolvedCount} unresolved \u2014 click to resolve.`
    : `Successfully imported ${resolvedCount} card(s).`;
  banner.appendChild(msg);

  if (unresolvedCount > 0) {
    banner.style.cursor = 'pointer';
    banner.addEventListener('click', () => {
      const resolver = document.getElementById('importUnresolved');
      if (resolver) resolver.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  const closeBtn = document.createElement('button');
  closeBtn.className = 'import-summary-banner__close';
  closeBtn.textContent = '\u00d7';
  closeBtn.setAttribute('aria-label', 'Dismiss');
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); banner.remove(); });
  banner.appendChild(closeBtn);

  // Auto-dismiss success banners after 8s
  if (unresolvedCount === 0) {
    setTimeout(() => banner.remove(), 8000);
  }

  // Insert at top of editor workspace
  const workspace = document.querySelector('.editor-workspace') || document.querySelector('.editor-grid') || document.body;
  workspace.prepend(banner);
}

function renderUnresolvedImports(): void {
  const container = byId<HTMLDivElement>('importUnresolved');
  container.textContent = '';

  if (unresolvedImportRows.length === 0) {
    return;
  }

  const heading = document.createElement('h4');
  heading.textContent = 'Unresolved import lines';
  container.append(heading);

  for (const row of unresolvedImportRows) {
    const box = document.createElement('div');
    box.className = 'unresolved-row';

    const label = document.createElement('span');
    label.textContent = `Line ${row.lineNumber}: ${row.qty} ${row.name} (${row.reason})`;

    const select = document.createElement('select');
    select.dataset.lineNumber = String(row.lineNumber);
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = row.reason === 'missing' ? 'No match' : 'Choose a card';
    select.append(empty);

    for (const candidate of row.candidates) {
      const option = document.createElement('option');
      option.value = candidate;
      option.textContent = candidate;
      select.append(option);
    }

    box.append(label, select);
    container.append(box);
  }
}

async function applyImportText(): Promise<void> {
  if (!currentDeck) return;
  const raw = byId<HTMLTextAreaElement>('importInput').value;
  const parsed = parseDeckbuilderImportText(raw);
  if (parsed.errors.length > 0) {
    showToast({ message: parsed.errors.slice(0, 3).join(' | '), type: 'error' });
  } else {
    showToast({ message: `Parsed ${parsed.lines.length} import lines.`, type: 'success' });
  }

  const names = Array.from(new Set(parsed.lines.map((line) => line.name)));
  const resolvedResponse = await resolveDeckbuilderCards(names);

  const suggestionsByName: Record<string, string[]> = {};
  for (const missing of resolvedResponse.missing.slice(0, 20)) {
    try {
      const suggestions = await fetchDeckbuilderAutocomplete(missing);
      suggestionsByName[normalizeNameKey(missing)] = suggestions.slice(0, 8);
    } catch {
      suggestionsByName[normalizeNameKey(missing)] = [];
    }
  }

  const resolution = resolveParsedImportLines({
    lines: parsed.lines,
    resolvedByName: resolvedResponse.resolved,
    suggestionsByName,
  });

  const mergedBoards = mergeBoards(currentDeck.boards, toBoardsFromResolvedImport(resolution.resolved));
  currentDeck.boards = mergedBoards;

  unresolvedImportRows = resolution.unresolved;
  renderUnresolvedImports();

  for (const resolved of resolution.resolved) {
    const key = normalizeNameKey(resolved.resolvedName);
    resolvedCardByName[key] = resolvedResponse.resolved[key] || resolvedResponse.resolved[normalizeNameKey(resolved.originalName)] || resolvedCardByName[key];
  }

  saveAndRender();

  // C2: Import validation summary banner
  showImportSummaryBanner(resolution.resolved.length, resolution.unresolved.length);

  // A4: Smart commander detection — if commander zone is empty, check for legendary creatures
  if (currentDeck.boards.commander.length === 0) {
    detectAndPromoteCommander(currentDeck, resolvedCardByName);
  }

  // Auto-launch optimization wizard after import if deck is large enough
  trackFunnelStep('import', { cardCount: currentDeck.boards.mainboard.reduce((s, e) => s + e.qty, 0) });
  if (currentDeck.boards.mainboard.length >= 10) {
    trackPremiumFeatureUse('optimization_wizard');
    setTimeout(() => openOptimizationWizard(getWizardCallbacks(), 'import_auto'), 500);
  }
}

function applySelectedUnresolvedRows(): void {
  if (!currentDeck) return;
  const selects = Array.from(document.querySelectorAll<HTMLSelectElement>('#importUnresolved select[data-line-number]'));
  const chosen: ImportResolvedLine[] = [];
  const remaining: DeckbuilderImportUnresolved[] = [];

  for (const unresolved of unresolvedImportRows) {
    const select = selects.find((item) => item.dataset.lineNumber === String(unresolved.lineNumber));
    const selected = select?.value.trim() || '';
    if (!selected) {
      remaining.push(unresolved);
      continue;
    }
    chosen.push({
      lineNumber: unresolved.lineNumber,
      board: unresolved.board,
      qty: unresolved.qty,
      originalName: unresolved.name,
      resolvedName: selected,
    });
  }

  if (chosen.length > 0) {
    currentDeck.boards = mergeBoards(currentDeck.boards, toBoardsFromResolvedImport(chosen));
  }

  unresolvedImportRows = remaining;
  renderUnresolvedImports();
  saveAndRender();
}

async function refreshMissingCardData(forceReload = false): Promise<void> {
  if (!currentDeck) {
    return;
  }
  if (resolveInFlight) {
    return;
  }

  let names: string[];
  if (forceReload) {
    // Force reload all cards
    names = allDeckNames(currentDeck);
  } else {
    // Only load missing cards
    names = allDeckNames(currentDeck).filter((name) => !resolvedCardByName[normalizeNameKey(name)]);
  }

  if (names.length === 0) {
    return;
  }

  resolveInFlight = true;
  try {
    const { resolved, missing } = await resolveDeckbuilderCards(names);

    for (const [apiKey, value] of Object.entries(resolved)) {
      // Store under both the API returned key and our normalized key
      const normKey = normalizeNameKey(apiKey);
      resolvedCardByName[normKey] = value;
      resolvedCardByName[apiKey] = value;
    }
  } catch (error) {
    console.error('[Deckbuilder] Failed to load card data:', error);
    throw error;
  } finally {
    resolveInFlight = false;
  }
}

async function refreshSpellbookCombos(): Promise<void> {
  if (!currentDeck || spellbookInFlight) return;

  const hash = deckContentHash(currentDeck);
  if (hash === spellbookLastHash && spellbookCombos) return;

  const commanders = currentDeck.boards.commander.map((e) => e.name);
  const main = currentDeck.boards.mainboard.map((e) => e.name);

  if (commanders.length === 0 && main.length < 5) {
    spellbookCombos = null;
    spellbookError = null;
    return;
  }

  spellbookInFlight = true;
  spellbookError = null;
  renderCombos(currentDeck);

  try {
    spellbookCombos = await fetchSpellbookCombos(commanders, main);
    spellbookLastHash = hash;
  } catch (e) {
    spellbookError = e instanceof Error ? e.message : 'Spellbook lookup failed.';
    spellbookCombos = null;
  } finally {
    spellbookInFlight = false;
    if (currentDeck) renderCombos(currentDeck);
  }
}

function openSearchSidebar(): void {
  if (sidebarOpen) return;
  sidebarOpen = true;
  const sidebar = byId<HTMLElement>('searchSidebar');
  sidebar.classList.add('active');
  sidebar.setAttribute('aria-hidden', 'false');
  byId<HTMLDivElement>('searchResults').classList.add('sidebar-active');
}

function closeSearchSidebar(): void {
  if (!sidebarOpen) return;
  sidebarOpen = false;
  const sidebar = byId<HTMLElement>('searchSidebar');
  sidebar.classList.remove('active');
  sidebar.setAttribute('aria-hidden', 'true');
  byId<HTMLDivElement>('searchResults').classList.remove('sidebar-active');
}

function showSearchSkeletons(): void {
  const grid = byId<HTMLDivElement>('searchSidebarGrid');
  grid.textContent = '';
  for (let i = 0; i < 8; i++) {
    const skel = document.createElement('div');
    skel.className = 'skeleton skeleton-card';
    grid.appendChild(skel);
  }
  openSearchSidebar();
}

// ==================== Search History ====================

function getSearchHistory(): string[] {
  return storageGet<string[]>(STORAGE_KEYS.DECKBUILDER_SEARCH_HISTORY, []);
}

function addToSearchHistory(term: string): void {
  const trimmed = term.trim();
  if (!trimmed || trimmed === '*') return;
  let history = getSearchHistory();
  history = history.filter((h) => h.toLowerCase() !== trimmed.toLowerCase());
  history.unshift(trimmed);
  if (history.length > 10) history = history.slice(0, 10);
  storageSet(STORAGE_KEYS.DECKBUILDER_SEARCH_HISTORY, history);
}

let searchHistoryContainer: HTMLElement | null = null;

function renderSearchHistoryChips(): void {
  if (!searchHistoryContainer) {
    searchHistoryContainer = document.createElement('div');
    searchHistoryContainer.className = 'search-history-chips';
    const searchContainer = byId<HTMLInputElement>('searchInput').closest('.sidebar-search');
    if (searchContainer) searchContainer.after(searchHistoryContainer);
  }

  const history = getSearchHistory();
  if (history.length === 0) {
    searchHistoryContainer.style.display = 'none';
    return;
  }

  searchHistoryContainer.style.display = '';
  searchHistoryContainer.textContent = '';

  const label = document.createElement('span');
  label.className = 'search-history-label';
  label.textContent = 'Recent:';
  searchHistoryContainer.appendChild(label);

  for (const term of history.slice(0, 8)) {
    const chip = document.createElement('button');
    chip.className = 'search-history-chip';
    chip.textContent = term;
    chip.addEventListener('mousedown', (e) => {
      e.preventDefault(); // Prevent blur from firing before click
      byId<HTMLInputElement>('searchInput').value = term;
      hideSearchHistoryChips();
      void runSearch(term);
    });
    searchHistoryContainer.appendChild(chip);
  }
}

function showSearchHistoryChips(): void {
  renderSearchHistoryChips();
}

function hideSearchHistoryChips(): void {
  if (searchHistoryContainer) searchHistoryContainer.style.display = 'none';
}

// ==================== F1: Saved Search Queries ====================

let savedSearchContainer: HTMLElement | null = null;

function getSavedSearches(): string[] {
  return storageGet<string[]>(STORAGE_KEYS.DECKBUILDER_SAVED_SEARCHES, []);
}

function addSavedSearch(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  let saved = getSavedSearches();
  if (saved.some((s) => s.toLowerCase() === trimmed.toLowerCase())) return false;
  saved.unshift(trimmed);
  if (saved.length > 10) saved = saved.slice(0, 10);
  storageSet(STORAGE_KEYS.DECKBUILDER_SAVED_SEARCHES, saved);
  renderSavedSearchChips();
  return true;
}

function removeSavedSearch(query: string): void {
  let saved = getSavedSearches();
  saved = saved.filter((s) => s.toLowerCase() !== query.toLowerCase());
  storageSet(STORAGE_KEYS.DECKBUILDER_SAVED_SEARCHES, saved);
  renderSavedSearchChips();
}

function renderSavedSearchChips(): void {
  if (!savedSearchContainer) {
    savedSearchContainer = document.createElement('div');
    savedSearchContainer.className = 'saved-search-chips';
    const searchContainer = byId<HTMLInputElement>('searchInput').closest('.sidebar-search');
    if (searchContainer) searchContainer.after(savedSearchContainer);
  }

  const saved = getSavedSearches();
  if (saved.length === 0) {
    savedSearchContainer.style.display = 'none';
    return;
  }

  savedSearchContainer.style.display = '';
  savedSearchContainer.textContent = '';

  const label = document.createElement('span');
  label.className = 'saved-search-label';
 label.textContent = ' Saved:';
  savedSearchContainer.appendChild(label);

  for (const query of saved) {
    const chip = document.createElement('span');
    chip.className = 'saved-search-chip';

    const text = document.createElement('button');
    text.className = 'saved-search-chip-text';
    text.textContent = query.length > 20 ? query.slice(0, 20) + '\u2026' : query;
    text.title = query;
    text.addEventListener('mousedown', (e) => {
      e.preventDefault();
      byId<HTMLInputElement>('searchInput').value = query;
      void runSearch(query);
    });

    const del = document.createElement('button');
    del.className = 'saved-search-chip-del';
    del.textContent = '\u00D7';
    del.title = 'Remove saved search';
    del.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeSavedSearch(query);
    });

    chip.append(text, del);
    savedSearchContainer.appendChild(chip);
  }
}

function showSavedSearchChips(): void {
  renderSavedSearchChips();
}

function hideSavedSearchChips(): void {
  if (savedSearchContainer) savedSearchContainer.style.display = 'none';
}

// ==================== C4: localStorage Quota Monitoring ====================

let quotaBannerShown = false;

function checkLocalStorageQuota(): void {
  try {
    let total = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        total += key.length + (localStorage.getItem(key)?.length || 0);
      }
    }
    // localStorage limit is ~5MB = ~5,242,880 chars (UTF-16)
    const maxBytes = 5 * 1024 * 1024;
    const usagePercent = (total * 2) / maxBytes * 100; // *2 for UTF-16

    if (usagePercent > 80 && !quotaBannerShown) {
      quotaBannerShown = true;
      showStorageWarningBanner(Math.round(usagePercent));
    } else if (usagePercent <= 80 && quotaBannerShown) {
      quotaBannerShown = false;
      removeStorageWarningBanner();
    }
  } catch (err) {
    console.error('[Deckbuilder] Failed to check storage quota:', err);
  }
}

function showStorageWarningBanner(usagePercent: number): void {
  if (document.getElementById('storageWarningBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'storageWarningBanner';
  banner.className = 'storage-warning-banner';

  const msg = document.createElement('span');
 msg.textContent = `! Storage ${usagePercent}% full \u2014 decks may fail to save.`;

  const exportBtn = document.createElement('button');
  exportBtn.className = 'btn';
 exportBtn.textContent = ' Download All Decks';
  exportBtn.addEventListener('click', () => {
    exportAllDecksAsJson();
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.className = 'storage-warning-dismiss';
 dismissBtn.textContent = '✕';
  dismissBtn.addEventListener('click', () => {
    banner.remove();
  });

  banner.append(msg, exportBtn, dismissBtn);
  const header = document.querySelector('.editor-header');
  if (header) header.after(banner);
  else document.body.prepend(banner);
}

function removeStorageWarningBanner(): void {
  document.getElementById('storageWarningBanner')?.remove();
}

function exportAllDecksAsJson(): void {
  try {
    const decks = listDecks();
    const json = JSON.stringify(decks, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `decklens-all-decks-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast({ message: `Exported ${decks.length} decks.`, type: 'success' });
  } catch (err) {
    showToast({ message: 'Failed to export decks.', type: 'error' });
  }
}

// ==================== Search Typing Feedback ====================

let typingFeedbackEl: HTMLElement | null = null;

function showSearchTypingFeedback(): void {
  if (!typingFeedbackEl) {
    typingFeedbackEl = document.createElement('div');
    typingFeedbackEl.className = 'search-typing-feedback';
    typingFeedbackEl.textContent = 'Searching';
    for (let i = 0; i < 3; i++) {
      const dot = document.createElement('span');
      dot.className = 'typing-dot';
      dot.style.animationDelay = `${i * 0.2}s`;
      dot.textContent = '.';
      typingFeedbackEl.appendChild(dot);
    }
    const searchContainer = byId<HTMLInputElement>('searchInput').closest('.sidebar-search');
    if (searchContainer) searchContainer.after(typingFeedbackEl);
  }
  typingFeedbackEl.style.display = '';
}

function hideSearchTypingFeedback(): void {
  if (typingFeedbackEl) typingFeedbackEl.style.display = 'none';
}

// ==================== Search Results Badge ====================

let resultsBadgeEl: HTMLElement | null = null;

function updateSearchResultsBadge(count: number): void {
  if (!resultsBadgeEl) {
    resultsBadgeEl = document.createElement('span');
    resultsBadgeEl.className = 'search-results-badge';
    const countEl = byId<HTMLSpanElement>('searchSidebarCount');
    if (countEl.parentElement) countEl.parentElement.appendChild(resultsBadgeEl);
  }
  if (count > 0) {
    resultsBadgeEl.textContent = `${count} results`;
    resultsBadgeEl.style.display = '';
  } else {
    resultsBadgeEl.style.display = 'none';
  }
}

function scrollActiveSearchCardIntoView(): void {
  if (selectedSearchIndex < 0) return;
  const grid = byId<HTMLDivElement>('searchSidebarGrid');
  const activeCard = grid.querySelector('.search-card.active') as HTMLElement | null;
  if (activeCard) {
    activeCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function renderSearchResults(): void {
  const grid = byId<HTMLDivElement>('searchSidebarGrid');
  const countEl = byId<HTMLSpanElement>('searchSidebarCount');
  grid.textContent = '';

  if (searchResults.length === 0) {
    closeSearchSidebar();
    return;
  }

  openSearchSidebar();
  // Reset header title if it was changed by suggestions
  const headerH3 = document.querySelector('.search-sidebar-header h3');
  if (headerH3 && headerH3.textContent !== 'Search Results') headerH3.textContent = 'Search Results';

  // Show "showing X of Y results"
  const totalResults = allSearchResults.length;
  const showingCount = searchResults.length;
  if (showingCount < totalResults) {
    countEl.textContent = `Showing ${showingCount} of ${totalResults} results`;
  } else {
    countEl.textContent = `${totalResults} result${totalResults !== 1 ? 's' : ''}`;
  }

  searchResults.forEach((card, index) => {
    const imgSrc = card.image_uris?.small || card.image_uris?.normal || '';
    const isActive = index === selectedSearchIndex;

    const cardEl = document.createElement('div');
    cardEl.className = `search-card${isActive ? ' active' : ''}`;

    if (imgSrc) {
      const img = document.createElement('img');
      img.src = imgSrc;
      img.alt = card.name;
      img.loading = 'lazy';
      img.addEventListener('error', () => {
        const placeholder = document.createElement('div');
        placeholder.className = 'search-card-placeholder';
        placeholder.textContent = card.name;
        img.replaceWith(placeholder);
      });
      cardEl.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'search-card-placeholder';
      placeholder.textContent = card.name;
      cardEl.appendChild(placeholder);
    }

    // Card name overlay
    const nameOverlay = document.createElement('div');
    nameOverlay.className = 'search-card-name';
    nameOverlay.textContent = card.name;
    cardEl.appendChild(nameOverlay);

    // Click to add
    cardEl.addEventListener('click', () => {
      selectedSearchIndex = index;
      addSelectedSearchCard();
    });

    // Hover preview
    cardEl.addEventListener('mouseenter', (e) => {
      showHoverPreview(card, e);
    });
    cardEl.addEventListener('mouseleave', () => {
      hideHoverPreview();
    });

    // Drag support
    makeSearchResultDraggable(cardEl, card);

    grid.appendChild(cardEl);
  });

  // Add "Load More" button if there are more results
  if (searchResults.length < allSearchResults.length) {
    const remaining = allSearchResults.length - searchResults.length;
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'search-load-more-btn';
    loadMoreBtn.textContent = `Load More (${remaining} remaining)`;
    loadMoreBtn.addEventListener('click', () => {
      displayedSearchCount += 25;
      searchResults = allSearchResults.slice(0, displayedSearchCount);
      renderSearchResults();
    });
    grid.appendChild(loadMoreBtn);
  }

  scrollActiveSearchCardIntoView();
}

function getActiveColorFilters(): string {
  const active = Array.from(document.querySelectorAll<HTMLButtonElement>('.color-toggle.active'));
  return active.map((btn) => btn.dataset.color || '').filter(Boolean).join('');
}

function buildSearchFilters(): { colorIdentity?: string; type?: string; manaValue?: string; keyword?: string; oracleText?: string } {
  const filters: { colorIdentity?: string; type?: string; manaValue?: string; keyword?: string; oracleText?: string } = {};
  const colorId = getActiveColorFilters();
  if (colorId) filters.colorIdentity = colorId;
  const typeVal = byId<HTMLSelectElement>('filterType').value;
  if (typeVal) filters.type = typeVal;
  const cmcMin = byId<HTMLInputElement>('filterCmcMin').value;
  const cmcMax = byId<HTMLInputElement>('filterCmcMax').value;
  if (cmcMin || cmcMax) filters.manaValue = `${cmcMin || '0'}-${cmcMax || '16'}`;
  const keyword = byId<HTMLSelectElement>('filterKeyword').value;
  if (keyword) filters.keyword = keyword;
  const oracleText = byId<HTMLInputElement>('filterOracleText').value.trim();
  if (oracleText) filters.oracleText = oracleText;
  return filters;
}

function renderActiveFilterPills(): void {
  const container = document.getElementById('activeFilterPills');
  if (!container) return;
  container.textContent = '';

  const pills: Array<{ label: string; clear: () => void }> = [];

  // Color filters
  const activeColors = Array.from(document.querySelectorAll<HTMLButtonElement>('.color-toggle.active'));
  if (activeColors.length > 0) {
    const colorStr = activeColors.map((b) => b.dataset.color || '').join('');
    pills.push({
      label: `Color: ${colorStr}`,
      clear: () => { activeColors.forEach((b) => b.classList.remove('active')); queueSearch(); },
    });
  }

  const typeEl = byId<HTMLSelectElement>('filterType');
  if (typeEl.value) {
    pills.push({ label: `Type: ${typeEl.value}`, clear: () => { typeEl.value = ''; queueSearch(); } });
  }

  const cmcMin = byId<HTMLInputElement>('filterCmcMin').value;
  const cmcMax = byId<HTMLInputElement>('filterCmcMax').value;
  if (cmcMin || cmcMax) {
    pills.push({
      label: `CMC: ${cmcMin || '0'}–${cmcMax || '∞'}`,
      clear: () => { byId<HTMLInputElement>('filterCmcMin').value = ''; byId<HTMLInputElement>('filterCmcMax').value = ''; queueSearch(); },
    });
  }

  const keywordEl = byId<HTMLSelectElement>('filterKeyword');
  if (keywordEl.value) {
    pills.push({ label: `Keyword: ${keywordEl.value}`, clear: () => { keywordEl.value = ''; queueSearch(); } });
  }

  const oracleEl = byId<HTMLInputElement>('filterOracleText');
  if (oracleEl.value.trim()) {
    pills.push({ label: `Oracle: ${oracleEl.value.trim()}`, clear: () => { oracleEl.value = ''; queueSearch(); } });
  }

  for (const pill of pills) {
    const el = document.createElement('span');
    el.className = 'filter-pill';
    el.textContent = pill.label;
    const x = document.createElement('span');
    x.className = 'filter-pill-x';
 x.textContent = '';
    x.addEventListener('click', () => { pill.clear(); renderActiveFilterPills(); });
    el.appendChild(x);
    container.appendChild(el);
  }
}

async function runSearch(term: string): Promise<void> {
  let q = term.trim();
  const filters = buildSearchFilters();

  // ── Scryfall-like syntax parsing ──
  // Skip parsing if the query contains parentheses (advanced boolean logic),
  // as our simple parser will destroy the structure.
  if (hasSyntaxPrefixes(q) && !q.includes('(') && !q.includes(')')) {
    const parsed = parseSearchSyntax(q);
    q = parsed.textQuery;
    if (parsed.oracleText && !filters.oracleText) filters.oracleText = parsed.oracleText;
    if (parsed.type && !filters.type) filters.type = parsed.type;
    if (parsed.colorIdentity && !filters.colorIdentity) filters.colorIdentity = parsed.colorIdentity;
    if (parsed.keyword && !filters.keyword) filters.keyword = parsed.keyword;
    if (parsed.cmcValue !== undefined) {
      const op = parsed.cmcOp || '=';
      if (op === '=') {
        filters.manaValue = `${parsed.cmcValue}-${parsed.cmcValue}`;
      } else if (op === '>=') {
        filters.manaValue = `${parsed.cmcValue}-16`;
      } else if (op === '<=') {
        filters.manaValue = `0-${parsed.cmcValue}`;
      } else if (op === '>') {
        filters.manaValue = `${parsed.cmcValue + 1}-16`;
      } else if (op === '<') {
        filters.manaValue = `0-${parsed.cmcValue - 1}`;
      }
    }
  }

  const hasFilters = Object.keys(filters).length > 0;

  if (!q && !hasFilters) {
    searchResults = [];
    selectedSearchIndex = -1;
    renderSearchResults();
    return;
  }

  // Abort any in-flight search before starting a new one
  searchAbortController?.abort();
  searchAbortController = new AbortController();
  const { signal } = searchAbortController;

  showSearchSkeletons();

  try {
    const response = await searchDeckbuilderCards(
      { q: q || '*', legality: 'commander', sort: 'name', ...filters },
      { signal },
    );
    // Ignore result if this search was aborted while awaiting
    if (signal.aborted) return;
    allSearchResults = response.items; // Store ALL results
    displayedSearchCount = 25; // Reset to initial page
    searchResults = allSearchResults.slice(0, displayedSearchCount);
    selectedSearchIndex = searchResults.length > 0 ? 0 : -1;
    renderSearchResults();
    updateSearchResultsBadge(allSearchResults.length); // Show total count
    if (q) addToSearchHistory(q);
  } catch (error) {
    // Silently ignore aborted searches (user typed again)
    if (signal.aborted) return;
    showToast({ message: error instanceof Error ? error.message : 'Card search failed.', type: 'error' });
  }
}

function queueSearch(): void {
  if (searchDebounce) {
    clearTimeout(searchDebounce);
  }
  showSearchTypingFeedback();
  hideSearchHistoryChips();
  searchDebounce = setTimeout(() => {
    hideSearchTypingFeedback();
    renderActiveFilterPills();
    void runSearch(byId<HTMLInputElement>('searchInput').value);
  }, 180);
}

/** A1: Quick-add inline confirmation (replaces toast for card adds) */
let quickAddTimer: ReturnType<typeof setTimeout> | null = null;
function showQuickAddConfirmation(cardName: string): void {
  const el = document.getElementById('quickAddConfirm');
  if (!el) return;
 el.textContent = ` ${cardName}`;
  el.classList.add('visible');
  if (quickAddTimer) clearTimeout(quickAddTimer);
  quickAddTimer = setTimeout(() => { el.classList.remove('visible'); quickAddTimer = null; }, 1800);
}

/** C1: Check if a card already exists in any board (ignoring basic lands) */
function checkDuplicateWarning(cardName: string, card?: DeckbuilderSearchCard): void {
  if (!currentDeck) return;
  const key = normalizeNameKey(cardName);
  // Basic lands are exempt from singleton
  const typeLine = (card?.type_line ?? '').toLowerCase();
  if (typeLine.includes('basic land')) return;
  for (const board of BOARD_ORDER) {
    const existing = currentDeck.boards[board].find((e) => normalizeNameKey(e.name) === key);
    if (existing) {
      showToast({
 message: `! ${cardName} already in ${BOARD_LABEL[board]} (qty: ${existing.qty}). EDH is singleton!`,
        type: 'warning',
        duration: 5000,
      });
      return;
    }
  }
}

function addSelectedSearchCard(): void {
  if (!currentDeck || selectedSearchIndex < 0 || selectedSearchIndex >= searchResults.length) return;
  // D3: Block add when viewer
  if (isCurrentUserViewer()) {
    showToast({ message: 'You are in viewer mode — editing is disabled.', type: 'warning' });
    return;
  }
  const card = searchResults[selectedSearchIndex];
  if (!card) return;

  // C1: Warn about duplicate before adding (non-blocking)
  checkDuplicateWarning(card.name, card);

  upsertEntry(activeBoard, card.name, 1, card);
  resolvedCardByName[normalizeNameKey(card.name)] = card;
  trackAnalyticsEvent('feature_used', {
    feature: 'deckbuilder_add_card',
    board: activeBoard,
  });
  deferredSaveAndRender();

  // A1: Quick-Add Queue — inline confirmation + keep search focused
  showQuickAddConfirmation(card.name);
  const searchInput = byId<HTMLInputElement>('searchInput');
  searchInput.value = '';
  searchResults = [];
  selectedSearchIndex = -1;
  renderSearchResults();
  // Re-focus after a microtask so the browser processes the click event
  requestAnimationFrame(() => searchInput.focus());
}

function deckbuilderToDeck(deck: DeckbuilderDeck): Deck {
  return {
    main: deck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty })),
    sideboard: deck.boards.sideboard.map((e) => ({ name: e.name, qty: e.qty })),
    commander: deck.boards.commander.map((e) => ({ name: e.name, qty: e.qty })),
  };
}

let suggestInFlight = false;

async function runSuggestCards(): Promise<void> {
  if (!currentDeck || suggestInFlight) return;
  if (currentDeck.boards.commander.length === 0) {
    showToast({ message: 'Add a commander first to get card suggestions.', type: 'warning' });
    return;
  }

  suggestInFlight = true;
  showSearchSkeletons();
  showToast({ message: 'Fetching card suggestions...', type: 'info', duration: 2000 });

  try {
    const response = await fetchRecommendations({
      deck: deckbuilderToDeck(currentDeck),
      maxRecommendations: 25,
    });

    const recs = response.data.recommendations;
    if (recs.length === 0) {
      showToast({ message: 'No suggestions found for this deck.', type: 'info' });
      return;
    }

    // Resolve card images for the recommendations
    const names = recs.map((r) => r.add.name);
    const resolved = await resolveDeckbuilderCards(names);

    // Build search results from recommendations
    searchResults = recs.map((rec) => {
      const key = normalizeNameKey(rec.add.name);
      const card = resolved.resolved[key];
      if (card) {
        resolvedCardByName[key] = card;
        return card;
      }
      // Fallback: create minimal card object
      return {
        id: rec.id,
        name: rec.add.name,
        cmc: rec.add.cmc,
        type_line: '',
        image_uris: undefined,
      } as unknown as DeckbuilderSearchCard;
    });

    selectedSearchIndex = searchResults.length > 0 ? 0 : -1;

    // Update sidebar header to show "Suggestions" instead of "Search Results"
    const headerH3 = document.querySelector('.search-sidebar-header h3');
    if (headerH3) headerH3.textContent = 'Card Suggestions';

    renderSearchResults();
    showToast({ message: `${recs.length} card suggestions loaded.`, type: 'success' });
  } catch (error) {
    showToast({ message: error instanceof Error ? error.message : 'Failed to fetch suggestions.', type: 'error' });
  } finally {
    suggestInFlight = false;
  }
}

/** A2: Detect multi-line deck list paste in search input → open import tab */
function switchToImportTab(prefill: string): void {
  // Activate the import/deck tab
  const tabBtn = document.querySelector<HTMLButtonElement>('[data-tab="deck"]');
  if (tabBtn) tabBtn.click();
  const textarea = byId<HTMLTextAreaElement>('importInput');
  textarea.value = prefill;
  textarea.focus();
  showToast({ message: 'Deck list detected \u2014 pasted into import.', type: 'info', duration: 3000 });
}

/** A5: Show/hide syntax hint below search input */
function showSyntaxHint(): void {
  const hint = document.getElementById('searchSyntaxHint');
  if (hint) hint.classList.add('visible');
}
function hideSyntaxHint(): void {
  const hint = document.getElementById('searchSyntaxHint');
  if (hint) hint.classList.remove('visible');
}

function bindSearchEvents(): void {
  const input = byId<HTMLInputElement>('searchInput');
  input.addEventListener('input', () => {
    hideSyntaxHint();
    queueSearch();
  });
  input.addEventListener('focus', () => {
    if (input.value.trim() === '') {
      showSearchHistoryChips();
      showSyntaxHint();
    }
    showSavedSearchChips();
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { hideSearchHistoryChips(); hideSavedSearchChips(); hideSyntaxHint(); }, 250);
  });

  // A2: Paste-to-Import detection
  input.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text') ?? '';
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    // Heuristic: 3+ lines matching "Nxcardname" or "N cardname" pattern
    const deckLineRegex = /^\d+x?\s+.+/i;
    const matchCount = lines.filter((l) => deckLineRegex.test(l.trim())).length;
    if (lines.length >= 3 && matchCount >= 3) {
      e.preventDefault();
      input.value = '';
      switchToImportTab(text);
    }
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (searchResults.length === 0) return;
      selectedSearchIndex = (selectedSearchIndex + 1) % searchResults.length;
      renderSearchResults();
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (searchResults.length === 0) return;
      selectedSearchIndex = (selectedSearchIndex - 1 + searchResults.length) % searchResults.length;
      renderSearchResults();
      return;
    }

    if (event.key === 'Home') {
      event.preventDefault();
      if (searchResults.length === 0) return;
      selectedSearchIndex = 0;
      renderSearchResults();
      return;
    }

    if (event.key === 'End') {
      event.preventDefault();
      if (searchResults.length === 0) return;
      selectedSearchIndex = searchResults.length - 1;
      renderSearchResults();
      return;
    }

    if (event.key === 'PageDown') {
      event.preventDefault();
      if (searchResults.length === 0) return;
      selectedSearchIndex = Math.min(searchResults.length - 1, selectedSearchIndex + 10);
      renderSearchResults();
      return;
    }

    if (event.key === 'PageUp') {
      event.preventDefault();
      if (searchResults.length === 0) return;
      selectedSearchIndex = Math.max(0, selectedSearchIndex - 10);
      renderSearchResults();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      addSelectedSearchCard();
    }
  });
}

function initSyntaxHelp(): void {
  const btn = document.getElementById('btnSyntaxHelp');
  if (!btn) return;

  // Create tooltip
  const tooltip = document.createElement('div');
  tooltip.className = 'syntax-help-tooltip';
  const rows = [
    ['o:draw', 'Oracle text'],
    ['t:creature', 'Card type'],
    ['id:WU', 'Color identity'],
    ['cmc:3', 'Exact mana value'],
    ['cmc>=4', 'Mana value ≥ 4'],
    ['kw:flying', 'Keyword ability'],
  ];
  for (const [code, desc] of rows) {
    const row = document.createElement('div');
    row.className = 'syntax-help-row';
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    const descEl = document.createElement('span');
    descEl.textContent = `— ${desc}`;
    row.append(codeEl, descEl);
    tooltip.appendChild(row);
  }

  // Position relative to parent
  const parent = btn.parentElement;
  if (parent) { parent.style.position = 'relative'; parent.appendChild(tooltip); }

  btn.addEventListener('click', () => {
    tooltip.classList.toggle('show');
  });
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!btn.contains(e.target as Node) && !tooltip.contains(e.target as Node)) {
      tooltip.classList.remove('show');
    }
  });
}

function initSaveSearchButton(): void {
  const searchWrapper = byId<HTMLInputElement>('searchInput').closest('.sidebar-search');
  if (!searchWrapper) return;

  const saveBtn = document.createElement('button');
  saveBtn.className = 'save-search-btn hidden';
 saveBtn.textContent = ' Save';
  saveBtn.title = 'Save this search query';
  saveBtn.addEventListener('click', () => {
    const input = byId<HTMLInputElement>('searchInput');
    const query = input.value.trim();
    if (addSavedSearch(query)) {
      showToast({ message: `Search "${query}" saved.`, type: 'success', duration: 2000 });
    } else {
      showToast({ message: 'Already saved or empty.', type: 'info', duration: 2000 });
    }
  });
  searchWrapper.appendChild(saveBtn);

  // Show/hide the button based on input content
  byId<HTMLInputElement>('searchInput').addEventListener('input', () => {
    const val = byId<HTMLInputElement>('searchInput').value.trim();
    const hasSyntax = val.length > 2 && /(?:^|\s)(o:|t:|id:|cmc[:<>=!]|kw:)/.test(val);
    saveBtn.classList.toggle('hidden', !hasSyntax);
  });
}

function initSearchAutocomplete(): void {
  const input = byId<HTMLInputElement>('searchInput');
  searchAutocomplete = attachCardAutocomplete({
    input,
    debounceMs: 120,
    maxSuggestions: 8,
    deckCards: currentDeck ? currentDeck.boards.mainboard.map((e) => e.name) : [],
    onSelect: (cardName) => {
      input.value = cardName;
      void runSearch(cardName);
    },
  });
}

function bindFilterEvents(): void {
  byId<HTMLButtonElement>('btnToggleFilters').addEventListener('click', () => {
    const filters = byId<HTMLDivElement>('searchFilters');
    const isHidden = filters.style.display === 'none';
    filters.style.display = isHidden ? '' : 'none';
  });

  const colorToggles = Array.from(document.querySelectorAll<HTMLButtonElement>('.color-toggle'));
  for (const btn of colorToggles) {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      queueSearch();
    });
  }

  byId<HTMLSelectElement>('filterType').addEventListener('change', queueSearch);
  byId<HTMLInputElement>('filterCmcMin').addEventListener('change', queueSearch);
  byId<HTMLInputElement>('filterCmcMax').addEventListener('change', queueSearch);
  byId<HTMLSelectElement>('filterKeyword').addEventListener('change', queueSearch);
  byId<HTMLInputElement>('filterOracleText').addEventListener('input', queueSearch);

  byId<HTMLButtonElement>('btnClearFilters').addEventListener('click', () => {
    colorToggles.forEach((btn) => btn.classList.remove('active'));
    byId<HTMLSelectElement>('filterType').value = '';
    byId<HTMLInputElement>('filterCmcMin').value = '';
    byId<HTMLInputElement>('filterCmcMax').value = '';
    byId<HTMLSelectElement>('filterKeyword').value = '';
    byId<HTMLInputElement>('filterOracleText').value = '';
    queueSearch();
  });
}

let strategyDirty = true;
let historyDirty = true;

function applyRecWithHistory(rec: RecommendationV1Item, source: 'strategy_tab' | 'wizard'): void {
  if (!currentDeck) return;
  const cutName = rec.cut?.name || null;
  if (cutName) removeEntry('mainboard', cutName);
  upsertEntry('mainboard', rec.add.name, 1);

  // Record to recommendation history
  recordRecommendationApplyHistory({
    deckName: currentDeck.name,
    commanderNames: currentDeck.boards.commander.map((e) => e.name),
    recommendationId: rec.id,
    cardName: rec.add.name,
    mode: cutName ? 'swap' : 'add',
    cutName,
    reason: rec.reasons[0] || '',
    powerImpactLabel: rec.confidence >= 0.7 ? 'high' : rec.confidence >= 0.4 ? 'medium' : 'low',
    logicTags: categoryToLogicTags(rec.category),
  });

  // Track in activation funnel
  trackRecApplied(rec.id, cutName, rec.add.name, source);

  strategyDirty = true;
  historyDirty = true;
  invalidateMatchupCache();
  saveAndRender();
}

function renderSmartRecs(): void {
  if (!currentDeck) return;
  const metaMode = (byId<HTMLSelectElement>('recsMetaMode').value || 'balanced') as MetaMode;
  renderSmartRecsView(byId<HTMLDivElement>('smartRecsContainer'), currentDeck, resolvedCardByName, metaMode, {
    onApplySwap: (cutName, addName) => {
      if (!currentDeck) return;
      if (cutName) {
        removeEntry('mainboard', cutName);
      }
      upsertEntry('mainboard', addName, 1);
      strategyDirty = true;
      invalidateMatchupCache();
      saveAndRender();
    },
    onApplySwapWithMeta: (rec) => {
      applyRecWithHistory(rec, 'strategy_tab');
    },
  });
  renderRecHistory();
}

function renderRecHistory(): void {
  if (!currentDeck || !historyDirty) return;
  renderRecHistoryPanel(
    byId<HTMLDivElement>('recHistoryContainer'),
    currentDeck,
    resolvedCardByName,
    {
      onReapply: (cardName, mode, cutName) => {
        if (!currentDeck) return;
        trackPremiumFeatureUse('rec_history');
        if (mode === 'swap' && cutName) removeEntry('mainboard', cutName);
        upsertEntry('mainboard', cardName, 1);
        strategyDirty = true;
        historyDirty = true;
        invalidateMatchupCache();
        saveAndRender();
      },
    },
  );
  historyDirty = false;
}

let edhrecDirty = true;

function renderEdhrecTab(): void {
  if (!currentDeck || !edhrecDirty) return;
  const commanderName = currentDeck.boards.commander[0]?.name;
  const deckCardNames = new Set(
    [...currentDeck.boards.mainboard, ...currentDeck.boards.sideboard, ...currentDeck.boards.commander]
      .map((e) => normalizeNameKey(e.name)),
  );
  void renderEdhrecPanel(
    byId<HTMLDivElement>('edhrecPanelContainer'),
    commanderName,
    deckCardNames,
    (name) => {
      if (!currentDeck) return;
      upsertEntry('mainboard', name, 1);
      saveAndRender();
      showBatchableToast({ message: `Added ${name} to mainboard`, type: 'success', batchKey: 'card-add' });
    },
  );
  edhrecDirty = false;
}

function renderStrategyTab(): void {
  if (!currentDeck || !strategyDirty) return;
  const metaMode = (byId<HTMLSelectElement>('strategyMetaMode').value || 'commander-pod') as MatchupMetaMode;
  renderMatchupPanel(byId<HTMLDivElement>('matchupPanelContainer'), currentDeck, resolvedCardByName, metaMode);
  renderSmartRecs();
  strategyDirty = false;
}

function bindTabEvents(): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tab]'));
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const target = button.dataset.tab || 'deck';
      buttons.forEach((item) => {
        item.classList.remove('active');
        item.setAttribute('aria-selected', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-selected', 'true');

      const sections = Array.from(document.querySelectorAll<HTMLElement>('.tab-panel'));
      sections.forEach((section) => {
        section.classList.toggle('active', section.dataset.tabPanel === target);
      });

      if (target === 'strategy') { trackPremiumFeatureUse('matchup_panel'); renderStrategyTab(); }
      if (target === 'prices') trackPremiumFeatureUse('budget_optimizer');
      if (target === 'edhrec') renderEdhrecTab();
      if (target === 'repo') onRepoTabActive();
    });
  }

  // Strategy meta mode selectors
  byId<HTMLSelectElement>('strategyMetaMode').addEventListener('change', () => {
    invalidateMatchupCache();
    strategyDirty = true;
    renderStrategyTab();
  });
  byId<HTMLSelectElement>('recsMetaMode').addEventListener('change', () => {
    strategyDirty = true;
    renderSmartRecs();
  });
}

function bindBoardEvents(): void {
  for (const board of BOARD_ORDER) {
    byId<HTMLButtonElement>(`boardBtn-${board}`).addEventListener('click', () => setActiveBoard(board));
  }
}

function bindCollapsibles(): void {
  const triggers = document.querySelectorAll<HTMLElement>('.collapsible-trigger');
  for (const trigger of triggers) {
    // Set initial aria-expanded state
    const section = trigger.closest('.collapsible-section');
    const isOpen = section?.classList.contains('open') ?? false;
    trigger.setAttribute('aria-expanded', String(isOpen));

    trigger.addEventListener('click', () => {
      if (section) {
        section.classList.toggle('open');
        trigger.setAttribute('aria-expanded', String(section.classList.contains('open')));
      }
    });
  }
}

/** B1: Expand All / Collapse All toggle for analytics sections */
function bindAnalyticsToggleAll(): void {
  const btn = document.getElementById('btnToggleAllAnalytics');
  if (!btn) return;
  btn.addEventListener('click', () => {
    // Support both original tab layout and reparented widget layout
    let sections = document.querySelectorAll<HTMLElement>('.tab-panel[data-tab-panel="analytics"] .collapsible-section');
    if (sections.length === 0) {
      // Fallback: widgets may have been reparented by panel-layout into .layout-widget-body
      sections = document.querySelectorAll<HTMLElement>('.collapsible-section');
    }
    const allOpen = Array.from(sections).every((s) => s.classList.contains('open'));
    for (const section of sections) {
      section.classList.toggle('open', !allOpen);
      const trigger = section.querySelector('.collapsible-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', String(!allOpen));
    }
    btn.textContent = allOpen ? 'Expand All' : 'Collapse All';
  });
}

function bindPriceSubTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('[data-price-tab]');
  const panels = document.querySelectorAll<HTMLElement>('[data-price-panel]');
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const target = tab.dataset.priceTab;
      tabs.forEach((t) => t.classList.toggle('active', t.dataset.priceTab === target));
      panels.forEach((p) => p.classList.toggle('active', p.dataset.pricePanel === target));
    });
  }
}

function bindGlobalShortcuts(): void {
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const isInputLike = target && (
      target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.isContentEditable
    );

    if (event.key === '/' && !isInputLike) {
      event.preventDefault();
      byId<HTMLInputElement>('searchInput').focus();
      return;
    }

    // Escape: close hand tester → close sidebar → clear selection
    if (event.key === 'Escape') {
      const handOverlay = byId<HTMLDivElement>('handTesterOverlay');
      if (handOverlay.style.display !== 'none') {
        closeHandTester();
        return;
      }
      if (sidebarOpen) {
        closeSearchSidebar();
        searchResults = [];
        selectedSearchIndex = -1;
        byId<HTMLInputElement>('searchInput').value = '';
        return;
      }
      clearSelection();
      scheduleRenderBoardRows();
      return;
    }

    // Undo/Redo (works even in inputs)
    if ((event.ctrlKey || event.metaKey) && event.key === 'z' && !event.shiftKey) {
      if (!isInputLike && currentDeck) {
        event.preventDefault();
        if (undo(currentDeck)) {
          saveCurrentDeck();
          renderAll();
        }
        return;
      }
    }
    if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || (event.key === 'z' && event.shiftKey))) {
      if (!isInputLike && currentDeck) {
        event.preventDefault();
        if (redo(currentDeck)) {
          saveCurrentDeck();
          renderAll();
        }
        return;
      }
    }

    // Ctrl+F: Focus deck filter input (override browser find)
    if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
      event.preventDefault();
      const filterInput = document.getElementById('deckFilterInput') as HTMLInputElement | null;
      if (filterInput) {
        filterInput.focus();
        filterInput.select();
      }
      return;
    }

    if (isInputLike) return;

    // A3: Shift+1/2/3/4 → move selected cards to target board
    if (event.shiftKey && ['1', '2', '3', '4'].includes(event.key) && selectedCards.size > 0 && currentDeck) {
      const keyToBoard: Record<string, DeckBoard> = { '1': 'commander', '2': 'mainboard', '3': 'maybeboard', '4': 'sideboard' };
      const targetBoard = keyToBoard[event.key];
      if (targetBoard && targetBoard !== activeBoard) {
        let moved = 0;
        for (const key of selectedCards) {
          const entry = currentDeck.boards[activeBoard].find((item) => normalizeNameKey(item.name) === key);
          if (entry) { moveEntry(activeBoard, targetBoard, entry.name); moved++; }
        }
        clearSelection();
        saveAndRender();
        if (moved > 0) {
          showToast({ message: `Moved ${moved} card(s) to ${BOARD_LABEL[targetBoard]}`, type: 'success', duration: 2500 });
        }
      }
      return;
    }

    if (event.key === '1') setActiveBoard('commander');
    if (event.key === '2') setActiveBoard('mainboard');
    if (event.key === '3') setActiveBoard('maybeboard');
    if (event.key === '4') setActiveBoard('sideboard');

    // Delete selected cards (C3: confirm when removing 5+ cards)
    if (event.key === 'Delete' && selectedCards.size > 0 && currentDeck) {
      const deleteCount = selectedCards.size;
      const performDelete = (): void => {
        for (const key of selectedCards) {
          const entry = currentDeck!.boards[activeBoard].find(
            (item) => normalizeNameKey(item.name) === key
          );
          if (entry) removeEntry(activeBoard, entry.name);
        }
        clearSelection();
        saveAndRender();
      };
      if (deleteCount >= 5) {
        void showConfirmModal({
          title: 'Remove Cards',
          message: `Remove ${deleteCount} card(s) from ${BOARD_LABEL[activeBoard]}?`,
          confirmLabel: 'Remove',
          danger: true,
        }).then((confirmed) => { if (confirmed) performDelete(); });
      } else {
        performDelete();
      }
    }

    // Ctrl+A select all in current board
    if ((event.ctrlKey || event.metaKey) && event.key === 'a' && currentDeck) {
      event.preventDefault();
      for (const entry of currentDeck.boards[activeBoard]) {
        selectedCards.add(normalizeNameKey(entry.name));
      }
      updateBulkBar();
      scheduleRenderBoardRows();
    }
  });
}

function bindDeckMetaEvents(): void {
  byId<HTMLInputElement>('deckNameInput').addEventListener('change', () => {
    if (!currentDeck) return;
    currentDeck.name = byId<HTMLInputElement>('deckNameInput').value.trim() || 'Untitled Deck';
    saveAndRender();
    // Broadcast metadata change to collab session
    if (!isRemoteUpdate && isCollabActive()) {
      getCollabManager().sendDeckMeta(currentDeck.name, currentDeck.description || '');
    }
  });

  byId<HTMLSelectElement>('deckVisibility').addEventListener('change', () => {
    if (!currentDeck) return;
    const visibility = byId<HTMLSelectElement>('deckVisibility').value;
    if (visibility === 'private' || visibility === 'unlisted' || visibility === 'public') {
      currentDeck.visibility = visibility;
      saveAndRender();
    }
  });

  // C5: Format selector change handler
  byId<HTMLSelectElement>('deckFormat').addEventListener('change', () => {
    if (!currentDeck) return;
    const format = byId<HTMLSelectElement>('deckFormat').value as DeckFormat;
    currentDeck.format = format;
    saveAndRender();
  });

  byId<HTMLButtonElement>('btnBackToDecks').addEventListener('click', () => {
    window.location.href = '/decks';
  });

  byId<HTMLButtonElement>('btnBrowsePublic').addEventListener('click', () => {
    window.location.href = '/decks/public';
  });

  byId<HTMLButtonElement>('btnCompareDeck').addEventListener('click', () => {
    trackPremiumFeatureUse('deck_comparison');
    showCompareModal();
  });

  // Collab button → start a new collaborative editing session
  const btnStartCollab = document.getElementById('btnStartCollab');
  if (btnStartCollab) {
    btnStartCollab.addEventListener('click', () => {
      if (!currentDeck) return;
      if (isCollabActive()) return; // Already in a session
      void startCollabSession(currentDeck);
    });
  }

  // Description toggle
  byId<HTMLButtonElement>('btnToggleDescription').addEventListener('click', () => {
    const editor = byId<HTMLDivElement>('descriptionEditor');
    const isHidden = editor.style.display === 'none';
    editor.style.display = isHidden ? '' : 'none';
    const btn = byId<HTMLButtonElement>('btnToggleDescription');
    btn.title = isHidden ? 'Hide Notes' : 'Notes';
    btn.classList.toggle('active', isHidden);
  });

  // Description textarea change → save
  byId<HTMLTextAreaElement>('deckDescription').addEventListener('change', () => {
    if (!currentDeck) return;
    currentDeck.description = byId<HTMLTextAreaElement>('deckDescription').value;
    scheduleAutosave();
    // Broadcast metadata change to collab session
    if (!isRemoteUpdate && isCollabActive()) {
      getCollabManager().sendDeckMeta(currentDeck.name, currentDeck.description || '');
    }
  });

  // Description Edit/Preview tabs
  const descTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-desc-mode]'));
  for (const tab of descTabs) {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.descMode;
      descTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');

      const textarea = byId<HTMLTextAreaElement>('deckDescription');
      const preview = byId<HTMLDivElement>('descriptionPreview');

      if (mode === 'preview') {
        textarea.style.display = 'none';
        preview.style.display = '';
        // Render markdown
        preview.textContent = '';
        const frag = renderMarkdown(textarea.value);
        preview.appendChild(frag);
        // Attach card hover previews to [[Card Name]] links
        attachCardHoverToContainer(preview);
      } else {
        textarea.style.display = '';
        preview.style.display = 'none';
      }
    });
  }

  // Primer section templates (shared with collab-chat)
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>('.primer-tpl-btn'))) {
    btn.addEventListener('click', () => {
      const key = btn.dataset.template || '';
      const template = getTemplateByKey(key);
      if (!template) return;
      const textarea = byId<HTMLTextAreaElement>('deckDescription');
      const pos = textarea.selectionStart || textarea.value.length;
      const before = textarea.value.slice(0, pos);
      const after = textarea.value.slice(pos);
      textarea.value = before + template + after;
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = pos + template.length;
      if (currentDeck) {
        currentDeck.description = textarea.value;
        scheduleAutosave();
      }
    });
  }
}

function bindImportEvents(): void {
  byId<HTMLButtonElement>('btnRunImport').addEventListener('click', () => {
    void applyImportText();
  });
  byId<HTMLButtonElement>('btnApplyUnresolved').addEventListener('click', applySelectedUnresolvedRows);
}

function bindExportEvents(): void {
  const output = byId<HTMLTextAreaElement>('exportOutput');

  byId<HTMLButtonElement>('btnExportText').addEventListener('click', () => {
    if (!currentDeck) return;
    output.value = buildPlainTextExport(currentDeck);
  });

  byId<HTMLButtonElement>('btnExportArena').addEventListener('click', () => {
    if (!currentDeck) return;
    output.value = buildArenaExport(currentDeck);
  });

  byId<HTMLButtonElement>('btnExportMtgo').addEventListener('click', () => {
    if (!currentDeck) return;
    output.value = buildMtgoExport(currentDeck);
  });

  byId<HTMLButtonElement>('btnExportCsv').addEventListener('click', () => {
    if (!currentDeck) return;
    output.value = buildDeckCsvExport(currentDeck, resolvedCardByName);
  });

  byId<HTMLButtonElement>('btnExportWants').addEventListener('click', () => {
    if (!currentDeck) return;
    output.value = buildCardmarketWantsListText(currentDeck);
  });

  byId<HTMLButtonElement>('btnExportMass').addEventListener('click', () => {
    if (!currentDeck) return;
    output.value = buildTcgplayerMassEntryText(currentDeck);
  });

  byId<HTMLButtonElement>('btnCopyExport').addEventListener('click', async () => {
    if (!output.value.trim()) return;
    await navigator.clipboard.writeText(output.value);
    showToast({ message: 'Export copied to clipboard.', type: 'success' });
  });

  byId<HTMLButtonElement>('btnExportImage').addEventListener('click', async () => {
    if (!currentDeck) return;
    showToast({ message: 'Generating deck image...', type: 'info', duration: 2000 });
    try {
      await downloadDeckImage(currentDeck, resolvedCardByName);
      showToast({ message: 'Deck image downloaded.', type: 'success' });
    } catch (error) {
      showToast({ message: error instanceof Error ? error.message : 'Image export failed.', type: 'error' });
    }
  });

  // G1: Mark recommended export format based on geo-currency detection
  const userCurrency = getStoredCurrencyPreference();
  const regionBtns = document.querySelectorAll<HTMLButtonElement>('.export-btn[data-export-region]');
  for (const btn of regionBtns) {
    if (btn.dataset.exportRegion === userCurrency) {
      btn.classList.add('export-recommended');
    }
  }

  byId<HTMLButtonElement>('btnPrintProxies').addEventListener('click', () => {
    if (!currentDeck) return;
    trackPremiumFeatureUse('print_proxy');
    const entries = [...currentDeck.boards.commander, ...currentDeck.boards.mainboard, ...currentDeck.boards.sideboard]
      .map((e) => {
        const card = resolvedCardByName[normalizeNameKey(e.name)];
        return { name: e.name, qty: e.qty, imageUrl: card?.image_uris?.normal || card?.image_uris?.small };
      });
    const html = generatePrintHTML(entries, { title: currentDeck.name });
    const win = window.open('', '_blank');
    if (win) {
      win.document.write(html);
      win.document.close();
    }
  });

  byId<HTMLButtonElement>('btnGoldfishPlaytest').addEventListener('click', () => {
    if (!currentDeck) return;
    trackPremiumFeatureUse('goldfish_playtest');
    openGoldfishPlaytest(currentDeck, resolvedCardByName);
  });

  byId<HTMLButtonElement>('btnMultiplayerGoldfish').addEventListener('click', () => {
    if (!currentDeck) return;
    trackPremiumFeatureUse('multiplayer_goldfish');
    showMultiplayerLaunchModal(currentDeck, resolvedCardByName);
  });

  byId<HTMLButtonElement>('btnCreateShareSnapshot').addEventListener('click', async () => {
    if (!currentDeck) return;
    if (currentDeck.visibility === 'private') {
      showToast({ message: 'Set visibility to public or unlisted before creating a snapshot.', type: 'warning' });
      return;
    }

    const status = byId<HTMLDivElement>('shareStatus');
    status.textContent = 'Creating immutable snapshot...';
    status.className = 'muted';
    try {
      const created = await createDeckbuilderShareSnapshot({
        visibility: currentDeck.visibility,
        deck: toSharePayload(currentDeck),
      });
      const url = `${window.location.origin}/d/${created.slug}`;
      status.innerHTML = `Snapshot created: <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
      status.className = 'muted';
      trackAnalyticsEvent('report_shared', {
        share_scope: created.visibility,
        share_slug: created.slug,
      });
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Failed to create snapshot.';
      status.className = 'danger';
    }
  });

  byId<HTMLButtonElement>('btnPublishCommunity').addEventListener('click', async () => {
    if (!currentDeck) return;
    const commander = currentDeck.boards.commander[0]?.name || 'Unknown';
    const notes = await showPromptModal({
      title: 'Publish to Community',
      message: 'Add a description for your deck (optional):',
      placeholder: 'Strategy notes, combos, etc.',
    });
    if (notes === null) return; // User cancelled

    const publishStatus = byId<HTMLDivElement>('publishStatus');
    publishStatus.textContent = 'Publishing to community...';
    publishStatus.className = 'muted';

    try {
      const decklist = buildPlainTextExport(currentDeck);
      const entries = currentDeck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty }));
      const dna = analyzeDeckDNA(entries, (name) => {
        const card = resolvedCardByName[normalizeNameKey(name)];
        return card ? { name: card.name, cmc: card.cmc, type_line: card.type_line, oracle_text: card.oracle_text } : undefined;
      });

      const payload: CommunityDeckInput = {
        name: currentDeck.name,
        format: 'commander',
        commander,
        archetype: dna.dominant || 'midrange',
        decklist,
        notes: notes || undefined,
      };

      const created = await createCommunityDeck(payload);
      const url = `${window.location.origin}/community#deck-${created.id}`;
      publishStatus.innerHTML = `Published! <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">View in Community</a>`;
      trackAnalyticsEvent('community_deck_published', { deckId: created.id });
    } catch (error) {
      publishStatus.textContent = error instanceof Error ? error.message : 'Failed to publish.';
      publishStatus.className = 'danger';
    }
  });

  // Cloud Sync toggle
  const cloudToggle = document.getElementById('cloudSyncToggle') as HTMLInputElement | null;
  const cloudStatus = document.getElementById('cloudSyncStatus');
  if (cloudToggle) {
    cloudToggle.checked = isCloudSyncEnabled();
    cloudToggle.addEventListener('change', () => {
      setCloudSyncEnabled(cloudToggle.checked);
      if (cloudStatus) {
        cloudStatus.textContent = cloudToggle.checked
          ? 'Cloud sync enabled. Deck will auto-sync after changes.'
          : 'Cloud sync disabled.';
      }
      if (cloudToggle.checked) {
        void performCloudSync();
      }
    });
  }
}

function updateOutboundLinks(): void {
  if (!currentDeck) return;
  byId<HTMLAnchorElement>('btnOpenCardmarket').href = buildCardmarketDeckUrl(currentDeck.name);
  byId<HTMLAnchorElement>('btnOpenTcgplayer').href = buildTcgplayerDeckUrl(currentDeck.name);
}

function renderHistory(): void {
  if (!currentDeck) return;
  const historyBox = byId<HTMLDivElement>('deckHistoryBox');
  void renderVersionPanel(historyBox, currentDeck, {
    onRestore: (boards) => {
      if (!currentDeck) return;
      currentDeck.boards = boards;
      saveAndRender();
    },
  });
}

function renderStatsBar(): void {
  const container = byId<HTMLDivElement>('deckStatsBar');
  container.textContent = '';
  if (!currentDeck) return;

  const data = computeAnalyticsDataCached(currentDeck);
  const total = totalCards(currentDeck.boards.mainboard) + totalCards(currentDeck.boards.commander);
  
  // Dynamic format limit
  const formatRules = getFormatRules(currentDeck.format || 'commander');
  const limitLabel = formatRules.maxDeckSize === Infinity ? String(formatRules.minDeckSize) + '+' : String(formatRules.maxDeckSize);
  const isOver = total > formatRules.maxDeckSize;
  const isUnder = total < formatRules.minDeckSize;

  const avgCmc = (() => {
    let sum = 0;
    let count = 0;
    for (const entry of currentDeck.boards.mainboard) {
      const card = resolvedCardByName[normalizeNameKey(entry.name)];
      const tl = (card?.type_line || '').toLowerCase();
      if (tl.includes('land')) continue;
      sum += (card?.cmc || 0) * entry.qty;
      count += entry.qty;
    }
    return count > 0 ? (sum / count) : 0;
  })();

  const mkStat = (label: string, value: string): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'stat-item';
    el.innerHTML = '';
    const v = document.createElement('span');
    v.className = 'stat-value';
    v.textContent = value;
    const l = document.createElement('span');
    l.className = 'stat-label';
    l.textContent = label;
    el.append(v, l);
    return el;
  };

  container.append(
    mkStat('Cards', `${total}/${limitLabel}`),
    mkStat('Lands', String(data.landCount)),
    mkStat('Avg CMC', avgCmc.toFixed(2)),
  );

  const cardStatVal = container.querySelector('.stat-item:first-child .stat-value');
  if (cardStatVal) {
    if (isOver) cardStatVal.classList.add('text-danger');
    else if (isUnder) cardStatVal.classList.add('text-warn');
  }

  // Color pips
  const pips = document.createElement('div');
  pips.className = 'color-pips';
  for (const c of ['W', 'U', 'B', 'R', 'G'] as const) {
    const count = data.colors[c] || 0;
    if (count > 0) {
      const pip = document.createElement('span');
      pip.className = `color-pip ${c}`;
      pip.textContent = `${c}${count}`;
      pips.appendChild(pip);
    }
  }
  if (pips.childElementCount > 0) container.appendChild(pips);

  // Archetype detection
  try {
    const deck = deckbuilderToDeck(currentDeck);
    const resolver = (name: string) => {
      const card = resolvedCardByName[normalizeNameKey(name)];
      if (!card) return undefined;
      return { name: card.name, type_line: card.type_line, oracle_text: card.oracle_text };
    };
    const result = detectDeckArchetype(deck, resolver);
    if (result.primaryArchetype) {
      const archDef = getArchetypeById(result.primaryArchetype);
      const conf = result.allScores.find((s) => s.id === result.primaryArchetype);
      const badge = document.createElement('span');
      badge.className = 'archetype-badge';
      badge.textContent = archDef?.name || result.primaryArchetype;
      if (conf) {
        const confSpan = document.createElement('span');
        confSpan.className = 'confidence';
        confSpan.textContent = `${Math.round(conf.confidence * 100)}%`;
        badge.appendChild(confSpan);
      }
      if (result.secondaryArchetypes.length > 0) {
        const secDef = getArchetypeById(result.secondaryArchetypes[0].id);
        if (secDef) {
          const sep = document.createElement('span');
          sep.className = 'stat-sep';
          sep.textContent = '·';
          const secBadge = document.createElement('span');
          secBadge.className = 'archetype-badge';
          secBadge.style.opacity = '0.7';
          secBadge.textContent = secDef.name;
          container.append(sep, badge, secBadge);
          return;
        }
      }
      container.appendChild(badge);
    }
  } catch {
    // Archetype detection is non-critical
  }
}

function getWizardCallbacks() {
  return {
    getDeck: () => currentDeck,
    getCardByName: () => resolvedCardByName,
    applySwap: (cutName: string | null, addName: string) => {
      if (!currentDeck) return;
      if (cutName) removeEntry('mainboard', cutName);
      upsertEntry('mainboard', addName, 1);
      strategyDirty = true;
      invalidateMatchupCache();
      saveAndRender();
    },
    applySwapWithMeta: (rec: RecommendationV1Item) => {
      applyRecWithHistory(rec, 'wizard');
    },
    onComplete: () => {
      saveAndRender();
    },
  };
}

function updateOptimizeButton(): void {
  const btn = document.getElementById('btnOptimize');
  if (!btn) return;
  btn.style.display = currentDeck && currentDeck.boards.mainboard.length >= 10 ? '' : 'none';
}

function updateShareToCommunityPrompt(): void {
  let prompt = document.getElementById('communitySharePrompt');
  const show = Boolean(currentDeck && currentDeck.boards.mainboard.length >= 10);
  if (!show) {
    if (prompt) prompt.style.display = 'none';
    return;
  }
  if (!prompt) {
    prompt = document.createElement('div');
    prompt.id = 'communitySharePrompt';
    prompt.className = 'community-share-prompt';
    prompt.innerHTML = '<span>Deck looking good? </span><a href="/community" class="community-share-link">Share to Community \u2192</a>';
    const counts = document.getElementById('deckCounts');
    if (counts?.parentElement) {
      counts.parentElement.insertBefore(prompt, counts.nextSibling);
    }
  }
  prompt.style.display = '';
}

// E3: Deferred heavy render — analytics, rules, pricing debounced to avoid jank during rapid mutations
let heavyRenderTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleHeavyRender(): void {
  if (heavyRenderTimer) clearTimeout(heavyRenderTimer);
  heavyRenderTimer = setTimeout(() => {
    heavyRenderTimer = null;
    renderRuleChecks();
    renderFormatLegalityCheck();
    renderAnalytics();
    renderPricing();
    renderHistory();
  }, 500);
}

function renderAll(): void {
  // Fast path (immediate visual feedback)
  renderDeckOverview();
  renderStatsBar();
  renderBoardRows();
  updateOutboundLinks();
  updateOptimizeButton();
  updateShareToCommunityPrompt();
  // Heavy path (debounced 500ms for analytics/rules/pricing)
  scheduleHeavyRender();
}

function saveAndRender(): void {
  if (!currentDeck) return;
  pushSnapshot(currentDeck);
  scheduleAutosave();
  strategyDirty = true;
  edhrecDirty = true;
  // Invalidate caches on deck mutation
  invalidateViewMemo();
  analyticsCache = null;
  powerLevelCache = null;
  spellbookLastHash = null;
  invalidateMatchupCache();
  autoSnapshotIfNeeded(currentDeck, lastSnapshotCardCount);
  lastSnapshotCardCount = currentDeck.boards.mainboard.reduce((s, e) => s + e.qty, 0) + currentDeck.boards.commander.reduce((s, e) => s + e.qty, 0);
  // Keep autocomplete deck-card list fresh
  if (searchAutocomplete && currentDeck) {
    searchAutocomplete.updateDeckCards(currentDeck.boards.mainboard.map((e) => e.name));
  }
  renderAll();
  void refreshMissingCardData().then(() => {
    analyticsCache = null;
    powerLevelCache = null;
    renderBoardRows();
    renderRuleChecks();
    renderFormatLegalityCheck();
    renderAnalytics();
    renderPricing();
  });
  void refreshSpellbookCombos();
  checkLocalStorageQuota();
}

/**
 * Debounced saveAndRender — coalesces rapid changes (qty +/-, fast card adds)
 * into a single render pass after 100ms of inactivity.
 */
function deferredSaveAndRender(): void {
  if (deferredRenderTimer) clearTimeout(deferredRenderTimer);
  deferredRenderTimer = setTimeout(() => {
    deferredRenderTimer = null;
    saveAndRender();
  }, 100);
}

function initDeck(): boolean {
  const deckId = parseDeckIdFromPath();
  if (!deckId) {
    // Auto-create a new deck when visiting /deck-editor directly
    const newDeck = createDeck('Untitled Deck');
    setLastOpenedDeckId(newDeck.id);
    window.location.replace(`/decks/id/${encodeURIComponent(newDeck.id)}`);
    return false; // Current init stops; new page load will init properly
  }
  const deck = getDeckById(deckId);
  if (!deck) {
    showStatus('Deck not found on this device.', 'danger');
    return false;
  }

  currentDeck = deck;
  historyDirty = true;
  lastSnapshotCardCount = deck.boards.mainboard.reduce((s, e) => s + e.qty, 0) + deck.boards.commander.reduce((s, e) => s + e.qty, 0);
  setLastOpenedDeckId(deck.id);
  byId<HTMLHeadingElement>('editorDeckTitle').textContent = deck.name;

  // Load description into textarea (always set, even if empty)
  const descInput = byId<HTMLTextAreaElement>('deckDescription');
  if (descInput) {
    descInput.value = deck.description || '';
  }

  // F2: Restore preferred board (default to mainboard)
  try {
    const savedBoard = localStorage.getItem(`dl_board_${deck.id}`) as DeckBoard | null;
    if (savedBoard && BOARD_ORDER.includes(savedBoard)) {
      activeBoard = savedBoard;
    }
  } catch (err) {
    console.error('[Deckbuilder] Failed to restore board preference:', err);
  }

  return true;
}

function initDragDropSystem(): void {
  // Hide hover preview when dragging starts
  document.addEventListener('dragstart', () => hideHoverPreview());

  initDragDrop({
    onDropToBoard: (cardNames, fromBoard, toBoard) => {
      if (!currentDeck || fromBoard === toBoard) return;
      for (const nameKey of cardNames) {
        // Find the actual entry by normalized key
        const entry = currentDeck.boards[fromBoard].find(
          (item) => normalizeNameKey(item.name) === nameKey
        );
        if (entry) moveEntry(fromBoard, toBoard, entry.name);
      }
      clearSelection();
      saveAndRender();
    },
    onDropFromSearch: (card, toBoard) => {
      if (!currentDeck) return;
      const cardKey = normalizeNameKey(card.name);
      const wasPresent = currentDeck.boards[toBoard].some((e) => normalizeNameKey(e.name) === cardKey);
      const lockBlocked = !isRemoteUpdate && isCollabActive() && isCardLocked(toBoard, card.name).locked;
      upsertEntry(toBoard, card.name, 1, card as DeckbuilderSearchCard);
      resolvedCardByName[cardKey] = card as DeckbuilderSearchCard;
      saveAndRender();
      if (!lockBlocked) {
        showToast({
          message: `Added "${card.name}" to ${toBoard}`,
          type: 'success',
          undoAction: () => {
            if (wasPresent) upsertEntry(toBoard, card.name, -1);
            else removeEntry(toBoard, card.name);
            saveAndRender();
          },
        });
      }
    },
    getSelectedCards,
    getActiveBoard: () => activeBoard,
  });
}

function initBoardDropZones(): void {
  for (const board of BOARD_ORDER) {
    const btn = byId<HTMLButtonElement>(`boardBtn-${board}`);
    makeDropZone(btn, board);
  }
  // The board rows container is also a drop zone for the active board
  const boardRows = byId<HTMLDivElement>('boardRows');
  makeDropZone(boardRows, activeBoard);
}

function bindViewModeEvents(): void {
  const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'));
  for (const btn of viewButtons) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.view as ViewMode;
      setViewMode(mode);
      viewButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');

      // Show/hide pile sort toggle and manage categories button
      const pileSortToggle = document.getElementById('pileSortToggle');
      if (pileSortToggle) {
        pileSortToggle.style.display = mode === 'pile' ? '' : 'none';
      }
      const manageCatsBtn = document.getElementById('btnManageCategories');
      if (manageCatsBtn) {
        manageCatsBtn.style.display = mode === 'pile' ? '' : 'none';
      }
      // Show/hide list/grid sort dropdown (hidden for pile view which has its own sort)
      const listSortToggle = document.getElementById('listSortToggle');
      if (listSortToggle) {
        listSortToggle.style.display = mode === 'pile' ? 'none' : '';
      }

      scheduleRenderBoardRows();
    });
  }

  const pileSortButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-pile-sort]'));
  for (const btn of pileSortButtons) {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.pileSort as 'type' | 'cmc' | 'color' | 'rarity' | 'tag';
      setPileSortMode(mode);
      pileSortButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      scheduleRenderBoardRows();
    });
  }

  // List/Grid sort dropdown
  const listSortSelect = document.getElementById('listSortSelect') as HTMLSelectElement | null;
  if (listSortSelect) {
    listSortSelect.addEventListener('change', () => {
      setListSortMode(listSortSelect.value as ListSortMode);
      scheduleRenderBoardRows();
    });
  }

  // Manage Custom Categories button
  const manageCatsBtn = document.getElementById('btnManageCategories');
  if (manageCatsBtn) {
    manageCatsBtn.addEventListener('click', () => showManageCategoriesModal());
  }
}

function bindDeckFilterEvents(): void {
  const input = document.getElementById('deckFilterInput') as HTMLInputElement | null;
  const clearBtn = document.getElementById('deckFilterClear') as HTMLButtonElement | null;
  const countEl = document.getElementById('deckFilterCount') as HTMLSpanElement | null;
  if (!input) return;

  input.addEventListener('input', () => {
    deckFilterText = input.value.trim();
    if (clearBtn) clearBtn.style.display = deckFilterText ? '' : 'none';
    scheduleRenderBoardRows();
    // Show filtered count
    if (deckFilterText && currentDeck && countEl) {
      const total = currentDeck.boards[activeBoard].length;
      const shown = document.querySelectorAll('#boardRows [data-card-name]').length;
      countEl.textContent = `${shown}/${total}`;
    } else if (countEl) {
      countEl.textContent = '';
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      deckFilterText = '';
      clearBtn.style.display = 'none';
      if (countEl) countEl.textContent = '';
      scheduleRenderBoardRows();
    });
  }
}

function applyDensityClass(density: CardDensity): void {
  const area = byId<HTMLDivElement>('boardRows');
  area.classList.remove('density-compact', 'density-normal', 'density-large');
  area.classList.add(`density-${density}`);
}

function bindDensityEvents(): void {
  const buttons = document.querySelectorAll<HTMLButtonElement>('[data-density]');
  for (const btn of buttons) {
    btn.addEventListener('click', () => {
      const density = btn.dataset.density as CardDensity;
      setCardDensity(density);
      buttons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      applyDensityClass(density);
      scheduleRenderBoardRows();
    });
  }
}

function bindBulkActions(): void {
  byId<HTMLSelectElement>('bulkMoveTo').addEventListener('change', (e) => {
    const target = (e.target as HTMLSelectElement).value as DeckBoard;
    if (!target || !currentDeck) return;
    for (const key of selectedCards) {
      const entry = currentDeck.boards[activeBoard].find(
        (item) => normalizeNameKey(item.name) === key
      );
      if (entry) moveEntry(activeBoard, target, entry.name);
    }
    clearSelection();
    (e.target as HTMLSelectElement).value = '';
    saveAndRender();
  });

  byId<HTMLButtonElement>('bulkRemove').addEventListener('click', () => {
    if (!currentDeck) return;

    const count = selectedCards.size;
    if (count === 0) return;

    const confirmMsg = count === 1
      ? 'Remove this card from deck?'
      : `Remove ${count} cards from deck?`;

    if (!confirm(confirmMsg)) return;

    for (const key of selectedCards) {
      const entry = currentDeck.boards[activeBoard].find(
        (item) => normalizeNameKey(item.name) === key
      );
      if (entry) removeEntry(activeBoard, entry.name);
    }
    clearSelection();
    saveAndRender();
    showToast(`Removed ${count} card${count > 1 ? 's' : ''}`, 'success', 2000);
  });

  byId<HTMLInputElement>('bulkTags').addEventListener('change', (e) => {
    if (!currentDeck) return;
    const rawTags = (e.target as HTMLInputElement).value;
    for (const key of selectedCards) {
      const entry = currentDeck.boards[activeBoard].find(
        (item) => normalizeNameKey(item.name) === key
      );
      if (entry) updateEntryTags(activeBoard, entry.name, rawTags);
    }
    (e.target as HTMLInputElement).value = '';
    saveAndRender();
  });

  byId<HTMLButtonElement>('bulkClear').addEventListener('click', () => {
    clearSelection();
    scheduleRenderBoardRows();
  });
}

/**
 * Attach delegated event listeners on #boardRows once.
 * Eliminates ~500 per-card listeners per render pass.
 * Card elements are identified via data-card-name / data-board attributes.
 */
function setupBoardRowDelegation(): void {
  const container = byId<HTMLDivElement>('boardRows');

  function getCardName(e: Event): string | null {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card-name]');
    return el ? el.getAttribute('data-card-name') : null;
  }

  // Click → card select (skip if target is button/input/select)
  container.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select')) return;
    const name = getCardName(e);
    if (name) {
      const ctx = buildViewModeContext();
      ctx.onCardSelect(name, e);
    }
  });

  // Double-click → open detail modal (skip if target is button/input/select)
  container.addEventListener('dblclick', (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('button, input, select')) return;
    const name = getCardName(e);
    if (name) {
      const ctx = buildViewModeContext();
      ctx.onCardClick(name, e);
    }
  });

  // Context menu → right-click menu
  container.addEventListener('contextmenu', (e: MouseEvent) => {
    const name = getCardName(e);
    if (name) {
      e.preventDefault();
      const ctx = buildViewModeContext();
      ctx.onCardContextMenu(name, e);
    }
  });

  // Mouse enter/leave → hover preview (use mouseover/mouseout for delegation)
  container.addEventListener('mouseover', (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card-name]');
    if (!el) return;
    // Avoid re-triggering when moving between children of the same card
    const related = e.relatedTarget as HTMLElement | null;
    if (related && el.contains(related)) return;
    const name = el.getAttribute('data-card-name');
    if (name) {
      const card = resolvedCardByName[normalizeNameKey(name)];
      if (card) showHoverPreview(card, e);
    }
  });

  container.addEventListener('mouseout', (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card-name]');
    if (!el) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && el.contains(related)) return;
    hideHoverPreview();
  });
}

// ==================== Card Hover for Arbitrary Containers ====================

function attachCardHoverToContainer(container: HTMLElement): void {
  container.addEventListener('mouseover', (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card-name]');
    if (!el) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && el.contains(related)) return;
    const name = el.getAttribute('data-card-name');
    if (name) {
      const card = resolvedCardByName[normalizeNameKey(name)];
      if (card) {
        showHoverPreview(card, e);
      } else {
        // Card not in deck — fetch image directly from Scryfall
        showHoverPreviewByName(name, e);
      }
    }
  });
  container.addEventListener('mouseout', (e: MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-card-name]');
    if (!el) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && el.contains(related)) return;
    hideHoverPreview();
  });
}

// ==================== Custom Category Management ====================

function assignCardCategory(cardName: string, board: DeckBoard, categoryId: string | undefined): void {
  const entry = findEntry(board, cardName);
  if (!entry) return;
  entry.customCategoryId = categoryId;
  saveAndRender();
}

function getCardCategoryId(cardName: string, board: DeckBoard): string | undefined {
  const entry = findEntry(board, cardName);
  return entry?.customCategoryId;
}

function showManageCategoriesModal(): void {
  if (!currentDeck) return;

  // Remove existing modal if open
  const existing = document.getElementById('manageCategoriesModal');
  if (existing) { existing.remove(); return; }

  const categories = currentDeck.customCategories || [];

  const modal = document.createElement('div');
  modal.id = 'manageCategoriesModal';
  modal.className = 'collection-import-modal'; // Reuse modal backdrop styles
  modal.style.zIndex = '10000';

  const content = document.createElement('div');
  content.className = 'collection-import-content';
  content.style.maxWidth = '420px';

  const title = document.createElement('h4');
  title.textContent = 'Manage Custom Categories';
  title.style.margin = '0 0 12px';

  const listEl = document.createElement('div');
  listEl.className = 'custom-categories-list';

  function renderCategoryList(): void {
    const cats = currentDeck!.customCategories || [];
    listEl.textContent = '';

    if (cats.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.style.cssText = 'font-size: 0.78rem; padding: 8px 0;';
      empty.textContent = 'No custom categories yet. Add one below.';
      listEl.appendChild(empty);
    }

    for (const cat of cats) {
      const row = document.createElement('div');
      row.className = 'custom-category-row';

      const colorDot = document.createElement('span');
      colorDot.className = 'ctx-color-dot';
      colorDot.style.cssText = `background: ${cat.color}; display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px;`;

      const nameLabel = document.createElement('span');
      nameLabel.style.flex = '1';
      nameLabel.textContent = cat.name;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn danger';
      removeBtn.style.cssText = 'font-size: 0.66rem; padding: 2px 8px;';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => {
        const deck = currentDeck!;
        deck.customCategories = (deck.customCategories || []).filter((c) => c.id !== cat.id);
        // Unassign cards that had this category
        for (const board of Object.values(deck.boards)) {
          for (const entry of board) {
            if (entry.customCategoryId === cat.id) {
              entry.customCategoryId = undefined;
            }
          }
        }
        renderCategoryList();
        saveAndRender();
      });

      row.append(colorDot, nameLabel, removeBtn);
      listEl.appendChild(row);
    }
  }

  renderCategoryList();

  // Add new category form
  const addForm = document.createElement('div');
  addForm.className = 'custom-category-add';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'Category name';
  nameInput.className = 'inline-tags';
  nameInput.style.cssText = 'flex: 1; font-size: 0.78rem; padding: 4px 8px;';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = '#e2b340';
  colorInput.style.cssText = 'width: 32px; height: 28px; border: none; border-radius: 4px; cursor: pointer; padding: 0;';

  const addBtn = document.createElement('button');
  addBtn.className = 'btn primary';
  addBtn.style.cssText = 'font-size: 0.72rem; padding: 4px 10px;';
  addBtn.textContent = 'Add';
  addBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    if (!currentDeck!.customCategories) currentDeck!.customCategories = [];
    currentDeck!.customCategories.push({
      id: `cat_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      color: colorInput.value,
    });
    nameInput.value = '';
    renderCategoryList();
    saveAndRender();
  });

  addForm.append(nameInput, colorInput, addBtn);

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'margin-top: 12px; width: 100%;';
  closeBtn.addEventListener('click', () => modal.remove());

  content.append(title, listEl, addForm, closeBtn);
  modal.appendChild(content);

  // Click backdrop to close
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  document.body.appendChild(modal);
  nameInput.focus();
}

// ==================== Deck Comparison ====================

function deckToZones(deck: DeckbuilderDeck): DeckZones {
  return {
    main: deck.boards.mainboard.map((e) => ({ name: e.name, qty: e.qty })),
    sideboard: deck.boards.sideboard.map((e) => ({ name: e.name, qty: e.qty })),
    commander: deck.boards.commander.map((e) => ({ name: e.name, qty: e.qty })),
  };
}

function parseTextToZones(text: string): { zones: DeckZones; name: string } {
  const result = parseDeckbuilderImportText(text);
  const zones: DeckZones = { main: [], sideboard: [], commander: [] };
  for (const line of result.lines) {
    const entry = { name: line.name, qty: line.qty };
    if (line.board === 'commander') zones.commander.push(entry);
    else if (line.board === 'sideboard') zones.sideboard.push(entry);
    else zones.main.push(entry);
  }
  const totalCards = zones.main.reduce((s, e) => s + e.qty, 0) + zones.commander.reduce((s, e) => s + e.qty, 0);
  return { zones, name: `Pasted Deck (${totalCards} cards)` };
}

function showDiffResult(
  content: HTMLElement,
  subtitle: HTMLElement,
  closeBtn: HTMLElement,
  modal: HTMLElement,
  deckNameB: string,
  zonesB: DeckZones,
  hideEl?: HTMLElement,
): void {
  if (hideEl) hideEl.style.display = 'none';
  subtitle.textContent = `${currentDeck!.name} vs ${deckNameB}`;

  const diffContainer = document.createElement('div');
  diffContainer.style.marginBottom = '12px';
  const diff = compareDecksDiff(deckToZones(currentDeck!), zonesB);
  renderDeckComparison(diffContainer, diff, {
    deckNameA: currentDeck!.name,
    deckNameB,
    showUnchanged: false,
  });
  content.insertBefore(diffContainer, closeBtn);

  if (diff.stats.uniqueToB.length > 0) {
    const addMissingBtn = document.createElement('button');
    addMissingBtn.className = 'btn primary';
    addMissingBtn.style.cssText = 'margin-bottom: 8px; width: 100%;';
    addMissingBtn.textContent = `Add ${diff.stats.uniqueToB.length} missing card(s) to your deck`;
    addMissingBtn.addEventListener('click', () => {
      for (const name of diff.stats.uniqueToB) {
        const mainEntry = zonesB.main.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (mainEntry) upsertEntry('mainboard', mainEntry.name, mainEntry.qty);
      }
      saveAndRender();
      modal.remove();
      showToast({ message: `Added ${diff.stats.uniqueToB.length} cards from ${deckNameB}`, type: 'success' });
    });
    content.insertBefore(addMissingBtn, closeBtn);
  }
}

function showCompareModal(): void {
  if (!currentDeck) return;

  const existing = document.getElementById('deckCompareModal');
  if (existing) { existing.remove(); return; }

  const allDecks = listDecks().filter((d) => d.id !== currentDeck!.id);

  const modal = document.createElement('div');
  modal.id = 'deckCompareModal';
  modal.className = 'collection-import-modal'; // Reuse backdrop
  modal.style.zIndex = '10000';

  const content = document.createElement('div');
  content.className = 'collection-import-content';
  content.style.maxWidth = '640px';
  content.style.maxHeight = '80vh';
  content.style.overflow = 'auto';

  const title = document.createElement('h4');
  title.textContent = 'Compare Deck';
  title.style.margin = '0 0 8px';

  const subtitle = document.createElement('div');
  subtitle.className = 'muted';
  subtitle.style.cssText = 'font-size: 0.78rem; margin-bottom: 12px;';
  subtitle.textContent = `Compare "${currentDeck.name}" against:`;

  content.append(title, subtitle);

  // Tab bar: My Decks | Paste Decklist
  const tabBar = document.createElement('div');
  tabBar.className = 'tabs';
  tabBar.style.marginBottom = '10px';
  const tabMyDecks = document.createElement('button');
  tabMyDecks.className = 'btn active';
  tabMyDecks.textContent = 'My Decks';
  const tabPaste = document.createElement('button');
  tabPaste.className = 'btn';
  tabPaste.textContent = 'Paste Decklist';
  tabBar.append(tabMyDecks, tabPaste);
  content.appendChild(tabBar);

  // Panel: My Decks list
  const myDecksPanel = document.createElement('div');
  if (allDecks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.padding = '16px 0';
    empty.textContent = 'No other decks found. Create another deck first.';
    myDecksPanel.appendChild(empty);
  } else {
    const list = document.createElement('div');
    list.style.cssText = 'display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px;';

    for (const deck of allDecks.slice(0, 20)) {
      const cardCount = deck.boards.mainboard.reduce((s, e) => s + e.qty, 0) + deck.boards.commander.reduce((s, e) => s + e.qty, 0);
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.style.cssText = 'text-align: left; display: flex; justify-content: space-between; padding: 8px 12px;';
      btn.innerHTML = `<span>${deck.name}</span><span class="muted" style="font-size: 0.72rem">${cardCount} cards</span>`;
      btn.addEventListener('click', () => {
        tabBar.style.display = 'none';
        showDiffResult(content, subtitle, closeBtn, modal, deck.name, deckToZones(deck), myDecksPanel);
      });
      list.appendChild(btn);
    }
    myDecksPanel.appendChild(list);
  }
  content.appendChild(myDecksPanel);

  // Panel: Paste decklist
  const pastePanel = document.createElement('div');
  pastePanel.style.display = 'none';
  const pasteLabel = document.createElement('div');
  pasteLabel.className = 'muted';
  pasteLabel.style.cssText = 'font-size: 0.72rem; margin-bottom: 4px;';
  pasteLabel.textContent = 'Paste a decklist in any format (1 Card Name, MTGO, Arena):';
  const textarea = document.createElement('textarea');
  textarea.style.cssText = 'width: 100%; height: 180px; background: var(--abyss); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px; font-family: "JetBrains Mono", monospace; font-size: 0.78rem; resize: vertical;';
  textarea.placeholder = '1 Sol Ring\n1 Command Tower\n1 Swords to Plowshares\n...';
  const compareBtn = document.createElement('button');
  compareBtn.className = 'btn primary';
  compareBtn.style.cssText = 'width: 100%; margin-top: 8px;';
  compareBtn.textContent = 'Compare';
  compareBtn.addEventListener('click', () => {
    const text = textarea.value.trim();
    if (!text) return;
    const { zones, name } = parseTextToZones(text);
    if (zones.main.length === 0 && zones.commander.length === 0) {
      showToast({ message: 'Could not parse any cards from the pasted text.', type: 'warning' });
      return;
    }
    tabBar.style.display = 'none';
    showDiffResult(content, subtitle, closeBtn, modal, name, zones, pastePanel);
  });
  pastePanel.append(pasteLabel, textarea, compareBtn);
  content.appendChild(pastePanel);

  // Tab switching
  tabMyDecks.addEventListener('click', () => {
    tabMyDecks.classList.add('active');
    tabPaste.classList.remove('active');
    myDecksPanel.style.display = '';
    pastePanel.style.display = 'none';
  });
  tabPaste.addEventListener('click', () => {
    tabPaste.classList.add('active');
    tabMyDecks.classList.remove('active');
    pastePanel.style.display = '';
    myDecksPanel.style.display = 'none';
    textarea.focus();
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn';
  closeBtn.textContent = 'Close';
  closeBtn.style.cssText = 'margin-top: 8px; width: 100%;';
  closeBtn.addEventListener('click', () => modal.remove());

  content.appendChild(closeBtn);
  modal.appendChild(content);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });

  document.body.appendChild(modal);
}

// ==================== Collaborative Editing Integration ====================

function setupCollabEventHandlers(): void {
  const mgr = getCollabManager();

  // On initial sync — replace entire deck state with server's version
  mgr.on('sync', (event: CollabEvent) => {
    const data = event.data as { deck: { name: string; description: string; boards: Record<string, unknown[]> } };
    if (!currentDeck || !data.deck) return;

    isRemoteUpdate = true;
    try {
      currentDeck.name = data.deck.name || currentDeck.name;
      currentDeck.description = typeof data.deck.description === 'string' ? data.deck.description : currentDeck.description;

      // Update boards from server state
      for (const board of ['commander', 'mainboard', 'sideboard', 'maybeboard'] as const) {
        if (Array.isArray(data.deck.boards[board])) {
          currentDeck.boards[board] = (data.deck.boards[board] as DeckbuilderCardEntry[]).map((entry) => ({
            name: entry.name,
            qty: entry.qty || 1,
            set: entry.set || null,
            collectorNumber: entry.collectorNumber || null,
            tags: Array.isArray(entry.tags) ? entry.tags : [],
          }));
        }
      }

      // Update UI
      byId<HTMLInputElement>('deckNameInput').value = currentDeck.name;
      const descInput = byId<HTMLTextAreaElement>('deckDescription');
      if (descInput) descInput.value = currentDeck.description || '';

      // Use the full saveAndRender path so that card images, analytics,
      // pricing, rule-checks and combos are all refreshed after sync.
      saveAndRender();
    } finally {
      isRemoteUpdate = false;
    }
  });

  // Remote card add
  mgr.on('remote-card-add', (event: CollabEvent) => {
    const data = event.data as { board: DeckBoard; entry: DeckbuilderCardEntry };
    if (!currentDeck) return;

    isRemoteUpdate = true;
    try {
      currentDeck.boards[data.board].push({
        name: data.entry.name,
        qty: data.entry.qty || 1,
        set: data.entry.set || null,
        collectorNumber: data.entry.collectorNumber || null,
        tags: Array.isArray(data.entry.tags) ? data.entry.tags : [],
      });
      saveAndRender();
    } finally {
      isRemoteUpdate = false;
    }
  });

  // Remote card remove
  mgr.on('remote-card-remove', (event: CollabEvent) => {
    const data = event.data as { board: DeckBoard; index: number };
    if (!currentDeck) return;

    isRemoteUpdate = true;
    try {
      const boardArr = currentDeck.boards[data.board];
      if (data.index >= 0 && data.index < boardArr.length) {
        boardArr.splice(data.index, 1);
        saveAndRender();
      }
    } finally {
      isRemoteUpdate = false;
    }
  });

  // Remote card update (qty change, tags, etc.)
  mgr.on('remote-card-update', (event: CollabEvent) => {
    const data = event.data as { board: DeckBoard; index: number; entry: DeckbuilderCardEntry };
    if (!currentDeck) return;

    isRemoteUpdate = true;
    try {
      const boardArr = currentDeck.boards[data.board];
      if (data.index >= 0 && data.index < boardArr.length) {
        boardArr[data.index] = {
          name: data.entry.name,
          qty: data.entry.qty || 1,
          set: data.entry.set || null,
          collectorNumber: data.entry.collectorNumber || null,
          tags: Array.isArray(data.entry.tags) ? data.entry.tags : [],
        };
        saveAndRender();
      }
    } finally {
      isRemoteUpdate = false;
    }
  });

  // Remote deck metadata update (name, description)
  mgr.on('remote-deck-meta', (event: CollabEvent) => {
    const data = event.data as { name: string; description: string };
    if (!currentDeck) return;

    isRemoteUpdate = true;
    try {
      currentDeck.name = data.name || currentDeck.name;
      currentDeck.description = typeof data.description === 'string' ? data.description : currentDeck.description;
      byId<HTMLInputElement>('deckNameInput').value = currentDeck.name;
      const descInput = byId<HTMLTextAreaElement>('deckDescription');
      if (descInput) descInput.value = currentDeck.description || '';
      scheduleAutosave();
      renderDeckOverview();
    } finally {
      isRemoteUpdate = false;
    }
  });

  // Snapshot request — editor-main provides deck data for timeline snapshots
  window.addEventListener('decklens:get-deck-for-snapshot', (e) => {
    if (!currentDeck) return;
    const label = (e as CustomEvent).detail?.label || 'Manual snapshot';
    const boardsJson = JSON.stringify(currentDeck.boards);
    let cardCount = 0;
    for (const board of ['commander', 'mainboard', 'sideboard', 'maybeboard'] as const) {
      cardCount += currentDeck.boards[board].reduce((sum, entry) => sum + (entry.qty || 1), 0);
    }
    window.dispatchEvent(new CustomEvent('decklens:snapshot-data', {
      detail: { label, boardsJson, cardCount },
    }));
  });
}

async function fillBasicLands(): Promise<void> {
  if (!currentDeck) return;
  
  const analysis = analyzeManaBase(currentDeck, resolvedCardByName);
  const currentLands = analysis.totalLands;

  // 1. Prompt for target land count
  const targetStr = await showPromptModal({
    title: 'Fill Basic Lands',
    message: `Current Lands: ${currentLands}\nTarget Land Count:`,
    defaultValue: '37',
    placeholder: '37',
    confirmLabel: 'Next',
  });

  if (!targetStr) return; // User cancelled
  const targetLands = parseInt(targetStr, 10);
  if (isNaN(targetLands) || targetLands < 0) {
    showToast({ message: 'Invalid land count.', type: 'error' });
    return;
  }
  
  if (currentLands >= targetLands) {
    showToast({ message: `Deck already has ${currentLands} lands (Target: ${targetLands})`, type: 'info' });
    return;
  }
  
  const needed = targetLands - currentLands;
  const landsToAdd: Record<string, number> = {
    'Plains': 0, 'Island': 0, 'Swamp': 0, 'Mountain': 0, 'Forest': 0
  };
  
  // Calculate pip ratios
  const totalPips = analysis.colors.reduce((sum, c) => sum + c.pips, 0);
  
  if (totalPips === 0) {
      showToast({ message: 'No colored mana requirements found to distribute lands.', type: 'warning' });
      return;
  }

  // Distribute lands based on pip ratio
  let assigned = 0;
  for (const color of analysis.colors) {
      const ratio = color.pips / totalPips;
      const count = Math.floor(needed * ratio);
      const landName = {
          'W': 'Plains', 'U': 'Island', 'B': 'Swamp', 'R': 'Mountain', 'G': 'Forest'
      }[color.color];
      
      if (landName) {
          landsToAdd[landName] += count;
          assigned += count;
      }
  }
  
  // Assign remainder to the color with most pips
  if (assigned < needed) {
      const topColor = analysis.colors.sort((a,b) => b.pips - a.pips)[0];
      if (topColor) {
           const landName = {
              'W': 'Plains', 'U': 'Island', 'B': 'Swamp', 'R': 'Mountain', 'G': 'Forest'
          }[topColor.color];
          if (landName) {
              landsToAdd[landName] += (needed - assigned);
          }
      }
  }

  // 2. Build confirmation message
  const summary: string[] = [];
  for (const [name, qty] of Object.entries(landsToAdd)) {
    if (qty > 0) summary.push(`${qty}x ${name}`);
  }

  if (summary.length === 0) {
     showToast({ message: 'Calculation resulted in no lands to add.', type: 'warning' });
     return;
  }

  const confirmed = await showConfirmModal({
    title: 'Review Changes',
    message: `Add the following ${needed} lands?\n\n${summary.join('\n')}`,
    confirmLabel: 'Add Lands',
  });

  if (!confirmed) return;

  // Apply changes
  let changes = 0;
  for (const [name, qty] of Object.entries(landsToAdd)) {
      if (qty > 0) {
          upsertEntry('mainboard', name, qty);
          changes++;
      }
  }

  if (changes > 0) {
      saveAndRender();
      showToast({ message: `Added ${needed} basic lands.`, type: 'success' });
  }
}

// ==================== F3: Light Theme Toggle ====================

function initThemeToggle(): void {
  // Load persisted theme
  const savedTheme = storageGet<string>(STORAGE_KEYS.THEME, 'dark');
  if (savedTheme === 'light') {
    document.body.classList.add('theme-light');
  }

  // Create toggle button in header
  const header = document.querySelector('.editor-header-actions') || document.querySelector('.editor-header');
  if (!header) return;

  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'theme-toggle-btn';
  toggleBtn.title = 'Toggle light/dark theme';
 toggleBtn.textContent = savedTheme === 'light' ? '☾' : '☀';
  toggleBtn.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('theme-light');
    storageSet(STORAGE_KEYS.THEME, isLight ? 'light' : 'dark');
 toggleBtn.textContent = isLight ? '☾' : '☀';
  });
  header.appendChild(toggleBtn);
}

function init(): void {
  initToastContainer();
  initSaveIndicator();
  initThemeToggle();
  initShortcutHelp();
  loadViewModePreference();
  loadCollection();
  initUndoStack(() => {});
  bindTabEvents();
  bindBoardEvents();
  bindCollapsibles();
  bindAnalyticsToggleAll();
  bindPriceSubTabs();
  bindSearchEvents();
  initSearchAutocomplete();
  initSyntaxHelp();
  initSaveSearchButton();
  bindFilterEvents();
  byId<HTMLButtonElement>('searchSidebarClose').addEventListener('click', () => {
    closeSearchSidebar();
    searchResults = [];
    selectedSearchIndex = -1;
    byId<HTMLInputElement>('searchInput').value = '';
  });
  byId<HTMLButtonElement>('btnSuggestCards').addEventListener('click', () => {
    void runSuggestCards();
  });
  bindGlobalShortcuts();
  bindDeckMetaEvents();

  // Optimize CTA button
  byId<HTMLButtonElement>('btnOptimize').addEventListener('click', () => {
    if (!currentDeck) return;
    trackPremiumFeatureUse('optimization_wizard');
    openOptimizationWizard(getWizardCallbacks());
  });

  bindImportEvents();
  bindExportEvents();

  // Basic Land Filler
  byId<HTMLButtonElement>('btnFillLands').addEventListener('click', () => {
     fillBasicLands();
  });

  const btnDoctor = byId('btnDoctor');
  if (btnDoctor) {
    btnDoctor.addEventListener('click', () => {
      if (!currentDeck) return;
      const diagnoses = diagnoseDeck(currentDeck, resolvedCardByName);
      
      const closeModal = () => {
        const overlay = document.querySelector('.doctor-overlay');
        if (overlay) overlay.remove();
      };

      const handleFix = (query: string) => {
        setSearchQuery(query);
      };

      const overlay = renderDoctorModal(diagnoses, handleFix, closeModal);
      document.body.appendChild(overlay);
    });
  }

  bindViewModeEvents();

  bindDensityEvents();
  bindDeckFilterEvents();
  bindBulkActions();
  setupBoardRowDelegation();
  initDragDropSystem();
  initBoardDropZones();
  initCardPreview();
  initHandTester(() => currentDeck, () => resolvedCardByName);
  initContextMenu({
    onMoveTo: (name, from, to) => {
      moveEntry(from, to, name);
      saveAndRender();
    },
    onQtyChange: (name, board, delta) => {
      if (delta < 0) {
        const entry = findEntry(board, name);
        if (entry && entry.qty <= 1) removeEntry(board, name);
        else upsertEntry(board, name, delta);
      } else {
        upsertEntry(board, name, delta);
      }
      saveAndRender();
    },
    onRemove: (name, board) => {
      removeEntry(board, name);
      saveAndRender();
      showToast({
        message: `Removed ${name}`,
        type: 'info',
        duration: 4000,
        undoAction: () => { undo(currentDeck!); saveCurrentDeck(); renderAll(); },
      });
    },
    onEditTags: async (name, board) => {
      const entry = findEntry(board, name);
      if (!entry) return;
      const result = await showPromptModal({
        title: 'Edit Tags',
        message: `Tags for ${name} (comma-separated):`,
        placeholder: 'ramp, draw, removal',
        defaultValue: entry.tags.join(', '),
      });
      if (result !== null) {
        updateEntryTags(board, name, result);
        saveAndRender();
      }
    },
    onToggleOwned: (name) => {
      const owned = toggleOwned(name);
      scheduleRenderBoardRows();
      renderPricing();
      return owned;
    },
    isOwned: (name) => isOwned(name),
    onAssignCategory: (name, board, categoryId) => {
      assignCardCategory(name, board, categoryId);
    },
    getCustomCategories: () => currentDeck?.customCategories || [],
    getCardCategoryId: (name, board) => getCardCategoryId(name, board),
    getScryfallUrl: (name) => {
      const key = normalizeNameKey(name);
      const card = resolvedCardByName[key];
      if (card?.set && card?.collector_number) {
        return `https://scryfall.com/card/${card.set}/${card.collector_number}`;
      }
      return `https://scryfall.com/search?q=${encodeURIComponent(name)}`;
    },
    onPingCard: (name, board) => {
      sendCardPing(board, name);
    },
    isCollabActive: () => isCollabActive(),
    onFindSimilar: (name) => {
      const card = resolvedCardByName[normalizeNameKey(name)];
      if (!card) return;
      
      const parts: string[] = [];
      // Color Identity
      if (!card.color_identity || card.color_identity.length === 0) {
        parts.push('id:c');
      } else {
        parts.push(`id:${card.color_identity.join('')}`);
      }
      // Type
      const type = (card.type_line || '').split('—')[0].trim().split(' ').pop();
      if (type && !['Legendary', 'Basic', 'World', 'Snow'].includes(type)) {
        parts.push(`t:${type}`);
      }
      // CMC
      if (card.cmc !== undefined) {
          const min = Math.max(0, Math.floor(card.cmc) - 1);
          const max = Math.floor(card.cmc) + 1;
          parts.push(`mv>=${min} mv<=${max}`);
      }
      // Exclude self
      parts.push(`!"${card.name}"`);

      const query = parts.join(' ');
      const searchInput = byId<HTMLInputElement>('searchInput');
      if (searchInput) {
        searchInput.value = query;
        searchInput.focus();
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        // Also ensure search sidebar is open
        if (!sidebarOpen) {
          document.querySelector('.editor-sidebar')?.classList.add('visible');
          sidebarOpen = true;
        }
      }
    },
    onPrintProxy: (name) => {
      const card = resolvedCardByName[normalizeNameKey(name)];
      if (!card) return;

      const imageUrl = card.image_uris?.large || card.image_uris?.normal || card.image_uris?.small;
      
      const html = generatePrintHTML([{ 
        name: card.name, 
        qty: 1, 
        imageUrl 
      }], {
        title: `Proxy: ${card.name}`,
        showCutGuides: true,
        showNames: true
      });

      const win = window.open('', '_blank');
      if (win) {
        win.document.write(html);
        win.document.close();
        // Allow images to load before printing - simple timeout or load event handler would be better but this is a start
        setTimeout(() => { win.print(); }, 500);
      }
    },
    boardOrder: BOARD_ORDER,
    boardLabels: BOARD_LABEL,
  });

  // Sync view mode buttons with loaded preference
  const savedMode = getViewMode();
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === savedMode);
  });
  const pileSortToggle = document.getElementById('pileSortToggle');
  if (pileSortToggle) {
    pileSortToggle.style.display = savedMode === 'pile' ? '' : 'none';
  }
  const manageCatsBtnInit = document.getElementById('btnManageCategories');
  if (manageCatsBtnInit) {
    manageCatsBtnInit.style.display = savedMode === 'pile' ? '' : 'none';
  }
  const listSortToggleInit = document.getElementById('listSortToggle');
  if (listSortToggleInit) {
    listSortToggleInit.style.display = savedMode === 'pile' ? 'none' : '';
  }

  // Sync density buttons + CSS class with saved preference
  const savedDensity = getCardDensity();
  document.querySelectorAll<HTMLButtonElement>('[data-density]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.density === savedDensity);
  });
  applyDensityClass(savedDensity);

  // ─── Collaborative Editing ───
  initCollabUI();
  initCollabCursors();
  initCollabDrawing();
  initCollabChat();
  initCollabPing();
  initCollabVoting();
  setVoteRenderCallback(() => scheduleRenderBoardRows());
  setupCollabEventHandlers();

  // Check for ?collab= FIRST — if joining, create placeholder deck if needed
  const collabSessionId = checkCollabUrlParam();
  if (collabSessionId) {
    // User B joining: try loading local deck, but don't bail if it's missing
    if (!initDeck()) {
      // Deck doesn't exist locally — create an empty placeholder.
      // The sync-response from the Durable Object will overwrite it with the real deck.
      const placeholder = createEmptyDeck('Loading...');
      currentDeck = placeholder;
    }

    // Load card data FIRST, then set board and render
    void (async () => {
      try {
        await refreshMissingCardData(true);
      } catch (e) {
        console.error('[Deckbuilder] Failed to load card data:', e);
      } finally {
        // Always set board and render after attempting to load data
        activeBoard = 'mainboard';
        // Update board button states
        for (const key of BOARD_ORDER) {
          const btn = byId<HTMLButtonElement>(`boardBtn-${key}`);
          btn.classList.toggle('active', key === activeBoard);
          btn.setAttribute('aria-selected', String(key === activeBoard));
        }
        invalidateViewMemo();
        analyticsCache = null;
        powerLevelCache = null;
        saveAndRender();
      }
    })();
    joinCollabSession(collabSessionId);
  } else {
    // Normal flow: load deck from localStorage
    if (!initDeck()) {
      return;
    }

    // Load card data FIRST, then set board and render
    void (async () => {
      try {
        await refreshMissingCardData(true);
      } catch (e) {
        console.error('[Deckbuilder] Failed to load card data:', e);
      } finally {
        // Always set board and render after attempting to load data
        activeBoard = 'mainboard';
        // Update board button states
        for (const key of BOARD_ORDER) {
          const btn = byId<HTMLButtonElement>(`boardBtn-${key}`);
          btn.classList.toggle('active', key === activeBoard);
          btn.setAttribute('aria-selected', String(key === activeBoard));
        }
        invalidateViewMemo();
        analyticsCache = null;
        powerLevelCache = null;
        saveAndRender();
      }
    })();
  }

  // Load meta badges asynchronously (non-blocking)
  void loadMetaData().then(() => scheduleRenderBoardRows());

  // Initialize layout mode (classic vs grid) - deferred to allow DOM to settle
  setTimeout(() => initLayoutMode(), 100);

  // Initialize Git repo panel + command palette
  initRepoPanel(() => currentDeck);
  initCommandPalette();

  // When repo widget becomes visible via layout system, trigger its init
  document.addEventListener('layout-widget-shown', (e) => {
    if ((e as CustomEvent).detail?.widgetId === 'repo') onRepoTabActive();
  });

  // First-time user onboarding (delayed to let UI settle)
  if (shouldShowOnboarding()) {
    setTimeout(() => startOnboarding(), 800);
  }

  // Expose functions globally for UI interactions
  (window as any).deckEditor = {
    setLayoutMode,
    showPresetPicker,
  };

  // Setup Tools Dropdown
  setupToolsDropdown();

  // Setup Layout Mode Toggle
  setupLayoutModeToggle();
}

// ==================== Tools Dropdown ====================

function setupToolsDropdown(): void {
  const dropdownBtn = document.getElementById('btnToolsDropdown');
  const dropdownMenu = document.getElementById('toolsDropdownMenu');

  if (!dropdownBtn || !dropdownMenu) return;

  // Toggle dropdown
  dropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdownMenu.classList.toggle('show');
  });

  // Close on click outside
  document.addEventListener('click', () => {
    dropdownMenu.classList.remove('show');
  });

  // Prevent dropdown from closing when clicking inside
  dropdownMenu.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Close dropdown after clicking an item
  dropdownMenu.querySelectorAll('.dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      dropdownMenu.classList.remove('show');
    });
  });
}

// ==================== Layout Mode Toggle ====================

function setupLayoutModeToggle(): void {
  const toggleButtons = document.querySelectorAll('.layout-mode-toggle .mode-btn');

  toggleButtons.forEach(button => {
    button.addEventListener('click', () => {
      const mode = button.getAttribute('data-mode') as LayoutMode;
      if (mode && (mode === 'classic' || mode === 'grid')) {
        setLayoutMode(mode);
      }
    });
  });
}

// E4: Offline-Ready — force save on tab close / background to prevent data loss
window.addEventListener('beforeunload', () => {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  // Always save — even if autosave timer isn't pending, unsaved micro-edits may exist
  if (currentDeck) saveCurrentDeck();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && currentDeck) {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    saveCurrentDeck();
  }
});

document.addEventListener('DOMContentLoaded', init);
