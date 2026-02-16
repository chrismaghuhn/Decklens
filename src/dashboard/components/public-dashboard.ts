// ==================== Public Dashboard ====================
// Aggregated metrics and transparency data for public viewing

import { createKPICard, createKPICardGrid, createChartContainer, createTableContainer, createAlertBanner, createLoadingSpinner } from './shared/dashboard-components.js';

interface PublicSummary {
  totalDecks: number;
  activeUsers: number;
  recommendationsGiven: number;
  satisfaction: {
    averageRating: number;
    totalReviews: number;
  };
  uptime: {
    percentage: number;
    lastWeek: number;
  };
  growth: {
    newUsersThisMonth: number;
    growthRatePercent: number;
  };
}

export async function renderPublicDashboard(params?: Record<string, string>): Promise<string> {
  return `
    <div class="public-dashboard">
      ${createPublicNavigation()}
      
      <!-- Hero Section -->
      <section class="dashboard-hero">
        <div class="hero-content">
          <h1>DeckLens Public Dashboard</h1>
          <p>Transparent insights into the DeckLens ecosystem performance and community growth.</p>
          <div class="hero-stats">
            <div class="hero-stat">
              <span class="stat-value" id="totalDecksCount">---</span>
              <span class="stat-label">Total Decks</span>
            </div>
            <div class="hero-stat">
              <span class="stat-value" id="activeUsersCount">---</span>
              <span class="stat-label">Active Users</span>
            </div>
            <div class="hero-stat">
              <span class="stat-value" id="recommendationsCount">---</span>
              <span class="stat-label">Recommendations</span>
            </div>
          </div>
        </div>
      </section>

      <!-- Platform Overview -->
      <section class="dashboard-section">
        <h2>Platform Overview</h2>
        <div id="publicKPIs">
          ${createLoadingSpinner('Loading platform metrics...')}
        </div>
      </section>

      <!-- Growth Metrics -->
      <section class="dashboard-section">
        <h2>Growth & Adoption</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-2">
            ${createChartContainer('User Growth', 'publicUserGrowthChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Platform Adoption', 'platformAdoptionChart', 'pie')}
          </div>
        </div>
      </section>

      <!-- Performance & Reliability -->
      <section class="dashboard-section">
        <h2>Performance & Reliability</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('Uptime History', 'uptimeHistoryChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createKPICard({
              label: 'Current Uptime',
              value: '---',
              change: 0.001,
              changeLabel: 'vs last week',
              trend: 'up',
              description: 'Last 30 days average'
            })}
          </div>
          <div class="dashboard-col-1">
            ${createKPICard({
              label: 'Average Response Time',
              value: '---',
              change: -0.045,
              changeLabel: 'vs last week',
              trend: 'up',
              description: 'API response time'
            })}
          </div>
        </div>
      </section>

      <!-- Community Satisfaction -->
      <section class="dashboard-section">
        <h2>Community Satisfaction</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-1">
            ${createChartContainer('User Satisfaction', 'satisfactionChart', 'line')}
          </div>
          <div class="dashboard-col-1">
            ${createChartContainer('Rating Distribution', 'publicRatingChart', 'bar')}
          </div>
          <div class="dashboard-col-1">
            ${createKPICard({
              label: 'Average Rating',
              value: '---',
              change: 0.034,
              changeLabel: 'vs last month',
              trend: 'up',
              description: `From ${new Date().toLocaleString()}`
            })}
          </div>
        </div>
      </section>

      <!-- Recent Activity -->
      <section class="dashboard-section">
        <h2>Recent Platform Activity</h2>
        <div class="dashboard-row">
          <div class="dashboard-col-2">
            ${createTableContainer(
              'Recent Milestones',
              'milestonesTable',
              [
                { key: 'date', label: 'Date' },
                { key: 'milestone', label: 'Milestone' },
                { key: 'impact', label: 'Impact' }
              ],
              [
                { date: '2025-02-08', milestone: '10K Recommendations', impact: 'High' },
                { date: '2025-02-05', milestone: '1K Active Users', impact: 'Medium' },
                { date: '2025-02-01', milestone: '99.9% Uptime', impact: 'High' },
              ]
            )}
          </div>
          <div class="dashboard-col-1">
            ${createKPICard({
              label: 'Monthly Growth Rate',
              value: '---',
              change: 0.082,
              changeLabel: 'vs last month',
              trend: 'up',
              description: 'User acquisition rate'
            })}
          </div>
        </div>
      </section>

      <!-- Transparency Notice -->
      <section class="dashboard-section">
        <div class="transparency-notice">
          <h3>📊 About This Dashboard</h3>
          <p>
            This dashboard provides transparent insights into DeckLens platform performance and community growth. 
            Data is updated hourly and represents aggregated, anonymized metrics to protect user privacy.
          </p>
          <div class="transparency-links">
            <a href="/privacy" class="link">Privacy Policy</a>
            <a href="/api-documentation" class="link">API Documentation</a>
            <a href="/methodology" class="link">Methodology</a>
          </div>
        </div>
      </section>
    </div>
  `;
}

