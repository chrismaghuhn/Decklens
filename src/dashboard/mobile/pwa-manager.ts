// ==================== Mobile PWA Dashboard ====================
// Progressive Web App features for mobile-optimized dashboard experience

export interface PWAConfig {
  name: string;
  shortName: string;
  description: string;
  startUrl: '/dashboard';
  display: 'standalone' | 'fullscreen' | 'minimal-ui' | 'browser';
  backgroundColor: string;
  themeColor: string;
  icons: Array<{
    src: string;
    sizes: string;
    type: string;
  }>;
}

export interface OfflineCache {
  name: string;
  version: string;
  urls: string[];
  maxAge: number;
}

export class PWADashboardManager {
  private config: PWAConfig;
  private cacheName = 'decklens-dashboard-v1';
  private isOnline = navigator.onLine;
  private deferredPrompt: any = null;
  private installButton: HTMLElement | null = null;

  constructor(config: Partial<PWAConfig> = {}) {
    this.config = {
      name: 'DeckLens Dashboard',
      shortName: 'DeckLens',
      description: 'Real-time MTG deck optimization dashboard',
      startUrl: '/dashboard',
      display: 'standalone',
      backgroundColor: '#ffffff',
      themeColor: '#3b82f6',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      ],
      ...config,
    };

    this.initializePWAFeatures();
  }

  private initializePWAFeatures(): void {
    this.setupServiceWorker();
    this.setupInstallPrompt();
    this.setupOnlineStatusListener();
    this.setupTouchOptimizations();
  }

  // Service Worker Management
  private setupServiceWorker(): void {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/dashboard-sw.js')
        .then((registration) => {
          console.log('Service Worker registered:', registration);
          
          // Check for updates
          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  this.showUpdateNotification();
                }
              });
            }
          });
        })
        .catch((error) => {
          console.error('Service Worker registration failed:', error);
        });
    }
  }

  // Install Prompt (Add to Home Screen)
  private setupInstallPrompt(): void {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.showInstallButton();
    });
  }

  private showInstallButton(): void {
    const installButton = document.createElement('button');
    installButton.className = 'pwa-install-btn';
    installButton.innerHTML = '📱 Install App';
    installButton.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: #3b82f6;
      color: white;
      border: none;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      cursor: pointer;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      z-index: 9999;
      transition: all 0.3s ease;
    `;

    installButton.addEventListener('click', () => {
      this.installApp();
    });

    document.body.appendChild(installButton);
    this.installButton = installButton;
  }

  private async installApp(): Promise<void> {
    if (!this.deferredPrompt) return;

    this.deferredPrompt.prompt();
    const { outcome } = await this.deferredPrompt.userChoice;
    
    if (outcome === 'accepted') {
      console.log('App installed successfully');
      if (this.installButton) {
        this.installButton.remove();
        this.installButton = null;
      }
    }
    
    this.deferredPrompt = null;
  }

  // Online/Offline Status
  private setupOnlineStatusListener(): void {
    window.addEventListener('online', () => {
      this.isOnline = true;
      this.hideOfflineIndicator();
      this.syncOfflineData();
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.showOfflineIndicator();
    });
  }

  private showOfflineIndicator(): void {
    let indicator = document.getElementById('offline-indicator');
    
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'offline-indicator';
      indicator.innerHTML = `
        <div class="offline-content">
          <span class="offline-icon">📵</span>
          <span class="offline-text">You're offline</span>
          <span class="offline-subtext">Data will sync when connection resumes</span>
        </div>
      `;
      indicator.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: #fbbf24;
        color: #92400e;
        padding: 12px;
        text-align: center;
        z-index: 10000;
        font-weight: 500;
        border-bottom: 2px solid #f59e0b;
        transform: translateY(-100%);
        transition: transform 0.3s ease;
      `;
      
      document.body.appendChild(indicator);
    }
    
    setTimeout(() => {
      indicator!.style.transform = 'translateY(0)';
    }, 100);
  }

  private hideOfflineIndicator(): void {
    const indicator = document.getElementById('offline-indicator');
    if (indicator) {
      indicator.style.transform = 'translateY(-100%)';
      setTimeout(() => {
        indicator.remove();
      }, 300);
    }
  }

  // Touch Optimizations
  private setupTouchOptimizations(): void {
    // Optimize for touch interactions
    document.addEventListener('touchstart', () => {
      document.body.classList.add('touch-active');
    });

    document.addEventListener('touchend', () => {
      setTimeout(() => {
        document.body.classList.remove('touch-active');
      }, 100);
    });

    // Prevent double-tap zoom
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouchEnd <= 300) {
        e.preventDefault();
      }
      lastTouchEnd = now;
    });

    // Add touch-friendly classes to dashboard
    this.optimizeForMobile();
  }

  private optimizeForMobile(): void {
    const isMobile = window.innerWidth <= 768;
    if (!isMobile) return;

    document.body.classList.add('mobile-dashboard');

    // Optimize chart containers for touch
    const charts = document.querySelectorAll('.chart-container');
    charts.forEach(chart => {
      chart.classList.add('touch-chart');
    });

    // Optimize tables for mobile
    const tables = document.querySelectorAll('.data-table');
    tables.forEach(table => {
      this.makeTableResponsive(table as HTMLTableElement);
    });

    // Add swipe gestures for navigation
    this.addSwipeNavigation();
  }

  private makeTableResponsive(table: HTMLTableElement): void {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-wrapper';
    wrapper.style.cssText = `
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      margin: 0 -16px;
      padding: 0 16px;
    `;
    
    table.parentNode?.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }

  private addSwipeNavigation(): void {
    let startX = 0;
    let startY = 0;

    const navigation = document.querySelector('.dashboard-navigation');
    if (!navigation) return;

    document.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    });

    document.addEventListener('touchend', (e) => {
      const endX = e.changedTouches[0].clientX;
      const endY = e.changedTouches[0].clientY;
      
      const deltaX = endX - startX;
      const deltaY = Math.abs(endY - startY);
      
      // Only handle horizontal swipes
      if (Math.abs(deltaX) > 50 && deltaY < 100) {
        if (deltaX > 0) {
          // Swipe right - show navigation
          navigation.classList.add('navigation-visible');
        } else {
          // Swipe left - hide navigation
          navigation.classList.remove('navigation-visible');
        }
      }
    });
  }

  // Offline Data Sync
  private async syncOfflineData(): Promise<void> {
    try {
      const offlineData = this.getOfflineData();
      
      for (const item of offlineData) {
        try {
          await this.syncDataItem(item);
          this.removeOfflineItem(item.id);
        } catch (error) {
          console.error('Failed to sync offline item:', error);
        }
      }
    } catch (error) {
      console.error('Failed to sync offline data:', error);
    }
  }

  private getOfflineData(): any[] {
    const data = localStorage.getItem('offline-dashboard-data');
    return data ? JSON.parse(data) : [];
  }

  private removeOfflineItem(id: string): void {
    const data = this.getOfflineData();
    const filtered = data.filter(item => item.id !== id);
    localStorage.setItem('offline-dashboard-data', JSON.stringify(filtered));
  }

  private async syncDataItem(item: any): Promise<void> {
    // Implementation depends on the specific data type
    console.log('Syncing offline item:', item);
  }

  // Caching for Offline Support
  public async cacheForOffline(cache: OfflineCache): Promise<void> {
    try {
      const cacheData = await caches.open(cache.name);
      
      // Cache essential files for offline dashboard
      const essentialFiles = [
        '/dashboard/',
        '/dashboard/executive',
        '/dashboard/growth',
        '/dashboard/technical',
        '/dashboard/community',
        '/dashboard/public',
        '/api/analytics/dashboard',
        '/assets/styles/dashboard.css',
        '/assets/js/dashboard.js',
      ];

      await cacheData.addAll(essentialFiles);
      console.log('Dashboard cached for offline use');
      
    } catch (error) {
      console.error('Failed to cache for offline:', error);
    }
  }

  // Update Notification
  private showUpdateNotification(): void {
    const notification = document.createElement('div');
    notification.className = 'pwa-update-notification';
    notification.innerHTML = `
      <div class="update-content">
        <span class="update-icon">🔄</span>
        <span class="update-text">A new version is available!</span>
        <button class="update-btn" onclick="this.parentElement.parentElement.remove(); location.reload()">
          Update Now
        </button>
      </div>
    `;
    
    notification.style.cssText = `
      position: fixed;
      top: 60px;
      right: 20px;
      background: #3b82f6;
      color: white;
      padding: 16px;
      border-radius: 8px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      z-index: 10001;
      max-width: 300px;
    `;
    
    document.body.appendChild(notification);
  }

  // Public API
  public getInstallStatus(): 'installed' | 'installable' | 'unsupported' {
    if (this.installButton) return 'installable';
    if (window.matchMedia('(display-mode: standalone)').matches) return 'installed';
    return 'unsupported';
  }

  public getOnlineStatus(): boolean {
    return this.isOnline;
  }

  public async preloadCriticalData(): Promise<void> {
    const criticalEndpoints = [
      '/api/analytics/kpi/business',
      '/api/analytics/kpi/growth',
      '/api/analytics/kpi/technical',
      '/api/analytics/kpi/community',
      '/api/analytics/public/summary',
    ];

    try {
      await Promise.all(
        criticalEndpoints.map(endpoint =>
          fetch(endpoint).then(response => response.ok ? response.text() : null)
        )
      );
      console.log('Critical data preloaded for offline use');
    } catch (error) {
      console.error('Failed to preload critical data:', error);
    }
  }
}

