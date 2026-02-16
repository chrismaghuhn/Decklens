-- ============================================================
-- Migration 0010: QOL Features - Draft PRs, Scheduling, Templates, Webhooks, Activity
-- ============================================================
-- Adds:
-- - PR Draft/WIP Support
-- - Auto-Merge Scheduling
-- - Repo Templates
-- - Webhooks
-- - Activity Feed
-- - Enhanced Search
-- ============================================================

-- ==================== PR Draft/WIP Support ====================
ALTER TABLE deck_pull_requests ADD COLUMN is_draft INTEGER DEFAULT 0;
ALTER TABLE deck_pull_requests ADD COLUMN draft_ready INTEGER DEFAULT 0;
ALTER TABLE deck_pull_requests ADD COLUMN merge_scheduled_at TEXT;
ALTER TABLE deck_pull_requests ADD COLUMN merge_schedule TEXT; -- "daily:09:00" or "weekly:monday"

-- ==================== Webhooks ====================
CREATE TABLE IF NOT EXISTS repo_webhooks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '[]',
  secret TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);
CREATE INDEX IF NOT EXISTS idx_webhooks_repo ON repo_webhooks(repo_id);

-- ==================== Activity Feed ====================
CREATE TABLE IF NOT EXISTS activity_feed (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);
CREATE INDEX IF NOT EXISTS idx_activity_repo ON activity_feed(repo_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_feed(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_feed(actor_id);

-- ==================== User Stats ====================
CREATE TABLE IF NOT EXISTS user_stats (
  user_id TEXT PRIMARY KEY,
  repos_created INTEGER DEFAULT 0,
  prs_opened INTEGER DEFAULT 0,
  prs_merged INTEGER DEFAULT 0,
  reviews_done INTEGER DEFAULT 0,
  commits_count INTEGER DEFAULT 0,
  last_active_at TEXT,
  updated_at TEXT NOT NULL
);

-- ==================== Search Index ====================
CREATE TABLE IF NOT EXISTS deck_search_index (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  branch_id TEXT,
  card_name TEXT NOT NULL,
  card_names_text TEXT, -- normalized for FTS
  deck_name TEXT,
  deck_description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);
CREATE INDEX IF NOT EXISTS idx_search_repo ON deck_search_index(repo_id);
CREATE INDEX IF NOT EXISTS idx_search_cards ON deck_search_index(card_name);

-- ==================== Review Templates ====================
ALTER TABLE deck_repos ADD COLUMN review_template_json TEXT DEFAULT '[]';

-- ==================== Deck Health Snapshots ====================
CREATE TABLE IF NOT EXISTS deck_health_snapshots (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  health_json TEXT NOT NULL,
  curve_json TEXT,
  mana_base_json TEXT,
  combo_count INTEGER DEFAULT 0,
  avg_cmc REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);
CREATE INDEX IF NOT EXISTS idx_health_repo ON deck_health_snapshots(repo_id);
CREATE INDEX IF NOT EXISTS idx_health_commit ON deck_health_snapshots(commit_id);

-- ==================== Scheduled Jobs ====================
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id TEXT PRIMARY KEY,
  job_type TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  executed_at TEXT,
  status TEXT DEFAULT 'pending',
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_pending ON scheduled_jobs(status, scheduled_for);
