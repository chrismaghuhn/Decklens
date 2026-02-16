// ==================== Live Chart System ====================
// Real-time chart updates with Chart.js integration

export interface LiveChartConfig {
  type: 'line' | 'bar' | 'pie' | 'doughnut';
  containerId: string;
  dataPoints: number;
  updateInterval: number;
  maxDataPoints: number;
  colors?: string[];
  animations?: boolean;
}

export interface ChartDataPoint {
  timestamp: number;
  value: number;
  label?: string;
}

export abstract class LiveChart {
  protected config: LiveChartConfig;
  protected data: ChartDataPoint[] = [];
  protected chart: any = null; // Chart.js instance
  protected updateTimer: number | null = null;
  protected isActive = false;

  constructor(config: LiveChartConfig) {
    this.config = {
      ...config,
      maxDataPoints: config.maxDataPoints ?? 60,
      animations: config.animations ?? true,
      colors: config.colors ?? ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6'],
      updateInterval: config.updateInterval ?? 1000
    };
  }

  public abstract init(): void;
  public abstract update(data: ChartDataPoint): void;
  public abstract destroy(): void;

  public start(): void {
    if (this.isActive) return;
    
    this.isActive = true;
    this.startUpdateLoop();
  }

  public stop(): void {
    this.isActive = false;
    
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  protected startUpdateLoop(): void {
    // Override in subclasses for specific update logic
  }

  public addDataPoint(point: ChartDataPoint): void {
    this.data.push(point);
    
    // Keep only the most recent data points
    if (this.data.length > this.config.maxDataPoints) {
      this.data = this.data.slice(-this.config.maxDataPoints);
    }
    
    if (this.chart) {
      this.updateChart();
    }
  }

  protected abstract updateChart(): void;

  public clearData(): void {
    this.data = [];
    if (this.chart) {
      this.updateChart();
    }
  }

  public getLatestValue(): number | null {
    return this.data.length > 0 ? this.data[this.data.length - 1].value : null;
  }

  public getAverageValue(window = this.data.length): number {
    if (this.data.length === 0) return 0;
    
    const relevantData = this.data.slice(-window);
    const sum = relevantData.reduce((acc, point) => acc + point.value, 0);
    return sum / relevantData.length;
  }
}

export class LiveLineChart extends LiveChart {
  public init(): void {
    const canvas = document.getElementById(this.config.containerId) as HTMLCanvasElement;
    if (!canvas) {
      console.error(`Canvas element not found: ${this.config.containerId}`);
      return;
    }

    // This would use Chart.js in real implementation
    // For now, create a simple canvas-based visualization
    this.createSimpleLineChart(canvas);
  }

  private createSimpleLineChart(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    // Store context for updates
    this.chart = { ctx, canvas };
    this.updateChart();
  }

  protected updateChart(): void {
    if (!this.chart) return;

    const { ctx, canvas } = this.chart;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this.data.length < 2) return;

    // Draw simple line chart
    ctx.strokeStyle = this.config.colors?.[0] || '#3b82f6';
    ctx.lineWidth = 2;
    ctx.beginPath();

    const padding = 40;
    const chartWidth = canvas.width - (padding * 2);
    const chartHeight = canvas.height - (padding * 2);
    const stepX = chartWidth / Math.max(this.data.length - 1, 1);

    // Find min/max values
    const values = this.data.map(d => d.value);
    const minValue = Math.min(...values);
    const maxValue = Math.max(...values);
    const valueRange = maxValue - minValue || 1;

    // Draw grid lines
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = padding + (chartHeight / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(canvas.width - padding, y);
      ctx.stroke();
    }

    // Draw data line
    ctx.strokeStyle = this.config.colors?.[0] || '#3b82f6';
    ctx.lineWidth = 2;
    ctx.beginPath();

    this.data.forEach((point, index) => {
      const x = padding + (index * stepX);
      const y = padding + chartHeight - ((point.value - minValue) / valueRange) * chartHeight;
      
      if (index === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });

    ctx.stroke();

    // Draw data points
    ctx.fillStyle = this.config.colors?.[0] || '#3b82f6';
    this.data.forEach((point, index) => {
      const x = padding + (index * stepX);
      const y = padding + chartHeight - ((point.value - minValue) / valueRange) * chartHeight;
      
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, 2 * Math.PI);
      ctx.fill();
    });

    // Draw latest value
    if (this.data.length > 0) {
      const latest = this.data[this.data.length - 1];
      const latestValue = latest.value.toFixed(1);
      
      ctx.fillStyle = '#1f2937';
      ctx.font = '14px sans-serif';
      ctx.fillText(latestValue, padding, padding - 10);
    }
  }

  public update(data: ChartDataPoint): void {
    this.addDataPoint(data);
  }

  public destroy(): void {
    this.stop();
    if (this.chart?.canvas) {
      const ctx = this.chart.canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, this.chart.canvas.width, this.chart.canvas.height);
      }
    }
  }
}

export class LiveBarChart extends LiveChart {
  public init(): void {
    const canvas = document.getElementById(this.config.containerId) as HTMLCanvasElement;
    if (!canvas) {
      console.error(`Canvas element not found: ${this.config.containerId}`);
      return;
    }

    this.createSimpleBarChart(canvas);
  }

  private createSimpleBarChart(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    this.chart = { ctx, canvas };
    this.updateChart();
  }

