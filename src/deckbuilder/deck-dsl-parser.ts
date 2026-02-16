/**
 * Deck DSL Parser — Structured requirements for decks
 * 
 * Parses special comments in deck notes to extract deck requirements.
 * Example: "// @require ramp >= 10" or "// @combo A + B"
 */

export type RequirementType = 'tag' | 'combo' | 'budget' | 'custom' | 'max-cmc';

export type RequirementSeverity = 'error' | 'warning' | 'info';

export type RequirementOperator = '>=' | '<=' | '>' | '<' | '=' | 'includes';

export interface DeckRequirement {
  type: RequirementType;
  /** Original DSL line */
  raw: string;
  /** Line number in notes (1-indexed) */
  lineNumber: number;
  /** Severity level */
  severity: RequirementSeverity;
  /** For tag requirements: the tag name */
  tag?: string;
  /** For comparison requirements: the operator */
  operator?: RequirementOperator;
  /** For numeric requirements: the target value */
  value?: number;
  /** For combo requirements: list of card names */
  comboCards?: string[];
  /** For budget requirements: max price */
  maxBudget?: number;
  /** For custom requirements: free text */
  customText?: string;
}

/**
 * Parse DSL directives from deck notes
 */
export function parseDeckDSL(notes: string): DeckRequirement[] {
  const requirements: DeckRequirement[] = [];
  const lines = notes.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNumber = i + 1;

    // Match @require directive: // @require <tag> <operator> <value>
    const requireMatch = line.match(/^\/\/\s*@require\s+(\w+)\s*(>=|<=|>|<|=)\s*(\d+)/i);
    if (requireMatch) {
      requirements.push({
        type: 'tag',
        raw: line,
        lineNumber,
        severity: 'error',
        tag: requireMatch[1].toLowerCase(),
        operator: requireMatch[2] as RequirementOperator,
        value: parseInt(requireMatch[3], 10),
      });
      continue;
    }

    // Match @combo directive: // @combo "Card A" + "Card B" [+ "Card C"]
    const comboMatch = line.match(/^\/\/\s*@combo\s+(.+)/i);
    if (comboMatch) {
      const cardsPart = comboMatch[1];
      const cards = cardsPart
        .split('+')
        .map(s => s.trim())
        .map(s => s.replace(/^["']|["']$/g, '')) // Remove quotes
        .filter(s => s.length > 0);

      requirements.push({
        type: 'combo',
        raw: line,
        lineNumber,
        severity: 'warning',
        comboCards: cards,
      });
      continue;
    }

    // Match @budget directive: // @budget max <value> [EUR|USD]
    const budgetMatch = line.match(/^\/\/\s*@budget\s+max\s+(\d+(?:\.\d+)?)\s*(EUR|USD)?/i);
    if (budgetMatch) {
      requirements.push({
        type: 'budget',
        raw: line,
        lineNumber,
        severity: 'warning',
        maxBudget: parseFloat(budgetMatch[1]),
      });
      continue;
    }

    // Match @max-cmc directive: // @max-cmc <value>
    const cmcMatch = line.match(/^\/\/\s*@max-cmc\s+(\d+)/i);
    if (cmcMatch) {
      requirements.push({
        type: 'max-cmc',
        raw: line,
        lineNumber,
        severity: 'info',
        value: parseInt(cmcMatch[1], 10),
      });
      continue;
    }

    // Match @custom directive: // @custom <free text>
    const customMatch = line.match(/^\/\/\s*@custom\s+(.+)/i);
    if (customMatch) {
      requirements.push({
        type: 'custom',
        raw: line,
        lineNumber,
        severity: 'info',
        customText: customMatch[1],
      });
      continue;
    }
  }

  return requirements;
}

/**
 * Example usage:
 * 
 * const notes = `
 * // @require ramp >= 10
 * // @require draw >= 10
 * // @combo "Thassa's Oracle" + "Demonic Consultation"
 * // @budget max 100 EUR
 * // @max-cmc 6
 * `;
 * 
 * const requirements = parseDeckDSL(notes);
 * // Returns array of structured requirements
 */
