-- Phase 1: Versioning — Branches, Activity Log, Deck Snapshots

-- Deck Branches (variants of a deck)
CREATE TABLE IF NOT EXISTS deck_branches (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_branch_id TEXT,
  boards_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deck_branches_deck ON deck_branches(deck_id);

-- Activity Log (persistent, cross-session)
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  branch_id TEXT,
  user_id TEXT REFERENCES users(id),
  participant_name TEXT,
  action TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_log_deck ON activity_log(deck_id, created_at DESC);

-- Deck Snapshots (server-side, not just localStorage)
CREATE TABLE IF NOT EXISTS deck_snapshots (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  branch_id TEXT,
  user_id TEXT REFERENCES users(id),
  label TEXT,
  boards_json TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deck_snapshots_deck ON deck_snapshots(deck_id, created_at DESC);