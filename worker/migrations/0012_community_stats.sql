-- ============================================================
-- Migration 0012: Community Deck Stats Fields
-- ============================================================
-- Adds stats tracking fields to community_decks for aggregation
-- ============================================================

-- Add stats fields to community_decks (for future win/loss tracking)
ALTER TABLE community_decks ADD COLUMN win_count INTEGER DEFAULT 0;
ALTER TABLE community_decks ADD COLUMN loss_count INTEGER DEFAULT 0;
ALTER TABLE community_decks ADD COLUMN games_played INTEGER DEFAULT 0;
ALTER TABLE community_decks ADD COLUMN power_level REAL DEFAULT 5.0; -- 1-10 scale
ALTER TABLE community_decks ADD COLUMN price REAL DEFAULT 0.0; -- EUR
ALTER TABLE community_decks ADD COLUMN last_updated INTEGER DEFAULT 0; -- Unix timestamp

-- Create index for aggregation queries
CREATE INDEX IF NOT EXISTS idx_community_decks_commander ON community_decks(commander);
