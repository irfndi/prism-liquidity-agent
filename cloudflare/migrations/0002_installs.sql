-- Migration: Anonymous install telemetry
-- Created: 2026-06-03
-- Tracks install/setup/dev_start/register events with a client-generated
-- anonymous install_id. No PII; no auth required.

CREATE TABLE IF NOT EXISTS installs (
    id TEXT PRIMARY KEY,
    install_id TEXT NOT NULL,
    event TEXT NOT NULL,
    version TEXT,
    channel TEXT,
    platform TEXT,
    user_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_installs_install_id ON installs(install_id);
CREATE INDEX IF NOT EXISTS idx_installs_created ON installs(created_at);
CREATE INDEX IF NOT EXISTS idx_installs_event ON installs(event);
