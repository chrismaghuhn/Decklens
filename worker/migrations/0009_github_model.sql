-- ============================================================
-- Migration 0009: "GitHub for Decks" Data Model
-- ============================================================
-- Adds delta-based commit system, pull requests, reviews,
-- checks, issues, releases, permissions, forks, inventory,
-- templates, combo lines, and draft/sealed support.
-- ============================================================

-- ==================== Deck Repos ====================
-- Extends the concept of user_decks into full repositories
CREATE TABLE IF NOT EXISTS deck_repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  owner_id TEXT NOT NULL,
  visibility TEXT DEFAULT 'private',  -- private / unlisted / public
  format TEXT DEFAULT 'commander',
  default_branch TEXT DEFAULT 'main',
  upstream_repo_id TEXT,              -- NULL unless forked
  fork_count INTEGER DEFAULT 0,
  star_count INTEGER DEFAULT 0,
  settings_json TEXT DEFAULT '{}',    -- branch protection, required checks, playgroup rules
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (upstream_repo_id) REFERENCES deck_repos(id)
);
CREATE INDEX IF NOT EXISTS idx_repos_owner ON deck_repos(owner_id);
CREATE INDEX IF NOT EXISTS idx_repos_visibility ON deck_repos(visibility);

-- ==================== Repo Branches ====================
CREATE TABLE IF NOT EXISTS repo_branches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  head_commit_id TEXT,
  base_branch_id TEXT,
  is_protected INTEGER DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id),
  UNIQUE(repo_id, name)
);
CREATE INDEX IF NOT EXISTS idx_branches_repo ON repo_branches(repo_id);

-- ==================== Deck Commits (DAG) ====================
CREATE TABLE IF NOT EXISTS deck_commits (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  parent_id TEXT,                     -- NULL for initial commit
  parent2_id TEXT,                    -- second parent for merge commits
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  message TEXT NOT NULL,
  patch_json TEXT NOT NULL,           -- DeckPatchOp[] serialized
  boards_snapshot TEXT,               -- full state cache (nullable, computed on demand)
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);
CREATE INDEX IF NOT EXISTS idx_commits_repo ON deck_commits(repo_id);
CREATE INDEX IF NOT EXISTS idx_commits_parent ON deck_commits(parent_id);

