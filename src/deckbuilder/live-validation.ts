// ============================================================
// Live Validation — Real-time format checking + Explain Mode
// ============================================================
// Client-side validation: singleton violations, color identity,
// deck size, banned cards. Explain Mode shows card role analysis.
// Links to ChecksService for server-side validation on PRs.
// ============================================================

import type { DeckbuilderBoards, DeckbuilderCardEntry, DeckBoard, DeckFormat } from './types.js';

// ==================== Types ====================

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
  cardName?: string;
  board?: DeckBoard;
  fix?: string;              // Suggested fix
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  deckSize: number;
  targetSize: number;
}

export interface ExplainResult {
  cardName: string;
  roles: string[];           // ["ramp", "removal"]
  synergies: string[];       // ["Combos with X", "Enables Y"]
  comboLines: string[];      // ["Dramatic Scepter"]
  replacements: string[];    // Budget/upgrade suggestions
  reasoning: string;         // "This card is here because..."
}

// ==================== Color Identity ====================

const COLOR_IDENTITY_MAP: Record<string, Set<string>> = {};

/**
 * Set color identity for validation (from commander data).
 */
export function setColorIdentity(commanders: string[], identity: string[]): void {
  // identity = ['W', 'U', 'B', 'R', 'G'] subset
  COLOR_IDENTITY_MAP['_deck'] = new Set(identity.map(c => c.toUpperCase()));
}

// ==================== Format Rules ====================

interface FormatRules {
  minDeckSize: number;
  maxDeckSize: number;
  singleton: boolean;
  commanderRequired: boolean;
  sideboardMax: number;
  maxCopies: number;         // 4 for standard, 1 for singleton
}

export function getFormatRules(format: DeckFormat): FormatRules {
  switch (format) {
    case 'commander':
      return { minDeckSize: 100, maxDeckSize: 100, singleton: true, commanderRequired: true, sideboardMax: 0, maxCopies: 1 };
    case 'standard':
    case 'modern':
    case 'pioneer':
    case 'legacy':
      return { minDeckSize: 60, maxDeckSize: Infinity, singleton: false, commanderRequired: false, sideboardMax: 15, maxCopies: 4 };
    case 'pauper':
      return { minDeckSize: 60, maxDeckSize: Infinity, singleton: false, commanderRequired: false, sideboardMax: 15, maxCopies: 4 };
    default:
      return { minDeckSize: 0, maxDeckSize: Infinity, singleton: false, commanderRequired: false, sideboardMax: Infinity, maxCopies: Infinity };
  }
}

// Basic lands that are exempt from singleton rule
const BASIC_LANDS = new Set([
  'Plains', 'Island', 'Swamp', 'Mountain', 'Forest',
  'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
  'Snow-Covered Mountain', 'Snow-Covered Forest', 'Wastes',
]);

// Cards exempt from singleton rule
const SINGLETON_EXEMPT = new Set([
  ...BASIC_LANDS,
  'Relentless Rats', 'Rat Colony', 'Shadowborn Apostle',
  'Persistent Petitioners', 'Dragon\'s Approach', 'Slime Against Humanity',
  'Seven Dwarves',
]);

// ==================== Validation ====================

/**
 * Validate a deck against format rules.
 */
