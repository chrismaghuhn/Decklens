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

/**
 * Debounce a function call - waits until user stops triggering the event.
 * Returns a debounced version of the function that delays execution until
 * after `delayMs` milliseconds have elapsed since the last invocation.
 *
 * @example
 * const debouncedSearch = debounce((query: string) => performSearch(query), 300);
 * inputEl.addEventListener('input', (e) => debouncedSearch(e.target.value));
 */
export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number = 300
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  return function(this: any, ...args: Parameters<T>) {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delayMs);
  };
}

/**
 * Throttle a function call - ensures maximum 1 call per interval.
 * Returns a throttled version of the function that only executes once
 * per `intervalMs` milliseconds, ignoring intermediate calls.
 *
 * @example
 * const throttledScroll = throttle(() => updateScrollPosition(), 200);
 * window.addEventListener('scroll', throttledScroll);
 */
export function throttle<T extends (...args: any[]) => void>(
  fn: T,
  intervalMs: number = 200
): (...args: Parameters<T>) => void {
  let lastCall = 0;
  return function(this: any, ...args: Parameters<T>) {
    const now = Date.now();
    if (now - lastCall >= intervalMs) {
      lastCall = now;
      fn.apply(this, args);
    }
  };
}

/**
 * Trap keyboard focus within a container (for accessible modals).
 * Prevents Tab key from moving focus outside the container, and
 * restores focus to the previously focused element when cleanup is called.
 *
 * @param container The element to trap focus within
 * @returns Cleanup function that removes the trap and restores previous focus
 *
 * @example
 * const modal = document.getElementById('myModal');
 * const cleanup = trapFocus(modal);
 * // ... later when modal closes:
 * cleanup();
 */
export function trapFocus(container: HTMLElement): () => void {
  const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const focusable = Array.from(container.querySelectorAll<HTMLElement>(focusableSelector));

  if (focusable.length === 0) return () => {};

  const firstFocusable = focusable[0];
  const lastFocusable = focusable[focusable.length - 1];
  const previousFocus = document.activeElement as HTMLElement;

  // Focus first element
  firstFocusable.focus();

  const handleTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;

    if (e.shiftKey) {
      // Shift+Tab: if on first element, wrap to last
      if (document.activeElement === firstFocusable) {
        e.preventDefault();
        lastFocusable.focus();
      }
    } else {
      // Tab: if on last element, wrap to first
      if (document.activeElement === lastFocusable) {
        e.preventDefault();
        firstFocusable.focus();
      }
    }
  };

  container.addEventListener('keydown', handleTab);

  // Return cleanup function
  return () => {
    container.removeEventListener('keydown', handleTab);
    previousFocus?.focus(); // Restore focus when modal closes
  };
}

