/**
 * Trend Dashboard Component
 * Visualizes meta trends and user analytics
 */

import { h, replaceChildren } from '../shared/dom.js';
import { getUserFeedbackSystem, type FeedbackAnalytics } from '../mtg/engine/user-feedback.js';
import type { ArchetypeId } from '../mtg/engine/archetype-catalog.js';

export interface TrendData {
  archetype: ArchetypeId;
  popularity: number; // 0-1
  trend: 'rising' | 'stable' | 'falling';
  weekChange: number; // percentage
  monthChange: number; // percentage
}

export class TrendDashboard {
  private container: HTMLElement | null = null;
  private feedbackSystem = getUserFeedbackSystem();
  private isVisible = false;

  constructor(containerId: string) {
    this.container = document.getElementById(containerId);
  }

  /**
   * Show the dashboard
   */
  show(): void {
    if (!this.container) return;
    this.isVisible = true;
    this.render();
  }

  /**
   * Hide the dashboard
   */
  hide(): void {
    this.isVisible = false;
    if (this.container) {
      this.container.innerHTML = '';
    }
  }

  /**
   * Toggle visibility
   */
  toggle(): void {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  /**
   * Render the dashboard
   */
  private render(): void {
    if (!this.container) return;

    const analytics = this.feedbackSystem.getAnalytics();
    const trends = this.generateTrends();

    const dashboard = h('div', { className: 'trend-dashboard' },
      h('div', { className: 'dashboard-header' },
        h('h2', {}, '📊 Meta Trends & Analytics'),
        h('button', {
          className: 'close-btn',
          onclick: () => this.hide(),
        }, '×')
      ),
      
      // Summary Cards
      h('div', { className: 'summary-cards' },
        this.renderSummaryCard('Total Interactions', analytics.totalEvents.toString()),
        this.renderSummaryCard('Apply Rate', `${(analytics.applyRate * 100).toFixed(1)}%`),
        this.renderSummaryCard('Avg Rating', analytics.averageRating.toFixed(2)),
        this.renderSummaryCard('Cards Rated', this.feedbackSystem.getAllPreferences().length.toString())
      ),

      // Top Cards Section
      h('div', { className: 'dashboard-section' },
        h('h3', {}, '⭐ Your Top Cards'),
        analytics.topCards.length > 0
          ? h('div', { className: 'card-list' },
              analytics.topCards.map(card => 
                h('div', { className: 'trend-card positive' },
                  h('span', { className: 'card-name' }, card.cardName),
                  h('span', { className: 'score' }, `+${card.score.toFixed(2)}`)
                )
              )
            )
          : h('p', { className: 'empty-state' }, 'Rate more recommendations to see your favorites!')
      ),

      // Disliked Cards Section
      analytics.worstCards.length > 0 && h('div', { className: 'dashboard-section' },
        h('h3', {}, '❌ Cards to Avoid'),
        h('div', { className: 'card-list' },
          analytics.worstCards.map(card => 
            h('div', { className: 'trend-card negative' },
              h('span', { className: 'card-name' }, card.cardName),
              h('span', { className: 'score' }, card.score.toFixed(2))
            )
          )
        )
      ),

      // Meta Trends Section
      h('div', { className: 'dashboard-section' },
        h('h3', {}, '📈 Archetype Trends'),
        trends.length > 0
          ? h('div', { className: 'trend-list' },
              trends.map(trend => this.renderTrendItem(trend))
            )
          : h('p', { className: 'empty-state' }, 'Analyzing meta trends...')
      ),

      // Archetype Preferences
      Object.keys(analytics.archetypePreferences).length > 0 && h('div', { className: 'dashboard-section' },
        h('h3', {}, '🎯 Your Archetype Preferences'),
        h('div', { className: 'archetype-preferences' },
          Object.entries(analytics.archetypePreferences)
            .sort((a, b) => b[1] - a[1])
            .map(([archetype, score]) => 
              h('div', { className: 'preference-bar' },
                h('span', { className: 'archetype-name' }, this.formatArchetypeName(archetype)),
                h('div', { className: 'bar-container' },
                  h('div', { 
                    className: 'bar',
                    style: `width: ${Math.abs(score) * 100}%; background: ${score > 0 ? 'var(--success)' : 'var(--error)'}`
                  })
                ),
                h('span', { className: 'score' }, score > 0 ? `+${score.toFixed(2)}` : score.toFixed(2))
              )
            )
        )
      ),

      // Insights
      this.renderInsights(analytics)
    );

    replaceChildren(this.container, dashboard);
  }

  /**
   * Render a summary card
   */
  private renderSummaryCard(label: string, value: string): HTMLElement {
    return h('div', { className: 'summary-card' },
      h('div', { className: 'value' }, value),
      h('div', { className: 'label' }, label)
    );
  }

  /**
   * Render a trend item
   */
  private renderTrendItem(trend: TrendData): HTMLElement {
    const trendIcon = trend.trend === 'rising' ? '📈' : trend.trend === 'falling' ? '📉' : '➡️';
    const weekChangeClass = trend.weekChange > 0 ? 'positive' : trend.weekChange < 0 ? 'negative' : 'neutral';
    const monthChangeClass = trend.monthChange > 0 ? 'positive' : trend.monthChange < 0 ? 'negative' : 'neutral';

    return h('div', { className: 'trend-item' },
      h('div', { className: 'trend-header' },
        h('span', { className: 'archetype-name' }, this.formatArchetypeName(trend.archetype)),
        h('span', { className: `trend-icon ${trend.trend}` }, trendIcon)
      ),
      h('div', { className: 'trend-stats' },
        h('div', { className: 'popularity-bar' },
          h('div', { 
            className: 'popularity-fill',
            style: `width: ${trend.popularity * 100}%`
          })
        ),
        h('span', { className: 'popularity-label' }, `${(trend.popularity * 100).toFixed(0)}% meta share`)
      ),
      h('div', { className: 'change-stats' },
        h('span', { className: `change ${weekChangeClass}` }, 
          `7d: ${trend.weekChange > 0 ? '+' : ''}${trend.weekChange.toFixed(1)}%`
        ),
        h('span', { className: `change ${monthChangeClass}` },
          `30d: ${trend.monthChange > 0 ? '+' : ''}${trend.monthChange.toFixed(1)}%`
        )
      )
    );
  }

  /**
   * Render insights section
   */
  private renderInsights(analytics: FeedbackAnalytics): HTMLElement | null {
    const insights: string[] = [];

    if (analytics.applyRate > 0.5) {
      insights.push('🎉 Great! You apply more than 50% of recommendations.');
    } else if (analytics.applyRate < 0.2) {
      insights.push('💡 Tip: Try applying more recommendations to improve your deck.');
    }

    if (analytics.averageRating > 0.3) {
      insights.push('😊 You seem happy with the recommendations overall!');
    } else if (analytics.averageRating < -0.2) {
      insights.push('🤔 The recommendations might not match your style. Try adjusting the meta mode.');
    }

    const topArchetype = Object.entries(analytics.archetypePreferences)
      .sort((a, b) => b[1] - a[1])[0];
    if (topArchetype) {
      insights.push(`🏆 Your favorite archetype: ${this.formatArchetypeName(topArchetype[0])}`);
    }

    if (insights.length === 0) return null;

    return h('div', { className: 'dashboard-section insights' },
      h('h3', {}, '💡 Insights'),
      h('ul', {},
        insights.map(insight => h('li', {}, insight))
      )
    );
  }

  /**
   * Generate mock trends (would come from server in production)
   */
  private generateTrends(): TrendData[] {
    // In production, this would fetch from the meta-aggregator
    return [
      { archetype: 'reanimator', popularity: 0.15, trend: 'rising', weekChange: 3.2, monthChange: 8.5 },
      { archetype: 'storm', popularity: 0.20, trend: 'stable', weekChange: -0.5, monthChange: 2.1 },
      { archetype: 'tribal-elves', popularity: 0.12, trend: 'falling', weekChange: -2.1, monthChange: -5.3 },
      { archetype: 'lifegain', popularity: 0.18, trend: 'rising', weekChange: 1.8, monthChange: 4.2 },
      { archetype: 'tokens', popularity: 0.14, trend: 'stable', weekChange: 0.3, monthChange: -1.2 },
    ];
  }

  /**
   * Format archetype name for display
   */
  private formatArchetypeName(archetype: string): string {
    return archetype
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}

// Singleton instance
let dashboardInstance: TrendDashboard | null = null;

export function getTrendDashboard(containerId: string = 'trendDashboard'): TrendDashboard {
  if (!dashboardInstance) {
    dashboardInstance = new TrendDashboard(containerId);
  }
  return dashboardInstance;
}
