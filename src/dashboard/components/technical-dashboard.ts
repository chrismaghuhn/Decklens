// ==================== Technical Dashboard ====================
// System performance, infrastructure health, and quality metrics for engineering teams

import { createKPICard, createKPICardGrid, createChartContainer, createTableContainer, createAlertBanner, createLoadingSpinner, RealtimeManager } from './shared/dashboard-components.js';

interface TechnicalMetrics {
  performance: {
    apiLatencyP50: number;
    apiLatencyP95: number;
    errorRate: number;
    uptime: number;
  };
  infrastructure: {
    activeWorkers: number;
    memoryUsage: number;
    dbConnections: number;
    cacheHitRate: number;
  };
  quality: {
    recommendationAccuracy: number;
    systemHealth: 'healthy' | 'degraded' | 'critical';
    alertCount: number;
  };
}

export async function renderTechnicalDashboard(params?: Record<string, string>): Promise<string> {
  return `
    <div class="technical-dashboard">
      ${createTechnicalNavigation()}
      
      <!-- System Health Overview -->
      <section class="dashboard-section">
        <h2>System Health</h2>
        <div id="systemHealthKPIs">
          ${createLoadingSpinner('Loading system metrics...')}
        </div>
      </section>

      <!-- Performance Metrics -->
      <section class="dashboard-section">
        <h2>Performance</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-2">
            ${createChartContainer('API Latency Trends', 'apiLatencyChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Error Rate', 'errorRateChart', 'line')}
          </div>
        </div>
      </section>

      <!-- Infrastructure -->
      <section class="dashboard-section">
        <h2>Infrastructure</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('Memory Usage', 'memoryChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Database Connections', 'dbConnectionChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Cache Hit Rate', 'cacheHitChart', 'line')}
          </div>
        </div>
      </section>

      <!-- Quality & Reliability -->
      <section class="dashboard-section">
        <h2>Quality & Reliability</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('Recommendation Accuracy', 'accuracyChart', 'line')}
          </div>
          <div class="dashboard-col-2">
            ${createTableContainer(
              'Recent Alerts',
              'alertsTable',
              [
                { key: 'timestamp', label: 'Time' },
                { key: 'severity', label: 'Severity' },
                { key: 'service', label: 'Service' },
                { key: 'message', label: 'Message' },
                { key: 'status', label: 'Status' }
              ],
              []
            )}
          </div>
        </div>
      </section>

      <!-- System Alerts -->
      <section class="dashboard-section">
        <h2>Active Alerts</h2>
        <div id="technicalAlerts">
          ${createLoadingSpinner('Checking system alerts...')}
        </div>
      </section>

      <!-- Service Dependencies -->
      <section class="dashboard-section">
        <h2>Service Dependencies</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-2">
            ${createTableContainer(
              'Service Status',
              'serviceStatusTable',
              [
                { key: 'service', label: 'Service' },
                { key: 'status', label: 'Status' },
                { key: 'responseTime', label: 'Response Time' },
                { key: 'lastCheck', label: 'Last Check' }
              ],
              []
            )}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Dependency Health', 'dependencyChart', 'pie')}
          </div>
        </div>
      </section>
    </div>
  `;
}

export function initTechnicalDashboard(): void {
  loadTechnicalMetrics();
  initTechnicalRealtimeUpdates();
  initTechnicalCharts();
}

async function loadTechnicalMetrics(): Promise<void> {
  const container = document.getElementById('systemHealthKPIs');
  if (!container) return;

  try {
    const mockTechnicalMetrics: TechnicalMetrics = {
      performance: {
        apiLatencyP50: 124,
        apiLatencyP95: 289,
        errorRate: 0.008,
        uptime: 0.997,
      },
      infrastructure: {
        activeWorkers: 3,
        memoryUsage: 67.3,
        dbConnections: 12,
        cacheHitRate: 0.892,
      },
      quality: {
        recommendationAccuracy: 0.842,
        systemHealth: 'healthy',
        alertCount: 3,
      },
    };

    const kpiCards = createKPICardGrid([
      {
        label: 'API Latency (p50)',
        value: `${mockTechnicalMetrics.performance.apiLatencyP50}ms`,
        change: -0.053,
        changeLabel: 'vs last hour',
        trend: 'up', // lower is better
        description: `p95: ${mockTechnicalMetrics.performance.apiLatencyP95}ms`
      },
      {
        label: 'Error Rate',
        value: `${(mockTechnicalMetrics.performance.errorRate * 100).toFixed(2)}%`,
        change: -0.021,
        changeLabel: 'vs last hour',
        trend: 'up',
        description: 'HTTP 5xx errors'
      },
      {
        label: 'Uptime',
        value: `${(mockTechnicalMetrics.performance.uptime * 100).toFixed(2)}%`,
        change: 0.001,
        changeLabel: 'vs last hour',
        trend: 'up',
        description: 'Last 24 hours'
      },
      {
        label: 'System Health',
        value: mockTechnicalMetrics.quality.systemHealth,
        trend: 'up',
        description: `${mockTechnicalMetrics.quality.alertCount} active alerts`
      },
      {
        label: 'Memory Usage',
        value: `${mockTechnicalMetrics.infrastructure.memoryUsage.toFixed(1)}%`,
        change: 0.032,
        changeLabel: 'vs last hour',
        trend: 'down',
        description: 'Workers memory utilization'
      },
      {
        label: 'Cache Hit Rate',
        value: `${(mockTechnicalMetrics.infrastructure.cacheHitRate * 100).toFixed(1)}%`,
        change: 0.018,
        changeLabel: 'vs last hour',
        trend: 'up',
        description: 'Redis cache performance'
      },
    ]);

    container.innerHTML = kpiCards;

  } catch (error) {
    console.error('Failed to load technical metrics:', error);
    container.innerHTML = `
      <div class="error-message">
        Failed to load system metrics. Please refresh the page.
      </div>
    `;
  }
}

