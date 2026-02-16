// ==================== YGO Tools Drawer ====================
// Right-side drawer with tool toggles for visibility control.
// Persists state to localStorage via STORAGE_KEYS.

import { h, replaceChildren, fragment } from '../shared/dom.js';
import { STORAGE_KEYS, storageGet, storageSet } from '../shared/storage.js';
import { YGO_TOOLS, getDefaultEnabledTools, type ToolDefinition } from './tool-registry.js';

// ==================== State ====================
let drawerOpen = false;
let enabledTools: Record<string, boolean> = {};
let onToolsChange: (() => void) | null = null;

// ==================== DOM References ====================
const $ = (id: string) => document.getElementById(id);

// ==================== Persistence ====================

/**
 * Load enabled tools state from localStorage.
 * Merges with defaults for any new tools not in storage.
 */
export function loadEnabledTools(): Record<string, boolean> {
  const defaults = getDefaultEnabledTools();
  const saved = storageGet<Record<string, boolean>>(STORAGE_KEYS.YGO_TOOLS_ENABLED, {});
  const normalized: Record<string, boolean> = {};
  for (const tool of YGO_TOOLS) {
    const raw = saved[tool.id];
    normalized[tool.id] = typeof raw === 'boolean' ? raw : (defaults[tool.id] ?? tool.defaultEnabled);
  }
  enabledTools = normalized;
  return enabledTools;
}

function getEnabledToolsCount(): number {
  return YGO_TOOLS.filter((tool) => enabledTools[tool.id] ?? tool.defaultEnabled).length;
}

/**
 * Save enabled tools state to localStorage.
 */
