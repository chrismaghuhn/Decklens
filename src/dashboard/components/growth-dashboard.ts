// ==================== Growth Dashboard ====================
// Product metrics, funnel analysis, and user engagement for product teams

import { createKPICard, createKPICardGrid, createChartContainer, createTableContainer, createAlertBanner, createLoadingSpinner, RealtimeManager } from './shared/dashboard-components.js';

interface GrowthMetrics {
  funnel: {
    importToAnalysis: number;
    analysisToApply: number;
    applyToExport: number;
    overallConversion: number;
  };
  retention: {
    day1: number;
    day7: number;
    day30: number;
    cohortAnalysis: Array<{
      cohort: string;
      day1: number;
      day7: number;
      day30: number;
      size: number;
    }>;
  };
  engagement: {
    recommendationsPerSession: number;
    sessionDuration: number;
    repeatUsageRate: number;
  };
}

export async function renderGrowthDashboard(params?: Record<string, string>): Promise<string> {
  const timeRange = parseInt(params?.timeRange || '30');
  
  return `
    <div class="growth-dashboard">
      ${createGrowthNavigation()}
      
      <!-- Funnel Analysis -->
      <section class="dashboard-section">
        <h2>Conversion Funnel</h2>
        <div id="funnelAnalysis">
          ${createLoadingSpinner('Loading funnel data...')}
        </div>
      </section>

      <!-- Funnel Details -->
      <section class="dashboard-section">
        <h2>Funnel Breakdown</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-2">
            ${createChartContainer('Funnel Visualization', 'funnelChart', 'funnel')}
          </div>
          <div class="dashboard-col-1">
            ${createTableContainer(
              'Conversion Rates',
              'conversionTable',
              [
                { key: 'step', label: 'Step' },
                { key: 'rate', label: 'Rate', format: (v) => `${(v as number * 100).toFixed(1)}%` },
                { key: 'change', label: 'vs Last Week', format: (v) => {
                  const val = v as number;
                  return `${val >= 0 ? '+' : ''}${(val * 100).toFixed(1)}%`;
                }}
              ],
              []
            )}
          </div>
        </div>
      </section>

      <!-- Engagement Metrics -->
      <section class="dashboard-section">
        <h2>User Engagement</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('Session Duration', 'sessionDurationChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Recommendations per Session', 'recommendationsChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Repeat Usage Rate', 'repeatUsageChart', 'line')}
          </div>
        </div>
      </section>

      <!-- Cohort Analysis -->
      <section class="dashboard-section">
        <h2>Cohort Retention</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-2">
            ${createChartContainer('Cohort Retention Heatmap', 'cohortHeatmap', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createTableContainer(
              'Recent Cohorts',
              'cohortTable',
              [
                { key: 'cohort', label: 'Cohort' },
                { key: 'size', label: 'Size' },
                { key: 'day1', label: 'D1', format: (v) => `${(v as number * 100).toFixed(1)}%` },
                { key: 'day7', label: 'D7', format: (v) => `${(v as number * 100).toFixed(1)}%` },
                { key: 'day30', label: 'D30', format: (v) => `${(v as number * 100).toFixed(1)}%` },
              ],
              []
            )}
          </div>
        </div>
      </section>

      <!-- Growth Insights -->
      <section class="dashboard-section">
        <h2>Growth Insights</h2>
        <div id="growthInsights">
          ${createLoadingSpinner('Analyzing growth patterns...')}
        </div>
      </section>

      <!-- User Journey Analysis -->
      <section class="dashboard-section">
        <h2>User Journey Analysis</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('Time to First Recommendation', 'timeToFirstRecChart', 'bar')}
          </div>
          <div class="dashboard-col-2">
            ${createChartContainer('Feature Adoption', 'featureAdoptionChart', 'bar')}
          </div>
        </div>
      </section>
    </div>
  `;
}

export function initGrowthDashboard(): void {
  loadGrowthMetrics();
  initGrowthRealtimeUpdates();
  initGrowthCharts();
}

