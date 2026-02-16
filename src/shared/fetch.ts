// ==================== Robust Fetch (Audit Report Â§4 L354-402) ====================
// Combined Timeout + Retry + Exponential Backoff for all external API calls.
// Source: decklens-audit-report-v4.3.md L354-402
//
// SECURITY RULES:
// - Timeout prevents UI freeze on hanging APIs
// - Generic error messages (no URL/body echo)
// - Retry on 429, 503, 504 with exponential backoff

/**
 * Options for fetchRobust.
 */
export interface FetchRobustOptions extends Omit<RequestInit, 'signal'> {
  /** Timeout in milliseconds (default: 8000) */
  timeoutMs?: number;
  /** Number of retries on failure (default: 3) */
  retries?: number;
  /** HTTP status codes to retry on (default: [429, 503, 504]) */
  retryOn?: number[];
  /** Initial backoff delay in milliseconds (default: 1000) */
  backoffMs?: number;
  /** External AbortSignal for cancellation */
  signal?: AbortSignal;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch with timeout, retry, and exponential backoff.
 * 
 * SECURITY GUARANTEES:
 * - Timeout prevents indefinite hangs
 * - Generic error messages (no URL/body leakage)
 * - Exponential backoff respects rate limits
 * 
 * @param url - Request URL (must already be validated!)
 * @param options - Fetch options with timeout/retry config
 * @returns Response object
 * @throws Error with generic message on failure
 */
export async function fetchRobust(
  url: string,
  options: FetchRobustOptions = {}
): Promise<Response> {
  const {
    timeoutMs = 8000,
    retries = 3,
    retryOn = [429, 503, 504],
    backoffMs = 1000,
    signal: externalSignal,
    ...fetchOptions
  } = options;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Create timeout controller
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    // Combine with external signal if provided
    const combinedSignal = externalSignal
      ? createCombinedSignal(controller.signal, externalSignal)
      : controller.signal;

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: combinedSignal,
      });
      clearTimeout(timeoutId);

      // Retry on specific status codes
      if (retryOn.includes(response.status) && attempt < retries) {
        // Honor Retry-After header if present
        const retryAfter = response.headers.get('Retry-After');
        const delayMs = retryAfter
          ? Math.min(Number(retryAfter) * 1000, 30_000) || backoffMs * Math.pow(2, attempt)
          : backoffMs * Math.pow(2, attempt);
        await sleep(delayMs);
        continue;
      }

      // SECURITY: Generic error messages, no URL/body echo
      if (!response.ok) {
        // Special handling for common cases
        if (response.status === 404) {
          throw new Error('Resource not found. Please check the URL.');
        }
        if (response.status === 403) {
          throw new Error('Access denied. The deck may be private.');
        }
        if (response.status === 429) {
          throw new Error('Rate limited. Please try again in a moment.');
        }
        // Generic fallback
        throw new Error(`Request failed (${response.status}). Please try again.`);
      }

      return response;
    } catch (e) {
      clearTimeout(timeoutId);

      // Handle abort/timeout
      if (e instanceof Error && e.name === 'AbortError') {
        // Check if it was external abort vs timeout
        if (externalSignal?.aborted) {
          throw new Error('Request was cancelled.');
        }
        // It was our timeout
        if (attempt < retries) {
          await sleep(backoffMs * Math.pow(2, attempt));
          continue;
        }
        throw new Error('Request timed out. Please try again.');
      }

      // Network errors
      if (e instanceof TypeError && e.message.includes('fetch')) {
        if (attempt < retries) {
          await sleep(backoffMs * Math.pow(2, attempt));
          continue;
        }
        throw new Error('Network error. Please check your connection.');
      }

      // Re-throw if it's already our error message
      if (e instanceof Error && !e.message.includes('fetch')) {
        throw e;
      }

      // Generic fallback
      throw new Error('Request failed. Please try again.');
    }
  }

  // Should not reach here, but TypeScript needs it
  throw new Error('Request failed after retries. Please try again.');
}

/**
 * Create a combined AbortSignal from multiple sources.
 * Aborts when ANY of the source signals abort.
 */
function createCombinedSignal(
  internalSignal: AbortSignal,
  externalSignal: AbortSignal
): AbortSignal {
  // If either is already aborted, return it
  if (externalSignal.aborted) return externalSignal;
  if (internalSignal.aborted) return internalSignal;

  // Use AbortSignal.any() if available (modern browsers)
  if ('any' in AbortSignal) {
    return AbortSignal.any([internalSignal, externalSignal]);
  }

  // Fallback: manual combination with proper cleanup
  const combined = new AbortController();

  const abort = () => {
    combined.abort();
    // Cleanup: remove listeners from source signals
    internalSignal.removeEventListener('abort', abort);
    externalSignal.removeEventListener('abort', abort);
  };
  internalSignal.addEventListener('abort', abort, { once: true });
  externalSignal.addEventListener('abort', abort, { once: true });

  return combined.signal;
}

