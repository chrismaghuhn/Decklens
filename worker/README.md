# DeckLens API Worker — Deployment Guide

## What This Does

A Cloudflare Worker that proxies Moxfield + Archidekt API requests and ingests analytics events.
Without it, browsers block direct API calls (CORS/Cloudflare protection).

**Flow:**
```
Browser → decklens.app/api/deck/moxfield/ABC123
       → Worker → api2.moxfield.com/v3/decks/all/ABC123
       → JSON response back to browser

Browser → decklens.app/api/analytics/events
       → Worker validates schema + optional forward to webhook
       → 202 Accepted

Browser → decklens.app/api/recommendations/mtg
       → Worker runs Recommendation Engine v1 (Top-5 cut/add pairs)
       → JSON response for UI
```

## Analytics Endpoints

- `POST /api/analytics/events` - ingest single event envelope
- `GET /api/analytics/health` - required events + in-memory counters
- `GET /api/analytics/dashboard?days=7` - MVP funnel KPIs + core metrics + feedback queue

## Recommendation Endpoint

- `POST /api/recommendations/mtg` - returns `dd201-v1` recommendation payload
- Input: deck (+ optional collection, meta mode)
- Output: top prioritized recommendations with heuristic breakdown and cut/add pairs
- Reliability: includes cache/retry/degradation diagnostics under `request` and optional `warnings`

## Community + Real-time Meta Endpoints

- `GET /api/community/decks` - fetch public deck feed (`?format=commander|cedh&q=...&limit=...`)
- `POST /api/community/decks` - create community post
- `POST /api/community/vote` - upvote a deck
- `POST /api/community/flag` - abuse/moderation flag
- `GET /api/meta/realtime` - live meta snapshot
- `GET /api/monitor/health` - health/ops metrics for dashboards

Persistence priority:

1. `COMMUNITY_DB` (D1) - preferred
2. `COMMUNITY_KV` - fallback
3. in-memory - last fallback

Optional worker secrets:

- `ANALYTICS_WEBHOOK_URL` - forwarding target for accepted events
- `ANALYTICS_WEBHOOK_TOKEN` - bearer token for forwarding

## Setup (5 minutes)

### 1. Install Wrangler (if not already)
```bash
npm install -g wrangler
```

### 2. Login to Cloudflare
```bash
wrangler login
```

### 3. Deploy the Worker
```bash
cd worker
wrangler deploy
```

This creates a worker at `decklens-api.<your-subdomain>.workers.dev`.

### 4. Add Route to Your Domain

In Cloudflare Dashboard:
1. Go to **Workers & Pages** → **decklens-api**
2. Click **Settings** → **Triggers** → **Add Route**
3. Route: `decklens.app/api/*`
4. Zone: `decklens.app`
5. Save

### 5. Test It
```bash
# Should return deck JSON:
curl https://decklens.app/api/deck/archidekt/1/
curl https://decklens.app/api/deck/moxfield/oEWXWHM5eEGMmopExLWRCA

# Health check:
curl https://decklens.app/api/health
```

### 6. Deploy the Updated Frontend
```bash
cd ..
npm run build
# Deploy dist/ to Cloudflare Pages as usual
```

## Security

- Rate limited: 180 req/min per IP
- Community post cooldown + duplicate deck fingerprint guard
- Basic blocked-content moderation + abuse flags endpoint
- Deck ID validation (regex) prevents injection
- Only GET allowed, only two whitelisted upstream APIs
- 5 min cache on responses

## Optional D1 Setup (recommended)

```bash
cd worker
wrangler d1 create decklens-community
```

Then add the DB binding to `wrangler.toml` and apply migration:

```bash
wrangler d1 migrations apply decklens-community
```

Migration file:

- `worker/migrations/0001_community.sql`

## Cost

**Free.** Cloudflare Workers free tier = 100,000 requests/day.
Even with heavy traffic, you won't hit this.

## Troubleshooting

**"Not found" on /api/deck/...**
→ Route not configured. Check step 4.

**Worker deploys but route doesn't work**
→ Make sure zone = `decklens.app` (not workers.dev)

**Moxfield returns 404**
→ Deck is private or ID is wrong
