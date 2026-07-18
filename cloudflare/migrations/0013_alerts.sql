-- Migration: proactive Telegram alerts (Wave 5)
-- Created: 2026-07-18
--
-- alerts: every engine-emitted alert is persisted before delivery so undelivered
--   alerts (user unlinked, bot unreachable, delivery disabled) remain auditable.
--   delivered_at IS NULL means the alert was stored but not pushed to Telegram.
-- users.alerts_enabled: per-user opt-out toggled via the bot `/alerts on|off`
--   command (1 = deliver, 0 = store-only). Alerts are a user-requested utility,
--   not telemetry, so this is independent of the feedback opt-out.

CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    pool_address TEXT,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    delivered_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_created ON alerts(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_alerts_user_undelivered ON alerts(user_id, delivered_at);

ALTER TABLE users ADD COLUMN alerts_enabled INTEGER NOT NULL DEFAULT 1;
