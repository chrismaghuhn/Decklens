// ==================== Real-time Dashboard System ====================
// WebSocket/SSE integration for live KPI updates and alert system

// Define RealtimeKPIUpdate interface inline for now
interface RealtimeKPIUpdate {
  timestamp: string;
  activeSessions: number;
  currentFunnelStep: Record<string, number>;
  apiLatencyMs: number;
  errorRatePercent: number;
  conversionRate24h: number;
  revenueToday: number;
}

export interface RealtimeConfig {
  endpoint: string;
  reconnectInterval: number;
  maxReconnectAttempts: number;
  heartbeatInterval: number;
}

export interface AlertRule {
  id: string;
  name: string;
  condition: (data: RealtimeKPIUpdate) => boolean;
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  actions?: Array<{
    label: string;
    action: string;
    autoTrigger?: boolean;
  }>;
  cooldown: number; // milliseconds
}

export class RealtimeDashboardManager {
  private eventSource: EventSource | null = null;
  private websocket: WebSocket | null = null;
  private config: RealtimeConfig;
  private subscribers: Map<string, Set<(data: unknown) => void>> = new Map();
  private alertRules: Map<string, AlertRule> = new Map();
  private alertCooldowns: Map<string, number> = new Map();
  private reconnectAttempts = 0;
  private heartbeatTimer: number | null = null;
  private isConnecting = false;
  private lastUpdate: string | null = null;

  constructor(config: Partial<RealtimeConfig> = {}) {
    this.config = {
      endpoint: '/api/analytics/live/updates',
      reconnectInterval: 5000,
      maxReconnectAttempts: 10,
      heartbeatInterval: 30000,
      ...config,
    };

    this.initializeDefaultAlerts();
  }

  // Connection Management
  public connect(useWebSocket = false): void {
    if (this.isConnecting || (this.eventSource && this.eventSource.readyState === EventSource.OPEN)) {
      return;
    }

    this.isConnecting = true;

    if (useWebSocket) {
      this.connectWebSocket();
    } else {
      this.connectSSE();
    }
  }