function saveEnabledTools(): void {
  storageSet(STORAGE_KEYS.YGO_TOOLS_ENABLED, enabledTools);
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
  for (const tool of YGO_TOOLS) {
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
  for (const tool of YGO_TOOLS) {
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
 * Uses data-tool-id attributes on analysis cards and tool-* IDs for tools panel.
 */
export function applyToolVisibility(): void {
  // Analysis panel tools - use data-tool-id attribute
  document.querySelectorAll('.analysis-card[data-tool-id]').forEach((card) => {
    const el = card as HTMLElement;
    const toolId = el.dataset.toolId;
    if (toolId) {
      el.style.display = enabledTools[toolId] ? '' : 'none';
    }
  });

  // Tools panel - tabs and content divs
  const toolsPanelIds = [
    'deckdna', 'engines', 'combos', 'handgrade', 'collection',
    'craft', 'crossformat', 'tags', 'versions', 'salt'
  ];

  for (const toolId of toolsPanelIds) {
    const content = $(`tool-${toolId}`);
    const tab = document.querySelector(`[data-tool-tab="${toolId}"]`) as HTMLElement | null;
    const isEnabled = enabledTools[toolId] ?? true;
    
    if (content) {
      content.style.display = isEnabled ? '' : 'none';
      // If this tool was active and is now hidden, deactivate it
      if (!isEnabled && content.classList.contains('active')) {
        content.classList.remove('active');
      }
    }
    if (tab) {
      tab.style.display = isEnabled ? '' : 'none';
      // If this tab was active and is now hidden, deactivate it
      if (!isEnabled && tab.classList.contains('active')) {
        tab.classList.remove('active');
      }
    }
  }

  // Ensure at least one visible tab is active in tools panel
  const visibleTabs = Array.from(document.querySelectorAll('.tools-tab'))
    .filter(tab => (tab as HTMLElement).style.display !== 'none');
  const hasActiveVisible = visibleTabs.some(tab => tab.classList.contains('active'));
  
  if (visibleTabs.length > 0 && !hasActiveVisible) {
    const firstVisible = visibleTabs[0] as HTMLElement;
    const tabName = firstVisible.dataset.toolTab;
    if (tabName) {
      firstVisible.classList.add('active');
      const content = $(`tool-${tabName}`);
      if (content) content.classList.add('active');
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
  console.log('[ToolsDrawer] openDrawer called');
  drawerOpen = true;
  const drawer = $('toolsDrawer');
  const overlay = $('toolsDrawerOverlay');
  
  console.log('[ToolsDrawer] drawer element:', drawer);
  console.log('[ToolsDrawer] overlay element:', overlay);
  
  if (drawer) {
    drawer.classList.add('active');
    drawer.setAttribute('aria-hidden', 'false');
    // Fallback inline style in case CSS class doesn't work
    drawer.style.transform = 'translateX(0)';
    console.log('[ToolsDrawer] Drawer classList after add:', drawer.classList.toString());
    console.log('[ToolsDrawer] Drawer has active class:', drawer.classList.contains('active'));
  } else {
    console.error('[ToolsDrawer] ERROR: toolsDrawer element not found!');
  }
  if (overlay) {
    overlay.classList.add('active');
    // Fallback inline style
    overlay.style.opacity = '1';
    overlay.style.visibility = 'visible';
    console.log('[ToolsDrawer] Overlay classList after add:', overlay.classList.toString());
  }
  
  // Focus first interactive element
  setTimeout(() => {
    const firstCheckbox = drawer?.querySelector('input[type="checkbox"]') as HTMLElement;
    firstCheckbox?.focus();
  }, 100);
}

/**
 * Close the tools drawer.
 */
export function closeDrawer(): void {
  console.log('[ToolsDrawer] closeDrawer called');
  drawerOpen = false;
  const drawer = $('toolsDrawer');
  const overlay = $('toolsDrawerOverlay');
  
  if (drawer) {
    drawer.classList.remove('active');
    drawer.setAttribute('aria-hidden', 'true');
    // Reset inline style
    drawer.style.transform = '';
  }
  if (overlay) {
    overlay.classList.remove('active');
    // Reset inline style
    overlay.style.opacity = '';
    overlay.style.visibility = '';
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
function createToolRow(tool: ToolDefinition): HTMLElement {
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

  const analysisTools = YGO_TOOLS.filter(t => t.section === 'analysis');
  const toolsTools = YGO_TOOLS.filter(t => t.section === 'tools');

  const enabledCount = getEnabledToolsCount();
  const totalCount = YGO_TOOLS.length;

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
    
    // Analysis section
    createSectionHeader('📊 Analysis'),
    ...analysisTools.map(createToolRow),
    
    // Tools section
    createSectionHeader('🔧 Tools'),
    ...toolsTools.map(createToolRow),
  );
}

/**
 * Render the complete drawer structure.
 * Should be called once during initialization.
 */
export function renderDrawer(): void {
  console.log('[ToolsDrawer] renderDrawer called');
  
  // Check if drawer already exists
  if ($('toolsDrawer')) {
    console.log('[ToolsDrawer] Drawer already exists, skipping');
    return;
  }

  console.log('[ToolsDrawer] Creating drawer elements...');

  // Create overlay - only close if clicking directly on overlay, not bubbled events
  const overlay = h('div', {
    id: 'toolsDrawerOverlay',
    className: 'drawer-overlay',
    onClick: (e: Event) => {
      // Only close if clicking directly on overlay, not on drawer content
      if (e.target === e.currentTarget) {
        console.log('[ToolsDrawer] Overlay clicked directly - closing');
        closeDrawer();
      }
    },
  });

  // Create drawer
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

  // Append to body
  document.body.appendChild(overlay);
  document.body.appendChild(drawer);
  
  console.log('[ToolsDrawer] Elements appended to body');
  console.log('[ToolsDrawer] Overlay:', overlay);
  console.log('[ToolsDrawer] Drawer:', drawer);
  
  // Render content
  renderDrawerContent();
  console.log('[ToolsDrawer] Content rendered');
}

// ==================== Initialization ====================

/**
 * Initialize the tools drawer system.
 * @param onChange Callback when tools are toggled
 */
export function initToolsDrawer(onChange?: () => void): void {
  console.log('[ToolsDrawer] Initializing...');
  onToolsChange = onChange ?? null;
  
  // Load saved state
  loadEnabledTools();
  console.log('[ToolsDrawer] Enabled tools loaded:', Object.keys(enabledTools).length);
  
  // Render drawer structure
  renderDrawer();
  console.log('[ToolsDrawer] Drawer rendered');
  
  // Verify drawer was created
  const drawer = $('toolsDrawer');
  const overlay = $('toolsDrawerOverlay');
  console.log('[ToolsDrawer] After render - drawer:', drawer, 'overlay:', overlay);
  
  // Apply initial visibility
  applyToolVisibility();
  
  // Keyboard handler for ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && drawerOpen) {
      closeDrawer();
    }
  });
  
  console.log('[ToolsDrawer] Init complete');
}

// Export for window binding if needed
export {
  enabledTools,
  drawerOpen,
};
