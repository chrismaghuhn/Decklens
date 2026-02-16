// ============================================================
// PolicyService — Evaluate "Policy as Code" for decks
// ============================================================
// Parses and evaluates deck-level policies defined in 
// settings or a policy.yml file.
// ============================================================

import { type DeckState, type PlaygroupRule, type CheckDetail, type DeckBoard } from './types.js';

export interface PolicyViolation {
  ruleId: string;
  ruleName: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  card?: string;
  board?: DeckBoard;
}

export class PolicyService {
  /**
   * Evaluate a deck state against a set of rules.
   */
  evaluate(state: DeckState, rules: PlaygroupRule[]): PolicyViolation[] {
    const violations: PolicyViolation[] = [];

    for (const rule of rules) {
      const ruleViolations = this.evaluateRule(state, rule);
      violations.push(...ruleViolations);
    }

    return violations;
  }

  private evaluateRule(state: DeckState, rule: PlaygroupRule): PolicyViolation[] {
    const violations: PolicyViolation[] = [];
    const allBoards: DeckBoard[] = ['commander', 'mainboard', 'sideboard', 'maybeboard'];
    
    // Flatten cards for easier checking
    const cards = allBoards.flatMap(board => 
      state.boards[board].map(c => ({ ...c, board }))
    );

    switch (rule.type) {
      case 'ban':
        // target is card name or tag
        for (const card of cards) {
          if (this.matchesTarget(card, rule.target)) {
            violations.push({
              ruleId: rule.id,
              ruleName: rule.name,
              message: `Banned card found: ${card.name}${rule.description ? ` (${rule.description})` : ''}`,
              severity: 'error',
              card: card.name,
              board: card.board
            });
          }
        }
        break;

      case 'limit':
        // target is card name or tag, value is max qty
        const limit = rule.value ?? 1;
        let count = 0;
        const matchingCards: typeof cards = [];
        
        for (const card of cards) {
          if (this.matchesTarget(card, rule.target)) {
            count += card.qty;
            matchingCards.push(card);
          }
        }

        if (count > limit) {
          violations.push({
            ruleId: rule.id,
            ruleName: rule.name,
            message: `Limit exceeded for ${rule.target}: ${count}/${limit}${rule.description ? ` (${rule.description})` : ''}`,
            severity: 'error',
            card: matchingCards[0]?.name // points to the first match
          });
        }
        break;

      case 'require':
        // target is card name or tag, must be present
        let found = false;
        for (const card of cards) {
          if (this.matchesTarget(card, rule.target)) {
            found = true;
            break;
          }
        }

        if (!found) {
          violations.push({
            ruleId: rule.id,
            ruleName: rule.name,
            message: `Required card/tag missing: ${rule.target}${rule.description ? ` (${rule.description})` : ''}`,
            severity: 'warning'
          });
        }
        break;

      case 'allow':
        // This is usually a whitelist, anything not matching is banned?
        // Let's implement it as "only these targets are allowed for this category"
        // Not implemented for now as it's complex without a scope
        break;
    }

    return violations;
  }

  private matchesTarget(card: { name: string; tags: string[] }, target: string): boolean {
    const lowerTarget = target.toLowerCase();
    
    // Direct name match
    if (card.name.toLowerCase() === lowerTarget) return true;
    
    // Tag match (prefixed with tag:)
    if (lowerTarget.startsWith('tag:')) {
      const tagName = lowerTarget.slice(4);
      return card.tags.some(t => t.toLowerCase() === tagName);
    }

    // Keyword in name
    if (card.name.toLowerCase().includes(lowerTarget)) return true;

    return false;
  }

  /**
   * Convert violations to CheckDetails for ChecksService.
   */
  convertToCheckDetails(violations: PolicyViolation[]): CheckDetail[] {
    return violations.map(v => ({
      severity: v.severity,
      message: `[${v.ruleName}] ${v.message}`,
      card: v.card,
      board: v.board
    }));
  }
}
