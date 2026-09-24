/**
 * Commander Stats Widget
 *
 * Displays commander statistics (win rate, meta %, popularity) in the deckbuilder
 */

import type { DeckbuilderDeck } from './editor-types.js';
import { fetchCommanderStats } from '../shared/commander-stats-api.js';
import { svgMarkup } from './line-icons.js';

/**
 * Render commander stats widget
 */
export async function renderCommanderStatsWidget(
  container: HTMLElement,
  deck: DeckbuilderDeck
): Promise<void> {
  container.innerHTML = '<div class="commander-stats-loading">Loading stats...</div>';

  // Extract commander from deck
  const commander = deck.boards.commander?.[0];
  if (!commander) {
    container.innerHTML = `
      <div class="commander-stats-empty">
        <div class="empty-icon">${svgMarkup('commander-stats')}</div>
        <p class="empty-text">No commander detected</p>
        <p class="empty-hint">Add a commander to see statistics</p>
      </div>
    `;
    return;
  }

  // Fetch stats from API
  const response = await fetchCommanderStats(commander.name);

  if (!response.ok || !response.stats) {
    container.innerHTML = `
      <div class="commander-stats-error">
        <div class="error-icon">${svgMarkup('warning')}</div>
        <p class="error-text">Stats unavailable</p>
        <p class="error-hint">No data found for ${commander.name}</p>
      </div>
    `;
    return;
  }

  const stats = response.stats;

  // Format last updated date
  const lastUpdatedDate = new Date(stats.lastUpdated * 1000);
  const daysAgo = Math.floor((Date.now() - lastUpdatedDate.getTime()) / (1000 * 60 * 60 * 24));
  const lastUpdatedText = daysAgo === 0 ? 'Today' : daysAgo === 1 ? 'Yesterday' : `${daysAgo} days ago`;

  // Determine data source badge
  const isRealData = stats.totalDecks >= 10;
  const sourceBadge = isRealData
    ? '<span class="stat-badge stat-badge-community">Community Data</span>'
    : '<span class="stat-badge stat-badge-estimated">Estimated</span>';

  container.innerHTML = `
    <div class="commander-stats">
      <div class="commander-stats-header">
        <h3 class="commander-stats-title">${stats.commanderName}</h3>
        ${sourceBadge}
      </div>

      <div class="commander-stats-grid">
        <!-- Win Rate -->
        <div class="stat-card ${stats.winRate === 0 ? 'stat-card-dim' : ''}">
          <div class="stat-label">Win Rate</div>
          <div class="stat-value stat-value-large">${stats.winRate.toFixed(1)}%</div>
          <div class="stat-bar-container">
            <div class="stat-bar stat-bar-gold" style="width: ${stats.winRate}%"></div>
          </div>
        </div>

        <!-- Meta Percentage -->
        <div class="stat-card">
          <div class="stat-label">Meta %</div>
          <div class="stat-value stat-value-large">${stats.metaPercentage.toFixed(2)}%</div>
          <div class="stat-hint">${stats.totalDecks.toLocaleString()} decks</div>
        </div>

        <!-- Popularity Rank -->
        <div class="stat-card">
          <div class="stat-label">Popularity</div>
          <div class="stat-value stat-value-rank">#${stats.popularityRank}</div>
          <div class="stat-hint">of 1000+ commanders</div>
        </div>

        <!-- Average Power Level -->
        <div class="stat-card">
          <div class="stat-label">Avg Power</div>
          <div class="stat-value">${stats.avgPowerLevel.toFixed(1)} / 10</div>
          <div class="stat-bar-container">
            <div class="stat-bar stat-bar-emerald" style="width: ${stats.avgPowerLevel * 10}%"></div>
          </div>
        </div>

        <!-- Average Deck Price -->
        <div class="stat-card">
          <div class="stat-label">Avg Price</div>
          <div class="stat-value">€${stats.avgDeckPrice.toFixed(0)}</div>
          <div class="stat-hint">${getPriceCategory(stats.avgDeckPrice)}</div>
        </div>

        <!-- Games Played (only show if > 0) -->
        ${stats.avgGamesPlayed > 0 ? `
        <div class="stat-card">
          <div class="stat-label">Avg Games</div>
          <div class="stat-value">${stats.avgGamesPlayed}</div>
          <div class="stat-hint">per deck</div>
        </div>
        ` : ''}
      </div>

      <div class="commander-stats-footer">
        <div class="footer-text">Updated ${lastUpdatedText}</div>
        <a href="https://edhrec.com/commanders/${encodeURIComponent(stats.commanderName.toLowerCase().replace(/,/g, '').replace(/ /g, '-'))}"
           target="_blank"
           class="footer-link">View on EDHREC →</a>
      </div>
    </div>
  `;
}

/**
 * Get price category label
 */
function getPriceCategory(price: number): string {
  if (price < 50) return 'Budget';
  if (price < 150) return 'Mid-Range';
  if (price < 500) return 'High';
  return 'cEDH';
}
