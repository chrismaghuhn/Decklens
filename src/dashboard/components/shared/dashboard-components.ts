// ==================== Shared Dashboard Components ====================
// Reusable UI components for all dashboard views

import { h } from '../../../shared/dom.js';

export interface KPIData {
  label: string;
  value: string | number;
  change?: number;
  changeLabel?: string;
  trend?: 'up' | 'down' | 'flat';
  description?: string;
}

export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    color?: string;
    fill?: boolean;
  }>;
}

export function createKPICard(data: KPIData): string {
  const trendIcon = data.trend ? getTrendIcon(data.trend) : '';
  const changeDisplay = data.change !== undefined ? formatChange(data.change) : '';
  const trendClass = data.trend ? `trend-${data.trend}` : '';

  return `
    <div class="kpi-card">
      <div class="kpi-header">
        <span class="kpi-label">${data.label}</span>
        ${trendIcon ? `<span class="kpi-trend ${trendClass}">${trendIcon}</span>` : ''}
      </div>
      <div class="kpi-value">${formatValue(data.value)}</div>
      <div class="kpi-change">
        ${changeDisplay ? `<span class="change ${trendClass}">${changeDisplay}</span>` : ''}
        ${data.changeLabel ? `<span class="change-label">${data.changeLabel}</span>` : ''}
      </div>
      ${data.description ? `<div class="kpi-description">${data.description}</div>` : ''}
    </div>
  `;
}

export function createKPICardGrid(kpis: KPIData[]): string {
  return `
    <div class="kpi-grid">
      ${kpis.map(kpi => createKPICard(kpi)).join('')}
    </div>
  `;
}

export function createChartContainer(
  title: string,
  chartId: string,
  type: 'line' | 'bar' | 'pie' | 'funnel' = 'line',
  data?: ChartData,
  options?: Record<string, unknown>
): string {
  return `
    <div class="chart-container">
      <div class="chart-header">
        <h3 class="chart-title">${title}</h3>
        <div class="chart-controls">
          <select class="chart-period" data-chart="${chartId}">
            <option value="7">7 days</option>
            <option value="30" selected>30 days</option>
            <option value="90">90 days</option>
          </select>
        </div>
      </div>
      <div class="chart-content">
        <canvas id="${chartId}" class="chart-canvas"></canvas>
      </div>
    </div>
  `;
}

export function createTableContainer(
  title: string,
  tableId: string,
  columns: Array<{ key: string; label: string; format?: (value: unknown) => string }>,
  data: Record<string, unknown>[]
): string {
  const headerRow = `
    <tr>
      ${columns.map(col => `<th>${col.label}</th>`).join('')}
    </tr>
  `;

  const dataRows = data.map(row => `
    <tr>
      ${columns.map(col => {
        const value = row[col.key];
        const formatted = col.format ? col.format(value) : String(value || '');
        return `<td>${formatted}</td>`;
      }).join('')}
    </tr>
  `).join('');

  return `
    <div class="table-container">
      <div class="table-header">
        <h3 class="table-title">${title}</h3>
        <div class="table-controls">
          <input type="text" class="table-search" placeholder="Search..." data-table="${tableId}">
        </div>
      </div>
      <div class="table-content">
        <table id="${tableId}" class="data-table">
          <thead>${headerRow}</thead>
          <tbody>${dataRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

export function createAlertBanner(
  type: 'info' | 'warning' | 'error' | 'success',
  title: string,
  message: string,
  actions?: Array<{ label: string; action: string }>): string {
  return `
    <div class="alert-banner alert-${type}">
      <div class="alert-content">
        <div class="alert-icon">${getAlertIcon(type)}</div>
        <div class="alert-text">
          <h4 class="alert-title">${title}</h4>
          <p class="alert-message">${message}</p>
        </div>
      </div>
      ${actions ? `
        <div class="alert-actions">
          ${actions.map(action => `
            <button class="hand-btn ${type === 'error' ? 'primary' : 'secondary'}" 
                    data-action="${action.action}">${action.label}</button>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

export function createLoadingSpinner(message: string = 'Loading...'): string {
  return `
    <div class="loading-container">
      <div class="loading-spinner"></div>
      <p class="loading-message">${message}</p>
    </div>
  `;
}

export function createEmptyState(
  icon: string,
  title: string,
  description: string,
  action?: { label: string; action: string }
): string {
  return `
    <div class="empty-state">
      <div class="empty-icon">${icon}</div>
      <h3 class="empty-title">${title}</h3>
      <p class="empty-description">${description}</p>
      ${action ? `
        <button class="hand-btn primary" data-action="${action.action}">${action.label}</button>
      ` : ''}
    </div>
  `;
}

// Utility functions
function getTrendIcon(trend: 'up' | 'down' | 'flat'): string {
  switch (trend) {
    case 'up': return '↗️';
    case 'down': return '↘️';
    case 'flat': return '→';
    default: return '';
  }
}

function formatValue(value: string | number): string {
  if (typeof value === 'number') {
    if (value >= 1000000) {
      return `${(value / 1000000).toFixed(1)}M`;
    } else if (value >= 1000) {
      return `${(value / 1000).toFixed(1)}K`;
    } else if (value < 1) {
      return `${(value * 100).toFixed(1)}%`;
    } else {
      return value.toFixed(0);
    }
  }
  return value;
}

function formatChange(change: number): string {
  const prefix = change >= 0 ? '+' : '';
  const icon = change >= 0 ? '↗️' : '↘️';
  const color = change >= 0 ? 'positive' : 'negative';
  
  return `<span class="change-${color}">${icon} ${prefix}${(change * 100).toFixed(1)}%</span>`;
}

function getAlertIcon(type: 'info' | 'warning' | 'error' | 'success'): string {
  switch (type) {
    case 'info': return 'ℹ️';
    case 'warning': return '⚠️';
    case 'error': return '❌';
    case 'success': return '✅';
    default: return 'ℹ️';
  }
}

// Real-time updates helper
export class RealtimeManager {
  private eventSource: EventSource | null = null;
  private updateCallbacks: Map<string, (data: unknown) => void> = new Map();

  constructor(private endpoint: string) {}

  connect(): void {
    if (this.eventSource) {
      this.eventSource.close();
    }

    try {
      this.eventSource = new EventSource(this.endpoint);
      
      this.eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.notifySubscribers(data);
        } catch (error) {
          console.error('Failed to parse real-time update:', error);
        }
      };

      this.eventSource.onerror = (error) => {
        console.error('Real-time connection error:', error);
      };

    } catch (error) {
      console.error('Failed to create real-time connection:', error);
    }
  }

  subscribe(eventType: string, callback: (data: unknown) => void): void {
    this.updateCallbacks.set(eventType, callback);
  }

  unsubscribe(eventType: string): void {
    this.updateCallbacks.delete(eventType);
  }

  private notifySubscribers(data: Record<string, unknown>): void {
    Object.entries(data).forEach(([eventType, eventData]) => {
      const callback = this.updateCallbacks.get(eventType);
      if (callback) {
        callback(eventData);
      }
    });
  }

  disconnect(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.updateCallbacks.clear();
  }
}