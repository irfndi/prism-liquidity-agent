-- Migration: telegram_link_codes — unixepoch expiry + per-code attempt counter
-- Created: 2026-07-17
--
-- Security context (Wave 3 remediation):
--   * expires_at was ISO-8601 text compared against CURRENT_TIMESTAMP, which
--     compares lexicographically ('T' > ' ') and kept 10-minute codes valid
--     for ~24h. It is now INTEGER unixepoch seconds compared with unixepoch().
--   * attempts backs the 5-strike burn that thwarts code brute-forcing.
-- Link codes are ephemeral (10-minute TTL), so existing rows are discarded
-- rather than migrated.

DROP TABLE IF EXISTS telegram_link_codes;

CREATE TABLE telegram_link_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at DATETIME,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_telegram_link_codes_user ON telegram_link_codes(user_id);