export function initPublicDashboard(): void {
  loadPublicMetrics();
  initPublicCharts();
  animateHeroStats();
}

async function loadPublicMetrics(): Promise<void> {
  const container = document.getElementById('publicKPIs');
  if (!container) return;

  try {
    const mockPublicSummary: PublicSummary = {
      totalDecks: 12567,
      activeUsers: 3421,
      recommendationsGiven: 87342,
      satisfaction: {
        averageRating: 4.2,
        totalReviews: 156,
      },
      uptime: {
        percentage: 99.7,
        lastWeek: 99.9,
      },
      growth: {
        newUsersThisMonth: 456,
        growthRatePercent: 8.2,
      },
    };

    const publicCards = createKPICardGrid([
      {
        label: 'Total Decks Analyzed',
        value: mockPublicSummary.totalDecks.toLocaleString(),
        change: 0.127,
        changeLabel: 'vs last month',
        trend: 'up',
        description: 'Unique decks processed'
      },
      {
        label: 'Active Community',
        value: mockPublicSummary.activeUsers.toLocaleString(),
        change: 0.082,
        changeLabel: 'vs last month',
        trend: 'up',
        description: 'Monthly active users'
      },
      {
        label: 'Recommendations Delivered',
        value: mockPublicSummary.recommendationsGiven.toLocaleString(),
        change: 0.156,
        changeLabel: 'vs last month',
        trend: 'up',
        description: 'Total recommendations made'
      },
      {
        label: 'User Satisfaction',
        value: `${mockPublicSummary.satisfaction.averageRating.toFixed(1)}/5.0`,
        change: 0.034,
        changeLabel: 'vs last month',
        trend: 'up',
        description: `${mockPublicSummary.satisfaction.totalReviews} reviews`
      },
      {
        label: 'Platform Uptime',
        value: `${mockPublicSummary.uptime.percentage.toFixed(1)}%`,
        change: 0.001,
        changeLabel: 'vs last week',
        trend: 'up',
        description: 'Last 30 days'
      },
      {
        label: 'Growth Rate',
        value: `${mockPublicSummary.growth.growthRatePercent.toFixed(1)}%`,
        change: 0.023,
        changeLabel: 'vs last month',
        trend: 'up',
        description: `${mockPublicSummary.growth.newUsersThisMonth} new users`
      },
    ]);

    container.innerHTML = publicCards;

  } catch (error) {
    console.error('Failed to load public metrics:', error);
    container.innerHTML = `
      <div class="error-message">
        Failed to load platform metrics. Please refresh the page.
      </div>
    `;
  }
}

function initPublicCharts(): void {
  initPublicUserGrowthChart();
  initPlatformAdoptionChart();
  initUptimeHistoryChart();
  initSatisfactionChart();
  initPublicRatingChart();
}

function initPublicUserGrowthChart(): void {
  console.log('Initializing public user growth chart...');
}

function initPlatformAdoptionChart(): void {
  console.log('Initializing platform adoption chart...');
}

function initUptimeHistoryChart(): void {
  console.log('Initializing uptime history chart...');
}

function initSatisfactionChart(): void {
  console.log('Initializing satisfaction chart...');
}

function initPublicRatingChart(): void {
  console.log('Initializing public rating chart...');
}

function animateHeroStats(): void {
  const animateValue = (element: HTMLElement | null, target: number, suffix: string = ''): void => {
    if (!element) return;
    
    const duration = 2000; // 2 seconds
    const start = 0;
    const increment = target / (duration / 16); // 60fps
    let current = start;
    
    const timer = setInterval(() => {
      current += increment;
      if (current >= target) {
        current = target;
        clearInterval(timer);
      }
      
      if (current >= 1000) {
        element.textContent = `${(current / 1000).toFixed(1)}K${suffix}`;
      } else {
        element.textContent = `${Math.floor(current).toLocaleString()}${suffix}`;
      }
    }, 16);
  };

  // Simulate loading actual values
  setTimeout(() => {
    animateValue(document.getElementById('totalDecksCount'), 12567);
    animateValue(document.getElementById('activeUsersCount'), 3421);
    animateValue(document.getElementById('recommendationsCount'), 87342);
  }, 500);
}

function createPublicNavigation(): string {
  return `
    <div class="dashboard-navigation public-nav">
      <div class="nav-header">
        <h1>DeckLens Public Dashboard</h1>
        <div class="nav-actions">
          <button class="hand-btn secondary" data-action="embed-dashboard">
            📊 Embed
          </button>
          <button class="hand-btn secondary" data-action="download-data">
            📥 Download Data
          </button>
          <button class="hand-btn primary" data-action="try-decklens">
            🚀 Try DeckLens
          </button>
        </div>
      </div>
      <div class="nav-description">
        <p>Transparent metrics for the DeckLens community and stakeholders</p>
      </div>
    </div>
  `;
}