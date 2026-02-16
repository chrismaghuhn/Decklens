// ==================== MTG Tools Drawer ====================
// Right-side drawer with tool toggles for visibility control.
// Persists state to localStorage.

import { h, replaceChildren } from '../shared/dom.js';
import { STORAGE_KEYS, storageGet, storageSet } from '../shared/storage.js';
import { MTG_TOOLS, getDefaultEnabledTools, type MTGToolDefinition } from './tool-registry.js';

const DEBUG_LOG_ENABLED = (globalThis as { DECKLENS_DEBUG?: boolean }).DECKLENS_DEBUG === true;
const debugLog = (...args: unknown[]): void => {
  if (DEBUG_LOG_ENABLED) {
    console.log(...args);
  }
};

// ==================== State ====================
let drawerOpen = false;
let enabledTools: Record<string, boolean> = {};
let onToolsChange: (() => void) | null = null;

// ==================== DOM References ====================
const $ = (id: string) => document.getElementById(id);

// ==================== Persistence ====================

/**
 * Load enabled tools state from localStorage.
 */
export function loadEnabledTools(): Record<string, boolean> {
  const defaults = getDefaultEnabledTools();
  const saved = storageGet<Record<string, boolean>>(STORAGE_KEYS.MTG_TOOLS_ENABLED, {});
  const normalized: Record<string, boolean> = {};
  for (const tool of MTG_TOOLS) {
    const raw = saved[tool.id];
    normalized[tool.id] = typeof raw === 'boolean' ? raw : (defaults[tool.id] ?? tool.defaultEnabled);
  }
  enabledTools = normalized;
  return enabledTools;
}

function getEnabledToolsCount(): number {
  return MTG_TOOLS.filter((tool) => enabledTools[tool.id] ?? tool.defaultEnabled).length;
}

/**
 * Save enabled tools state to localStorage.
 */
function saveEnabledTools(): void {
  storageSet(STORAGE_KEYS.MTG_TOOLS_ENABLED, enabledTools);
}


/**
 * Toggle a specific tool's enabled state.
 */
export function toggleTool(toolId: string, enabled?: boolean): void {
  if (enabled === undefined) {
    enabledTools[toolId] = !enabledTools[toolId];
  } else {
    enabledTools[toolId] = enabled;
  }
  saveEnabledTools();
  applyToolVisibility();
  renderDrawerContent();
  onToolsChange?.();
}

/**
 * Enable all tools.
 */
export function enableAllTools(): void {
  for (const tool of MTG_TOOLS) {
    enabledTools[tool.id] = true;
  }
  saveEnabledTools();
  applyToolVisibility();
  renderDrawerContent();
  onToolsChange?.();
}

/**
 * Disable all tools.
 */
export function disableAllTools(): void {
  for (const tool of MTG_TOOLS) {
    enabledTools[tool.id] = false;
  }
  saveEnabledTools();
  applyToolVisibility();
  renderDrawerContent();
  onToolsChange?.();
}

/**
 * Reset to default tool states.
 */
export function resetToolsToDefault(): void {
  enabledTools = getDefaultEnabledTools();
  saveEnabledTools();
  applyToolVisibility();
  renderDrawerContent();
  onToolsChange?.();
}

// ==================== Visibility ====================

/**
 * Apply tool visibility to the DOM based on enabledTools state.
 */
export function applyToolVisibility(): void {
  // Map tool IDs to tab IDs (some are different)
  const toolToTabMap: Record<string, string> = {
    collection: 'collection',
    goldfish: 'goldfish',
    compare: 'compare',
    buy: 'buy',
    wishlist: 'wishlist',
    hyper: 'hyper',
    tokens: 'tokens',
    combos: 'combos',
    matchup: 'matchup',
    versions: 'versions',
    dna: 'dna',
    power: 'power',
    salt: 'salt',
    synergy: 'synergy',
    budget: 'budget',
    recs: 'recs',
  };
  
  for (const tool of MTG_TOOLS) {
    const isEnabled = enabledTools[tool.id] ?? tool.defaultEnabled;
    
    // Find header button by ID pattern
    const btnId = `btn${tool.id.charAt(0).toUpperCase() + tool.id.slice(1)}`;
    const headerBtn = $(btnId);
    if (headerBtn) {
      headerBtn.style.display = isEnabled ? '' : 'none';
    }
    
    // Find more menu button by mapped panel ID
    const menuBtn = document.querySelector(`[data-panel="${tool.panelId}"]`) as HTMLElement | null;
    if (menuBtn) {
      menuBtn.style.display = isEnabled ? '' : 'none';
    }
    
    // Find tab in Tools Panel by data-tool-tab
    const tabId = toolToTabMap[tool.id];
    if (tabId) {
      const tab = document.querySelector(`[data-tool-tab="${tabId}"]`) as HTMLElement | null;
      if (tab) {
        tab.style.display = isEnabled ? '' : 'none';
      }
      
      // Also hide the content if tool is disabled and was active
      const content = $(`tool-${tabId}`);
      if (content && !isEnabled && content.classList.contains('active')) {
        content.classList.remove('active');
        // Activate first enabled tab
        const firstEnabledTab = document.querySelector('.tools-tab:not([style*="display: none"])') as HTMLElement | null;
        if (firstEnabledTab) {
          firstEnabledTab.click();
        }
      }
    }
  }

  // Update the tools count badge
  updateToolsCount();
}

/**
 * Update the tools count badge in the header.
 */
