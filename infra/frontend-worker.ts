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
  [/^\/deck-editor\/?$/, '/deck-editor.html'],
  [/^\/decks\/.+/, '/deck-editor.html'],
  [/^\/decks\/?$/, '/decks.html'],
  [/^\/mtg\/?$/, '/mtg.html'],
  [/^\/yugioh\/?$/, '/yugioh.html'],
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // Proxy for Commander Spellbook: their API sends no CORS headers
      // for our origin, so the browser calls us and we call them.
      if (path === '/api/spellbook/find-my-combos' && request.method === 'POST') {
        const body = await request.text();
        if (body.length > 200_000) {
          return new Response('Payload too large', { status: 413 });
        }
        const upstream = await fetch('https://backend.commanderspellbook.com/find-my-combos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }

      // Same reason: proxy Spellbook's variants search (GET).
      if (path === '/api/spellbook/variants' && request.method === 'GET') {
        const upstream = await fetch(`https://backend.commanderspellbook.com/variants${url.search}`);
        return new Response(upstream.body, {
          status: upstream.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        });
      }

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
