-- Migration: separate the alert claim from the delivery timestamp
-- Created: 2026-11-08
--
-- Before this migration `delivered_at` carried three different states in one
-- column: NULL (pending), 'claim:<ms>:<uuid>' (claimed by an in-flight flush),
-- and a seconds-resolution timestamp (delivered). Two defects followed from
-- that overload:
--   1. The stale-claim sweep compared the claim's millisecond epoch
--      (CAST(substr(delivered_at, 7) AS INTEGER)) against a millisecond cutoff
--      inside the same column that otherwise holds seconds, so the comparison
--      could not be trusted.
--   2. That sweep bumped `delivery_attempts` for a claim that was never
--      delivered, so three worker restarts retired an alert nobody had tried to
--      send.
--
-- After this migration the states are explicit and disjoint:
--   claim_token IS NULL, delivered_at IS NULL     -> pending
--   claim_token IS NOT NULL, delivered_at IS NULL -> claimed (claimed_at = ms)
--   delivered_at IS NOT NULL                      -> delivered (claim cleared)
-- `claimed_at` is a millisecond epoch so reclaiming compares like with like.
-- `delivery_attempts` now counts failed deliveries only.
--
-- Backfill: an old 'claim:...' token moves into claim_token with its embedded
-- millisecond time, and delivered_at is cleared so the row reads as claimed
-- rather than delivered. The first flush reclaims it once it ages past the
-- window, without charging it a delivery attempt.

ALTER TABLE alerts ADD COLUMN claim_token TEXT;
ALTER TABLE alerts ADD COLUMN claimed_at INTEGER;

UPDATE alerts
SET claim_token = delivered_at,
    claimed_at = CAST(substr(delivered_at, 7) AS INTEGER),
    delivered_at = NULL
WHERE delivered_at LIKE 'claim:%';

CREATE INDEX IF NOT EXISTS idx_alerts_claim_token ON alerts(claim_token);
