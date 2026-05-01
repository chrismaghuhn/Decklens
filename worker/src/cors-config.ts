/** Allowed browser origins for DeckLens API — keep in sync with worker fetch router CORS. */

export const ALLOWED_ORIGINS = [
  'https://decklens.chrisgarkisch.workers.dev',
  'https://decklens.app',
  'https://www.decklens.app',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
];

/** Reflect Origin when allowed; otherwise default to first entry (matches main worker behavior). */
export function resolveAllowedOrigin(request?: Request): string {
  const origin = request?.headers.get('Origin') || '';
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}
