// ==================== DeckLens Storage Layer ====================
// Safe localStorage operations with JSON schema validation.
// Enhanced with QuotaExceededError handling and Safe Mode boot recovery.
// Source: decklens-audit-report-v4.3.md L470-545

/**
 * Centralized storage keys - ALL localStorage access MUST use these.
 * Sprint 2 S2-A3: Eliminate magic strings.
 */
export const STORAGE_KEYS = {
  // MTG
  MTG_COLLECTION: 'decklens_collection',
  MTG_WISHLIST: 'decklens_wishlist',
  MTG_VERSIONS: 'decklens_versions',
  MTG_DECK_HISTORY: 'decklens_deck_history',
  MTG_CARD_CACHE: 'decklens_card_cache',
  MTG_META_MODE: 'decklens_meta_mode',
  MTG_DEVICE_PROFILE: 'decklens_mtg_device_profile',
  MTG_RECOMMENDATION_HISTORY: 'decklens_mtg_recommendation_history',
  MTG_RECOMMENDATION_APPLY_MODE: 'decklens_recommendation_apply_mode',
  MTG_RECOMMENDATION_INCLUDE_MISSING: 'decklens_recommendation_include_missing',
  MTG_USE_DYNAMIC_DISCOVERY: 'decklens_use_dynamic_discovery',
  MTG_USE_ARCHETYPE_DETECTION: 'decklens_use_archetype_detection',
  MTG_MATCHUP_META_MODE: 'decklens_matchup_meta_mode',
  MTG_TOOLS_ENABLED: 'mtg-tools-enabled',
  // Deckbuilder MVP (local-only decks)
  DECKBUILDER_DECKS: 'decklens_deckbuilder_decks_v1',
  DECKBUILDER_LAST_OPENED_ID: 'decklens_deckbuilder_last_opened_id',
  DECKBUILDER_VIEW_MODE: 'decklens_deckbuilder_view_mode',
  DECKBUILDER_CARD_DENSITY: 'decklens_deckbuilder_card_density',
  DECKBUILDER_SEARCH_HISTORY: 'decklens_deckbuilder_search_history',
  DECKBUILDER_SAVED_SEARCHES: 'decklens_deckbuilder_saved_searches',
  DECKBUILDER_ONBOARDING: 'decklens_deckbuilder_onboarding',
  DECKBUILDER_CLOUD_SYNC: 'decklens_deckbuilder_cloud_sync',
  DECKBUILDER_DEVICE_FP: 'decklens_deckbuilder_device_fp',
  DECKBUILDER_CURRENCY_PREFERENCE: 'decklens_deckbuilder_currency_pref',
  DECKBUILDER_CUSTOM_SHORTCUTS: 'decklens_deckbuilder_custom_shortcuts',
  DECKBUILDER_PANEL_LAYOUT: 'decklens_deckbuilder_panel_layout',
  DECKBUILDER_LAYOUT_MODE: 'decklens_deckbuilder_layout_mode',
  // YGO - Note: These match actual production keys
  YGO_COLLECTION: 'ygo-collection',
  YGO_RECENT: 'decklens-recent',
  YGO_VERSIONS: 'ygo-versions',
  YGO_TAGS: 'decklens-tags',
  YGO_FOLDERS: 'decklens-folders',
  YGO_TOOLS_ENABLED: 'ygo-tools-enabled',
  // Shared
  COMMUNITY_PROFILE: 'decklens_community_profile',
  COMMUNITY_FEED_PREFS: 'decklens_community_feed_prefs',
  THEME: 'decklens-theme',
  ANALYTICS_USER_ID: 'decklens_analytics_user_id',
  ANALYTICS_SESSION_ID: 'decklens_analytics_session_id',
  HEALTH_CHECK: '__health_check__',
} as const;


// ==================== Core Storage Functions ====================

/**
 * Safely get and parse JSON from localStorage.
 * Returns defaultValue on any error (missing key, parse failure, validation failure).
 */
export function storageGet<T>(
  key: string,
  defaultValue: T,
  validator?: (val: unknown) => boolean
): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    const parsed: unknown = JSON.parse(raw);
    if (validator && !validator(parsed)) {
      console.warn(`[storage] Validation failed for key "${key}", using default`);
      return defaultValue;
    }
    return parsed as T;
  } catch (e) {
    console.warn(`[storage] Failed to load key "${key}":`, e);
    return defaultValue;
  }
}

/**
 * Safely set a JSON value in localStorage.
 * Handles QuotaExceededError with automatic cleanup attempt.
 * Returns true on success, false on failure.
 */
export function storageSet(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    if (e instanceof DOMException && e.name === 'QuotaExceededError') {
      console.warn('[storage] Quota exceeded, attempting cleanup...');
      
      // Try to free up space
      if (attemptStorageCleanup()) {
        // Retry the save
        try {
          localStorage.setItem(key, JSON.stringify(value));
          return true;
        } catch {
          // Still failed after cleanup
          console.error('[storage] Save failed even after cleanup');
          return false;
        }
      }
      return false;
    }
    console.error(`[storage] Failed to save key "${key}":`, e);
    return false;
  }
}

/**
 * Remove a key from localStorage.
 */
export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore - removal failures are not critical
  }
}

// ==================== Storage Cleanup & Recovery ====================

/**
 * Attempt to free up localStorage space by clearing expendable data.
 * Preserves collection and wishlist data.
 * @returns true if cleanup was successful
 */
export function attemptStorageCleanup(): boolean {
  try {
    // 1. Clear history (keep only last 10 entries)
    trimHistory(STORAGE_KEYS.MTG_DECK_HISTORY, 10);
    
    // 2. Clear card cache (can be refetched)
    storageRemove(STORAGE_KEYS.MTG_CARD_CACHE);
    
    // 3. Clear YGO recent decks (keep only last 5)
    trimHistory(STORAGE_KEYS.YGO_RECENT, 5);
    
    console.info('[storage] Cleanup completed');
    return true;
  } catch (e) {
    console.error('[storage] Cleanup failed:', e);
    return false;
  }
}

/**
 * Trim a history array in localStorage to keep only the most recent entries.
 */
function trimHistory(key: string, keepCount: number): void {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    
    const history: unknown[] = JSON.parse(raw);
    if (!Array.isArray(history)) return;
    
    if (history.length > keepCount) {
      localStorage.setItem(key, JSON.stringify(history.slice(-keepCount)));
    }
  } catch {
    // If we can't parse it, just remove it
    localStorage.removeItem(key);
  }
}
