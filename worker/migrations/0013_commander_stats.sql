-- ============================================================
-- Migration 0013: Commander Stats Table
-- ============================================================
-- Creates commander_stats table for aggregated commander statistics
-- ============================================================

CREATE TABLE IF NOT EXISTS commander_stats (
  commander_name TEXT PRIMARY KEY,
  win_rate REAL DEFAULT 0.0,                 -- % (0-100)
  meta_percentage REAL DEFAULT 0.0,          -- % of all decks (0-100)
  total_decks INTEGER DEFAULT 0,             -- Number of decks with this commander
  avg_power_level REAL DEFAULT 5.0,          -- 1-10 scale
  avg_deck_price REAL DEFAULT 0.0,           -- EUR
  avg_games_played INTEGER DEFAULT 0,        -- Avg games per deck
  popularity_rank INTEGER DEFAULT 0,         -- 1 = most popular
  last_updated INTEGER NOT NULL              -- Unix timestamp
);

-- Index for fast lookups
CREATE INDEX IF NOT EXISTS idx_commander_stats_popularity ON commander_stats(popularity_rank ASC);
CREATE INDEX IF NOT EXISTS idx_commander_stats_updated ON commander_stats(last_updated DESC);
