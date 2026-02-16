// ==================== Executive Dashboard ====================
// High-level business metrics and strategic KPIs for stakeholders

// Define BusinessMetrics interface inline for now
interface BusinessMetrics {
  revenue: {
    today: number;
    mtd: number;
    growthRate: number;
  };
  users: {
    total: number;
    active: number;
    paying: number;
    churnRate: number;
  };
  product: {
    activationRate: number;
    retention7d: number;
    arpu: number;
    ltv: number;
  };
}
import { createKPICard, createKPICardGrid, createChartContainer, createTableContainer, createAlertBanner, createLoadingSpinner, RealtimeManager } from './shared/dashboard-components.js';

export async function renderExecutiveDashboard(params?: Record<string, string>): Promise<string> {
  const timeRange = parseInt(params?.timeRange || '30');
  
  return `
    <div class="executive-dashboard">
      ${createDashboardNavigation()}
      
      <!-- Key Performance Indicators -->
      <section class="dashboard-section">
        <h2>Executive Overview</h2>
        <div id="executiveKPIs">
          ${createLoadingSpinner('Loading business metrics...')}
        </div>
      </section>

      <!-- Revenue Analytics -->
      <section class="dashboard-section">
        <h2>Revenue Analytics</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-2">
            ${createChartContainer('Revenue Trend', 'revenueChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Revenue Breakdown', 'revenueBreakdownChart', 'pie')}
          </div>
        </div>
      </section>

      <!-- User Analytics -->
      <section class="dashboard-section">
        <h2>User Analytics</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('User Growth', 'userGrowthChart', 'line')}
          </div>
          <div class="dashboard-col-2">
            ${createTableContainer(
              'Cohort Analysis',
              'cohortTable',
              [
                { key: 'cohort', label: 'Cohort' },
                { key: 'size', label: 'Size' },
                { key: 'day1', label: 'Day 1', format: (v) => `${(v as number * 100).toFixed(1)}%` },
                { key: 'day7', label: 'Day 7', format: (v) => `${(v as number * 100).toFixed(1)}%` },
                { key: 'day30', label: 'Day 30', format: (v) => `${(v as number * 100).toFixed(1)}%` },
              ],
              []
            )}
          </div>
        </div>
      </section>

      <!-- Product Performance -->
      <section class="dashboard-section">
        <h2>Product Performance</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('Activation Rate', 'activationRateChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Retention Trends', 'retentionChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('ARPU & LTV', 'monetizationChart', 'line')}
          </div>
        </div>
      </section>

      <!-- Alerts & Insights -->
      <section class="dashboard-section">
        <h2>Strategic Insights</h2>
        <div id="executiveAlerts">
          ${createLoadingSpinner('Analyzing insights...')}
        </div>
      </section>

      <!-- Real-time Status -->
      <section class="dashboard-section">
        <h2>Live Status</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createKPICard({
              label: 'Current Active Users',
              value: '---',
              description: 'Users active in the last 5 minutes'
            })}
          </div>
          <div class="dashboard-col-1">
            ${createKPICard({
              label: 'Revenue Today',
              value: '---',
              description: 'Total revenue generated today'
            })}
          </div>
          <div class="dashboard-col-1">
            ${createKPICard({
              label: 'Conversion Rate (24h)',
              value: '---',
              description: 'Import to recommendation conversion'
            })}
          </div>
        </div>
      </section>
    </div>
  `;
}

export function initExecutiveDashboard(): void {
  loadExecutiveKPIs();
  initRealtimeUpdates();
  initExecutiveCharts();
}

