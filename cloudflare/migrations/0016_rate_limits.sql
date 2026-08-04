-- Migration: atomic per-key rate-limit counters (replaces non-atomic KV
-- get→check→put read-modify-write, which is a TOCTOU race under concurrent
-- requests). One row per rate-limit key; the count is incremented atomically
-- with `UPDATE ... SET count = count + 1 RETURNING count`, so concurrent
-- bursts cannot all pass the check.
-- Created: 2026-08-03

CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
