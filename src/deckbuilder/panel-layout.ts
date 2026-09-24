/**
 * Panel Layout — Customizable Widget Dashboard for the Deck Editor.
 *
 * Turns the fixed 2-column editor into a 12-column snap-to-grid dashboard
 * where every widget (Mana Curve, Synergy Web, Combos, etc.) can be freely
 * dragged, resized, collapsed, hidden, and rearranged.
 *
 * All DOM created programmatically (no innerHTML for XSS safety).
 * Uses shared/dom.ts h() helper and shared/storage.ts for persistence.
 */

import { h } from '../shared/dom.js';
import { storageGet, storageSet, STORAGE_KEYS } from '../shared/storage.js';
import { showConfirmModal } from './confirm-modal.js';
import { lineIcon } from './line-icons.js';

// ═══════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════

export type WidgetId =
  | 'cards' | 'search'
  | 'mana-curve' | 'color-pie' | 'type-dist'
  | 'power-bracket' | 'health-score' | 'official-bracket'
  | 'fingerprint' | 'mana-calc' | 'synergy-map' | 'combos'
  | 'draw-probability' | 'deck-tips' | 'land-split' | 'tags'
  | 'summary-bar'
  | 'price-summary' | 'collection' | 'budget'
  | 'export' | 'version-history'
  | 'matchups' | 'smart-recs' | 'rec-history'
  | 'edhrec' | 'import'
  | 'repo'
  | 'coach'
  | 'matchup-strategy'
  | 'deck-solver'
  | 'cut-suggestions'
  | 'simulation';

interface WidgetPlacement {
  widgetId: WidgetId;
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
  visible: boolean;
  collapsed: boolean;
}

interface WidgetRegistryEntry {
  id: WidgetId;
  label: string;
  minColSpan: number;
  minRowSpan: number;
  defaultVisible: boolean;
  /** CSS selectors to extract content from the existing DOM */
  extractSelectors: string[];
}

interface LayoutConfig {
  version: number;
  columns: number;
  rowHeight: number;
  widgets: WidgetPlacement[];
}

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════

const LAYOUT_VERSION = 2;
const GRID_COLUMNS = 12;
const ROW_HEIGHT = 56;

// ═══════════════════════════════════════════════════════════════════
// Layout Presets
// ═══════════════════════════════════════════════════════════════════

interface LayoutPreset {
  id: string;
  name: string;
  description: string;
  widgets: WidgetPlacement[];
}

