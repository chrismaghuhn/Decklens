# AGENTS.md — Base44 Dev Environment Notes

## Project Overview
DeckLens is a Vite-based MTG & Yu-Gi-Oh! deck analyzer. The main entry point is `index.html` served by Vite dev server on port 3000. It's a pnpm monorepo with shared packages (game-engine, bot-core, bot-ml, card-data, db, rust-core).

## Running the App
- **Compose**: `docker compose -f docker-compose.base44.yml up -d`
- **Port**: 3000 (Vite dev server)
- **Health check**: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/` → 200
- **Package manager**: pnpm (via corepack in node:22-slim)

## Key Quirks
- **pnpm lockfile is outdated**: `pnpm-lock.yaml` doesn't match `package.json` (2 eslint deps were added). Must use `--no-frozen-lockfile`.
- **pnpm 12 ignores build scripts by default**: esbuild, sharp, tesseract.js, tfjs-node etc. have their postinstall scripts skipped. This is non-fatal — Vite 6.4 uses rolldown, not esbuild, so the dev server works without esbuild's build script. The install exits non-zero (ERR_PNPM_IGNORED_BUILDS) so the compose command uses `;` instead of `&&` to continue to the dev server.
- **Vite `open: true` in config**: The config has `server.open: true` which tries to spawn `xdg-open` (not available in the container). Pass `--no-open` to the vite CLI to suppress this error.
- **`pnpm dev -- --host` doesn't work**: pnpm passes the `--` separator through to Vite, which treats `--host` as a positional arg. Run `npx vite --host 0.0.0.0 --port 3000 --no-open` directly instead.

## Backend (Cloudflare Worker)
- The API is a Cloudflare Worker (`worker/`) using KV, D1, Durable Objects, and Analytics Engine — it cannot run locally in Docker.
- The Vite dev server has an optional proxy (`VITE_DECK_PROXY_TARGET`) to the worker. Without it, `/api` routes won't work but the core client-side deck analysis features still load.
- The worker URL in production is `https://decklens-api.chrisgarkisch.workers.dev` (hardcoded in CSP).

## Other Apps
- `apps/web` — a Next.js 14 app (separate, not the main preview entry point)
- `apps/api` — a NestJS API (separate, uses Drizzle ORM + PostgreSQL)
- These are workspace packages but not needed for the Vite dev server to run.
