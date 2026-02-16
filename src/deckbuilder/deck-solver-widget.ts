/**
 * Deck Solver Widget — Constraint-based deck fixing assistant
 * 
 * Displays deck constraint violations and suggests fixes.
 * Example: "Need 3 more ramp cards" → suggests additions/cuts
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import {
  solveConstraints,
  getDefaultEDHConstraints,
  type TagConstraint,
  type SolverResult,
} from './constraint-solver.js';

/**
 * Render the deck solver widget
 */
export function renderDeckSolverWidget(
  container: HTMLElement,
  deck: DeckbuilderDeck | null,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  customConstraints?: TagConstraint[],
): void {
  container.textContent = '';

  if (!deck || deck.boards.mainboard.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'solver-widget-empty';
    empty.innerHTML = `
      <p style="text-align:center;padding:2rem 1rem;color:var(--text-dim);">
        🧮<br>
        <span style="font-size:0.82rem;">Add cards to analyze deck constraints.</span>
      </p>
    `;
    container.appendChild(empty);
    return;
  }

  // Prepare cards for solver
  const cards = [
    { board: 'mainboard' as const, entries: deck.boards.mainboard },
    { board: 'commander' as const, entries: deck.boards.commander },
  ];

  const constraints = customConstraints || getDefaultEDHConstraints();
  const result = solveConstraints(cards, constraints, 100);

  // Header
  const header = document.createElement('div');
  header.className = 'solver-header';
  header.innerHTML = `
    <span class="solver-icon">🧮</span>
    <span class="solver-title">Deck Solver</span>
    <span class="solver-status solver-status--${result.isSatisfied ? 'ok' : 'warning'}">
      ${result.isSatisfied ? '✓ Satisfied' : `⚠ ${result.violations.length} Issues`}
    </span>
  `;
  container.appendChild(header);

  // Violations
  if (result.violations.length > 0) {
    const violationsSection = document.createElement('div');
    violationsSection.className = 'solver-violations';

    const violTitle = document.createElement('div');
    violTitle.className = 'solver-section-title';
    violTitle.textContent = 'Constraint Violations';
    violationsSection.appendChild(violTitle);

    for (const v of result.violations) {
      const vCard = document.createElement('div');
      vCard.className = 'solver-violation-card';

      const deficit = v.deficit > 0 ? `Need ${v.deficit} more` : `${Math.abs(v.deficit)} over limit`;
      const ratio = `${v.currentCount}/${v.constraint.minCount}${v.constraint.maxCount ? `-${v.constraint.maxCount}` : ''}`;

      vCard.innerHTML = `
        <div class="solver-violation-tag">${v.constraint.tag}</div>
        <div class="solver-violation-details">
          <span class="solver-violation-deficit">${deficit}</span>
          <span class="solver-violation-ratio">${ratio}</span>
        </div>
      `;
      violationsSection.appendChild(vCard);
    }

    container.appendChild(violationsSection);
  }

  // Suggestions
  if (result.suggestions.length > 0) {
    const suggestionsSection = document.createElement('div');
    suggestionsSection.className = 'solver-suggestions';

    const sugTitle = document.createElement('div');
    sugTitle.className = 'solver-section-title';
    sugTitle.textContent = 'Suggested Fixes';
    suggestionsSection.appendChild(sugTitle);

    for (const sug of result.suggestions.slice(0, 8)) {
      const sugCard = document.createElement('div');
      sugCard.className = `solver-suggestion solver-suggestion--${sug.action}`;

      const actionIcon = sug.action === 'add' ? '➕' : sug.action === 'cut' ? '➖' : '🔄';
      sugCard.innerHTML = `
        <span class="solver-action-icon">${actionIcon}</span>
        <div class="solver-suggestion-content">
          <div class="solver-suggestion-card">${sug.cardName}</div>
          <div class="solver-suggestion-reason">${sug.reason}</div>
        </div>
      `;
      suggestionsSection.appendChild(sugCard);
    }

    container.appendChild(suggestionsSection);
  }

  // Summary (if satisfied)
  if (result.isSatisfied) {
    const summary = document.createElement('div');
    summary.className = 'solver-summary-ok';
    summary.innerHTML = `
      <span style="font-size:1.2rem;">✅</span>
      <span>All constraints satisfied!</span>
    `;
    container.appendChild(summary);
  }
}