  protected updateChart(): void {
    if (!this.chart || this.data.length === 0) return;

    const { ctx, canvas } = this.chart;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const padding = 40;
    const chartWidth = canvas.width - (padding * 2);
    const chartHeight = canvas.height - (padding * 2);
    const barWidth = chartWidth / Math.max(this.data.length, 1) * 0.8;
    const barSpacing = chartWidth / Math.max(this.data.length, 1) * 0.2;

    // Find max value
    const maxValue = Math.max(...this.data.map(d => d.value));
    const valueRange = maxValue || 1;

    // Draw bars
    this.data.forEach((point, index) => {
      const barHeight = (point.value / valueRange) * chartHeight;
      const x = padding + (index * (barWidth + barSpacing));
      const y = padding + chartHeight - barHeight;

      ctx.fillStyle = this.config.colors?.[index % this.config.colors!.length] || '#3b82f6';
      ctx.fillRect(x, y, barWidth, barHeight);
    });

    // Draw axis
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, canvas.height - padding);
    ctx.lineTo(canvas.width - padding, canvas.height - padding);
    ctx.stroke();
  }

  public update(data: ChartDataPoint): void {
    this.addDataPoint(data);
  }

  public destroy(): void {
    this.stop();
    if (this.chart?.canvas) {
      const ctx = this.chart.canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, this.chart.canvas.width, this.chart.canvas.height);
      }
    }
  }
}

export class LiveGaugeChart extends LiveChart {
  private min = 0;
  private max = 100;

  constructor(config: LiveChartConfig, min = 0, max = 100) {
    super(config);
    this.min = min;
    this.max = max;
  }

  public init(): void {
    const canvas = document.getElementById(this.config.containerId) as HTMLCanvasElement;
    if (!canvas) {
      console.error(`Canvas element not found: ${this.config.containerId}`);
      return;
    }

    this.createSimpleGaugeChart(canvas);
  }

  private createSimpleGaugeChart(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    this.chart = { ctx, canvas };
    this.updateChart();
  }

  protected updateChart(): void {
    if (!this.chart) return;

    const { ctx, canvas } = this.chart;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(centerX, centerY) - 40;

    // Draw gauge background
    ctx.strokeStyle = '#e5e7eb';
    ctx.lineWidth = 20;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, Math.PI, 2 * Math.PI);
    ctx.stroke();

    // Draw gauge value
    const latestValue = this.getLatestValue();
    if (latestValue !== null) {
      const percentage = (latestValue - this.min) / (this.max - this.min);
      const endAngle = Math.PI + (percentage * Math.PI);

      // Determine color based on value
      let color = '#10b981'; // green
      if (percentage > 0.7) color = '#f59e0b'; // yellow
      if (percentage > 0.9) color = '#ef4444'; // red

      ctx.strokeStyle = color;
      ctx.lineWidth = 20;
      ctx.beginPath();
      ctx.arc(centerX, centerY, radius, Math.PI, endAngle);
      ctx.stroke();

      // Draw value text
      ctx.fillStyle = '#1f2937';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(latestValue.toFixed(1), centerX, centerY);
    }

    // Draw scale labels
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'center';
    
    ctx.fillText(this.min.toString(), centerX - radius - 10, centerY + 30);
    ctx.fillText(((this.min + this.max) / 2).toString(), centerX, centerY + radius + 25);
    ctx.fillText(this.max.toString(), centerX + radius + 10, centerY + 30);
  }

  public update(data: ChartDataPoint): void {
    // Keep only the latest value for gauge
    this.data = [data];
    if (this.chart) {
      this.updateChart();
    }
  }

  public destroy(): void {
    this.stop();
    if (this.chart?.canvas) {
      const ctx = this.chart.canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, this.chart.canvas.width, this.chart.canvas.height);
      }
    }
  }
}

// Chart Factory
export class LiveChartFactory {
  private static charts: Map<string, LiveChart> = new Map();

  public static createChart(
    id: string,
    type: 'line' | 'bar' | 'gauge',
    config: LiveChartConfig
  ): LiveChart {
    let chart: LiveChart;

    switch (type) {
      case 'line':
        chart = new LiveLineChart(config);
        break;
      case 'bar':
        chart = new LiveBarChart(config);
        break;
      case 'gauge':
        chart = new LiveGaugeChart(config);
        break;
      default:
        throw new Error(`Unsupported chart type: ${type}`);
    }

    this.charts.set(id, chart);
    return chart;
  }

  public static getChart(id: string): LiveChart | null {
    return this.charts.get(id) || null;
  }

  public static destroyChart(id: string): void {
    const chart = this.charts.get(id);
    if (chart) {
      chart.destroy();
      this.charts.delete(id);
    }
  }

  public static destroyAllCharts(): void {
    this.charts.forEach(chart => chart.destroy());
    this.charts.clear();
  }
}

// Real-time data adapters
export class KPIDataAdapter {
  public static convertRealtimeUpdate(update: any): Record<string, ChartDataPoint> {
    return {
      activeSessions: {
        timestamp: Date.now(),
        value: update.activeSessions || 0,
        label: 'Active Sessions'
      },
      apiLatency: {
        timestamp: Date.now(),
        value: update.apiLatencyMs || 0,
        label: 'API Latency (ms)'
      },
      errorRate: {
        timestamp: Date.now(),
        value: (update.errorRatePercent || 0) * 100,
        label: 'Error Rate (%)'
      },
      conversionRate: {
        timestamp: Date.now(),
        value: (update.conversionRate24h || 0) * 100,
        label: 'Conversion Rate (%)'
      },
      revenue: {
        timestamp: Date.now(),
        value: update.revenueToday || 0,
        label: 'Revenue Today ($)'
      }
    };
  }
}