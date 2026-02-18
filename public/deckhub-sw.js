// DeckHub Service Worker
// Provides offline support and caching for DeckHub

const CACHE_VERSION = 'deckhub-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;

const STATIC_ASSETS = [
  '/deckhub.html',
  '/src/deckhub/deckhub-main.js',
  '/src/shared/dom.js',
];

// Install: Cache static assets
self.addEventListener('install', (event) => {
  console.log('[SW] Installing Service Worker...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate: Clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating Service Worker...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames
          .filter(name => name.startsWith('deckhub-') && name !== STATIC_CACHE && name !== API_CACHE)
          .map(name => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Network-first for API, cache-first for static
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API requests: Network-first, fallback to cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          // Clone and cache successful responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(API_CACHE).then(cache => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => {
          // Network failed, try cache
          return caches.match(request).then(cached => {
            if (cached) {
              console.log('[SW] Serving from cache (offline):', url.pathname);
              return cached;
            }
            // Return offline response
            return new Response(
              JSON.stringify({ error: 'Offline', cached: false }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
          });
        })
    );
    return;
  }

  // Static assets: Cache-first
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        return cached;
      }

      return fetch(request).then(response => {
        // Cache successful static responses
        if (response.ok && request.method === 'GET') {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});

// Background Sync (future feature)
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-deck-changes') {
    console.log('[SW] Background sync triggered');
    event.waitUntil(syncDeckChanges());
  }
});

async function syncDeckChanges() {
  // Placeholder for future sync logic
  console.log('[SW] Syncing deck changes...');
  return Promise.resolve();
}
