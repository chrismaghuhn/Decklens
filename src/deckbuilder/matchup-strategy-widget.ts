/**
 * Matchup Strategy Widget — Wrapper for renderMatchupPanel()
 * 
 * This widget exposes the existing matchup-panel logic to the dashboard layout system.
 * It displays archetype-specific matchup strategies and sideboard plans.
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import type { MatchupMetaMode } from '../mtg/engine/matchup-guide.js';
import { renderMatchupPanel } from './matchup-panel.js';

/**
 * Render the matchup strategy widget.
 * This is a lightweight wrapper that delegates to the existing renderMatchupPanel.
 */
export function renderMatchupStrategyWidget(
  container: HTMLElement,
  deck: DeckbuilderDeck | null,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  metaMode: MatchupMetaMode = 'commander-pod',
): void {
  container.textContent = '';

  if (!deck || deck.boards.mainboard.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'matchup-widget-empty';
    empty.innerHTML = `
      <p style="text-align:center;padding:2rem 1rem;color:var(--text-dim);">
 ✕<br>
        <span style="font-size:0.82rem;">Add cards to your deck to see matchup strategies.</span>
      </p>
    `;
    container.appendChild(empty);
    return;
  }

  // Delegate to existing matchup panel renderer
  renderMatchupPanel(container, deck, cardByName, metaMode);
}