// Data loading functions
async function loadExecutiveKPIs(): Promise<void> {
  const container = document.getElementById('executiveKPIs');
  if (!container) return;

  try {
    // In real implementation, these would be API calls
    const mockKPIs: BusinessMetrics = {
      revenue: {
        today: 1247,
        mtd: 18750,
        growthRate: 0.083,
      },
      users: {
        total: 8543,
        active: 2341,
        paying: 428,
        churnRate: 0.042,
      },
      product: {
        activationRate: 0.67,
        retention7d: 0.43,
        arpu: 15.23,
        ltv: 182.76,
      },
    };

    const kpiCards = createKPICardGrid([
      {
        label: 'Revenue Today',
        value: mockKPIs.revenue.today,
        change: mockKPIs.revenue.growthRate,
        changeLabel: 'vs yesterday',
        trend: mockKPIs.revenue.growthRate > 0 ? 'up' : 'down',
        description: `MTD: $${(mockKPIs.revenue.mtd / 100).toFixed(0)}`
      },
      {
        label: 'Active Users',
        value: mockKPIs.users.active,
        change: 0.125,
        changeLabel: 'vs last week',
        trend: 'up',
        description: `Total: ${mockKPIs.users.total.toLocaleString()}`
      },
      {
        label: 'Paying Users',
        value: mockKPIs.users.paying,
        change: 0.058,
        changeLabel: 'vs last week',
        trend: 'up',
        description: `Conversion: ${(mockKPIs.users.paying / mockKPIs.users.active * 100).toFixed(1)}%`
      },
      {
        label: 'ARPU',
        value: `$${mockKPIs.product.arpu.toFixed(2)}`,
        change: 0.042,
        changeLabel: 'vs last month',
        trend: 'up',
        description: `LTV: $${mockKPIs.product.ltv.toFixed(0)}`
      },
      {
        label: 'Activation Rate',
        value: mockKPIs.product.activationRate,
        change: -0.021,
        changeLabel: 'vs last week',
        trend: 'down',
        description: 'Import to analysis conversion'
      },
      {
        label: '7-Day Retention',
        value: mockKPIs.product.retention7d,
        change: 0.035,
        changeLabel: 'vs last week',
        trend: 'up',
        description: 'Day 7 retention rate'
      },
    ]);

    container.innerHTML = kpiCards;

  } catch (error) {
    console.error('Failed to load executive KPIs:', error);
    container.innerHTML = `
      <div class="error-message">
        Failed to load KPIs. Please refresh the page.
      </div>
    `;
  }
}

// Real-time updates
function initRealtimeUpdates(): void {
  const realtime = new RealtimeManager('/api/analytics/live/updates');
  
  realtime.connect();
  
  // Subscribe to specific updates
  realtime.subscribe('activeSessions', (data) => {
    const activeUsersElement = document.querySelector('[data-kpi="activeUsers"] .kpi-value');
    if (activeUsersElement) {
      activeUsersElement.textContent = String(data);
    }
  });

  realtime.subscribe('revenueToday', (data) => {
    const revenueElement = document.querySelector('[data-kpi="revenueToday"] .kpi-value');
    if (revenueElement) {
      revenueElement.textContent = `$${(data as number / 100).toFixed(2)}`;
    }
  });

  realtime.subscribe('conversionRate24h', (data) => {
    const conversionElement = document.querySelector('[data-kpi="conversionRate24h"] .kpi-value');
    if (conversionElement) {
      conversionElement.textContent = `${(data as number * 100).toFixed(1)}%`;
    }
  });
}

// Chart initialization
function initExecutiveCharts(): void {
  // Revenue Chart
  initRevenueChart();
  // User Growth Chart
  initUserGrowthChart();
  // Activation Rate Chart
  initActivationRateChart();
  // Retention Chart
  initRetentionChart();
  // Monetization Chart
  initMonetizationChart();
}

function initRevenueChart(): void {
  // Placeholder for chart implementation
  // Would use Chart.js or similar library
  console.log('Initializing revenue chart...');
}

function initUserGrowthChart(): void {
  console.log('Initializing user growth chart...');
}

function initActivationRateChart(): void {
  console.log('Initializing activation rate chart...');
}

function initRetentionChart(): void {
  console.log('Initializing retention chart...');
}

function initMonetizationChart(): void {
  console.log('Initializing monetization chart...');
}

// Insights generation
async function loadExecutiveAlerts(): Promise<void> {
  const container = document.getElementById('executiveAlerts');
  if (!container) return;

  try {
    // Placeholder insights generation
    const alerts = [
      createAlertBanner(
        'warning',
        'Declining Activation Rate',
        'The activation rate has decreased by 2.1% this week. This may indicate onboarding friction.',
        [
          { label: 'View Funnel', action: 'navigate-to-growth-dashboard' },
          { label: 'Investigate', action: 'investigate-activation-decline' }
        ]
      ),
      createAlertBanner(
        'success',
        'Revenue Growth',
        'Monthly recurring revenue has increased by 8.3% compared to last month.',
        [
          { label: 'View Details', action: 'view-revenue-details' }
        ]
      ),
    ];

    container.innerHTML = alerts.join('');

  } catch (error) {
    console.error('Failed to load executive alerts:', error);
    container.innerHTML = '<div class="error-message">Unable to load insights.</div>';
  }
}

// Navigation helper
function createDashboardNavigation(): string {
  return `
    <div class="dashboard-navigation">
      <div class="nav-header">
        <h1>Executive Dashboard</h1>
        <div class="nav-actions">
          <select id="timeRangeSelector" class="time-range-selector">
            <option value="7">Last 7 days</option>
            <option value="30" selected>Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
          <button class="hand-btn secondary" data-action="export-report">
            Export Report
          </button>
        </div>
      </div>
    </div>
  `;
}