-- ==================== Pull Requests ====================
CREATE TABLE IF NOT EXISTS deck_pull_requests (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  source_branch_id TEXT NOT NULL,
  target_branch_id TEXT NOT NULL,
  source_repo_id TEXT,                -- for cross-repo (fork) PRs
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  status TEXT DEFAULT 'open',         -- open / merged / closed
  merge_commit_id TEXT,
  merge_strategy TEXT,                -- squash / merge / rebase
  labels_json TEXT DEFAULT '[]',
  assignees_json TEXT DEFAULT '[]',
  required_approvals INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  merged_at TEXT,
  closed_at TEXT,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id),
  FOREIGN KEY (source_branch_id) REFERENCES repo_branches(id),
  FOREIGN KEY (target_branch_id) REFERENCES repo_branches(id),
  UNIQUE(repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_prs_repo ON deck_pull_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_prs_status ON deck_pull_requests(status);

-- ==================== PR Reviews ====================
CREATE TABLE IF NOT EXISTS pr_reviews (
  id TEXT PRIMARY KEY,
  pr_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  reviewer_name TEXT NOT NULL,
  state TEXT NOT NULL,                -- APPROVED / CHANGES_REQUESTED / COMMENTED
  body TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  FOREIGN KEY (pr_id) REFERENCES deck_pull_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_pr ON pr_reviews(pr_id);

-- ==================== PR Comments (inline + general) ====================
CREATE TABLE IF NOT EXISTS pr_comments (
  id TEXT PRIMARY KEY,
  pr_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  commit_id TEXT,                     -- NULL for general conversation
  path TEXT,                          -- "mainboard:Lightning Bolt" or "meta:description"
  line_context TEXT,                  -- for inline diff comments
  parent_comment_id TEXT,             -- for threaded replies
  created_at TEXT NOT NULL,
  updated_at TEXT,
  FOREIGN KEY (pr_id) REFERENCES deck_pull_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_comments_pr ON pr_comments(pr_id);

-- ==================== Check Runs ====================
CREATE TABLE IF NOT EXISTS check_runs (
  id TEXT PRIMARY KEY,
  pr_id TEXT NOT NULL,
  commit_id TEXT NOT NULL,
  check_name TEXT NOT NULL,           -- format_validation, regression_test, tag_quotas, budget, etc.
  status TEXT DEFAULT 'pending',      -- pending / running / pass / fail / error
  report_json TEXT,                   -- { summary, details[], metrics }
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (pr_id) REFERENCES deck_pull_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_checks_pr ON check_runs(pr_id);
CREATE INDEX IF NOT EXISTS idx_checks_commit ON check_runs(commit_id);

-- ==================== Issues ====================
CREATE TABLE IF NOT EXISTS repo_issues (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  status TEXT DEFAULT 'open',         -- open / closed
  labels_json TEXT DEFAULT '[]',
  assignees_json TEXT DEFAULT '[]',
  linked_pr_id TEXT,                  -- "closes #N" linkage
  kanban_column TEXT DEFAULT 'backlog', -- backlog / in_progress / done
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id),
  UNIQUE(repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_repo ON repo_issues(repo_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON repo_issues(status);

-- ==================== Issue Comments ====================
CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES repo_issues(id)
);
CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id);

-- ==================== Releases / Tags ====================
CREATE TABLE IF NOT EXISTS repo_releases (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT DEFAULT '',               -- release notes (auto-generated + editable)
  commit_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  boards_snapshot TEXT NOT NULL,       -- frozen deck state
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id),
  UNIQUE(repo_id, tag_name)
);
CREATE INDEX IF NOT EXISTS idx_releases_repo ON repo_releases(repo_id);

-- ==================== Repo Collaborators ====================
CREATE TABLE IF NOT EXISTS repo_collaborators (
  repo_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,                 -- OWNER / MAINTAINER / CONTRIBUTOR / REVIEWER / VIEWER
  invited_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, user_id),
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);

-- ==================== Audit Log ====================
CREATE TABLE IF NOT EXISTS repo_audit_log (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,               -- branch.create, pr.merge, settings.update, etc.
  details_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);
CREATE INDEX IF NOT EXISTS idx_audit_repo ON repo_audit_log(repo_id);
CREATE INDEX IF NOT EXISTS idx_audit_time ON repo_audit_log(created_at);

-- ==================== Shared Inventory (Feature 8) ====================
CREATE TABLE IF NOT EXISTS shared_inventory (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  card_name TEXT NOT NULL,
  qty_owned INTEGER DEFAULT 0,
  qty_reserved INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE(owner_id, card_name)
);
CREATE INDEX IF NOT EXISTS idx_inventory_owner ON shared_inventory(owner_id);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (inventory_id) REFERENCES shared_inventory(id),
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);
CREATE INDEX IF NOT EXISTS idx_reservations_inventory ON inventory_reservations(inventory_id);

-- ==================== Draft/Sealed Sessions (Feature 12) ====================
CREATE TABLE IF NOT EXISTS draft_sessions (
  id TEXT PRIMARY KEY,
  format TEXT NOT NULL,               -- draft / sealed
  host_id TEXT NOT NULL,
  status TEXT DEFAULT 'waiting',      -- waiting / active / completed
  settings_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_draft_host ON draft_sessions(host_id);

CREATE TABLE IF NOT EXISTS draft_participants (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  seat_number INTEGER NOT NULL,
  pool_json TEXT DEFAULT '[]',
  PRIMARY KEY (session_id, user_id),
  FOREIGN KEY (session_id) REFERENCES draft_sessions(id)
);

-- ==================== Deck Templates (Feature N) ====================
CREATE TABLE IF NOT EXISTS deck_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  author_id TEXT NOT NULL,
  format TEXT NOT NULL,
  boards_json TEXT NOT NULL,
  tags_json TEXT DEFAULT '[]',
  is_public INTEGER DEFAULT 0,
  use_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_templates_format ON deck_templates(format);
CREATE INDEX IF NOT EXISTS idx_templates_public ON deck_templates(is_public);

-- ==================== Combo Lines Library (Feature 2) ====================
CREATE TABLE IF NOT EXISTS combo_lines (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  cards_json TEXT NOT NULL,           -- ["Card A", "Card B", "Card C"]
  steps_json TEXT DEFAULT '[]',       -- ordered activation steps
  tags_json TEXT DEFAULT '[]',        -- ["infinite", "wincon", "value"]
  author_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (repo_id) REFERENCES deck_repos(id)
);
CREATE INDEX IF NOT EXISTS idx_lines_repo ON combo_lines(repo_id);
