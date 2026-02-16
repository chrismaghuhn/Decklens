CREATE TABLE IF NOT EXISTS community_decks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  format TEXT NOT NULL,
  commander TEXT NOT NULL,
  archetype TEXT NOT NULL,
  decklist TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  upvotes INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  tags_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS community_votes (
  deck_id TEXT NOT NULL,
  voter_ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(deck_id, voter_ip_hash)
);

CREATE TABLE IF NOT EXISTS community_abuse_flags (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  reporter_ip_hash TEXT NOT NULL,
  reported_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_community_decks_created_at ON community_decks(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_community_decks_upvotes ON community_decks(upvotes DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_flags_reported_at ON community_abuse_flags(reported_at DESC);
