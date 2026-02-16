-- ============================================================
-- Migration 0011: Watch Features
-- ============================================================
-- Adds:
-- - Watch Rules for User Notifications
-- ============================================================

CREATE TABLE IF NOT EXISTS deck_watch_rules (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);

CREATE INDEX IF NOT EXISTS idx_watch_user ON deck_watch_rules(user_id);
CREATE INDEX IF NOT EXISTS idx_watch_repo ON deck_watch_rules(repo_id);
