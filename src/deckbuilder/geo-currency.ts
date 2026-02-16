// ==================== Geo-based Currency Detection ====================
// Detects user's preferred currency from timezone, with localStorage persistence.

import { STORAGE_KEYS } from '../shared/storage.js';

export type PriceCurrency = 'EUR' | 'USD';

/**
 * Detect preferred currency from browser timezone.
 * Europe/* timezones → EUR, everything else → USD.
 */
function detectCurrencyFromTimezone(): PriceCurrency {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz.startsWith('Europe/')) return 'EUR';
    // Africa and some Middle East timezones that use EUR
    if (tz.startsWith('Africa/') && ['Africa/Ceuta', 'Africa/Canary'].includes(tz)) return 'EUR';
    return 'USD';
  } catch {
    return 'EUR'; // Default to EUR (larger underserved market)
  }
}

/**
 * Get the user's stored currency preference, falling back to timezone detection.
 */
export function getStoredCurrencyPreference(): PriceCurrency {
  try {
    const stored = localStorage.getItem(STORAGE_KEYS.DECKBUILDER_CURRENCY_PREFERENCE);
    if (stored === 'EUR' || stored === 'USD') return stored;
  } catch {
    // localStorage unavailable
  }
  return detectCurrencyFromTimezone();
}

/**
 * Persist the user's currency preference.
 */
export function setStoredCurrencyPreference(currency: PriceCurrency): void {
  try {
    localStorage.setItem(STORAGE_KEYS.DECKBUILDER_CURRENCY_PREFERENCE, currency);
  } catch {
    // Ignore storage failures
  }
}
