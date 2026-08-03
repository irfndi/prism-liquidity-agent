ALTER TABLE error_logs ADD COLUMN fingerprint TEXT;
ALTER TABLE error_logs ADD COLUMN first_seen_at DATETIME;
ALTER TABLE error_logs ADD COLUMN last_seen_at DATETIME;
ALTER TABLE error_logs ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE error_logs ADD COLUMN last_report_id TEXT;

UPDATE error_logs
SET first_seen_at = COALESCE(first_seen_at, created_at),
    last_seen_at = COALESCE(last_seen_at, created_at),
    last_report_id = COALESCE(last_report_id, id)
WHERE first_seen_at IS NULL OR last_seen_at IS NULL OR last_report_id IS NULL;

-- Backfill fingerprint for legacy rows so pre-existing rows do not carry NULL
-- fingerprints. SQLite treats NULLs as distinct in a unique index, so NULL
-- fingerprints would never match ON CONFLICT(user_id, fingerprint) and every
-- first new report for an existing signature would create a second row. The
-- placeholder ('legacy:' || id) gives each legacy row a stable non-null value
-- so the unique index is satisfied; new reports still compute their own
-- sha256(errorType:message) fingerprint, so legacy rows remain distinct from
-- (and do not merge into) new summaries — the placeholder only prevents
-- index-level NULL collisions.
UPDATE error_logs
SET fingerprint = COALESCE(fingerprint, 'legacy:' || id)
WHERE fingerprint IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_error_logs_user_fingerprint
  ON error_logs(user_id, fingerprint);

CREATE TABLE IF NOT EXISTS error_report_receipts (
  user_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  summary_applied INTEGER NOT NULL DEFAULT 0,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, report_id)
);

CREATE INDEX IF NOT EXISTS idx_error_report_receipts_received
  ON error_report_receipts(received_at);

CREATE TABLE IF NOT EXISTS install_event_summary (
  install_id TEXT NOT NULL,
  event TEXT NOT NULL,
  version TEXT,
  channel TEXT,
  platform TEXT,
  user_id TEXT,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (install_id, event)
);

CREATE INDEX IF NOT EXISTS idx_install_event_summary_last_seen
  ON install_event_summary(last_seen_at);

-- Backfill install_event_summary from the raw installs table. Metadata
-- (version/channel/platform/user_id) is taken from the NEWEST row per
-- install_id/event group via bare-column selection on MAX(created_at), matching
-- the latest-write-wins rule the runtime upsert applies to later pings — not
-- the lexicographic MAX() which would order "0.9.0" above "0.10.0".
INSERT OR IGNORE INTO install_event_summary
  (install_id, event, version, channel, platform, user_id, first_seen_at, last_seen_at, occurrence_count)
SELECT install_id,
       event,
       version,
       channel,
       platform,
       user_id,
       COALESCE(MIN(created_at), CURRENT_TIMESTAMP),
       COALESCE(MAX(created_at), CURRENT_TIMESTAMP),
       COUNT(*)
FROM installs
GROUP BY install_id, event;
