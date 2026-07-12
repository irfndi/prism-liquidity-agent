ALTER TABLE feedback ADD COLUMN user_id TEXT;
ALTER TABLE error_logs ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_feedback_user_hash
  ON feedback(user_id, agent_id, hash);
CREATE INDEX IF NOT EXISTS idx_error_logs_user_created
  ON error_logs(user_id, created_at);

CREATE TABLE IF NOT EXISTS audit_event_summary (
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  event_key TEXT NOT NULL,
  details TEXT,
  first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, action, event_key),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_audit_event_summary_last_seen
  ON audit_event_summary(last_seen_at);

DELETE FROM audit_log WHERE action IN ('config_fetch', 'login');
