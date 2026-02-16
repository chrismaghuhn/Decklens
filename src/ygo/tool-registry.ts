// ==================== YGO Tool Registry ====================
// Single source of truth for all tool modules.
// Each tool has: id, label, description, section, defaultEnabled.
// Section determines which HTML container the tool belongs to.

/**
 * Tool definition interface
 */
export interface ToolDefinition {
  /** Unique identifier matching HTML element IDs */
  id: string;
  /** Display label in the drawer */
  label: string;
  /** Short description for the drawer */
  description: string;
  /** Section: 'analysis' or 'tools' - determines which panel contains it */
  section: 'analysis' | 'tools';
  /** Default enabled state on first load */
  defaultEnabled: boolean;
  /** Icon (emoji) for visual identification */
  icon: string;
}

/**
 * Complete tool registry for YGO.
 * Order determines display order in the drawer.
 */
export const YGO_TOOLS: readonly ToolDefinition[] = [
  // === Analysis Panel Tools ===
  {
    id: 'levelChart',
    label: 'Level/Rank Distribution',
    description: 'Visual chart of monster levels and ranks',
    section: 'analysis',
    defaultEnabled: true,
    icon: '📊',
  },
  {
    id: 'typeBars',
    label: 'Card Type Breakdown',
    description: 'Monster, Spell, Trap distribution',
    section: 'analysis',
    defaultEnabled: true,
    icon: '📈',
  },
  {
    id: 'handCalc',
    label: 'Opening Hand Calculator',
    description: 'Hypergeometric probability for specific cards',
    section: 'analysis',
    defaultEnabled: true,
    icon: '🎯',
  },
  {
    id: 'formatLegality',
    label: 'Format Legality',
    description: 'Check legality across TCG/OCG formats',
    section: 'analysis',
    defaultEnabled: true,
    icon: '✓',
  },
  {
    id: 'testHand',
    label: 'Test Hand Simulator',
    description: 'Draw and evaluate opening hands',
    section: 'analysis',
    defaultEnabled: true,
    icon: '🃏',
  },
  {
    id: 'extStats',
    label: 'Extended Statistics',
    description: 'Attributes, races, hand traps breakdown',
    section: 'analysis',
    defaultEnabled: true,
    icon: '📉',
  },
  {
    id: 'hyperCalc',
    label: 'Multi-Category Probability',
    description: 'Complex opening hand calculations',
    section: 'analysis',
    defaultEnabled: true,
    icon: '🧮',
  },
  {
    id: 'archetype',
    label: 'Archetype Detection',
    description: 'Identify archetypes in your deck',
    section: 'analysis',
    defaultEnabled: true,
    icon: '🏷️',
  },
  
  // === Tools Panel Tools ===
  {
    id: 'deckdna',
    label: 'Deck DNA Fingerprint',
    description: 'Playstyle profile analysis',
    section: 'tools',
    defaultEnabled: true,
    icon: '🧬',
  },
  {
    id: 'engines',
    label: 'Engine Detection',
    description: 'Detect engines and consistency',
    section: 'tools',
    defaultEnabled: true,
    icon: '⚙️',
  },
  {
    id: 'combos',
    label: 'Combo Consistency',
    description: 'Define and calculate combo probabilities',
    section: 'tools',
    defaultEnabled: true,
    icon: '🔗',
  },
  {
    id: 'handgrade',
    label: 'Hand Quality Grading',
    description: 'Simulate and grade opening hands A-F',
    section: 'tools',
    defaultEnabled: false,
    icon: '📝',
  },
  {
    id: 'collection',
    label: 'Collection Manager',
    description: 'Track owned cards and missing pieces',
    section: 'tools',
    defaultEnabled: false,
    icon: '📦',
  },
  {
    id: 'craft',
    label: 'Master Duel Craft Cost',
    description: 'UR/SR/R/N crafting requirements',
    section: 'tools',
    defaultEnabled: false,
    icon: '💎',
  },
  {
    id: 'crossformat',
    label: 'Cross-Format Legality',
    description: 'Card status across all formats',
    section: 'tools',
    defaultEnabled: false,
    icon: '🌐',
  },
  {
    id: 'tags',
    label: 'Tags & Folders',
    description: 'Organize decks with tags and folders',
    section: 'tools',
    defaultEnabled: false,
    icon: '🏷️',
  },
  {
    id: 'versions',
    label: 'Deck Versions',
    description: 'Save and restore deck snapshots',
    section: 'tools',
    defaultEnabled: true,
    icon: '📚',
  },
  {
    id: 'salt',
    label: 'Salt Score',
    description: 'How frustrating is your deck?',
    section: 'tools',
    defaultEnabled: false,
    icon: '🧂',
  },
] as const;

/**
 * Get default enabled state map
 */
export function getDefaultEnabledTools(): Record<string, boolean> {
  const defaults: Record<string, boolean> = {};
  for (const tool of YGO_TOOLS) {
    defaults[tool.id] = tool.defaultEnabled;
  }
  return defaults;
}
