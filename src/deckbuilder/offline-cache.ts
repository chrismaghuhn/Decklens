// ============================================================
// Offline Cache — Service Worker + IndexedDB for offline use
// ============================================================
// Caches card images, deck data, and pending edits for offline
// editing. Syncs changes when connection is restored.
// ============================================================

// ==================== Types ====================

export interface CachedCard {
  name: string;
  imageUrl: string;
  imageBlob?: Blob;
  cachedAt: number;
}

export interface PendingEdit {
  id: string;
  deckId: string;
  repoId?: string;
  branchId?: string;
  action: 'commit' | 'save';
  payload: unknown;
  createdAt: number;
  retries: number;
}

export interface OfflineStatus {
  isOnline: boolean;
  cachedCards: number;
  pendingEdits: number;
  lastSyncAt: number | null;
  storageUsedMB: number;
}

// ==================== IndexedDB ====================

const DB_NAME = 'decklens-offline';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cards')) {
        const cardStore = db.createObjectStore('cards', { keyPath: 'name' });
        cardStore.createIndex('cachedAt', 'cachedAt');
      }
      if (!db.objectStoreNames.contains('decks')) {
        db.createObjectStore('decks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('pendingEdits')) {
        const editStore = db.createObjectStore('pendingEdits', { keyPath: 'id' });
        editStore.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

async function tx(
  storeName: string,
  mode: IDBTransactionMode = 'readonly'
): Promise<IDBObjectStore> {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

async function idbGet<T>(storeName: string, key: string): Promise<T | undefined> {
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(storeName: string, value: unknown): Promise<void> {
  const store = await tx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(storeName: string, key: string): Promise<void> {
  const store = await tx(storeName, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

async function idbCount(storeName: string): Promise<number> {
  const store = await tx(storeName);
  return new Promise((resolve, reject) => {
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ==================== Card Image Cache ====================

/**
 * Cache a card image for offline use.
 */
export async function cacheCardImage(name: string, imageUrl: string): Promise<void> {
  try {
    const resp = await fetch(imageUrl);
    if (!resp.ok) return;
    const imageBlob = await resp.blob();
    await idbPut('cards', { name, imageUrl, imageBlob, cachedAt: Date.now() });
  } catch {
    // Cache URL only, no blob
    await idbPut('cards', { name, imageUrl, cachedAt: Date.now() });
  }
}

/**
 * Get a cached card image. Returns blob URL if available, otherwise original URL.
 */
export async function getCachedCardImage(name: string): Promise<string | null> {
  const cached = await idbGet<CachedCard>('cards', name);
  if (!cached) return null;
  if (cached.imageBlob) {
    return URL.createObjectURL(cached.imageBlob);
  }
  return cached.imageUrl;
}

/**
 * Batch cache multiple card images.
 */
export async function batchCacheCards(cards: Array<{ name: string; imageUrl: string }>): Promise<number> {
  let cached = 0;
  // Process in batches of 5 to avoid overwhelming the network
  for (let i = 0; i < cards.length; i += 5) {
    const batch = cards.slice(i, i + 5);
    const results = await Promise.allSettled(
      batch.map(c => cacheCardImage(c.name, c.imageUrl))
    );
    cached += results.filter(r => r.status === 'fulfilled').length;
  }
  return cached;
}

/**
 * Clear cards older than maxAge (ms).
 */
export async function pruneCardCache(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  const all = await idbGetAll<CachedCard>('cards');
  let removed = 0;
  for (const card of all) {
    if (card.cachedAt < cutoff) {
      await idbDelete('cards', card.name);
      removed++;
    }
  }
  return removed;
}

// ==================== Deck Cache ====================

/**
 * Cache a deck for offline viewing/editing.
 */
export async function cacheDeck(deck: { id: string; [key: string]: unknown }): Promise<void> {
  await idbPut('decks', { ...deck, _cachedAt: Date.now() });
}

/**
 * Get a cached deck.
 */
export async function getCachedDeck<T>(id: string): Promise<T | undefined> {
  return idbGet<T>('decks', id);
}

/**
 * Get all cached decks.
 */
export async function getAllCachedDecks<T>(): Promise<T[]> {
  return idbGetAll<T>('decks');
}

// ==================== Pending Edits Queue ====================

/**
 * Queue an edit for sync when connection is restored.
 */
export async function queueEdit(edit: Omit<PendingEdit, 'id' | 'createdAt' | 'retries'>): Promise<string> {
  const id = `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const pending: PendingEdit = {
    ...edit,
    id,
    createdAt: Date.now(),
    retries: 0,
  };
  await idbPut('pendingEdits', pending);
  return id;
}

/**
 * Get all pending edits, ordered by creation time.
 */
export async function getPendingEdits(): Promise<PendingEdit[]> {
  const edits = await idbGetAll<PendingEdit>('pendingEdits');
  return edits.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Remove a pending edit after successful sync.
 */
export async function removePendingEdit(id: string): Promise<void> {
  await idbDelete('pendingEdits', id);
}

/**
 * Increment retry count for a failed edit.
 */
export async function retryPendingEdit(id: string): Promise<void> {
  const edit = await idbGet<PendingEdit>('pendingEdits', id);
  if (edit) {
    edit.retries++;
    await idbPut('pendingEdits', edit);
  }
}

// ==================== Sync Engine ====================

type SyncHandler = (edit: PendingEdit) => Promise<boolean>;
let syncHandler: SyncHandler | null = null;
let syncIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Register a handler that processes pending edits.
 * Return true if edit was successfully synced.
 */
export function registerSyncHandler(handler: SyncHandler): void {
  syncHandler = handler;
}

/**
 * Process all pending edits. Call when coming back online.
 */
export async function syncPendingEdits(): Promise<{ synced: number; failed: number }> {
  if (!syncHandler) return { synced: 0, failed: 0 };

  const edits = await getPendingEdits();
  let synced = 0;
  let failed = 0;

  for (const edit of edits) {
    if (edit.retries >= 5) {
      // Too many retries, skip (user can manually retry)
      failed++;
      continue;
    }

    try {
      const success = await syncHandler(edit);
      if (success) {
        await removePendingEdit(edit.id);
        synced++;
      } else {
        await retryPendingEdit(edit.id);
        failed++;
      }
    } catch {
      await retryPendingEdit(edit.id);
      failed++;
    }
  }

  // Update last sync time
  await idbPut('meta', { key: 'lastSync', value: Date.now() });

  return { synced, failed };
}

/**
 * Start automatic sync: checks pending edits every N seconds when online.
 */
export function startAutoSync(intervalMs = 30000): void {
  stopAutoSync();

  syncIntervalId = setInterval(async () => {
    if (navigator.onLine) {
      const edits = await getPendingEdits();
      if (edits.length > 0) {
        await syncPendingEdits();
      }
    }
  }, intervalMs);

  // Sync immediately when coming back online
  window.addEventListener('online', onOnline);
}

function onOnline(): void {
  syncPendingEdits().catch(console.error);
}

/**
 * Stop automatic sync.
 */
export function stopAutoSync(): void {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
  }
  window.removeEventListener('online', onOnline);
}

// ==================== Status ====================

/**
 * Get current offline cache status.
 */
export async function getOfflineStatus(): Promise<OfflineStatus> {
  const cachedCards = await idbCount('cards');
  const pendingEdits = await idbCount('pendingEdits');
  const lastSyncMeta = await idbGet<{ key: string; value: number }>('meta', 'lastSync');

  let storageUsedMB = 0;
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    storageUsedMB = Math.round((est.usage ?? 0) / 1024 / 1024 * 100) / 100;
  }

  return {
    isOnline: navigator.onLine,
    cachedCards,
    pendingEdits,
    lastSyncAt: lastSyncMeta?.value ?? null,
    storageUsedMB,
  };
}

/**
 * Clear all offline data.
 */
export async function clearOfflineData(): Promise<void> {
  const db = await openDB();
  const storeNames = ['cards', 'decks', 'pendingEdits', 'meta'];
  for (const name of storeNames) {
    const txn = db.transaction(name, 'readwrite');
    txn.objectStore(name).clear();
    await new Promise<void>((resolve, reject) => {
      txn.oncomplete = () => resolve();
      txn.onerror = () => reject(txn.error);
    });
  }
}
