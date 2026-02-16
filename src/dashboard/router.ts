// ==================== Dashboard Router ====================
// Handles navigation between different dashboard views

export enum DashboardView {
  EXECUTIVE = 'executive',
  GROWTH = 'growth',
  TECHNICAL = 'technical',
  COMMUNITY = 'community',
  PUBLIC = 'public',
}

export interface DashboardRoute {
  view: DashboardView;
  title: string;
  description: string;
  accessLevel: 'public' | 'internal' | 'admin';
}

export const DASHBOARD_ROUTES: Record<DashboardView, DashboardRoute> = {
  [DashboardView.EXECUTIVE]: {
    view: DashboardView.EXECUTIVE,
    title: 'Executive Dashboard',
    description: 'High-level business metrics and strategic KPIs',
    accessLevel: 'internal',
  },
  [DashboardView.GROWTH]: {
    view: DashboardView.GROWTH,
    title: 'Growth Dashboard',
    description: 'Product metrics, funnel analysis, and user engagement',
    accessLevel: 'internal',
  },
  [DashboardView.TECHNICAL]: {
    view: DashboardView.TECHNICAL,
    title: 'Technical Dashboard',
    description: 'System performance, infrastructure health, and quality metrics',
    accessLevel: 'internal',
  },
  [DashboardView.COMMUNITY]: {
    view: DashboardView.COMMUNITY,
    title: 'Community Dashboard',
    description: 'User feedback, sentiment analysis, and support metrics',
    accessLevel: 'internal',
  },
  [DashboardView.PUBLIC]: {
    view: DashboardView.PUBLIC,
    title: 'Public Dashboard',
    description: 'Aggregated metrics and transparency data',
    accessLevel: 'public',
  },
};

export class DashboardRouter {
  private currentView: DashboardView | null = null;
  private container: HTMLElement | null = null;
  private onRouteChange: ((view: DashboardView) => void) | null = null;

  constructor(containerId: string, onRouteChange?: (view: DashboardView) => void) {
    this.container = document.getElementById(containerId);
    this.onRouteChange = onRouteChange || null;
    this.init();
  }

  private init(): void {
    if (!this.container) {
      console.error('Dashboard container not found');
      return;
    }

    // Handle browser navigation
    window.addEventListener('popstate', (event) => {
      const view = this.getViewFromPath();
      if (view) {
        this.renderView(view);
      }
    });

    // Handle initial route
    const initialView = this.getViewFromPath() || DashboardView.EXECUTIVE;
    this.renderView(initialView);
  }

  private getViewFromPath(): DashboardView | null {
    const path = window.location.pathname;
    const match = path.match(/\/dashboard\/([a-z]+)/);
    if (match && match[1]) {
      const viewName = match[1].toUpperCase();
      if (Object.values(DashboardView).includes(viewName as DashboardView)) {
        return viewName as DashboardView;
      }
    }
    return null;
  }

  private updateURL(view: DashboardView): void {
    const url = `/dashboard/${view}`;
    const state = { view };
    window.history.pushState(state, '', url);
  }

  public navigate(view: DashboardView, params?: Record<string, string>): void {
    this.updateURL(view);
    this.renderView(view, params);
  }

  public getCurrentView(): DashboardView | null {
    return this.currentView;
  }

  private async renderView(view: DashboardView, params?: Record<string, string>): Promise<void> {
    if (!this.container) return;

    this.currentView = view;
    
    // Show loading state
    this.container.innerHTML = `
      <div class="dashboard-loading">
        <div class="loading-spinner"></div>
        <p>Loading ${DASHBOARD_ROUTES[view].title}...</p>
      </div>
    `;

    try {
      // Import and render the appropriate dashboard component
      const component = await this.importDashboardComponent(view);
      const renderFn = (component as any).renderDashboard || 
                       (component as any).renderExecutiveDashboard ||
                       (component as any).renderGrowthDashboard ||
                       (component as any).renderTechnicalDashboard ||
                       (component as any).renderCommunityDashboard ||
                       (component as any).renderPublicDashboard;

      if (!renderFn) {
        throw new Error(`No render function found for ${view} dashboard`);
      }

      const dashboardHTML = await renderFn(params);
      this.container.innerHTML = dashboardHTML;

      // Trigger route change callback
      if (this.onRouteChange) {
        this.onRouteChange(view);
      }

    } catch (error) {
      console.error(`Failed to load ${view} dashboard:`, error);
      this.container.innerHTML = `
        <div class="dashboard-error">
          <h3>Failed to Load Dashboard</h3>
          <p>Could not load the ${DASHBOARD_ROUTES[view].title}. Please try again.</p>
          <button class="hand-btn primary" onclick="window.location.reload()">Reload</button>
        </div>
      `;
    }
  }

  private async importDashboardComponent(view: DashboardView): Promise<any> {
    switch (view) {
      case DashboardView.EXECUTIVE:
        return import('./components/executive-dashboard.js');
      case DashboardView.GROWTH:
        return import('./components/growth-dashboard.js');
      case DashboardView.TECHNICAL:
        return import('./components/technical-dashboard.js');
      case DashboardView.COMMUNITY:
        return import('./components/community-dashboard.js');
      case DashboardView.PUBLIC:
        return import('./components/public-dashboard.js');
      default:
        throw new Error(`Unknown dashboard view: ${view}`);
    }
  }
}

// Navigation helper
export function createDashboardNavigation(currentView: DashboardView): string {
  return `
    <nav class="dashboard-navigation">
      <div class="nav-header">
        <h2>DeckLens Dashboard</h2>
        <select id="dashboardTimeRange" class="time-range-selector">
          <option value="7">Last 7 days</option>
          <option value="30" selected>Last 30 days</option>
          <option value="90">Last 90 days</option>
        </select>
      </div>
      <ul class="nav-tabs">
        ${Object.values(DashboardView)
          .filter(view => DASHBOARD_ROUTES[view].accessLevel !== 'admin') // Hide admin-only tabs
          .map(view => `
            <li>
              <button 
                class="nav-tab ${view === currentView ? 'active' : ''}"
                data-action="navigate-dashboard" 
                data-view="${view}"
              >
                ${DASHBOARD_ROUTES[view].title}
              </button>
            </li>
          `).join('')}
      </ul>
    </nav>
  `;
}