// Mobile CSS Utilities
export const mobileStyles = `
  .mobile-dashboard {
    font-size: 16px; /* Prevent zoom on iOS */
    -webkit-text-size-adjust: 100%;
  }

  .mobile-dashboard .dashboard-navigation {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    background: white;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    z-index: 1000;
    transform: translateX(-100%);
    transition: transform 0.3s ease;
  }

  .mobile-dashboard .dashboard-navigation.navigation-visible {
    transform: translateX(0);
  }

  .mobile-dashboard .dashboard-section {
    padding: 16px;
    margin-top: 60px;
  }

  .mobile-dashboard .kpi-grid {
    grid-template-columns: 1fr;
    gap: 12px;
  }

  .mobile-dashboard .dashboard-row {
    flex-direction: column;
    gap: 16px;
  }

  .mobile-dashboard .dashboard-col-1,
  .mobile-dashboard .dashboard-col-2 {
    width: 100%;
  }

  .mobile-dashboard .chart-container {
    margin: 16px 0;
  }

  .mobile-dashboard .touch-chart canvas {
    max-width: 100%;
    height: auto;
  }

  .mobile-dashboard .data-table {
    font-size: 14px;
  }

  .mobile-dashboard .hand-btn {
    min-height: 44px; /* iOS touch target minimum */
    font-size: 16px;
  }

  .touch-active * {
    -webkit-tap-highlight-color: rgba(59, 130, 246, 0.1);
  }

  .pwa-install-btn:hover {
    transform: scale(1.05);
    box-shadow: 0 6px 8px rgba(0, 0, 0, 0.15);
  }

  .offline-content {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .offline-icon {
    font-size: 18px;
  }

  .offline-text {
    font-weight: 600;
  }

  .offline-subtext {
    font-size: 12px;
    opacity: 0.8;
  }

  .update-content {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .update-btn {
    background: white;
    color: #3b82f6;
    border: none;
    padding: 8px 12px;
    border-radius: 4px;
    font-weight: 600;
    cursor: pointer;
  }

  @media (max-width: 768px) {
    .dashboard-section {
      padding: 8px !important;
    }
    
    .kpi-card {
      padding: 16px !important;
    }
    
    .chart-header {
      flex-direction: column;
      align-items: flex-start;
      gap: 8px;
    }
  }
`;

// Export for easy initialization
export function initializePWADashboard(config?: Partial<PWAConfig>): PWADashboardManager {
  // Inject mobile styles
  if (!document.getElementById('pwa-mobile-styles')) {
    const style = document.createElement('style');
    style.id = 'pwa-mobile-styles';
    style.textContent = mobileStyles;
    document.head.appendChild(style);
  }

  return new PWADashboardManager(config);
}