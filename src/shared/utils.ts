// ==================== DeckLens Shared Utilities ====================
// Extracted from inline scripts for CSP compliance
// Source: mtg.html lines 822-867

/**
 * Escape HTML special characters to prevent XSS.
 * Use for ALL untrusted data before innerHTML insertion.
 */
export function escapeHtml(str: string | null | undefined): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Validate that a URL uses https:// or http:// protocol only.
 * Returns the URL if valid, or '#' as safe fallback.
 */
export function sanitizeUrl(url: string | null | undefined): string {
  if (!url) return '#';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return url;
    return '#';
  } catch {
    return '#';
  }
}

/**
 * Fetch with exponential backoff for rate-limited APIs.
 * Retries on HTTP 429 with exponentially increasing delays.
 */
export async function fetchWithBackoff(
  url: string,
  options: RequestInit = {},
  maxRetries: number = 4,
  baseDelayMs: number = 200
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const response = await fetch(url, options);
    if (response.status !== 429) return response;
    lastError = new Error(`HTTP 429 (attempt ${attempt + 1}/${maxRetries + 1})`);
    if (attempt === maxRetries) break;
    const retryAfter = response.headers.get('Retry-After');
    const delayMs = retryAfter
      ? Math.min(Number(retryAfter) * 1000, 30000) || baseDelayMs * 2 ** attempt
      : baseDelayMs * 2 ** attempt;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastError!;
}



/**
 * MTG specific: normalize card names for lookups.
 * Splits double-faced cards or split cards to get the primary face name.
 * Lowercases and replaces multiple spaces.
 */
export function normalizeNameKey(value: string | null | undefined): string {
  if (!value) return '';
  const base = value.split('//')[0].trim();
  return base.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Dollar sign helper - get element by ID.
 */
export function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * Show an element by adding 'active' class.
 */
export function show(el: HTMLElement | null): void {
  el?.classList.add('active');
}