function initTechnicalRealtimeUpdates(): void {
  const realtime = new RealtimeManager('/api/analytics/live/updates');
  
  realtime.connect();
  
  realtime.subscribe('apiLatencyMs', (data) => {
    updateLatencyMetrics(data as number);
  });

  realtime.subscribe('errorRatePercent', (data) => {
    updateErrorRate(data as number);
  });

  realtime.subscribe('activeSessions', (data) => {
    updateSystemLoad(data as number);
  });
}

function updateLatencyMetrics(latency: number): void {
  const latencyElement = document.querySelector('[data-metric="apiLatency"]');
  if (latencyElement) {
    latencyElement.textContent = `${latency}ms`;
  }
}

function updateErrorRate(rate: number): void {
  const errorRateElement = document.querySelector('[data-metric="errorRate"]');
  if (errorRateElement) {
    errorRateElement.textContent = `${(rate * 100).toFixed(2)}%`;
  }
}

function updateSystemLoad(sessions: number): void {
  const loadElement = document.querySelector('[data-metric="systemLoad"]');
  if (loadElement) {
    const loadPercent = Math.min((sessions / 100) * 100, 100);
    loadElement.textContent = `${loadPercent.toFixed(1)}%`;
  }
}

function initTechnicalCharts(): void {
  initAPILatencyChart();
  initErrorRateChart();
  initMemoryChart();
  initDBConnectionChart();
  initCacheHitChart();
  initAccuracyChart();
  initDependencyChart();
}

function initAPILatencyChart(): void {
  console.log('Initializing API latency chart...');
}

function initErrorRateChart(): void {
  console.log('Initializing error rate chart...');
}

function initMemoryChart(): void {
  console.log('Initializing memory chart...');
}

function initDBConnectionChart(): void {
  console.log('Initializing DB connection chart...');
}

function initCacheHitChart(): void {
  console.log('Initializing cache hit chart...');
}

function initAccuracyChart(): void {
  console.log('Initializing accuracy chart...');
}

function initDependencyChart(): void {
  console.log('Initializing dependency chart...');
}

async function loadTechnicalAlerts(): Promise<void> {
  const container = document.getElementById('technicalAlerts');
  if (!container) return;

  try {
    const mockAlerts = [
      createAlertBanner(
        'warning',
        'High Memory Usage',
        'Worker memory usage is at 82%, approaching threshold.',
        [
          { label: 'Investigate', action: 'investigate-memory' },
          { label: 'Scale', action: 'scale-workers' }
        ]
      ),
      createAlertBanner(
        'info',
        'Cache Performance Degraded',
        'Cache hit rate dropped to 76% in the last hour.',
        [
          { label: 'Clear Cache', action: 'clear-cache' },
          { label: 'Investigate', action: 'investigate-cache' }
        ]
      ),
    ];

    container.innerHTML = mockAlerts.join('');

  } catch (error) {
    console.error('Failed to load technical alerts:', error);
    container.innerHTML = '<div class="error-message">Unable to load alerts.</div>';
  }
}

function createTechnicalNavigation(): string {
  return `
    <div class="dashboard-navigation">
      <div class="nav-header">
        <h1>Technical Dashboard</h1>
        <div class="nav-actions">
          <button class="hand-btn secondary" data-action="refresh-metrics">
            Refresh
          </button>
          <button class="hand-btn secondary" data-action="view-logs">
            View Logs
          </button>
          <button class="hand-btn secondary" data-action="system-commands">
            System Commands
          </button>
        </div>
      </div>
    </div>
  `;
}