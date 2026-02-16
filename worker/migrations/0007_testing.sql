-- Phase 5: Collaborative Testing
-- Test Session Logs + Sideboard Plans

CREATE TABLE IF NOT EXISTS test_sessions (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  player_id TEXT REFERENCES users(id),
  player_name TEXT,
  opening_hand_json TEXT,
  mulligan_count INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  notes TEXT,
  key_moments_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_test_sessions_deck ON test_sessions(deck_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sideboard_plans (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  matchup TEXT NOT NULL,
  in_cards_json TEXT NOT NULL,
  out_cards_json TEXT NOT NULL,
  notes TEXT,
  created_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sideboard_plans_deck ON sideboard_plans(deck_id, matchup);
