// ==================== Community Dashboard ====================
// User feedback, sentiment analysis, and support metrics for community managers

import { createKPICard, createKPICardGrid, createChartContainer, createTableContainer, createAlertBanner, createLoadingSpinner, RealtimeManager } from './shared/dashboard-components.js';

interface FeedbackAnalytics {
  volume: {
    total: number;
    byCategory: Record<string, number>;
    trend: 'up' | 'down' | 'stable';
  };
  sentiment: {
    positive: number;
    neutral: number;
    negative: number;
    averageRating: number;
  };
  responseTime: {
    averageHours: number;
    oldestUnresolvedHours: number;
  };
}

export async function renderCommunityDashboard(params?: Record<string, string>): Promise<string> {
  const timeRange = parseInt(params?.timeRange || '30');
  
  return `
    <div class="community-dashboard">
      ${createCommunityNavigation()}
      
      <!-- Community Overview -->
      <section class="dashboard-section">
        <h2>Community Overview</h2>
        <div id="communityKPIs">
          ${createLoadingSpinner('Loading community metrics...')}
        </div>
      </section>

      <!-- Feedback Analysis -->
      <section class="dashboard-section">
        <h2>Feedback Analysis</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-2">
            ${createChartContainer('Feedback Volume', 'feedbackVolumeChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Feedback Categories', 'feedbackCategoriesChart', 'pie')}
          </div>
        </div>
      </section>

      <!-- Sentiment Analysis -->
      <section class="dashboard-section">
        <h2>Sentiment Analysis</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('Sentiment Trend', 'sentimentTrendChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Rating Distribution', 'ratingDistributionChart', 'bar')}
          </div>
          <div class="dashboard-col-1">
            ${createKPICard({
              label: 'Average Rating',
              value: '---',
              change: 0.042,
              changeLabel: 'vs last week',
              trend: 'up',
              description: 'From 1-5 scale'
            })}
          </div>
        </div>
      </section>

      <!-- Support Queue -->
      <section class="dashboard-section">
        <h2>Support Queue</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-2">
            ${createTableContainer(
              'Recent Feedback',
              'recentFeedbackTable',
              [
                { key: 'timestamp', label: 'Time' },
                { key: 'category', label: 'Category' },
                { key: 'rating', label: 'Rating' },
                { key: 'message', label: 'Message' },
                { key: 'status', label: 'Status' }
              ],
              []
            )}
          </div>
          <div class="dashboard-col-1">
            ${createTableContainer(
              'Response Time Metrics',
              'responseTimeTable',
              [
                { key: 'metric', label: 'Metric' },
                { key: 'current', label: 'Current' },
                { key: 'target', label: 'Target' },
                { key: 'status', label: 'Status' }
              ],
              []
            )}
          </div>
        </div>
      </section>

      <!-- Community Insights -->
      <section class="dashboard-section">
        <h2>Community Insights</h2>
        <div id="communityInsights">
          ${createLoadingSpinner('Analyzing community feedback...')}
        </div>
      </section>

      <!-- User Activity -->
      <section class="dashboard-section">
        <h2>User Activity</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('Most Active Users', 'activeUsersChart', 'bar')}
          </div>
          <div class="dashboard-col-2">
            ${createChartContainer('Feature Feedback', 'featureFeedbackChart', 'bar')}
          </div>
        </div>
      </section>
    </div>
  `;
}

export function initCommunityDashboard(): void {
  loadCommunityMetrics();
  initCommunityRealtimeUpdates();
  initCommunityCharts();
}