export function validateDeck(
  boards: DeckbuilderBoards,
  format: DeckFormat
): ValidationResult {
  const rules = getFormatRules(format);
  const issues: ValidationIssue[] = [];

  // Count total cards (commander + mainboard)
  const mainboardCount = boards.mainboard.reduce((sum, c) => sum + c.qty, 0);
  const commanderCount = boards.commander.reduce((sum, c) => sum + c.qty, 0);
  const sideboardCount = boards.sideboard.reduce((sum, c) => sum + c.qty, 0);
  const totalDeck = mainboardCount + commanderCount;

  // Deck size check
  if (totalDeck < rules.minDeckSize) {
    issues.push({
      severity: 'error',
      code: 'DECK_TOO_SMALL',
      message: `Deck has ${totalDeck} cards (minimum ${rules.minDeckSize})`,
      fix: `Add ${rules.minDeckSize - totalDeck} more cards`,
    });
  }
  if (totalDeck > rules.maxDeckSize && rules.maxDeckSize < Infinity) {
    issues.push({
      severity: 'error',
      code: 'DECK_TOO_LARGE',
      message: `Deck has ${totalDeck} cards (maximum ${rules.maxDeckSize})`,
      fix: `Remove ${totalDeck - rules.maxDeckSize} cards`,
    });
  }

  // Commander check
  if (rules.commanderRequired && commanderCount === 0) {
    issues.push({
      severity: 'error',
      code: 'NO_COMMANDER',
      message: 'No commander designated',
      fix: 'Add a legendary creature as commander',
    });
  }

  // Commander count (EDH: 1 or 2 with partner)
  if (format === 'commander' && commanderCount > 2) {
    issues.push({
      severity: 'error',
      code: 'TOO_MANY_COMMANDERS',
      message: `${commanderCount} commanders (maximum 2 with partner)`,
    });
  }

  // Singleton check
  if (rules.singleton) {
    const cardCounts = new Map<string, number>();
    for (const board of ['commander', 'mainboard'] as DeckBoard[]) {
      for (const card of boards[board]) {
        const current = cardCounts.get(card.name) || 0;
        cardCounts.set(card.name, current + card.qty);
      }
    }

    for (const [name, qty] of cardCounts) {
      if (qty > 1 && !SINGLETON_EXEMPT.has(name)) {
        issues.push({
          severity: 'error',
          code: 'SINGLETON_VIOLATION',
          message: `${name}: ${qty} copies (singleton format allows 1)`,
          cardName: name,
          fix: `Remove ${qty - 1} copies of ${name}`,
        });
      }
    }
  }

  // Max copies check (for 60-card formats)
  if (!rules.singleton && rules.maxCopies < Infinity) {
    const allCards = [...boards.mainboard, ...boards.sideboard];
    const counts = new Map<string, number>();
    for (const card of allCards) {
      counts.set(card.name, (counts.get(card.name) || 0) + card.qty);
    }
    for (const [name, qty] of counts) {
      if (qty > rules.maxCopies && !BASIC_LANDS.has(name)) {
        issues.push({
          severity: 'error',
          code: 'MAX_COPIES_EXCEEDED',
          message: `${name}: ${qty} copies (maximum ${rules.maxCopies})`,
          cardName: name,
          fix: `Remove ${qty - rules.maxCopies} copies`,
        });
      }
    }
  }

  // Sideboard size
  if (sideboardCount > rules.sideboardMax && rules.sideboardMax < Infinity) {
    issues.push({
      severity: 'warning',
      code: 'SIDEBOARD_TOO_LARGE',
      message: `Sideboard has ${sideboardCount} cards (maximum ${rules.sideboardMax})`,
      fix: `Remove ${sideboardCount - rules.sideboardMax} cards from sideboard`,
    });
  }

  // Color identity check (for commander)
  if (format === 'commander') {
    const identityIssues = checkColorIdentity(boards);
    issues.push(...identityIssues);
  }

  // Tag-based warnings
  const tagWarnings = checkTagBasedWarnings(boards, format);
  issues.push(...tagWarnings);

  return {
    valid: issues.filter(i => i.severity === 'error').length === 0,
    issues,
    deckSize: totalDeck,
    targetSize: rules.minDeckSize,
  };
}

// ==================== Color Identity ====================

function checkColorIdentity(boards: DeckbuilderBoards): ValidationIssue[] {
  const deckIdentity = COLOR_IDENTITY_MAP['_deck'];
  if (!deckIdentity || deckIdentity.size === 0) return [];

  const issues: ValidationIssue[] = [];

  // Check each card in mainboard (we don't have mana cost data client-side,
  // so this is tag-based: cards tagged with color info)
  for (const board of ['mainboard', 'sideboard'] as DeckBoard[]) {
    for (const card of boards[board]) {
      // Check if card has color tags that are outside commander's identity
      const colorTags = card.tags.filter(t =>
        ['W', 'U', 'B', 'R', 'G'].includes(t.toUpperCase())
      );
      for (const color of colorTags) {
        if (!deckIdentity.has(color.toUpperCase())) {
          issues.push({
            severity: 'error',
            code: 'COLOR_IDENTITY_VIOLATION',
            message: `${card.name} has color ${color} outside commander's identity`,
            cardName: card.name,
            board,
            fix: `Remove ${card.name} or change commander`,
          });
          break; // One violation per card is enough
        }
      }
    }
  }

  return issues;
}

// ==================== Tag-Based Warnings ====================

