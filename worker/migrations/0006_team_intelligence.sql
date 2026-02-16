-- Phase 4: Team Intelligence
-- Shared Collection Pool, Card Packages, Team Constraints

-- Shared Collections (pro User, persistent)
CREATE TABLE IF NOT EXISTS user_collections (
  user_id TEXT NOT NULL REFERENCES users(id),
  card_name TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 1,
  foil INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, card_name)
);
CREATE INDEX IF NOT EXISTS idx_user_collections_card ON user_collections(card_name);

-- Card Packages (wiederverwendbare Bausteine)
CREATE TABLE IF NOT EXISTS card_packages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  cards_json TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  is_public INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  upvotes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_card_packages_category ON card_packages(category);

-- Team Constraints (pro Deck / Collab-Session)
CREATE TABLE IF NOT EXISTS team_constraints (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  constraint_type TEXT NOT NULL,
  constraint_value TEXT NOT NULL,
  set_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_team_constraints_deck ON team_constraints(deck_id);