async function loadCommunityMetrics(): Promise<void> {
  const container = document.getElementById('communityKPIs');
  if (!container) return;

  try {
    const mockFeedbackAnalytics: FeedbackAnalytics = {
      volume: {
        total: 234,
        byCategory: { bug: 67, ux: 89, feature: 45, performance: 23, other: 10 },
        trend: 'up',
      },
      sentiment: {
        positive: 156,
        neutral: 58,
        negative: 20,
        averageRating: 4.2,
      },
      responseTime: {
        averageHours: 3.7,
        oldestUnresolvedHours: 18.5,
      },
    };

    const communityCards = createKPICardGrid([
      {
        label: 'Total Feedback',
        value: mockFeedbackAnalytics.volume.total,
        change: 0.128,
        changeLabel: 'vs last week',
        trend: 'up',
        description: `${mockFeedbackAnalytics.volume.trend === 'up' ? '↗️' : ''} Trending ${mockFeedbackAnalytics.volume.trend}`
      },
      {
        label: 'Average Rating',
        value: mockFeedbackAnalytics.sentiment.averageRating.toFixed(1),
        change: 0.042,
        changeLabel: 'vs last week',
        trend: 'up',
        description: 'From 1-5 scale'
      },
      {
        label: 'Response Time',
        value: `${mockFeedbackAnalytics.responseTime.averageHours.toFixed(1)}h`,
        change: -0.234,
        changeLabel: 'vs last week',
        trend: 'up', // lower is better
        description: `Oldest: ${mockFeedbackAnalytics.responseTime.oldestUnresolvedHours.toFixed(1)}h`
      },
      {
        label: 'Positive Sentiment',
        value: `${(mockFeedbackAnalytics.sentiment.positive / mockFeedbackAnalytics.volume.total * 100).toFixed(1)}%`,
        change: 0.056,
        changeLabel: 'vs last week',
        trend: 'up',
        description: `${mockFeedbackAnalytics.sentiment.positive} positive responses`
      },
    ]);

    container.innerHTML = communityCards;

  } catch (error) {
    console.error('Failed to load community metrics:', error);
    container.innerHTML = `
      <div class="error-message">
        Failed to load community metrics. Please refresh the page.
      </div>
    `;
  }
}

function initCommunityRealtimeUpdates(): void {
  const realtime = new RealtimeManager('/api/analytics/live/updates');
  
  realtime.connect();
  
  realtime.subscribe('newFeedback', (data) => {
    updateFeedbackQueue(data as any);
  });

  realtime.subscribe('sentimentChange', (data) => {
    updateSentimentMetrics(data as any);
  });
}

function updateFeedbackQueue(feedback: any): void {
  console.log('New feedback received:', feedback);
}

function updateSentimentMetrics(sentiment: any): void {
  console.log('Sentiment updated:', sentiment);
}

function initCommunityCharts(): void {
  initFeedbackVolumeChart();
  initFeedbackCategoriesChart();
  initSentimentTrendChart();
  initRatingDistributionChart();
  initActiveUsersChart();
  initFeatureFeedbackChart();
}

function initFeedbackVolumeChart(): void {
  console.log('Initializing feedback volume chart...');
}

function initFeedbackCategoriesChart(): void {
  console.log('Initializing feedback categories chart...');
}

function initSentimentTrendChart(): void {
  console.log('Initializing sentiment trend chart...');
}

function initRatingDistributionChart(): void {
  console.log('Initializing rating distribution chart...');
}

function initActiveUsersChart(): void {
  console.log('Initializing active users chart...');
}

function initFeatureFeedbackChart(): void {
  console.log('Initializing feature feedback chart...');
}

async function loadCommunityInsights(): Promise<void> {
  const container = document.getElementById('communityInsights');
  if (!container) return;

  try {
    const insights = [
      createAlertBanner(
        'success',
        'Positive User Feedback Trend',
        'User satisfaction has improved by 5.6% this week, with average rating of 4.2/5.',
        [
          { label: 'View Detailed Feedback', action: 'view-feedback' },
          { label: 'Respond to Users', action: 'respond-feedback' }
        ]
      ),
      createAlertBanner(
        'warning',
        'High Response Time for Bug Reports',
        'Bug reports are taking 8.3 hours on average to respond, exceeding our 4-hour SLA.',
        [
          { label: 'Review Bug Queue', action: 'review-bug-queue' },
          { label: 'Assign Team', action: 'assign-team' }
        ]
      ),
    ];

    container.innerHTML = insights.join('');

  } catch (error) {
    console.error('Failed to load community insights:', error);
    container.innerHTML = '<div class="error-message">Unable to load insights.</div>';
  }
}

function createCommunityNavigation(): string {
  return `
    <div class="dashboard-navigation">
      <div class="nav-header">
        <h1>Community Dashboard</h1>
        <div class="nav-actions">
          <select id="timeRangeSelector" class="time-range-selector">
            <option value="7">Last 7 days</option>
            <option value="30" selected>Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
          <button class="hand-btn secondary" data-action="export-feedback">
            Export Feedback
          </button>
          <button class="hand-btn secondary" data-action="manage-community">
            Manage Community
          </button>
        </div>
      </div>
    </div>
  `;
}