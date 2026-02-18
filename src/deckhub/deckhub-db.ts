// DeckHub IndexedDB Wrapper
// Provides offline storage for deck data and sync queue

const DB_NAME = 'DeckHubDB';
const DB_VERSION = 1;

let db: IDBDatabase | null = null;

export async function initDB(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onsuccess = () => {
      db = request.result;
      console.log('[DB] IndexedDB initialized');
      resolve();
    };

    request.onerror = () => {
      console.error('[DB] Failed to open IndexedDB:', request.error);
      reject(request.error);
    };

    request.onupgradeneeded = (e) => {
      const database = (e.target as IDBOpenDBRequest).result;

      // Deck cache: Store full deck state by repo + branch
      if (!database.objectStoreNames.contains('deckCache')) {
        const deckStore = database.createObjectStore('deckCache', { keyPath: 'id' });
        deckStore.createIndex('repoId', 'repoId', { unique: false });
        deckStore.createIndex('timestamp', 'timestamp', { unique: false });
        console.log('[DB] Created deckCache store');
      }

      // Sync queue: Store pending operations for offline sync
      if (!database.objectStoreNames.contains('syncQueue')) {
        const syncStore = database.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
        syncStore.createIndex('timestamp', 'timestamp', { unique: false });
        console.log('[DB] Created syncQueue store');
      }

      // Recent repos: Store recently accessed repos for quick access
      if (!database.objectStoreNames.contains('recentRepos')) {
        const recentStore = database.createObjectStore('recentRepos', { keyPath: 'repoId' });
        recentStore.createIndex('lastAccessed', 'lastAccessed', { unique: false });
        console.log('[DB] Created recentRepos store');
      }
    };
  });
}

// ═══════════════════════════════════════════════════
// Deck Cache
// ═══════════════════════════════════════════════════

export interface CachedDeck {
  id: string; // `${repoId}:${branch}`
  repoId: string;
  branch: string;
  deckState: any;
  timestamp: number;
}

export async function cacheDeck(repoId: string, branch: string, deckState: any): Promise<void> {
  if (!db) throw new Error('DB not initialized');

  const id = `${repoId}:${branch}`;
  const cached: CachedDeck = {
    id,
    repoId,
    branch,
    deckState,
    timestamp: Date.now()
  };

  return new Promise((resolve, reject) => {
    const tx = db!.transaction('deckCache', 'readwrite');
    const store = tx.objectStore('deckCache');
    const request = store.put(cached);

    request.onsuccess = () => {
      console.log('[DB] Cached deck:', id);
      resolve();
    };

    request.onerror = () => {
      console.error('[DB] Failed to cache deck:', request.error);
      reject(request.error);
    };
  });
}

export async function getCachedDeck(repoId: string, branch: string): Promise<any | null> {
  if (!db) return null;

  const id = `${repoId}:${branch}`;

  return new Promise((resolve) => {
    const tx = db!.transaction('deckCache', 'readonly');
    const store = tx.objectStore('deckCache');
    const request = store.get(id);

    request.onsuccess = () => {
      const cached = request.result as CachedDeck | undefined;
      if (cached) {
        console.log('[DB] Retrieved cached deck:', id, `(${Math.round((Date.now() - cached.timestamp) / 1000)}s old)`);
        resolve(cached.deckState);
      } else {
        resolve(null);
      }
    };

    request.onerror = () => {
      console.error('[DB] Failed to get cached deck:', request.error);
      resolve(null);
    };
  });
}

export async function clearOldCache(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  if (!db) return 0;

  const cutoff = Date.now() - maxAgeMs;
  let deleted = 0;

  return new Promise((resolve) => {
    const tx = db!.transaction('deckCache', 'readwrite');
    const store = tx.objectStore('deckCache');
    const index = store.index('timestamp');
    const request = index.openCursor(IDBKeyRange.upperBound(cutoff));

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        deleted++;
        cursor.continue();
      } else {
        console.log('[DB] Cleared', deleted, 'old cached decks');
        resolve(deleted);
      }
    };

    request.onerror = () => {
      console.error('[DB] Failed to clear old cache:', request.error);
      resolve(deleted);
    };
  });
}

// ═══════════════════════════════════════════════════
// Sync Queue (for offline operations)
// ═══════════════════════════════════════════════════

export interface SyncOperation {
  id?: number;
  url: string;
  method: string;
  body?: any;
  timestamp: number;
}

export async function queueSyncOperation(url: string, method: string, body?: any): Promise<void> {
  if (!db) throw new Error('DB not initialized');

  const operation: SyncOperation = {
    url,
    method,
    body,
    timestamp: Date.now()
  };

  return new Promise((resolve, reject) => {
    const tx = db!.transaction('syncQueue', 'readwrite');
    const store = tx.objectStore('syncQueue');
    const request = store.add(operation);

    request.onsuccess = () => {
      console.log('[DB] Queued sync operation:', method, url);
      resolve();
    };

    request.onerror = () => {
      console.error('[DB] Failed to queue operation:', request.error);
      reject(request.error);
    };
  });
}

export async function getSyncQueue(): Promise<SyncOperation[]> {
  if (!db) return [];

  return new Promise((resolve) => {
    const tx = db!.transaction('syncQueue', 'readonly');
    const store = tx.objectStore('syncQueue');
    const request = store.getAll();

    request.onsuccess = () => {
      const operations = request.result as SyncOperation[];
      console.log('[DB] Retrieved', operations.length, 'queued operations');
      resolve(operations);
    };

    request.onerror = () => {
      console.error('[DB] Failed to get sync queue:', request.error);
      resolve([]);
    };
  });
}

export async function clearSyncQueue(): Promise<void> {
  if (!db) return;

  return new Promise((resolve) => {
    const tx = db!.transaction('syncQueue', 'readwrite');
    const store = tx.objectStore('syncQueue');
    const request = store.clear();

    request.onsuccess = () => {
      console.log('[DB] Cleared sync queue');
      resolve();
    };

    request.onerror = () => {
      console.error('[DB] Failed to clear sync queue:', request.error);
      resolve();
    };
  });
}

// ═══════════════════════════════════════════════════
// Recent Repos
// ═══════════════════════════════════════════════════

export interface RecentRepo {
  repoId: string;
  name: string;
  lastAccessed: number;
}

export async function saveRecentRepo(repoId: string, name: string): Promise<void> {
  if (!db) return;

  const recent: RecentRepo = {
    repoId,
    name,
    lastAccessed: Date.now()
  };

  return new Promise((resolve) => {
    const tx = db!.transaction('recentRepos', 'readwrite');
    const store = tx.objectStore('recentRepos');
    const request = store.put(recent);

    request.onsuccess = () => {
      console.log('[DB] Saved recent repo:', name);
      resolve();
    };

    request.onerror = () => {
      console.error('[DB] Failed to save recent repo:', request.error);
      resolve();
    };
  });
}

export async function getRecentRepos(limit = 10): Promise<RecentRepo[]> {
  if (!db) return [];

  return new Promise((resolve) => {
    const tx = db!.transaction('recentRepos', 'readonly');
    const store = tx.objectStore('recentRepos');
    const index = store.index('lastAccessed');
    const request = index.openCursor(null, 'prev'); // Descending order

    const results: RecentRepo[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };

    request.onerror = () => {
      console.error('[DB] Failed to get recent repos:', request.error);
      resolve([]);
    };
  });
}