const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'compact',
    name: 'Compact',
    description: 'Deck + Search + Essential Analytics',
    widgets: [
      { widgetId: 'cards', col: 0, row: 0, colSpan: 7, rowSpan: 12, visible: true, collapsed: false },
      { widgetId: 'search', col: 7, row: 0, colSpan: 5, rowSpan: 6, visible: true, collapsed: false },
      { widgetId: 'mana-curve', col: 7, row: 6, colSpan: 3, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'power-bracket', col: 10, row: 6, colSpan: 2, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'health-score', col: 7, row: 9, colSpan: 2, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'price-summary', col: 9, row: 9, colSpan: 3, rowSpan: 3, visible: true, collapsed: false },
    ]
  },

  {
    id: 'analytics',
    name: 'Analytics Focus',
    description: 'Full analytics dashboard with charts',
    widgets: [
      { widgetId: 'cards', col: 0, row: 0, colSpan: 5, rowSpan: 10, visible: true, collapsed: false },
      { widgetId: 'search', col: 0, row: 10, colSpan: 5, rowSpan: 6, visible: true, collapsed: false },
      { widgetId: 'mana-curve', col: 5, row: 0, colSpan: 4, rowSpan: 4, visible: true, collapsed: false },
      { widgetId: 'color-pie', col: 9, row: 0, colSpan: 3, rowSpan: 4, visible: true, collapsed: false },
      { widgetId: 'type-dist', col: 5, row: 4, colSpan: 3, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'power-bracket', col: 8, row: 4, colSpan: 2, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'health-score', col: 10, row: 4, colSpan: 2, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'combos', col: 5, row: 7, colSpan: 4, rowSpan: 4, visible: true, collapsed: false },
      { widgetId: 'synergy-map', col: 9, row: 7, colSpan: 3, rowSpan: 4, visible: true, collapsed: false },
      { widgetId: 'price-summary', col: 5, row: 11, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
      { widgetId: 'deck-tips', col: 8, row: 11, colSpan: 4, rowSpan: 2, visible: true, collapsed: false },
    ]
  },

  {
    id: 'goldfish',
    name: 'Goldfish Testing',
    description: 'Deck + Playtest Coach + Draw Probability',
    widgets: [
      { widgetId: 'cards', col: 0, row: 0, colSpan: 8, rowSpan: 10, visible: true, collapsed: false },
      { widgetId: 'coach', col: 8, row: 0, colSpan: 4, rowSpan: 6, visible: true, collapsed: false },
      { widgetId: 'draw-probability', col: 8, row: 6, colSpan: 4, rowSpan: 4, visible: true, collapsed: false },
      { widgetId: 'search', col: 0, row: 10, colSpan: 6, rowSpan: 5, visible: true, collapsed: false },
      { widgetId: 'mana-curve', col: 6, row: 10, colSpan: 3, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'power-bracket', col: 9, row: 10, colSpan: 3, rowSpan: 3, visible: true, collapsed: false },
    ]
  },

  {
    id: 'minimal',
    name: 'Minimal',
    description: 'Just Deck + Search. Maximum focus.',
    widgets: [
      { widgetId: 'cards', col: 0, row: 0, colSpan: 8, rowSpan: 14, visible: true, collapsed: false },
      { widgetId: 'search', col: 8, row: 0, colSpan: 4, rowSpan: 14, visible: true, collapsed: false },
    ]
  },

  {
    id: 'full',
    name: 'Full Dashboard',
    description: 'Everything visible. Power user mode.',
    widgets: [
      { widgetId: 'cards', col: 0, row: 0, colSpan: 4, rowSpan: 16, visible: true, collapsed: false },
      { widgetId: 'search', col: 4, row: 0, colSpan: 3, rowSpan: 8, visible: true, collapsed: false },
      { widgetId: 'mana-curve', col: 7, row: 0, colSpan: 3, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'color-pie', col: 10, row: 0, colSpan: 2, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'type-dist', col: 7, row: 3, colSpan: 2, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'power-bracket', col: 9, row: 3, colSpan: 2, rowSpan: 2, visible: true, collapsed: false },
      { widgetId: 'health-score', col: 11, row: 3, colSpan: 1, rowSpan: 2, visible: true, collapsed: false },
      { widgetId: 'price-summary', col: 9, row: 5, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
      { widgetId: 'combos', col: 7, row: 7, colSpan: 3, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'synergy-map', col: 10, row: 7, colSpan: 2, rowSpan: 3, visible: true, collapsed: false },
      { widgetId: 'budget', col: 4, row: 8, colSpan: 3, rowSpan: 4, visible: true, collapsed: false },
      { widgetId: 'deck-tips', col: 7, row: 10, colSpan: 5, rowSpan: 3, visible: true, collapsed: false },
    ]
  },
];

export function applyPreset(presetId: string): void {
  const preset = LAYOUT_PRESETS.find(p => p.id === presetId);
  if (!preset || !layoutConfig) return;

  // Update layout config with preset
  layoutConfig.widgets = preset.widgets;
  saveLayout();

  // Clear existing widgets
  gridContainer?.querySelectorAll('.layout-widget').forEach(w => w.remove());
  widgetWrappers.clear();

  // Re-mount all widgets with new positions
  for (const placement of preset.widgets) {
    if (!placement.visible) continue;

    const entry = WIDGET_REGISTRY.find(e => e.id === placement.widgetId);
    if (!entry) continue;

    const body = extractWidgetContent(entry);
    if (!body) continue;

    const wrapper = createWidgetWrapper(entry, placement);
    const resizeHandle = wrapper.querySelector('.layout-resize-handle');
    if (resizeHandle) {
      wrapper.insertBefore(body, resizeHandle);
    } else {
      wrapper.appendChild(body);
    }

    applyGridPosition(wrapper, placement);
    setupWidgetInteractions(wrapper, entry.id);
    gridContainer?.appendChild(wrapper);
    widgetWrappers.set(entry.id, wrapper);
  }
}

export { LAYOUT_PRESETS };

// ═══════════════════════════════════════════════════════════════════
// Widget Registry
// ═══════════════════════════════════════════════════════════════════

const WIDGET_REGISTRY: WidgetRegistryEntry[] = [
  // Core
  { id: 'cards', label: 'Deck Cards', minColSpan: 4, minRowSpan: 4, defaultVisible: true,
    extractSelectors: ['#descriptionEditor', '#bulkBar', '#boardLiveRegion', '#boardRows', '#rulesPanel'] },
  { id: 'search', label: 'Card Search', minColSpan: 3, minRowSpan: 3, defaultVisible: true,
    extractSelectors: ['.sidebar-search', '#searchFilters', '#activeFilterPills', '#searchResults'] },

  // Analytics
  { id: 'commander-stats', label: 'Commander Stats', minColSpan: 3, minRowSpan: 3, defaultVisible: true,
    extractSelectors: ['#commanderStatsWidget'] },
  { id: 'mana-curve', label: 'Mana Curve', minColSpan: 3, minRowSpan: 2, defaultVisible: true,
    extractSelectors: ['#manaCurveChart', '#manaCurveAvg'] },
  { id: 'color-pie', label: 'Color Distribution', minColSpan: 2, minRowSpan: 2, defaultVisible: true,
    extractSelectors: ['#colorDonutChart'] },
  { id: 'type-dist', label: 'Type Distribution', minColSpan: 2, minRowSpan: 2, defaultVisible: true,
    extractSelectors: ['#typeDistChart'] },
  { id: 'power-bracket', label: 'Power Bracket', minColSpan: 2, minRowSpan: 2, defaultVisible: true,
    extractSelectors: ['#powerBracketBox'] },
  { id: 'health-score', label: 'Health Score', minColSpan: 2, minRowSpan: 2, defaultVisible: true,
    extractSelectors: ['#healthScoreBox'] },
  { id: 'official-bracket', label: 'Commander Bracket', minColSpan: 2, minRowSpan: 2, defaultVisible: false,
    extractSelectors: ['#officialBracketBox'] },
  { id: 'fingerprint', label: 'Deck DNA', minColSpan: 2, minRowSpan: 2, defaultVisible: false,
    extractSelectors: ['#fingerprintBox'] },
  { id: 'mana-calc', label: 'Mana Base Calc', minColSpan: 3, minRowSpan: 2, defaultVisible: false,
    extractSelectors: ['#manaCalcBox'] },
  { id: 'synergy-map', label: 'Synergy Web', minColSpan: 3, minRowSpan: 2, defaultVisible: false,
    extractSelectors: ['#synergyMapBox'] },
  { id: 'combos', label: 'Detected Combos', minColSpan: 3, minRowSpan: 2, defaultVisible: false,
    extractSelectors: ['#combosPanel'] },
  { id: 'draw-probability', label: 'Draw Probability', minColSpan: 3, minRowSpan: 2, defaultVisible: false,
    extractSelectors: ['#drawProbabilityBox'] },
  { id: 'deck-tips', label: 'Deck Tips', minColSpan: 3, minRowSpan: 2, defaultVisible: true,
    extractSelectors: ['#deckTipsBox'] },
  { id: 'land-split', label: 'Land/Nonland', minColSpan: 2, minRowSpan: 1, defaultVisible: true,
    extractSelectors: ['#analyticsLandSplit'] },
  { id: 'tags', label: 'Deck Tags', minColSpan: 2, minRowSpan: 1, defaultVisible: true,
    extractSelectors: ['#analyticsTags'] },
  { id: 'summary-bar', label: 'Analytics Summary', minColSpan: 3, minRowSpan: 1, defaultVisible: true,
    extractSelectors: ['#analyticsSummaryBar'] },

  // Prices
  { id: 'price-summary', label: 'Price Summary', minColSpan: 3, minRowSpan: 2, defaultVisible: false,
    extractSelectors: ['#priceEurTotal', '#priceUsdTotal', '#currencyToggle', '#priceMeta', '#priceTopExpensive'] },
  { id: 'collection', label: 'Collection', minColSpan: 3, minRowSpan: 3, defaultVisible: false,
    extractSelectors: ['#collectionMissing'] },
  { id: 'budget', label: 'Budget Optimizer', minColSpan: 3, minRowSpan: 3, defaultVisible: false,
    extractSelectors: ['#budgetOptimizerBox', '#budgetAlternativesBox'] },

  // Export
  { id: 'export', label: 'Export & Share', minColSpan: 3, minRowSpan: 3, defaultVisible: false,
    extractSelectors: [] }, // Special: takes entire export tab
  { id: 'version-history', label: 'Version History', minColSpan: 3, minRowSpan: 2, defaultVisible: false,
    extractSelectors: ['#deckHistoryBox'] },

  // Strategy
  { id: 'matchups', label: 'Matchup Strategy', minColSpan: 3, minRowSpan: 3, defaultVisible: false,
    extractSelectors: ['#matchupPanelContainer'] },
  { id: 'smart-recs', label: 'Smart Recs', minColSpan: 3, minRowSpan: 3, defaultVisible: false,
    extractSelectors: ['#smartRecsContainer'] },
  { id: 'rec-history', label: 'Rec History', minColSpan: 3, minRowSpan: 2, defaultVisible: false,
    extractSelectors: ['#recHistoryContainer'] },

  // Other
  { id: 'edhrec', label: 'EDHREC Recs', minColSpan: 3, minRowSpan: 3, defaultVisible: false,
    extractSelectors: ['#edhrecPanelContainer'] },
  { id: 'import', label: 'Import Decklist', minColSpan: 3, minRowSpan: 2, defaultVisible: false,
    extractSelectors: [] }, // Special: takes entire import tab

  // Git / Repo
  { id: 'repo', label: 'Repo', minColSpan: 4, minRowSpan: 4, defaultVisible: false,
    extractSelectors: [] }, // Special: takes entire repo tab

  // Playtest Coach
  { id: 'coach', label: 'Playtest Coach', minColSpan: 3, minRowSpan: 3, defaultVisible: false,
    extractSelectors: ['#goldfishCoachWidget'] },

  // Matchup Strategy
  { id: 'matchup-strategy', label: 'Matchup Strategy', minColSpan: 3, minRowSpan: 4, defaultVisible: false,
    extractSelectors: ['#matchupStrategyWidget'] },

  // Deck Solver
  { id: 'deck-solver', label: 'Deck Solver', minColSpan: 3, minRowSpan: 3, defaultVisible: false,
    extractSelectors: ['#deckSolverWidget'] },

  // Cut Suggestions
  { id: 'cut-suggestions', label: 'Cut Suggestions', minColSpan: 3, minRowSpan: 4, defaultVisible: false,
    extractSelectors: ['#cutSuggestionsWidget'] },

  // Simulation
  { id: 'simulation', label: 'Digital Twin', minColSpan: 4, minRowSpan: 5, defaultVisible: false,
    extractSelectors: ['#simulationWidget'] },
];

const REGISTRY_MAP = new Map<WidgetId, WidgetRegistryEntry>(
  WIDGET_REGISTRY.map((w) => [w.id, w]),
);

// ═══════════════════════════════════════════════════════════════════
// Default Layout
// ═══════════════════════════════════════════════════════════════════

function createDefaultLayout(): LayoutConfig {
  return {
    version: LAYOUT_VERSION,
    columns: GRID_COLUMNS,
    rowHeight: ROW_HEIGHT,
    widgets: [
      // Left: Cards area (large)
      { widgetId: 'cards', col: 0, row: 0, colSpan: 7, rowSpan: 10, visible: true, collapsed: false },
      // Right top: Search
      { widgetId: 'search', col: 7, row: 0, colSpan: 5, rowSpan: 5, visible: true, collapsed: false },
      // Right middle: Mana Curve
      { widgetId: 'mana-curve', col: 7, row: 5, colSpan: 5, rowSpan: 3, visible: true, collapsed: false },
      // Right bottom: Color Pie + Type Dist
      { widgetId: 'color-pie', col: 7, row: 8, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
      { widgetId: 'type-dist', col: 10, row: 8, colSpan: 2, rowSpan: 2, visible: true, collapsed: false },
      // Bottom row: Power + Health + Tips + Land/Tags + Summary
      { widgetId: 'power-bracket', col: 0, row: 10, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
      { widgetId: 'health-score', col: 3, row: 10, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
      { widgetId: 'deck-tips', col: 6, row: 10, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
      { widgetId: 'land-split', col: 9, row: 10, colSpan: 2, rowSpan: 1, visible: true, collapsed: false },
      { widgetId: 'tags', col: 9, row: 11, colSpan: 2, rowSpan: 1, visible: true, collapsed: false },
      { widgetId: 'summary-bar', col: 11, row: 10, colSpan: 1, rowSpan: 2, visible: true, collapsed: false },
      // Hidden by default
      { widgetId: 'official-bracket', col: 0, row: 12, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
      { widgetId: 'fingerprint', col: 3, row: 12, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
      { widgetId: 'mana-calc', col: 6, row: 12, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
      { widgetId: 'synergy-map', col: 9, row: 12, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
      { widgetId: 'combos', col: 0, row: 14, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
      { widgetId: 'draw-probability', col: 4, row: 14, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
      { widgetId: 'price-summary', col: 0, row: 17, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
      { widgetId: 'collection', col: 4, row: 17, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
      { widgetId: 'budget', col: 8, row: 17, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
      { widgetId: 'export', col: 0, row: 20, colSpan: 6, rowSpan: 4, visible: false, collapsed: false },
      { widgetId: 'version-history', col: 6, row: 20, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
      { widgetId: 'matchups', col: 0, row: 24, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
      { widgetId: 'smart-recs', col: 4, row: 24, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
      { widgetId: 'rec-history', col: 8, row: 24, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
      { widgetId: 'edhrec', col: 0, row: 27, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
      { widgetId: 'import', col: 4, row: 27, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
      { widgetId: 'repo', col: 8, row: 27, colSpan: 4, rowSpan: 4, visible: false, collapsed: false },
      { widgetId: 'coach', col: 0, row: 31, colSpan: 6, rowSpan: 4, visible: false, collapsed: false },
      { widgetId: 'matchup-strategy', col: 6, row: 31, colSpan: 6, rowSpan: 4, visible: false, collapsed: false },
      { widgetId: 'deck-solver', col: 0, row: 35, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
      { widgetId: 'cut-suggestions', col: 4, row: 35, colSpan: 4, rowSpan: 4, visible: false, collapsed: false },
      { widgetId: 'simulation', col: 8, row: 35, colSpan: 4, rowSpan: 5, visible: false, collapsed: false },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════
// Module State
// ═══════════════════════════════════════════════════════════════════

let layoutConfig: LayoutConfig | null = null;
let isActive = false;
let isCustomizing = false;

/** Maps widgetId → wrapper DOM element */
const widgetWrappers = new Map<WidgetId, HTMLElement>();

/** Maps widgetId → original parent element (for restoration) */
const originalParents = new Map<WidgetId, { parent: HTMLElement; nextSibling: Node | null }>();

/** Container for the grid */
let gridContainer: HTMLElement | null = null;

/** Layout toolbar element */
let toolbarEl: HTMLElement | null = null;

/** Drag state */
let dragState: {
  widgetId: WidgetId;
  startCol: number;
  startRow: number;
  offsetX: number;
  offsetY: number;
  placeholder: HTMLElement | null;
} | null = null;

/** Resize state */
let resizeState: {
  widgetId: WidgetId;
  startColSpan: number;
  startRowSpan: number;
  startMouseX: number;
  startMouseY: number;
} | null = null;

/** Cleanup functions */
const cleanupFns: Array<() => void> = [];

// ═══════════════════════════════════════════════════════════════════
// Storage
// ═══════════════════════════════════════════════════════════════════

function validateLayout(val: unknown): boolean {
  if (!val || typeof val !== 'object') return false;
  const obj = val as Record<string, unknown>;
  if (obj.version !== LAYOUT_VERSION) return false;
  if (!Array.isArray(obj.widgets)) return false;
  return true;
}

function loadLayout(): LayoutConfig {
  const config = storageGet<LayoutConfig>(
    STORAGE_KEYS.DECKBUILDER_PANEL_LAYOUT,
    createDefaultLayout(),
    validateLayout,
  );
  // Migrate: ensure all registered widgets have a placement
  for (const entry of WIDGET_REGISTRY) {
    if (!config.widgets.find((w) => w.widgetId === entry.id)) {
      config.widgets.push({
        widgetId: entry.id,
        col: 0, row: 50, colSpan: entry.minColSpan, rowSpan: entry.minRowSpan,
        visible: false, collapsed: false,
      });
    }
  }
  return config;
}

function saveLayout(): void {
  if (layoutConfig) {
    storageSet(STORAGE_KEYS.DECKBUILDER_PANEL_LAYOUT, layoutConfig);
  }
}

function getPlacement(id: WidgetId): WidgetPlacement | undefined {
  return layoutConfig?.widgets.find((w) => w.widgetId === id);
}

// ═══════════════════════════════════════════════════════════════════
// DOM Extraction — Move widget content from original tabs to wrappers
// ═══════════════════════════════════════════════════════════════════

/**
 * Extract a widget's content from the existing DOM and wrap it.
 * Uses appendChild which MOVES elements (preserving event listeners).
 */
function extractWidgetContent(entry: WidgetRegistryEntry): HTMLElement | null {
  const body = document.createElement('div');
  body.className = 'layout-widget-body';

  // Special cases: entire tab panels
  if (entry.id === 'export') {
    const panel = document.querySelector<HTMLElement>('[data-tab-panel="export"]');
    if (panel) {
      // Move all children
      while (panel.firstChild) body.appendChild(panel.firstChild);
      return body;
    }
    return null;
  }
  if (entry.id === 'import') {
    const panel = document.querySelector<HTMLElement>('[data-tab-panel="deck"]');
    if (panel) {
      while (panel.firstChild) body.appendChild(panel.firstChild);
      return body;
    }
    return null;
  }
  if (entry.id === 'repo') {
    const panel = document.querySelector<HTMLElement>('[data-tab-panel="repo"]');
    if (panel) {
      while (panel.firstChild) body.appendChild(panel.firstChild);
      return body;
    }
    return null;
  }
  if (entry.id === 'matchups') {
    // Grab the matchup section including its mode selector
    const modeSelector = document.getElementById('strategyMetaMode');
    const container = document.getElementById('matchupPanelContainer');
    if (modeSelector) {
      const row = modeSelector.closest('div');
      if (row) body.appendChild(row);
    }
    if (container) body.appendChild(container);
    return body.childElementCount > 0 ? body : null;
  }
  if (entry.id === 'smart-recs') {
    const modeSelector = document.getElementById('recsMetaMode');
    const container = document.getElementById('smartRecsContainer');
    if (modeSelector) {
      const row = modeSelector.closest('div');
      if (row) body.appendChild(row);
    }
    if (container) body.appendChild(container);
    return body.childElementCount > 0 ? body : null;
  }
  if (entry.id === 'price-summary') {
    // Grab the pricing KPI section, currency toggle, meta, links, and top expensive
    const pricePanel = document.querySelector<HTMLElement>('[data-tab-panel="prices"]');
    if (pricePanel) {
      // Move children up to the price-sub-tabs
      const subTabs = pricePanel.querySelector('.price-sub-tabs');
      const children = Array.from(pricePanel.children);
      for (const child of children) {
        if (child === subTabs) break;
        body.appendChild(child);
      }
      return body.childElementCount > 0 ? body : null;
    }
    return null;
  }
  if (entry.id === 'collection') {
    const panel = document.querySelector<HTMLElement>('[data-price-panel="collection"]');
    if (panel) {
      while (panel.firstChild) body.appendChild(panel.firstChild);
      return body;
    }
    return null;
  }
  if (entry.id === 'budget') {
    const panel = document.querySelector<HTMLElement>('[data-price-panel="budget"]');
    if (panel) {
      while (panel.firstChild) body.appendChild(panel.firstChild);
      return body;
    }
    return null;
  }

  // Standard extraction: grab elements by selectors
  let found = 0;
  for (const selector of entry.extractSelectors) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) {
      // Save original parent for restore
      if (!originalParents.has(entry.id)) {
        originalParents.set(entry.id, {
          parent: el.parentElement as HTMLElement,
          nextSibling: el.nextSibling,
        });
      }
      body.appendChild(el);
      found++;
    }
  }

  if (found === 0) {
    // Fallback: show placeholder text instead of empty widget
    const placeholder = document.createElement('div');
    placeholder.className = 'layout-widget-empty';
    placeholder.textContent = 'Widget content will appear when data loads.';
    body.appendChild(placeholder);
  }

  return body;
}

// ═══════════════════════════════════════════════════════════════════
// Widget Wrapper Creation
// ═══════════════════════════════════════════════════════════════════

function createWidgetWrapper(entry: WidgetRegistryEntry, placement: WidgetPlacement): HTMLElement {
  // Collapse button
  const collapseBtn = h('button', {
    className: 'layout-widget-btn',
    type: 'button',
    title: 'Collapse / Expand',
    onClick: () => toggleCollapse(entry.id),
  }, placement.collapsed ? '▶' : '▼');

  // Hide button (only in customize mode, but create it always)
  const hideBtn = h('button', {
    className: 'layout-widget-btn lw-hide-btn',
    type: 'button',
    title: 'Hide widget',
    onClick: () => hideWidget(entry.id),
 }, '✕');

  // Controls container
  const controls = h('div', { className: 'layout-widget-controls' }, collapseBtn, hideBtn);

  // Header (drag handle)
  const header = h('div', { className: 'layout-widget-header' },
    lineIcon(entry.id, 'layout-widget-icon'),
    h('span', { className: 'layout-widget-label' }, entry.label),
    controls,
  );

  // Resize handle
  const resizeHandle = document.createElement('div');
  resizeHandle.className = 'layout-resize-handle';

  // Wrapper
  const wrapper = document.createElement('div');
  wrapper.className = 'layout-widget';
  wrapper.dataset.widgetId = entry.id;
  if (placement.collapsed) wrapper.classList.add('lw-collapsed');
  wrapper.appendChild(header);
  // Body is appended by extractWidgetContent
  wrapper.appendChild(resizeHandle);

  return wrapper;
}

function applyGridPosition(wrapper: HTMLElement, placement: WidgetPlacement): void {
  wrapper.style.gridColumn = `${placement.col + 1} / span ${placement.colSpan}`;
  if (placement.collapsed) {
    wrapper.style.gridRow = `${placement.row + 1} / span 1`;
  } else {
    wrapper.style.gridRow = `${placement.row + 1} / span ${placement.rowSpan}`;
  }
  wrapper.style.display = placement.visible ? '' : 'none';
}

// ═══════════════════════════════════════════════════════════════════
// Grid Snap Helpers
// ═══════════════════════════════════════════════════════════════════

function mouseToGrid(e: MouseEvent): { col: number; row: number } {
  if (!gridContainer) return { col: 0, row: 0 };
  const rect = gridContainer.getBoundingClientRect();
  const relX = e.clientX - rect.left + gridContainer.scrollLeft;
  const relY = e.clientY - rect.top + gridContainer.scrollTop;
  const cellWidth = rect.width / GRID_COLUMNS;
  const cellHeight = ROW_HEIGHT + 6; // row height + gap
  return {
    col: Math.max(0, Math.min(GRID_COLUMNS - 1, Math.floor(relX / cellWidth))),
    row: Math.max(0, Math.floor(relY / cellHeight)),
  };
}

function hasCollision(
  placement: WidgetPlacement,
  exclude: WidgetId,
): boolean {
  if (!layoutConfig) return false;
  for (const other of layoutConfig.widgets) {
    if (!other.visible || other.widgetId === exclude) continue;
    // AABB overlap test
    const noOverlap =
      placement.col + placement.colSpan <= other.col ||
      other.col + other.colSpan <= placement.col ||
      placement.row + placement.rowSpan <= other.row ||
      other.row + other.rowSpan <= placement.row;
    if (!noOverlap) return true;
  }
  return false;
}

/**
 * Auto-push: when placing a widget creates a collision, push overlapping
 * widgets down to make room.
 */
function autoPush(newPlacement: WidgetPlacement): void {
  if (!layoutConfig) return;
  const maxIterations = 50;
  let iteration = 0;

  const changed = new Set<WidgetId>();
  changed.add(newPlacement.widgetId);

  while (iteration++ < maxIterations) {
    let anyPushed = false;
    for (const w of layoutConfig.widgets) {
      if (!w.visible || w.widgetId === newPlacement.widgetId) continue;
      if (changed.has(w.widgetId)) continue;

      // Check overlap with the new placement
      const noOverlap =
        newPlacement.col + newPlacement.colSpan <= w.col ||
        w.col + w.colSpan <= newPlacement.col ||
        newPlacement.row + newPlacement.rowSpan <= w.row ||
        w.row + w.rowSpan <= newPlacement.row;

      if (!noOverlap) {
        // Push this widget below the new one
        w.row = newPlacement.row + newPlacement.rowSpan;
        changed.add(w.widgetId);
        anyPushed = true;
      }
    }

    // Also check pushed widgets against each other
    if (!anyPushed) break;

    // Re-check for cascading collisions
    for (const w of layoutConfig.widgets) {
      if (!w.visible) continue;
      for (const w2 of layoutConfig.widgets) {
        if (!w2.visible || w.widgetId === w2.widgetId) continue;
        if (w.widgetId >= w2.widgetId) continue; // avoid double-check

        const noOverlap =
          w.col + w.colSpan <= w2.col ||
          w2.col + w2.colSpan <= w.col ||
          w.row + w.rowSpan <= w2.row ||
          w2.row + w2.rowSpan <= w.row;

        if (!noOverlap) {
          // Push the one with higher row down
          if (w.row <= w2.row) {
            w2.row = w.row + w.rowSpan;
          } else {
            w.row = w2.row + w2.rowSpan;
          }
          anyPushed = true;
        }
      }
    }
    if (!anyPushed) break;
  }
}

/**
 * Find the first free position for a widget with the given size.
 */
function findFreePosition(colSpan: number, rowSpan: number, excludeId?: WidgetId): { col: number; row: number } {
  if (!layoutConfig) return { col: 0, row: 0 };

  // Find the bottom-most row of all visible widgets
  let maxRow = 0;
  for (const w of layoutConfig.widgets) {
    if (w.visible && w.widgetId !== excludeId) {
      maxRow = Math.max(maxRow, w.row + w.rowSpan);
    }
  }

  // Try to place from row 0
  for (let row = 0; row <= maxRow + 5; row++) {
    for (let col = 0; col <= GRID_COLUMNS - colSpan; col++) {
      const test: WidgetPlacement = {
        widgetId: (excludeId || 'cards') as WidgetId,
        col,
        row,
        colSpan,
        rowSpan,
        visible: true,
        collapsed: false,
      };
      if (!hasCollision(test, test.widgetId)) {
        return { col, row };
      }
    }
  }

  // Fallback: place at the bottom
  return { col: 0, row: maxRow };
}

// ═══════════════════════════════════════════════════════════════════
// Drag System
// ═══════════════════════════════════════════════════════════════════

function onDragStart(e: MouseEvent, widgetId: WidgetId): void {
  if (!isActive || !gridContainer || !layoutConfig) return;
  const placement = getPlacement(widgetId);
  if (!placement) return;

  e.preventDefault();
  const wrapper = widgetWrappers.get(widgetId);
  if (!wrapper) return;

  const rect = wrapper.getBoundingClientRect();
  const gridRect = gridContainer.getBoundingClientRect();
  const cellW = gridRect.width / GRID_COLUMNS;
  const cellH = ROW_HEIGHT + 6;

  dragState = {
    widgetId,
    startCol: placement.col,
    startRow: placement.row,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    placeholder: null,
  };

  // Create placeholder
  const ph = document.createElement('div');
  ph.className = 'layout-placeholder';
  ph.style.gridColumn = `${placement.col + 1} / span ${placement.colSpan}`;
  ph.style.gridRow = `${placement.row + 1} / span ${placement.rowSpan}`;
  gridContainer.appendChild(ph);
  dragState.placeholder = ph;

  wrapper.classList.add('lw-dragging');
  wrapper.style.position = 'fixed';
  wrapper.style.left = rect.left + 'px';
  wrapper.style.top = rect.top + 'px';
  wrapper.style.width = rect.width + 'px';
  wrapper.style.height = rect.height + 'px';
  wrapper.style.zIndex = '10000';

  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
}

function onDragMove(e: MouseEvent): void {
  if (!dragState || !gridContainer || !layoutConfig) return;
  const wrapper = widgetWrappers.get(dragState.widgetId);
  if (!wrapper) return;

  // Move the floating widget
  wrapper.style.left = (e.clientX - dragState.offsetX) + 'px';
  wrapper.style.top = (e.clientY - dragState.offsetY) + 'px';

  // Compute grid snap position
  const grid = mouseToGrid(e);
  const placement = getPlacement(dragState.widgetId);
  if (!placement || !dragState.placeholder) return;

  // Clamp col so widget doesn't overflow grid
  const maxCol = GRID_COLUMNS - placement.colSpan;
  const snappedCol = Math.max(0, Math.min(maxCol, grid.col));
  const snappedRow = Math.max(0, grid.row);

  // Update placeholder
  dragState.placeholder.style.gridColumn = `${snappedCol + 1} / span ${placement.colSpan}`;
  dragState.placeholder.style.gridRow = `${snappedRow + 1} / span ${placement.rowSpan}`;

  // Check collision for visual feedback
  const testPlacement: WidgetPlacement = {
    ...placement,
    col: snappedCol,
    row: snappedRow,
  };
  const collides = hasCollision(testPlacement, dragState.widgetId);
  dragState.placeholder.classList.toggle('lp-invalid', collides);
}

function onDragEnd(e: MouseEvent): void {
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', onDragEnd);

  if (!dragState || !layoutConfig || !gridContainer) {
    dragState = null;
    return;
  }

  const wrapper = widgetWrappers.get(dragState.widgetId);
  const placement = getPlacement(dragState.widgetId);

  // Remove placeholder
  if (dragState.placeholder) {
    dragState.placeholder.remove();
  }

  if (wrapper && placement) {
    // Compute final snap position
    const grid = mouseToGrid(e);
    const maxCol = GRID_COLUMNS - placement.colSpan;
    const newCol = Math.max(0, Math.min(maxCol, grid.col));
    const newRow = Math.max(0, grid.row);

    // Apply new position
    placement.col = newCol;
    placement.row = newRow;

    // Auto-push colliders
    autoPush(placement);

    // Reset wrapper styles
    wrapper.classList.remove('lw-dragging');
    wrapper.style.position = '';
    wrapper.style.left = '';
    wrapper.style.top = '';
    wrapper.style.width = '';
    wrapper.style.height = '';
    wrapper.style.zIndex = '';

    // Re-apply all positions (auto-push may have moved others)
    applyAllPositions();
    saveLayout();
  }

  dragState = null;
}

// ═══════════════════════════════════════════════════════════════════
// Resize System
// ═══════════════════════════════════════════════════════════════════

function onResizeStart(e: MouseEvent, widgetId: WidgetId): void {
  if (!isActive || !gridContainer || !layoutConfig) return;
  const placement = getPlacement(widgetId);
  if (!placement) return;

  e.preventDefault();
  e.stopPropagation();

  resizeState = {
    widgetId,
    startColSpan: placement.colSpan,
    startRowSpan: placement.rowSpan,
    startMouseX: e.clientX,
    startMouseY: e.clientY,
  };

  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
}

function onResizeMove(e: MouseEvent): void {
  if (!resizeState || !gridContainer || !layoutConfig) return;

  const placement = getPlacement(resizeState.widgetId);
  const entry = REGISTRY_MAP.get(resizeState.widgetId);
  if (!placement || !entry) return;

  const rect = gridContainer.getBoundingClientRect();
  const cellW = rect.width / GRID_COLUMNS;
  const cellH = ROW_HEIGHT + 6;

  const dx = e.clientX - resizeState.startMouseX;
  const dy = e.clientY - resizeState.startMouseY;

  const deltaCol = Math.round(dx / cellW);
  const deltaRow = Math.round(dy / cellH);

  const newColSpan = Math.max(entry.minColSpan, Math.min(GRID_COLUMNS - placement.col, resizeState.startColSpan + deltaCol));
  const newRowSpan = Math.max(entry.minRowSpan, resizeState.startRowSpan + deltaRow);

  placement.colSpan = newColSpan;
  placement.rowSpan = newRowSpan;

  // Update visual immediately
  const wrapper = widgetWrappers.get(resizeState.widgetId);
  if (wrapper) {
    applyGridPosition(wrapper, placement);
  }
}

function onResizeEnd(): void {
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);

  if (resizeState && layoutConfig) {
    const placement = getPlacement(resizeState.widgetId);
    if (placement) {
      autoPush(placement);
      applyAllPositions();
    }
    saveLayout();
  }

  resizeState = null;
}

// ═══════════════════════════════════════════════════════════════════
// Widget Actions
// ═══════════════════════════════════════════════════════════════════

function toggleCollapse(id: WidgetId): void {
  if (!layoutConfig) return;
  const placement = getPlacement(id);
  if (!placement) return;

  placement.collapsed = !placement.collapsed;

  const wrapper = widgetWrappers.get(id);
  if (wrapper) {
    wrapper.classList.toggle('lw-collapsed', placement.collapsed);
    // Update collapse button text
    const btn = wrapper.querySelector('.layout-widget-btn');
    if (btn) btn.textContent = placement.collapsed ? '▶' : '▼';
    applyGridPosition(wrapper, placement);
  }
  saveLayout();
}

function hideWidget(id: WidgetId): void {
  if (!layoutConfig) return;
  const placement = getPlacement(id);
  if (!placement) return;

  placement.visible = false;
  const wrapper = widgetWrappers.get(id);
  if (wrapper) {
    wrapper.style.display = 'none';
  }

  updateToolbarPills();
  saveLayout();
}

function showWidget(id: WidgetId): void {
  if (!layoutConfig) return;
  const placement = getPlacement(id);
  const entry = REGISTRY_MAP.get(id);
  if (!placement || !entry) return;

  // If widget wrapper doesn't exist yet, create it
  if (!widgetWrappers.has(id) && gridContainer) {
    const body = extractWidgetContent(entry);
    if (body) {
      const wrapper = createWidgetWrapper(entry, placement);
      // Insert body before resize handle
      const resizeHandle = wrapper.querySelector('.layout-resize-handle');
      if (resizeHandle) {
        wrapper.insertBefore(body, resizeHandle);
      } else {
        wrapper.appendChild(body);
      }
      setupWidgetInteractions(wrapper, id);
      gridContainer.appendChild(wrapper);
      widgetWrappers.set(id, wrapper);
    }
  }

  // Find a free position
  const pos = findFreePosition(placement.colSpan, placement.rowSpan, id);
  placement.col = pos.col;
  placement.row = pos.row;
  placement.visible = true;

  const wrapper = widgetWrappers.get(id);
  if (wrapper) {
    applyGridPosition(wrapper, placement);
    // Entrance animation
    wrapper.classList.add('lw-entering');
    setTimeout(() => wrapper.classList.remove('lw-entering'), 300);
  }

  updateToolbarPills();
  saveLayout();

  // Scroll to the newly shown widget
  wrapper?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  // Notify listeners that a widget became visible
  document.dispatchEvent(new CustomEvent('layout-widget-shown', { detail: { widgetId: id } }));
}

// ═══════════════════════════════════════════════════════════════════
// Customize Mode
// ═══════════════════════════════════════════════════════════════════

export function enterCustomizeMode(): void {
  if (!isActive || isCustomizing) return;
  isCustomizing = true;

  gridContainer?.classList.add('layout-customize');

  // Show toolbar
  if (toolbarEl) toolbarEl.style.display = '';

  // Show hide buttons on all widgets
  for (const wrapper of widgetWrappers.values()) {
    wrapper.querySelectorAll<HTMLElement>('.lw-hide-btn').forEach((btn) => {
      btn.style.display = '';
    });
  }

  // Gold accent on layout button
  const layoutBtn = document.querySelector<HTMLElement>('.layout-toggle-btn');
  if (layoutBtn) layoutBtn.classList.add('layout-toggle-active');

  updateToolbarPills();
}

export function exitCustomizeMode(): void {
  if (!isCustomizing) return;
  isCustomizing = false;

  gridContainer?.classList.remove('layout-customize');

  // Hide toolbar
  if (toolbarEl) toolbarEl.style.display = 'none';

  // Hide hide buttons
  for (const wrapper of widgetWrappers.values()) {
    wrapper.querySelectorAll<HTMLElement>('.lw-hide-btn').forEach((btn) => {
      btn.style.display = 'none';
    });
  }

  // Remove gold accent from layout button
  const layoutBtn = document.querySelector<HTMLElement>('.layout-toggle-btn');
  if (layoutBtn) layoutBtn.classList.remove('layout-toggle-active');

  saveLayout();

  // Refresh all widgets after customize to ensure latest data
  setTimeout(() => refreshAllWidgets(), 100);
}

function updateToolbarPills(): void {
  if (!toolbarEl || !layoutConfig) return;
  const pillContainer = toolbarEl.querySelector('.layout-pill-container');
  const counterEl = toolbarEl.querySelector('.layout-toolbar-counter');
  if (!pillContainer) return;

  pillContainer.textContent = '';

  let visibleCount = 0;
  const total = WIDGET_REGISTRY.length;

  for (const entry of WIDGET_REGISTRY) {
    const placement = getPlacement(entry.id);
    const vis = placement?.visible ?? false;
    if (vis) visibleCount++;

    const pill = h('button', {
      className: `layout-widget-pill${vis ? ' lwp-active' : ''}`,
      type: 'button',
      title: vis ? `Hide ${entry.label}` : `Show ${entry.label}`,
      onClick: () => {
        if (vis) {
          hideWidget(entry.id);
        } else {
          showWidget(entry.id);
        }
      },
    }, entry.label);

    pillContainer.appendChild(pill);
  }

  // Update counter
  if (counterEl) {
    counterEl.textContent = `${visibleCount}/${total}`;
  }
}

function showAllWidgets(): void {
  if (!layoutConfig) return;
  for (const entry of WIDGET_REGISTRY) {
    const placement = getPlacement(entry.id);
    if (placement && !placement.visible) {
      showWidget(entry.id);
    }
  }
}

function hideAllWidgets(): void {
  if (!layoutConfig) return;
  // Keep cards and search visible always
  for (const entry of WIDGET_REGISTRY) {
    if (entry.id === 'cards' || entry.id === 'search') continue;
    const placement = getPlacement(entry.id);
    if (placement && placement.visible) {
      hideWidget(entry.id);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Apply All Positions
// ═══════════════════════════════════════════════════════════════════

function applyAllPositions(): void {
  if (!layoutConfig) return;
  for (const placement of layoutConfig.widgets) {
    const wrapper = widgetWrappers.get(placement.widgetId);
    if (wrapper) {
      applyGridPosition(wrapper, placement);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// Widget Interaction Setup
// ═══════════════════════════════════════════════════════════════════

function setupWidgetInteractions(wrapper: HTMLElement, widgetId: WidgetId): void {
  const header = wrapper.querySelector<HTMLElement>('.layout-widget-header');
  const resizeHandle = wrapper.querySelector<HTMLElement>('.layout-resize-handle');

  // Drag: mousedown on header
  if (header) {
    header.addEventListener('mousedown', (e: MouseEvent) => {
      // Don't drag if clicking a button
      if ((e.target as HTMLElement).closest('button')) return;
      onDragStart(e, widgetId);
    });

    // Double-click to collapse
    header.addEventListener('dblclick', () => {
      toggleCollapse(widgetId);
    });
  }

  // Resize: mousedown on handle
  if (resizeHandle) {
    resizeHandle.addEventListener('mousedown', (e: MouseEvent) => {
      onResizeStart(e, widgetId);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// Toolbar Creation
// ═══════════════════════════════════════════════════════════════════

function createToolbar(): HTMLElement {
  const resetBtn = h('button', {
    className: 'btn layout-toolbar-btn',
    type: 'button',
    onClick: () => confirmAndResetLayout(),
  }, '↺ Reset');

  const showAllBtn = h('button', {
    className: 'btn layout-toolbar-btn',
    type: 'button',
    title: 'Show all hidden widgets',
    onClick: () => showAllWidgets(),
 }, 'Show All');

  const hideAllBtn = h('button', {
    className: 'btn layout-toolbar-btn',
    type: 'button',
    title: 'Hide all widgets except Cards and Search',
    onClick: () => hideAllWidgets(),
 }, 'Hide All');

  const counterEl = document.createElement('span');
  counterEl.className = 'layout-toolbar-counter';

  const doneBtn = h('button', {
    className: 'btn primary layout-toolbar-btn',
    type: 'button',
    onClick: () => exitCustomizeMode(),
 }, ' Done');

  const pillContainer = document.createElement('div');
  pillContainer.className = 'layout-pill-container';

  // Preset buttons
  const presetDefault = h('button', {
    className: 'btn layout-toolbar-btn layout-preset-btn',
    type: 'button',
    title: 'Minimal: Just Deck + Search',
    onClick: () => applyPreset('minimal'),
  }, 'Minimal');

  const presetAnalytics = h('button', {
    className: 'btn layout-toolbar-btn layout-preset-btn',
    type: 'button',
    title: 'Analytics-focused: all analytics widgets visible and large',
    onClick: () => applyPreset('analytics'),
  }, 'Analytics');

  const presetCompact = h('button', {
    className: 'btn layout-toolbar-btn layout-preset-btn',
    type: 'button',
    title: 'Compact: Deck + Search + Essential Analytics',
    onClick: () => applyPreset('compact'),
  }, 'Compact');

  const toolbar = h('div', { className: 'layout-toolbar' },
    h('span', { className: 'layout-toolbar-label' }, 'Customize Layout'),
    counterEl,
    h('div', { className: 'layout-toolbar-sep' }),
    showAllBtn,
    hideAllBtn,
    h('div', { className: 'layout-toolbar-sep' }),
    presetDefault,
    presetAnalytics,
    presetCompact,
    h('div', { className: 'layout-toolbar-sep' }),
    resetBtn,
    h('div', { className: 'layout-toolbar-spacer' }),
    pillContainer,
    h('div', { className: 'layout-toolbar-spacer' }),
    doneBtn,
  );

  toolbar.style.display = 'none'; // Hidden by default
  return toolbar;
}

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Initialize the panel layout system.
 * Call this from editor-main.ts init() AFTER all render functions have run.
 */
export function initPanelLayout(): void {
  // Don't double-init
  if (isActive) return;

  // Check viewport — disable on mobile
  if (window.innerWidth <= 1024) return;

  layoutConfig = loadLayout();
  gridContainer = document.querySelector<HTMLElement>('.editor-main');
  if (!gridContainer) return;

  // Add "⚙ Layout" button to header
  const header = document.querySelector<HTMLElement>('.editor-header');
  if (header) {
    const spacer = header.querySelector('.header-spacer');
    const layoutBtn = h('button', {
      className: 'btn-ghost layout-toggle-btn',
      type: 'button',
      title: 'Customize panel layout',
      onClick: () => {
        if (isCustomizing) {
          exitCustomizeMode();
        } else {
          enterCustomizeMode();
        }
      },
    }, 'Layout');
    if (spacer) {
      spacer.before(layoutBtn);
    } else {
      header.appendChild(layoutBtn);
    }
  }

  // Create and insert toolbar
  toolbarEl = createToolbar();
  const editorLayout = document.querySelector<HTMLElement>('.editor-layout');
  const editorMain = document.querySelector<HTMLElement>('.editor-main');
  if (editorLayout && editorMain) {
    editorLayout.insertBefore(toolbarEl, editorMain);
  }

  // Switch to 12-column grid
  gridContainer.classList.add('layout-active');

  // Hide original containers (their children will be moved)
  const editorLeft = gridContainer.querySelector<HTMLElement>('.editor-left');
  const editorRight = gridContainer.querySelector<HTMLElement>('.editor-right');

  // Extract and mount visible widgets
  for (const entry of WIDGET_REGISTRY) {
    const placement = getPlacement(entry.id);
    if (!placement) continue;

    // Only extract visible widgets initially (to avoid breaking hidden tab content)
    if (!placement.visible) continue;

    const body = extractWidgetContent(entry);
    if (!body) continue;

    const wrapper = createWidgetWrapper(entry, placement);
    // Insert body before resize handle
    const resizeHandle = wrapper.querySelector('.layout-resize-handle');
    if (resizeHandle) {
      wrapper.insertBefore(body, resizeHandle);
    } else {
      wrapper.appendChild(body);
    }

    applyGridPosition(wrapper, placement);
    setupWidgetInteractions(wrapper, entry.id);
    gridContainer.appendChild(wrapper);
    widgetWrappers.set(entry.id, wrapper);
  }

  // Hide the original left/right columns (children have been moved out)
  if (editorLeft) editorLeft.style.display = 'none';
  if (editorRight) editorRight.style.display = 'none';

  // Keyboard: Escape to exit customize mode
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && isCustomizing) {
      exitCustomizeMode();
    }
  };
  document.addEventListener('keydown', onKeyDown);
  cleanupFns.push(() => document.removeEventListener('keydown', onKeyDown));

  // Window resize handler
  const onResize = () => {
    if (window.innerWidth <= 1024) {
      // Disable layout on mobile — would need full restoration
      // For now, just single-column via CSS media query
    }
  };
  window.addEventListener('resize', onResize);
  cleanupFns.push(() => window.removeEventListener('resize', onResize));

  isActive = true;

  // Initially, hide-buttons are hidden (only visible in customize mode)
  for (const wrapper of widgetWrappers.values()) {
    wrapper.querySelectorAll<HTMLElement>('.lw-hide-btn').forEach((btn) => {
      btn.style.display = 'none';
    });
  }
}

/**
 * Confirm before resetting — prevents accidental layout loss.
 */
async function confirmAndResetLayout(): Promise<void> {
  const ok = await showConfirmModal({
    title: 'Reset Layout?',
    message: 'This will discard your custom widget arrangement and restore the default layout. This cannot be undone.',
    confirmLabel: 'Reset',
    cancelLabel: 'Keep Current',
    danger: true,
  });
  if (ok) {
    resetLayout();
  }
}

/**
 * Reset layout to default and reapply all positions.
 */
export function resetLayout(): void {
  layoutConfig = createDefaultLayout();
  saveLayout();

  // Reapply all positions with animation
  for (const placement of layoutConfig.widgets) {
    const wrapper = widgetWrappers.get(placement.widgetId);
    if (wrapper) {
      applyGridPosition(wrapper, placement);
      wrapper.classList.toggle('lw-collapsed', placement.collapsed);
      // Brief entrance animation
      wrapper.classList.add('lw-entering');
      setTimeout(() => wrapper.classList.remove('lw-entering'), 300);
    }
  }

  updateToolbarPills();
}

// ═══════════════════════════════════════════════════════════════════
// Preset Layouts
// ═══════════════════════════════════════════════════════════════════

function createAnalyticsPreset(): WidgetPlacement[] {
  return [
    // Cards compact on left
    { widgetId: 'cards', col: 0, row: 0, colSpan: 4, rowSpan: 8, visible: true, collapsed: false },
    // Search compact on left below cards
    { widgetId: 'search', col: 0, row: 8, colSpan: 4, rowSpan: 4, visible: true, collapsed: false },
    // Analytics: all visible, large
    { widgetId: 'mana-curve', col: 4, row: 0, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'color-pie', col: 8, row: 0, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'type-dist', col: 4, row: 3, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'power-bracket', col: 8, row: 3, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'health-score', col: 4, row: 6, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'official-bracket', col: 8, row: 6, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'fingerprint', col: 4, row: 9, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'mana-calc', col: 8, row: 9, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'synergy-map', col: 0, row: 12, colSpan: 6, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'combos', col: 6, row: 12, colSpan: 6, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'draw-probability', col: 0, row: 15, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'deck-tips', col: 4, row: 15, colSpan: 4, rowSpan: 3, visible: true, collapsed: false },
    { widgetId: 'land-split', col: 8, row: 15, colSpan: 2, rowSpan: 2, visible: true, collapsed: false },
    { widgetId: 'tags', col: 10, row: 15, colSpan: 2, rowSpan: 2, visible: true, collapsed: false },
    { widgetId: 'summary-bar', col: 8, row: 17, colSpan: 4, rowSpan: 1, visible: true, collapsed: false },
    // Rest hidden
    { widgetId: 'price-summary', col: 0, row: 18, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'collection', col: 4, row: 18, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'budget', col: 8, row: 18, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'export', col: 0, row: 21, colSpan: 6, rowSpan: 4, visible: false, collapsed: false },
    { widgetId: 'version-history', col: 6, row: 21, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'matchups', col: 0, row: 25, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'smart-recs', col: 4, row: 25, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'rec-history', col: 8, row: 25, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'edhrec', col: 0, row: 28, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'import', col: 4, row: 28, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
  ];
}

function createCompactPreset(): WidgetPlacement[] {
  return [
    // Everything dense, 3-4 col each, 2-3 rows high
    { widgetId: 'cards', col: 0, row: 0, colSpan: 6, rowSpan: 6, visible: true, collapsed: false },
    { widgetId: 'search', col: 6, row: 0, colSpan: 6, rowSpan: 4, visible: true, collapsed: false },
    { widgetId: 'mana-curve', col: 6, row: 4, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
    { widgetId: 'color-pie', col: 9, row: 4, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
    { widgetId: 'type-dist', col: 0, row: 6, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
    { widgetId: 'power-bracket', col: 3, row: 6, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
    { widgetId: 'health-score', col: 6, row: 6, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
    { widgetId: 'deck-tips', col: 9, row: 6, colSpan: 3, rowSpan: 2, visible: true, collapsed: false },
    { widgetId: 'land-split', col: 0, row: 8, colSpan: 2, rowSpan: 1, visible: true, collapsed: false },
    { widgetId: 'tags', col: 2, row: 8, colSpan: 2, rowSpan: 1, visible: true, collapsed: false },
    { widgetId: 'summary-bar', col: 4, row: 8, colSpan: 4, rowSpan: 1, visible: true, collapsed: false },
    { widgetId: 'price-summary', col: 8, row: 8, colSpan: 4, rowSpan: 2, visible: true, collapsed: false },
    // Hidden
    { widgetId: 'official-bracket', col: 0, row: 9, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'fingerprint', col: 3, row: 9, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'mana-calc', col: 6, row: 9, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'synergy-map', col: 0, row: 11, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'combos', col: 4, row: 11, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'draw-probability', col: 8, row: 11, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'collection', col: 0, row: 13, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'budget', col: 4, row: 13, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'export', col: 0, row: 16, colSpan: 6, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'version-history', col: 6, row: 16, colSpan: 3, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'matchups', col: 0, row: 19, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'smart-recs', col: 4, row: 19, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'rec-history', col: 8, row: 19, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
    { widgetId: 'edhrec', col: 0, row: 22, colSpan: 4, rowSpan: 3, visible: false, collapsed: false },
    { widgetId: 'import', col: 4, row: 22, colSpan: 4, rowSpan: 2, visible: false, collapsed: false },
  ];
}

/**
 * Destroy the panel layout system and clean up.
 */
export function destroyPanelLayout(): void {
  for (const fn of cleanupFns) fn();
  cleanupFns.length = 0;

  // TODO: Restore DOM elements to their original positions if needed
  widgetWrappers.clear();
  originalParents.clear();
  isActive = false;
  isCustomizing = false;
  layoutConfig = null;
  gridContainer = null;
  toolbarEl = null;
  dragState = null;
  resizeState = null;
}

/**
 * Check if the panel layout system is currently active.
 */
export function isPanelLayoutActive(): boolean {
  return isActive;
}

/**
 * Refresh all widget contents - extract data from DOM and update widgets.
 * Called when switching to grid mode or after customize changes.
 */
export function refreshAllWidgets(): void {
  if (!isActive || !layoutConfig) return;

  for (const entry of WIDGET_REGISTRY) {
    const placement = getPlacement(entry.id);
    if (!placement || !placement.visible) continue;

    const wrapper = widgetWrappers.get(entry.id);
    if (!wrapper) continue;

    // Extract fresh content from original DOM
    const freshContent = extractWidgetContent(entry);
    if (!freshContent) continue;

    // Replace old body content with fresh content
    const oldBody = wrapper.querySelector('.layout-widget-body');
    if (oldBody) {
      // Clear old content
      oldBody.innerHTML = '';
      // Move fresh content into widget body
      while (freshContent.firstChild) {
        oldBody.appendChild(freshContent.firstChild);
      }
    }
  }
}

/**
 * Auto-scale cards to fit all cards in widget without scrolling.
 * Dynamically adjusts card size based on available space.
 * Works in both grid image view and category view.
 */
// Cache last card count to prevent flickering on every render
let lastCardCount = 0;
let lastOptimalWidth = 110; // Default card width

export function autoFitCardsWidget(): void {
  if (!isActive || !layoutConfig) return;

  const cardsPlacement = layoutConfig.widgets.find(w => w.widgetId === 'cards');
  if (!cardsPlacement || !cardsPlacement.visible) return;

  const wrapper = widgetWrappers.get('cards');
  if (!wrapper) return;

  const widgetBody = wrapper.querySelector('.layout-widget-body') as HTMLElement;
  if (!widgetBody) return;

  // CRITICAL: Cards content is in #boardRows, NOT in widget body (cards widget is special)
  const boardRows = document.getElementById('boardRows');
  if (!boardRows) return;

  // Detect view mode by checking which container exists in #boardRows
  const singleGrid = boardRows.querySelector('.card-grid-img') as HTMLElement;
  const categoryGrids = boardRows.querySelectorAll('.cat-grid') as NodeListOf<HTMLElement>;
  const pileView = boardRows.querySelector('.pile-view') as HTMLElement;

  // Get available space
  const availableHeight = widgetBody.clientHeight - 40; // minus padding
  const availableWidth = widgetBody.clientWidth - 40;

  const aspectRatio = 1.4; // MTG card aspect ratio (height/width)
  const gap = 6;
  const baseCardWidth = 110; // Default card width
  const minCardWidth = 60; // Minimum readable size
  const maxCardWidth = 180; // Maximum card size

  // Handle Grid Image View (.card-grid-img)
  if (singleGrid) {
    const totalCards = singleGrid.querySelectorAll('.gcard').length;
    if (totalCards === 0) return;

    // CRITICAL: Only recalculate if card count changed (prevent flickering)
    if (totalCards === lastCardCount && lastOptimalWidth > 0) {
      // Just reapply cached width without recalculation
      singleGrid.style.setProperty('--card-width', `${lastOptimalWidth}px`);
      singleGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${lastOptimalWidth}px, 1fr))`;
      return;
    }

    let optimalCardWidth = baseCardWidth;

    for (let cardWidth = maxCardWidth; cardWidth >= minCardWidth; cardWidth -= 5) {
      const cardsPerRow = Math.floor((availableWidth + gap) / (cardWidth + gap));
      if (cardsPerRow === 0) continue;

      const totalRows = Math.ceil(totalCards / cardsPerRow);
      const cardHeight = cardWidth * aspectRatio;
      const totalHeight = (totalRows * (cardHeight + gap)) - gap;

      if (totalHeight <= availableHeight) {
        optimalCardWidth = cardWidth;
        break;
      }
    }

    // Cache for next render
    lastCardCount = totalCards;
    lastOptimalWidth = optimalCardWidth;

    singleGrid.style.setProperty('--card-width', `${optimalCardWidth}px`);
    singleGrid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${optimalCardWidth}px, 1fr))`;

    console.log(`[Auto-Fit] Grid Image View scaled to ${optimalCardWidth}px (${totalCards} cards, ${availableHeight}px available)`);
    return;
  }

  // Handle Category View (.cat-grid)
  if (categoryGrids.length > 0) {
    const cardGrids = Array.from(categoryGrids);
    let totalCards = 0;
    categoryGrids.forEach(grid => {
      totalCards += grid.querySelectorAll('.gcard').length;
    });

    if (totalCards === 0) return;

    // CRITICAL: Only recalculate if card count changed (prevent flickering)
    if (totalCards === lastCardCount && lastOptimalWidth > 0) {
      cardGrids.forEach(grid => {
        grid.style.setProperty('--card-width', `${lastOptimalWidth}px`);
        grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${lastOptimalWidth}px, 1fr))`;
      });
      return;
    }

    let optimalCardWidth = baseCardWidth;

    for (let cardWidth = maxCardWidth; cardWidth >= minCardWidth; cardWidth -= 5) {
      const cardsPerRow = Math.floor((availableWidth + gap) / (cardWidth + gap));
      if (cardsPerRow === 0) continue;

      const totalRows = Math.ceil(totalCards / cardsPerRow);
      const cardHeight = cardWidth * aspectRatio;
      const categoryHeaderHeight = categoryGrids.length * 40;
      const totalHeight = (totalRows * (cardHeight + gap)) - gap + categoryHeaderHeight;

      if (totalHeight <= availableHeight) {
        optimalCardWidth = cardWidth;
        break;
      }
    }

    // Cache for next render
    lastCardCount = totalCards;
    lastOptimalWidth = optimalCardWidth;

    cardGrids.forEach(grid => {
      grid.style.setProperty('--card-width', `${optimalCardWidth}px`);
      grid.style.gridTemplateColumns = `repeat(auto-fill, minmax(${optimalCardWidth}px, 1fr))`;
    });

    console.log(`[Auto-Fit] Category View scaled to ${optimalCardWidth}px (${totalCards} cards in ${cardGrids.length} categories, ${availableHeight}px available)`);
    return;
  }

  // Handle Pile View (.pile-view with .pile-card)
  if (pileView) {
    const pileCards = pileView.querySelectorAll('.pile-card') as NodeListOf<HTMLElement>;
    if (pileCards.length === 0) return;

    const pileColumns = pileView.querySelectorAll('.pile-column') as NodeListOf<HTMLElement>;
    const numColumns = pileColumns.length;

    if (numColumns === 0) return;

    const totalCards = pileCards.length;

    // CRITICAL: Only recalculate if card count changed (prevent flickering)
    if (totalCards === lastCardCount && lastOptimalWidth > 0) {
      const roundedWidth = Math.round(lastOptimalWidth / 10) * 10;
      const PILE_OVERLAP_MAP_CACHED: Record<number, string> = {
        60: '-50%', 70: '-48%', 80: '-45%', 90: '-42%', 100: '-40%',
        110: '-38%', 120: '-35%', 130: '-32%', 140: '-30%', 150: '-28%',
        160: '-25%', 170: '-22%', 180: '-20%',
      };
      const overlap = PILE_OVERLAP_MAP_CACHED[roundedWidth] || '-38%';

      pileCards.forEach((card) => {
        card.style.width = `${lastOptimalWidth}px`;
        const pileStack = card.closest('.pile-stack');
        if (pileStack) {
          const cardsInStack = pileStack.querySelectorAll('.pile-card');
          const indexInStack = Array.from(cardsInStack).indexOf(card);
          card.style.marginTop = indexInStack > 0 ? overlap : '';
        }
      });
      return;
    }

    // In pile view, cards are stacked with overlap
    // We need to scale cards AND adjust overlap to fit height
    let optimalCardWidth = baseCardWidth;

    // Pile overlap percentages (negative margin-top as % of card width)
    // REDUCED overlap so more of each card is visible
    const PILE_OVERLAP_MAP: Record<number, string> = {
      60: '-50%',    // Show ~50% of each card
      70: '-48%',
      80: '-45%',
      90: '-42%',
      100: '-40%',
      110: '-38%',   // Default - show ~62% of each card
      120: '-35%',
      130: '-32%',
      140: '-30%',
      150: '-28%',
      160: '-25%',
      170: '-22%',
      180: '-20%',   // Large - show ~80% of each card
    };

    for (let cardWidth = maxCardWidth; cardWidth >= minCardWidth; cardWidth -= 10) {
      const cardHeight = cardWidth * aspectRatio;

      // Calculate column width with gap
      const columnWidth = Math.floor((availableWidth + gap) / numColumns) - gap;

      // Check if card fits column width
      if (cardWidth > columnWidth) continue;

      // Find tallest pile to calculate total height
      let maxPileHeight = 0;
      pileColumns.forEach(column => {
        const cardsInPile = column.querySelectorAll('.pile-card').length;
        if (cardsInPile === 0) return;

        // First card full height, rest overlap
        const overlap = parseFloat(PILE_OVERLAP_MAP[cardWidth] || '-110%') / 100;
        const pileHeight = cardHeight + (cardsInPile - 1) * cardHeight * (1 + overlap);
        maxPileHeight = Math.max(maxPileHeight, pileHeight);
      });

      // Account for pile headers (40px each)
      const headerHeight = numColumns > 0 ? 50 : 0; // Approximate header height
      const totalHeight = maxPileHeight + headerHeight;

      if (totalHeight <= availableHeight) {
        optimalCardWidth = cardWidth;
        break;
      }
    }

    // Round to nearest 10 for overlap map
    const roundedWidth = Math.round(optimalCardWidth / 10) * 10;
    const overlap = PILE_OVERLAP_MAP[roundedWidth] || '-38%';

    // Cache for next render
    lastCardCount = totalCards;
    lastOptimalWidth = optimalCardWidth;

    // CRITICAL FIX: Set width on .pile-card container, not img (CSS has img { width: 100% })
    pileCards.forEach((card) => {
      // Set container width (img will fill 100% of this)
      card.style.width = `${optimalCardWidth}px`;

      // Apply overlap (skip first card in each pile)
      const pileStack = card.closest('.pile-stack');
      if (pileStack) {
        const cardsInStack = pileStack.querySelectorAll('.pile-card');
        const indexInStack = Array.from(cardsInStack).indexOf(card);
        if (indexInStack > 0) {
          card.style.marginTop = overlap;
        } else {
          card.style.marginTop = '';
        }
      }
    });

    console.log(`[Auto-Fit] Pile View scaled to ${roundedWidth}px with ${overlap} overlap (${pileCards.length} cards in ${numColumns} piles, ${availableHeight}px available)`);
    return;
  }

  // No recognized view mode found
  console.log('[Auto-Fit] No supported view mode detected');
}
