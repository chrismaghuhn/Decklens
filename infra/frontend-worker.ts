/**
 * DeckLens Frontend Worker
 * Handles SPA routing for Cloudflare Workers deployment.
 * Mirrors the rewrite rules from _redirects (which only works on CF Pages).
 */

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
}

// Rewrite rules: [pattern, target HTML file]
// Order matters – more specific patterns first
const REWRITES: [RegExp, string][] = [
  [/^\/play\/?$/, '/play-vs-bot.html'],
  [/^\/play\/.+/, '/play-vs-bot.html'],
  [/^\/train-bot\/?$/, '/train-bot.html'],
  [/^\/deck-editor\/?$/, '/deck-editor.html'],
  [/^\/decks\/public\/?$/, '/decks-public.html'],
  [/^\/decks\/.+/, '/deck-editor.html'],
  [/^\/d\/.+/, '/deck-public.html'],
  [/^\/dashboard\/executive\/?$/, '/executive-dashboard.html'],
  [/^\/dashboard\/growth\/?$/, '/growth-dashboard.html'],
  [/^\/dashboard\/technical\/?$/, '/technical-dashboard.html'],
  [/^\/dashboard\/community\/?$/, '/community-dashboard.html'],
  [/^\/dashboard\/public\/?$/, '/public-dashboard.html'],
  [/^\/dashboard\/?$/, '/dashboard-hub.html'],
  [/^\/dashboard\/.+/, '/dashboard-hub.html'],
  [/^\/deckhub\/?/, '/deckhub.html'],
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Check SPA rewrite rules
      for (const [pattern, target] of REWRITES) {
        if (pattern.test(path)) {
          // Rewrite: serve the target HTML but keep the original browser URL
          const rewrittenUrl = new URL(target, url.origin);
          const rewrittenRequest = new Request(rewrittenUrl.toString(), {
            method: request.method,
            headers: request.headers,
          });
          return env.ASSETS.fetch(rewrittenRequest);
        }
      }

      // Default: serve static asset from dist/ as-is
      return env.ASSETS.fetch(request);
    } catch (e: any) {
      return new Response(`Internal Error: ${e?.message || 'Unknown'}`, { status: 500 });
    }
  },
};
