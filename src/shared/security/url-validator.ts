// ==================== URL Validator (Audit Report Â§4 - Score 30) ====================
// Strict hostname allowlist for deck import URLs.
// Source: decklens-audit-report-v4.3.md L275-408
//
// SECURITY RULES (from report):
// 1. Never fetch before Host AND Path are validated
// 2. Never echo user-entered URL in error messages (prevents phishing)
// 3. Use generic error messages: "Unsupported deck site", "Invalid URL format"
// 4. Rate limit import flow (max 10 API batches)
// 5. Timeout on all external fetches

import { INPUT_LIMITS, validateUrlInput } from './limits';

/**
 * Configuration for an allowed deck hosting site.
 */
interface AllowedHost {
  /** Regex pattern to match and extract deck ID from pathname. Capture group 1 = deck ID */
  pathPattern: RegExp;
  /** Base URL for API requests (deck ID is appended) */
  apiBase: string;
  /** Human-readable site name for UI badges */
  displayName: string;
}

/**
 * Strict hostname allowlist for deck import URLs.
 * 
 * SECURITY: Only exact hostname matches are allowed.
 * - âŒ `url.includes('moxfield.com')` is BYPASSABLE: `https://evil.com?moxfield.com`
 * - âœ… `ALLOWED_HOSTS[parsed.hostname]` is SAFE: exact match only
 */
export const ALLOWED_HOSTS: Record<string, AllowedHost> = {
  'moxfield.com': {
    pathPattern: /^\/decks\/([a-zA-Z0-9_-]+)(?:\/export)?\/?$/,
    apiBase: 'https://api2.moxfield.com/v3/decks/all/',
    displayName: 'Moxfield',
  },
  'www.moxfield.com': {
    pathPattern: /^\/decks\/([a-zA-Z0-9_-]+)(?:\/export)?\/?$/,
    apiBase: 'https://api2.moxfield.com/v3/decks/all/',
    displayName: 'Moxfield',
  },
  'archidekt.com': {
    pathPattern: /^\/decks\/(\d+)(?:\/.*)?$/,
    apiBase: 'https://archidekt.com/api/decks/',
    displayName: 'Archidekt',
  },
  'www.archidekt.com': {
    pathPattern: /^\/decks\/(\d+)(?:\/.*)?$/,
    apiBase: 'https://archidekt.com/api/decks/',
    displayName: 'Archidekt',
  },
};

/**
 * Result of URL validation.
 */
export type UrlValidationResult =
  | { valid: true; deckId: string; apiUrl: string; site: string }
  | { valid: false; error: string };

/**
 * Validate a deck URL against the strict hostname allowlist.
 * 
 * @param url - User-entered URL string
 * @returns Validation result with API URL if valid, generic error if invalid
 * 
 * SECURITY NOTES:
 * - Generic error messages prevent information leakage
 * - URL is never echoed back to user
 * - Only HTTPS protocol is allowed
 */
export function validateDeckUrl(url: string): UrlValidationResult {
  // Length check first
  try {
    validateUrlInput(url);
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }

  try {
    const parsed = new URL(url);

    // Protocol check: HTTPS only
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'Only HTTPS URLs are allowed' };
    }

    // Hostname allowlist check (SAFE: exact match, not includes())
    const hostConfig = ALLOWED_HOSTS[parsed.hostname];
    if (!hostConfig) {
      return {
        valid: false,
        error: 'Unsupported deck site. Use Moxfield or Archidekt.',
      };
    }

    // Path validation + ID extraction via capture group
    const match = parsed.pathname.match(hostConfig.pathPattern);
    if (!match || !match[1]) {
      return { valid: false, error: 'Invalid deck URL format' };
    }

    const deckId = match[1];
    return {
      valid: true,
      deckId,
      apiUrl: hostConfig.apiBase + deckId,
      site: hostConfig.displayName,
    };
  } catch {
    // URL constructor threw (malformed URL)
    return { valid: false, error: 'Invalid URL' };
  }
}

/**
 * Get the display name for a validated URL (for Anti-Homograph UI badge).
 * 
 * SECURITY: Shows trusted site badge instead of free-form URL text.
 * This prevents homograph attacks (e.g., `mÐ¾xfield.com` with Cyrillic 'o').
 * 
 * @param url - User-entered URL
 * @returns Site display name or null if not in allowlist
 */
export function getUrlSiteBadge(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostConfig = ALLOWED_HOSTS[parsed.hostname];
    return hostConfig?.displayName ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if a hostname is in the allowlist (for CSP connect-src validation).
 */
export function isAllowedHost(hostname: string): boolean {
  return hostname in ALLOWED_HOSTS;
}

/**
 * Get list of allowed API base URLs (for reference/documentation).
 */
export function getAllowedApiUrls(): string[] {
  const urls = new Set<string>();
  for (const config of Object.values(ALLOWED_HOSTS)) {
    // Extract base domain from apiBase
    try {
      const parsed = new URL(config.apiBase);
      urls.add(parsed.origin);
    } catch {
      // Skip invalid URLs (shouldn't happen with hardcoded values)
    }
  }
  return [...urls];
}
