-- Fix: Add missing columns to deck_snapshots that handler code references
-- The 0004_versioning.sql migration created deck_snapshots with user_id and metadata_json,
-- but the handler code (index.ts handleGetSnapshots/handleCreateSnapshot) references
-- snapshot_type, card_count, and created_by instead.

ALTER TABLE deck_snapshots ADD COLUMN snapshot_type TEXT DEFAULT 'auto';
ALTER TABLE deck_snapshots ADD COLUMN card_count INTEGER DEFAULT 0;
ALTER TABLE deck_snapshots ADD COLUMN created_by TEXT;
