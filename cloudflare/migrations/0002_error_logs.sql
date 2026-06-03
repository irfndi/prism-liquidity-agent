-- Migration: Error reporting table for privacy-first telemetry
-- Created: 2026-06-03
-- See: https://github.com/irfndi/prism-liqudity-agent/issues/29

-- Error logs table (agent-side error reports)
CREATE TABLE IF NOT EXISTS error_logs (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    error_type TEXT NOT NULL,
    message TEXT NOT NULL,
    stack_trace TEXT,
    prism_version TEXT NOT NULL,
    platform TEXT,
    severity TEXT DEFAULT 'error',
    is_recoverable INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for dashboard queries by agent
CREATE INDEX IF NOT EXISTS idx_error_logs_agent_created ON error_logs(agent_id, created_at);
