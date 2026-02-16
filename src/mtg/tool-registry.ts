// ==================== MTG Tool Registry ====================
// Single source of truth for all MTG tool modules.
// Each tool has: id, label, description, panelId, defaultEnabled.

/**
 * Tool definition interface
 */
export interface MTGToolDefinition {
  /** Unique identifier */
  id: string;
  /** Display label in the drawer */
  label: string;
  /** Short description for the drawer */
  description: string;
  /** Panel ID in HTML (matches data-panel attribute) */
  panelId: string;
  /** Default enabled state on first load */
  defaultEnabled: boolean;
  /** Icon (emoji) for visual identification */
  icon: string;
  /** Category: 'primary' (header buttons) or 'secondary' (more menu) */
  category: 'primary' | 'secondary';
}

/**
 * Complete tool registry for MTG.
 * Order determines display order in the drawer.
 */
export const MTG_TOOLS: readonly MTGToolDefinition[] = [
  // === Primary Tools (Header Buttons) ===
  {
    id: 'collection',
    label: 'Collection Manager',
    description: 'Track cards you own and check buildability',
    panelId: 'collectionPanel',
    defaultEnabled: true,
    icon: '📦',
    category: 'primary',
  },
  {
    id: 'buy',
    label: 'Buy Cards',
    description: 'Find best prices across vendors',
    panelId: 'buyPanel',
    defaultEnabled: true,
    icon: '🛒',
    category: 'primary',
  },
  {
    id: 'recs',
    label: 'Card Suggestions',
    description: 'AI-powered card recommendations',
    panelId: 'recsPanel',
    defaultEnabled: true,
    icon: '💡',
    category: 'primary',
  },
  {
    id: 'wishlist',
    label: 'Wishlist',
    description: 'Track cards you want to acquire',
    panelId: 'wishlistPanel',
    defaultEnabled: true,
    icon: '⭐',
    category: 'primary',
  },
  {
    id: 'hand',
    label: 'Hand Simulator',
    description: 'Draw and evaluate opening hands',
    panelId: 'testHandPanel',
    defaultEnabled: true,
    icon: '✋',
    category: 'primary',
  },
  {
    id: 'analysis',
    label: 'Analysis',
    description: 'Mana curve, type breakdown, statistics',
    panelId: 'analysisPanel',
    defaultEnabled: true,
    icon: '📊',
    category: 'primary',
  },
  {
    id: 'goldfish',
    label: 'Goldfish Playtester',
    description: 'Test deck solo gameplay',
    panelId: 'goldfishPanel',
    defaultEnabled: true,
    icon: '🐟',
    category: 'primary',
  },
  {
    id: 'budget',
    label: 'Budget Alternatives',
    description: 'Find cheaper card replacements',
    panelId: 'budgetPanel',
    defaultEnabled: true,
    icon: '💰',
    category: 'primary',
  },
  {
    id: 'compare',
    label: 'Deck Comparison',
    description: 'Compare two deck lists side-by-side',
    panelId: 'comparePanel',
    defaultEnabled: true,
    icon: '⇄',
    category: 'primary',
  },
  {
    id: 'export',
    label: 'Export',
    description: 'Export deck in various formats',
    panelId: 'exportPanel',
    defaultEnabled: true,
    icon: '💾',
    category: 'primary',
  },
  
  // === Secondary Tools (More Menu) ===
  {
    id: 'hyper',
    label: 'Probability Calculator',
    description: 'Hypergeometric probability calculations',
    panelId: 'hyperPanel',
    defaultEnabled: true,
    icon: '🎯',
    category: 'secondary',
  },
  {
    id: 'tokens',
    label: 'Token Detection',
    description: 'Find tokens your deck creates',
    panelId: 'tokensPanel',
    defaultEnabled: true,
    icon: '🎭',
    category: 'secondary',
  },
  {
    id: 'power',
    label: 'Power Level',
    description: 'Estimate deck power level',
    panelId: 'powerPanel',
    defaultEnabled: false,
    icon: '⚡',
    category: 'secondary',
  },
  {
    id: 'salt',
    label: 'Salt Score',
    description: 'How frustrating is your deck?',
    panelId: 'saltPanel',
    defaultEnabled: false,
    icon: '🧂',
    category: 'secondary',
  },
  {
    id: 'combos',
    label: 'Combo Detection',
    description: 'Find infinite combos in your deck',
    panelId: 'combosPanel',
    defaultEnabled: true,
    icon: '♾️',
    category: 'secondary',
  },
  {
    id: 'matchup',
    label: 'Matchup Guide',
    description: 'Sideboard and gameplan plans',
    panelId: 'matchupPanel',
    defaultEnabled: true,
    icon: '🧭',
    category: 'secondary',
  },
  {
    id: 'dna',
    label: 'Deck DNA',
    description: 'Deck archetype fingerprint',
    panelId: 'dnaPanel',
    defaultEnabled: true,
    icon: '🧬',
    category: 'secondary',
  },
  {
    id: 'synergy',
    label: 'Card Synergies',
    description: 'Discover card interactions',
    panelId: 'synergyPanel',
    defaultEnabled: true,
    icon: '🔗',
    category: 'secondary',
  },
  {
    id: 'versions',
    label: 'Version History',
    description: 'Save and restore deck versions',
    panelId: 'versionsPanel',
    defaultEnabled: true,
    icon: '📚',
    category: 'secondary',
  },
] as const;

/**
 * Get default enabled state map
 */
export function getDefaultEnabledTools(): Record<string, boolean> {
  const defaults: Record<string, boolean> = {};
  for (const tool of MTG_TOOLS) {
    defaults[tool.id] = tool.defaultEnabled;
  }
  return defaults;
}