function checkTagBasedWarnings(boards: DeckbuilderBoards, format: DeckFormat): ValidationIssue[] {
  if (format !== 'commander') return [];

  const issues: ValidationIssue[] = [];
  const allCards = [...boards.commander, ...boards.mainboard];

  // Count tags
  const tagCounts = new Map<string, number>();
  for (const card of allCards) {
    for (const tag of card.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + card.qty);
    }
  }

  // Low ramp warning
  const rampCount = tagCounts.get('ramp') || 0;
  if (rampCount < 8) {
    issues.push({
      severity: 'warning',
      code: 'LOW_RAMP',
      message: `Only ${rampCount} ramp cards (recommended 10+)`,
      fix: 'Add more mana rocks or ramp spells',
    });
  }

  // Low draw warning
  const drawCount = tagCounts.get('draw') || 0;
  if (drawCount < 8) {
    issues.push({
      severity: 'warning',
      code: 'LOW_DRAW',
      message: `Only ${drawCount} draw cards (recommended 10+)`,
      fix: 'Add more card draw or card advantage',
    });
  }

  // Low removal
  const removalCount = (tagCounts.get('removal') || 0) + (tagCounts.get('board_wipe') || 0);
  if (removalCount < 5) {
    issues.push({
      severity: 'warning',
      code: 'LOW_INTERACTION',
      message: `Only ${removalCount} removal/wipe cards (recommended 7+)`,
      fix: 'Add more removal spells or board wipes',
    });
  }

  // Land count check
  const landCount = tagCounts.get('land') || 0;
  if (landCount < 30) {
    issues.push({
      severity: 'warning',
      code: 'LOW_LANDS',
      message: `Only ${landCount} lands (recommended 33-38)`,
      fix: 'Add more lands to avoid mana screw',
    });
  } else if (landCount > 42) {
    issues.push({
      severity: 'info',
      code: 'HIGH_LANDS',
      message: `${landCount} lands is quite high (typical 33-38)`,
      fix: 'Consider removing some lands for more spells',
    });
  }

  return issues;
}

// ==================== Explain Mode ====================

/**
 * Explain why a card is in the deck.
 * Uses tags, combo lines, and synergy data to build an explanation.
 */
export function explainCard(
  cardName: string,
  boards: DeckbuilderBoards,
  options: {
    comboLines?: Array<{ name: string; cards: string[] }>;
    synergies?: Array<{ from: string; to: string; type: string }>;
  } = {}
): ExplainResult {
  // Find the card
  let card: DeckbuilderCardEntry | null = null;
  for (const board of Object.values(boards)) {
    card = board.find(c => c.name === cardName) || card;
  }

  const roles = card?.tags || [];
  const synergies: string[] = [];
  const comboLines: string[] = [];
  const replacements: string[] = [];

  // Find combos containing this card
  if (options.comboLines) {
    for (const line of options.comboLines) {
      if (line.cards.some(c => c.toLowerCase() === cardName.toLowerCase())) {
        comboLines.push(line.name);
      }
    }
  }

  // Find synergies
  if (options.synergies) {
    for (const syn of options.synergies) {
      if (syn.from.toLowerCase() === cardName.toLowerCase()) {
        synergies.push(`Synergizes with ${syn.to} (${syn.type})`);
      } else if (syn.to.toLowerCase() === cardName.toLowerCase()) {
        synergies.push(`Enabled by ${syn.from} (${syn.type})`);
      }
    }
  }

  // Build reasoning
  const parts: string[] = [];
  if (roles.length > 0) {
    parts.push(`Serves as: ${roles.join(', ')}`);
  }
  if (comboLines.length > 0) {
    parts.push(`Part of combo(s): ${comboLines.join(', ')}`);
  }
  if (synergies.length > 0) {
    parts.push(`Synergies: ${synergies.slice(0, 3).join('; ')}`);
  }
  if (parts.length === 0) {
    parts.push('No specific role detected — consider if this card is necessary');
  }

  return {
    cardName,
    roles,
    synergies,
    comboLines,
    replacements,
    reasoning: parts.join('\n'),
  };
}

// ==================== Quick Validate ====================

/**
 * Quick inline validation for a single card operation.
 */
export function validateCardAdd(
  cardName: string,
  board: DeckBoard,
  boards: DeckbuilderBoards,
  format: DeckFormat
): ValidationIssue[] {
  const rules = getFormatRules(format);
  const issues: ValidationIssue[] = [];

  if (rules.singleton && !SINGLETON_EXEMPT.has(cardName)) {
    // Check if already in deck
    for (const b of Object.values(boards)) {
      if (b.some(c => c.name === cardName)) {
        issues.push({
          severity: 'error',
          code: 'SINGLETON_VIOLATION',
          message: `${cardName} is already in the deck (singleton format)`,
          cardName,
        });
        break;
      }
    }
  }

  return issues;
}

// ==================== Severity Helpers ====================

export function getIssueSeverityColor(severity: ValidationSeverity): string {
  switch (severity) {
    case 'error': return '#ef4444';
    case 'warning': return '#f59e0b';
    case 'info': return '#3b82f6';
  }
}

export function getIssueSeverityIcon(severity: ValidationSeverity): string {
  switch (severity) {
    case 'error': return '❌';
    case 'warning': return '⚠️';
    case 'info': return 'ℹ️';
  }
}
