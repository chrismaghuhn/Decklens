/**
 * Cut Suggestions Widget — AI-powered card cutting assistant
 * 
 * Displays explainable cut candidates when deck is over target size.
 * Example: "Cut X because: low synergy, high CMC, not in combos"
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { analyzeCuts, type CutAnalysis } from './cut-assistant.js';

/**
 * Render the cut suggestions widget
 */
export function renderCutSuggestionsWidget(
  container: HTMLElement,
  deck: DeckbuilderDeck | null,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
): void {
  container.textContent = '';

  if (!deck || deck.boards.mainboard.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'cut-widget-empty';
    empty.innerHTML = `
      <p style="text-align:center;padding:2rem 1rem;color:var(--text-dim);">
        ✂️<br>
        <span style="font-size:0.82rem;">Add cards to see cut suggestions.</span>
      </p>
    `;
    container.appendChild(empty);
    return;
  }

  const analysis = analyzeCuts(deck.boards, { targetSize: 100 });

  // Header
  const header = document.createElement('div');
  header.className = 'cut-header';
  
  const statusClass = analysis.toCut === 0 ? 'ok' : 'warning';
  header.innerHTML = `
    <span class="cut-icon">✂️</span>
    <span class="cut-title">Cut Suggestions</span>
    <span class="cut-status cut-status--${statusClass}">
      ${analysis.toCut === 0 ? '✓ Size OK' : `⚠ Cut ${analysis.toCut}`}
    </span>
  `;
  container.appendChild(header);

  // Summary
  if (analysis.toCut > 0) {
    const summary = document.createElement('div');
    summary.className = 'cut-summary';
    summary.innerHTML = `
      <span class="cut-summary-size">Deck: ${analysis.deckSize}/${analysis.targetSize} cards</span>
      <span class="cut-summary-text">Need to cut ${analysis.toCut} card${analysis.toCut > 1 ? 's' : ''}</span>
    `;
    container.appendChild(summary);
  }

  // Candidates (top 10 worst scores)
  const candidates = analysis.candidates
    .filter(c => c.board !== 'commander') // Never show commanders
    .sort((a, b) => a.score - b.score) // Lower score = better cut candidate
    .slice(0, 10);

  if (candidates.length > 0) {
    const candidatesSection = document.createElement('div');
    candidatesSection.className = 'cut-candidates';

    for (const candidate of candidates) {
      const card = document.createElement('div');
      card.className = 'cut-candidate-card';

      // Card name
      const nameEl = document.createElement('div');
      nameEl.className = 'cut-candidate-name';
      nameEl.textContent = candidate.name;
      card.appendChild(nameEl);

      // Score bar
      const scoreBarWrap = document.createElement('div');
      scoreBarWrap.className = 'cut-score-bar-wrap';
      const scoreBar = document.createElement('div');
      scoreBar.className = 'cut-score-bar';
      scoreBar.style.width = `${candidate.score}%`;
      scoreBar.style.background = candidate.score < 30 ? 'var(--danger)' : candidate.score < 50 ? 'var(--warning)' : 'var(--success)';
      scoreBarWrap.appendChild(scoreBar);
      card.appendChild(scoreBarWrap);

      // Reasons
      const reasonsEl = document.createElement('div');
      reasonsEl.className = 'cut-reasons';
      
      for (const reason of candidate.reasons.slice(0, 3)) {
        if (reason.weight < 0) { // Only show negative factors (cut reasons)
          const reasonBadge = document.createElement('span');
          reasonBadge.className = `cut-reason-badge cut-reason--${reason.severity}`;
          reasonBadge.textContent = reason.factor;
          reasonBadge.title = reason.explanation;
          reasonsEl.appendChild(reasonBadge);
        }
      }
      card.appendChild(reasonsEl);

      candidatesSection.appendChild(card);
    }

    container.appendChild(candidatesSection);
  }

  // All good state
  if (analysis.toCut === 0) {
    const allGood = document.createElement('div');
    allGood.className = 'cut-all-good';
    allGood.innerHTML = `
      <span style="font-size:1.2rem;">✅</span>
      <span>Deck size is perfect!</span>
    `;
    container.appendChild(allGood);
  }
}