function updateToolsCount(): void {
  const countEl = $('toolsActiveCount');
  if (countEl) {
    const enabledCount = getEnabledToolsCount();
    countEl.textContent = String(enabledCount);
  }
}

// ==================== Drawer UI ====================

/**
 * Open the tools drawer.
 */
export function openDrawer(): void {
  debugLog('[MTG Tools] openDrawer called');
  drawerOpen = true;
  const drawer = $('toolsDrawer');
  const overlay = $('toolsDrawerOverlay');
  
  debugLog('[MTG Tools] drawer found:', !!drawer, 'overlay found:', !!overlay);
  
  if (drawer) {
    drawer.classList.add('active');
    drawer.setAttribute('aria-hidden', 'false');
  }
  if (overlay) {
    overlay.classList.add('active');
  }
  
  setTimeout(() => {
    const firstCheckbox = drawer?.querySelector('input[type="checkbox"]') as HTMLElement;
    firstCheckbox?.focus();
  }, 100);
}

/**
 * Close the tools drawer.
 */
export function closeDrawer(): void {
  drawerOpen = false;
  const drawer = $('toolsDrawer');
  const overlay = $('toolsDrawerOverlay');
  
  if (drawer) {
    drawer.classList.remove('active');
    drawer.setAttribute('aria-hidden', 'true');
  }
  if (overlay) {
    overlay.classList.remove('active');
  }
}


/**
 * Check if drawer is open.
 */
export function isDrawerOpen(): boolean {
  return drawerOpen;
}

// ==================== Render ====================

/**
 * Create a tool row element for the drawer.
 */
function createToolRow(tool: MTGToolDefinition): HTMLElement {
  const enabled = enabledTools[tool.id] ?? tool.defaultEnabled;
  const checkboxId = `drawer-tool-${tool.id}`;
  
  return h('label', { 
    className: `drawer-tool-row ${enabled ? 'enabled' : ''}`,
    htmlFor: checkboxId,
  },
    h('input', {
      type: 'checkbox',
      id: checkboxId,
      className: 'drawer-checkbox',
      checked: enabled,
      'data-tool-id': tool.id,
      onChange: (e: Event) => {
        const target = e.target as HTMLInputElement;
        toggleTool(tool.id, target.checked);
      },
    }),
    h('span', { className: 'drawer-tool-icon' }, tool.icon),
    h('div', { className: 'drawer-tool-info' },
      h('span', { className: 'drawer-tool-label' }, tool.label),
      h('span', { className: 'drawer-tool-desc' }, tool.description),
    ),
  );
}

/**
 * Create a section header.
 */
function createSectionHeader(title: string): HTMLElement {
  return h('div', { className: 'drawer-section-header' }, title);
}

/**
 * Render the drawer content.
 */
export function renderDrawerContent(): void {
  const container = $('toolsDrawerContent');
  if (!container) return;

  const primaryTools = MTG_TOOLS.filter(t => t.category === 'primary');
  const secondaryTools = MTG_TOOLS.filter(t => t.category === 'secondary');

  const enabledCount = getEnabledToolsCount();
  const totalCount = MTG_TOOLS.length;

  replaceChildren(container,
    // Stats bar
    h('div', { className: 'drawer-stats' },
      h('span', {}, `${enabledCount}/${totalCount} tools active`),
    ),
    
    // Quick actions
    h('div', { className: 'drawer-actions' },
      h('button', {
        className: 'drawer-action-btn',
        onClick: enableAllTools,
      }, 'Enable All'),
      h('button', {
        className: 'drawer-action-btn',
        onClick: disableAllTools,
      }, 'Disable All'),
      h('button', {
        className: 'drawer-action-btn outline',
        onClick: resetToolsToDefault,
      }, 'Reset'),
    ),
    
    // Primary section
    createSectionHeader('🎯 Primary Tools'),
    ...primaryTools.map(createToolRow),
    
    // Secondary section
    createSectionHeader('🔧 Advanced Tools'),
    ...secondaryTools.map(createToolRow),
  );
}

/**
 * Render the complete drawer structure.
 */
export function renderDrawer(): void {
  debugLog('[MTG Tools] renderDrawer called');
  if ($('toolsDrawer')) {
    debugLog('[MTG Tools] Drawer already exists');
    return;
  }

  const overlay = h('div', {
    id: 'toolsDrawerOverlay',
    className: 'drawer-overlay',
    onClick: closeDrawer,
  });

  const drawer = h('aside', {
    id: 'toolsDrawer',
    className: 'tools-drawer',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Tools Configuration',
    'aria-hidden': 'true',
  },
    h('div', { className: 'drawer-header' },
      h('h2', { className: 'drawer-title' }, '⚙️ Tools'),
      h('button', {
        className: 'drawer-close-btn',
        onClick: closeDrawer,
        'aria-label': 'Close drawer',
      }, '✕'),
    ),
    h('div', { id: 'toolsDrawerContent', className: 'drawer-content' }),
  );

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
  debugLog('[MTG Tools] Drawer elements appended to body');
  
  renderDrawerContent();
}

// ==================== Initialization ====================

/**
 * Initialize the tools drawer system.
 */
export function initToolsDrawer(onChange?: () => void): void {
  debugLog('[MTG Tools] initToolsDrawer called');
  onToolsChange = onChange ?? null;
  loadEnabledTools();
  renderDrawer();
  applyToolVisibility();
  debugLog('[MTG Tools] Drawer initialized, drawerOpen:', drawerOpen);
  
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) {
      closeDrawer();
    }
  });
}

export { enabledTools, drawerOpen };