// Data loading functions
async function loadGrowthMetrics(): Promise<void> {
  const container = document.getElementById('funnelAnalysis');
  if (!container) return;

  try {
    // Mock data for development
    const mockGrowthMetrics: GrowthMetrics = {
      funnel: {
        importToAnalysis: 0.73,
        analysisToApply: 0.58,
        applyToExport: 0.41,
        overallConversion: 0.17,
      },
      retention: {
        day1: 0.85,
        day7: 0.43,
        day30: 0.22,
        cohortAnalysis: [
          { cohort: '2025-W01', day1: 0.87, day7: 0.46, day30: 0.24, size: 124 },
          { cohort: '2025-W02', day1: 0.83, day7: 0.41, day30: 0.19, size: 98 },
          { cohort: '2025-W03', day1: 0.89, day7: 0.48, day30: 0.27, size: 156 },
          { cohort: '2025-W04', day1: 0.81, day7: 0.39, day30: 0.20, size: 112 },
        ],
      },
      engagement: {
        recommendationsPerSession: 3.7,
        sessionDuration: 847, // seconds
        repeatUsageRate: 0.34,
      },
    };

    const funnelCards = createKPICardGrid([
      {
        label: 'Import → Analysis',
        value: mockGrowthMetrics.funnel.importToAnalysis,
        change: 0.032,
        changeLabel: 'vs last week',
        trend: 'up',
        description: 'Users who start analysis after importing'
      },
      {
        label: 'Analysis → Apply',
        value: mockGrowthMetrics.funnel.analysisToApply,
        change: -0.018,
        changeLabel: 'vs last week',
        trend: 'down',
        description: 'Users who apply recommendations'
      },
      {
        label: 'Apply → Export',
        value: mockGrowthMetrics.funnel.applyToExport,
        change: 0.025,
        changeLabel: 'vs last week',
        trend: 'up',
        description: 'Users who export after applying'
      },
      {
        label: 'Overall Conversion',
        value: mockGrowthMetrics.funnel.overallConversion,
        change: 0.012,
        changeLabel: 'vs last week',
        trend: 'up',
        description: 'Import to export conversion'
      },
    ]);

    container.innerHTML = funnelCards;

  } catch (error) {
    console.error('Failed to load growth metrics:', error);
    container.innerHTML = `
      <div class="error-message">
        Failed to load funnel metrics. Please refresh the page.
      </div>
    `;
  }
}

// Real-time updates
function initGrowthRealtimeUpdates(): void {
  const realtime = new RealtimeManager('/api/analytics/live/updates');
  
  realtime.connect();
  
  // Subscribe to specific updates
  realtime.subscribe('currentFunnelStep', (data) => {
    updateFunnelChart(data as Record<string, number>);
  });

  realtime.subscribe('conversionRate24h', (data) => {
    updateConversionMetrics(data as number);
  });
}

function updateFunnelChart(data: Record<string, number>): void {
  // Update funnel visualization with real-time data
  console.log('Updating funnel chart:', data);
}

function updateConversionMetrics(rate: number): void {
  // Update overall conversion rate display
  const rateElement = document.querySelector('[data-metric="overallConversion"]');
  if (rateElement) {
    rateElement.textContent = `${(rate * 100).toFixed(1)}%`;
  }
}

// Chart initialization
function initGrowthCharts(): void {
  initFunnelChart();
  initSessionDurationChart();
  initRecommendationsChart();
  initRepeatUsageChart();
  initCohortHeatmap();
  initTimeToFirstRecChart();
  initFeatureAdoptionChart();
}

function initFunnelChart(): void {
  console.log('Initializing funnel chart...');
}

function initSessionDurationChart(): void {
  console.log('Initializing session duration chart...');
}

function initRecommendationsChart(): void {
  console.log('Initializing recommendations chart...');
}

function initRepeatUsageChart(): void {
  console.log('Initializing repeat usage chart...');
}

function initCohortHeatmap(): void {
  console.log('Initializing cohort heatmap...');
}

function initTimeToFirstRecChart(): void {
  console.log('Initializing time to first recommendation chart...');
}

function initFeatureAdoptionChart(): void {
  console.log('Initializing feature adoption chart...');
}

// Insights generation
async function loadGrowthInsights(): Promise<void> {
  const container = document.getElementById('growthInsights');
  if (!container) return;

  try {
    const insights = [
      createAlertBanner(
        'warning',
        'Drop in Analysis → Apply Conversion',
        'The conversion from analysis to recommendation application has decreased by 1.8% this week. Consider reviewing the recommendation UI.',
        [
          { label: 'View User Flows', action: 'view-user-flows' },
          { label: 'Run A/B Test', action: 'start-ab-test' }
        ]
      ),
      createAlertBanner(
        'success',
        'Improving Funnel Entry',
        'Import to analysis conversion is up 3.2%, indicating smoother onboarding experience.',
        [
          { label: 'View Onboarding Metrics', action: 'view-onboarding' }
        ]
      ),
    ];

    container.innerHTML = insights.join('');

  } catch (error) {
    console.error('Failed to load growth insights:', error);
    container.innerHTML = '<div class="error-message">Unable to load insights.</div>';
  }
}

// Navigation helper
function createGrowthNavigation(): string {
  return `
    <div class="dashboard-navigation">
      <div class="nav-header">
        <h1>Growth Dashboard</h1>
        <div class="nav-actions">
          <select id="timeRangeSelector" class="time-range-selector">
            <option value="7">Last 7 days</option>
            <option value="30" selected>Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
          <button class="hand-btn secondary" data-action="create-segment">
            Create Segment
          </button>
          <button class="hand-btn secondary" data-action="export-funnel-data">
            Export Data
          </button>
        </div>
      </div>
    </div>
  `;
}