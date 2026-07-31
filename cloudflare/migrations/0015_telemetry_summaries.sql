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

INSERT OR IGNORE INTO install_event_summary
  (install_id, event, version, channel, platform, user_id, first_seen_at, last_seen_at, occurrence_count)
SELECT install_id,
       event,
       MAX(version),
       MAX(channel),
       MAX(platform),
       MAX(user_id),
       COALESCE(MIN(created_at), CURRENT_TIMESTAMP),
       COALESCE(MAX(created_at), CURRENT_TIMESTAMP),
       COUNT(*)
FROM installs
GROUP BY install_id, event;
