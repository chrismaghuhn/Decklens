# Changelog

All notable changes to this project are documented here.

## 2026-02-09

### Added
- Phase 1 dynamic MTG discovery engine (Scryfall-backed) with caching and contextual query builder.
- Phase 2 archetype catalog + anti-meta recommendations (Commander/cEDH focused).
- Phase 3 feedback loop, ML personalization scaffolding, trend dashboard, and worker offload.
- Phase 4 community deck feed and real-time meta endpoints.
- Dedicated community page at `community.html` for deck posting and feed interaction.
- Monitoring endpoint: `GET /api/monitor/health`.
- Moderation endpoint: `POST /api/community/flag`.
- Optional D1 schema migration: `worker/migrations/0001_community.sql`.

### Changed
- Worker community persistence now supports layered backend:
  - D1 (`COMMUNITY_DB`) preferred
  - KV (`COMMUNITY_KV`) fallback
  - in-memory fallback
- Community posting now has anti-spam protections:
  - blocked term checks
  - cooldown per IP fingerprint
  - duplicate deck fingerprint window
- Vote endpoint now rate-limits repeated voting and supports DB-level duplicate checks.
- CSP updated to allow API worker origin from frontend pages.

### Fixed
- Moxfield/Archidekt import failures caused by CSP blocking cross-worker API calls.
- Frontend API origin routing now robust outside localhost.
