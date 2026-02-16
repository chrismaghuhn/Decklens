-- Add Google OAuth support (multi-provider auth)
-- Idempotent: safe to re-run if columns already exist

-- Create unique index on google_id (will only succeed if column exists already)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL;
