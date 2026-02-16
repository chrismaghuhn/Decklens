-- Phase 2: Decision Tools — Proposals, Threads, Decisions, Tasks

-- 1. Change Proposals (Merge Requests für Decks)
CREATE TABLE IF NOT EXISTS change_proposals (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  proposed_by TEXT REFERENCES users(id),
  proposed_by_name TEXT,
  title TEXT NOT NULL,
  description TEXT,
  changes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_proposals_deck ON change_proposals(deck_id, status);

-- 2. Proposal Votes
CREATE TABLE IF NOT EXISTS proposal_votes (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES change_proposals(id),
  user_id TEXT,
  participant_name TEXT,
  vote TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_proposal_votes_proposal ON proposal_votes(proposal_id);

-- 3. Card Threads (Kommentare pro Karte)
CREATE TABLE IF NOT EXISTS card_threads (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  board TEXT NOT NULL,
  card_name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  participant_name TEXT,
  text TEXT NOT NULL,
  parent_id TEXT REFERENCES card_threads(id),
  reactions_json TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_card_threads_deck ON card_threads(deck_id, board, card_name);

-- 4. Decision Log
CREATE TABLE IF NOT EXISTS decision_log (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  card_name TEXT,
  user_id TEXT REFERENCES users(id),
  participant_name TEXT,
  decision_type TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_decision_log_deck ON decision_log(deck_id, created_at DESC);

-- 5. Deck Tasks (Kanban)
CREATE TABLE IF NOT EXISTS deck_tasks (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  assigned_to TEXT,
  created_by TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deck_tasks_deck ON deck_tasks(deck_id, status);