  private connectSSE(): void {
    try {
      this.eventSource = new EventSource(this.config.endpoint);
      
      this.eventSource.onopen = () => {
        console.log('Real-time SSE connection established');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.notifyConnectionChange('connected');
      };

      this.eventSource.onmessage = (event) => {
        this.handleRealtimeUpdate(event);
      };

      this.eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        this.handleConnectionError();
      };

    } catch (error) {
      console.error('Failed to create SSE connection:', error);
      this.handleConnectionError();
    }
  }

  private connectWebSocket(): void {
    try {
      const wsUrl = this.config.endpoint.replace('http', 'ws');
      this.websocket = new WebSocket(wsUrl);
      
      this.websocket.onopen = () => {
        console.log('Real-time WebSocket connection established');
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.notifyConnectionChange('connected');
      };

      this.websocket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleRealtimeUpdate({ data: event.data } as MessageEvent);
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error);
        }
      };

      this.websocket.onerror = (error) => {
        console.error('WebSocket connection error:', error);
        this.handleConnectionError();
      };

      this.websocket.onclose = () => {
        console.log('WebSocket connection closed');
        this.handleConnectionError();
      };

    } catch (error) {
      console.error('Failed to create WebSocket connection:', error);
      this.handleConnectionError();
    }
  }

  private handleConnectionError(): void {
    this.isConnecting = false;
    this.stopHeartbeat();
    this.notifyConnectionChange('disconnected');

    if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
      this.reconnectAttempts++;
      console.log(`Attempting to reconnect (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
      
      setTimeout(() => {
        this.connect();
      }, this.config.reconnectInterval);
    } else {
      console.error('Max reconnection attempts reached');
      this.notifyConnectionChange('failed');
    }
  }

  public disconnect(): void {
    this.stopHeartbeat();
    
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
    
    this.subscribers.clear();
    this.notifyConnectionChange('disconnected');
  }

  // Data Handling
  private handleRealtimeUpdate(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data) as RealtimeKPIUpdate;
      this.lastUpdate = data.timestamp;
      
      // Update all subscribers
      this.notifySubscribers(data);
      
      // Check alert rules
      this.checkAlertRules(data);
      
      // Update connection status
      this.notifyConnectionChange('live');

    } catch (error) {
      console.error('Failed to parse real-time update:', error);
    }
  }

  private notifySubscribers(data: RealtimeKPIUpdate): void {
    Object.entries(data).forEach(([eventType, eventData]) => {
      const callbacks = this.subscribers.get(eventType);
      if (callbacks) {
        callbacks.forEach(callback => {
          try {
            callback(eventData);
          } catch (error) {
            console.error(`Error in subscriber callback for ${eventType}:`, error);
          }
        });
      }
    });
  }

  // Subscription Management
  public subscribe(eventType: string, callback: (data: unknown) => void): () => void {
    if (!this.subscribers.has(eventType)) {
      this.subscribers.set(eventType, new Set());
    }
    
    this.subscribers.get(eventType)!.add(callback);
    
    // Return unsubscribe function
    return () => {
      const callbacks = this.subscribers.get(eventType);
      if (callbacks) {
        callbacks.delete(callback);
        if (callbacks.size === 0) {
          this.subscribers.delete(eventType);
        }
      }
    };
  }

  // Alert System
  private initializeDefaultAlerts(): void {
    // High error rate alert
    this.addAlertRule({
      id: 'high-error-rate',
      name: 'High Error Rate',
      condition: (data) => data.errorRatePercent > 0.05,
      severity: 'error',
      message: 'Error rate is above 5%',
      actions: [
        { label: 'View Logs', action: 'view-logs' },
        { label: 'Investigate', action: 'investigate-errors' }
      ],
      cooldown: 300000, // 5 minutes
    });

    // Low conversion rate alert
    this.addAlertRule({
      id: 'low-conversion-rate',
      name: 'Low Conversion Rate',
      condition: (data) => data.conversionRate24h < 0.1,
      severity: 'warning',
      message: '24h conversion rate is below 10%',
      actions: [
        { label: 'View Funnel', action: 'view-funnel' },
        { label: 'Investigate', action: 'investigate-conversion' }
      ],
      cooldown: 600000, // 10 minutes
    });

    // High latency alert
    this.addAlertRule({
      id: 'high-latency',
      name: 'High API Latency',
      condition: (data) => data.apiLatencyMs > 500,
      severity: 'warning',
      message: 'API latency is above 500ms',
      actions: [
        { label: 'View Performance', action: 'view-performance' },
        { label: 'Scale Resources', action: 'scale-resources' }
      ],
      cooldown: 300000, // 5 minutes
    });

    // Revenue drop alert
    this.addAlertRule({
      id: 'revenue-drop',
      name: 'Revenue Drop',
      condition: (data) => {
        // This would need historical comparison
        return false; // Placeholder
      },
      severity: 'critical',
      message: 'Daily revenue has dropped significantly',
      actions: [
        { label: 'Investigate', action: 'investigate-revenue' },
        { label: 'Emergency Response', action: 'emergency-response' }
      ],
      cooldown: 1800000, // 30 minutes
    });
  }

  public addAlertRule(rule: AlertRule): void {
    this.alertRules.set(rule.id, rule);
  }

  public removeAlertRule(ruleId: string): void {
    this.alertRules.delete(ruleId);
    this.alertCooldowns.delete(ruleId);
  }

  private checkAlertRules(data: RealtimeKPIUpdate): void {
    const now = Date.now();
    
    this.alertRules.forEach((rule, ruleId) => {
      // Check cooldown
      const lastTriggered = this.alertCooldowns.get(ruleId) || 0;
      if (now - lastTriggered < rule.cooldown) {
        return;
      }
      
      // Check condition
      if (rule.condition(data)) {
        this.triggerAlert(rule, data);
        this.alertCooldowns.set(ruleId, now);
      }
    });
  }

  private triggerAlert(rule: AlertRule, data: RealtimeKPIUpdate): void {
    const alert = {
      id: rule.id,
      name: rule.name,
      severity: rule.severity,
      message: rule.message,
      timestamp: new Date().toISOString(),
      data: data,
      actions: rule.actions || [],
    };
    
    // Notify alert subscribers
    const alertCallbacks = this.subscribers.get('alert');
    if (alertCallbacks) {
      alertCallbacks.forEach(callback => callback(alert));
    }
    
    // Auto-trigger actions if configured
    rule.actions?.forEach(action => {
      if (action.autoTrigger) {
        this.executeAlertAction(action.action, alert);
      }
    });
    
    console.warn(`Alert triggered: ${rule.name} - ${rule.message}`);
  }

  private executeAlertAction(action: string, alert: any): void {
    console.log(`Executing alert action: ${action}`, alert);
    
    // Dispatch custom event for UI to handle
    const event = new CustomEvent('alertAction', {
      detail: { action, alert }
    });
    document.dispatchEvent(event);
  }

  // Heartbeat System
  private startHeartbeat(): void {
    this.heartbeatTimer = window.setInterval(() => {
      this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendHeartbeat(): void {
    if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: 'heartbeat' }));
    }
  }

  // Connection Status
  private notifyConnectionChange(status: 'connected' | 'disconnected' | 'failed' | 'live'): void {
    const statusCallbacks = this.subscribers.get('connection');
    if (statusCallbacks) {
      statusCallbacks.forEach(callback => callback({ status, lastUpdate: this.lastUpdate }));
    }
  }

  // Utility Methods
  public getConnectionStatus(): 'connected' | 'disconnected' | 'connecting' | 'failed' {
    if (this.isConnecting) return 'connecting';
    
    if (this.eventSource) {
      return this.eventSource.readyState === EventSource.OPEN ? 'connected' : 'disconnected';
    }
    
    if (this.websocket) {
      return this.websocket.readyState === WebSocket.OPEN ? 'connected' : 'disconnected';
    }
    
    return 'disconnected';
  }

  public getLastUpdate(): string | null {
    return this.lastUpdate;
  }

  public getMetrics(): {
    subscribers: number;
    alertRules: number;
    reconnectAttempts: number;
    connectionStatus: string;
  } {
    return {
      subscribers: Array.from(this.subscribers.values()).reduce((sum, set) => sum + set.size, 0),
      alertRules: this.alertRules.size,
      reconnectAttempts: this.reconnectAttempts,
      connectionStatus: this.getConnectionStatus(),
    };
  }
}

// Global instance for dashboard usage
export const realtimeManager = new RealtimeDashboardManager();

// Helper function for easy subscription
export function subscribeToKPI(eventType: string, callback: (data: unknown) => void): () => void {
  return realtimeManager.subscribe(eventType, callback);
}

// Alert helper
export function subscribeToAlerts(callback: (alert: any) => void): () => void {
  return realtimeManager.subscribe('alert', callback);
}

// Connection status helper
export function subscribeToConnectionStatus(callback: (status: any) => void): () => void {
  return realtimeManager.subscribe('connection', callback);
}