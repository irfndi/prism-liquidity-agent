-- Migration: Agent feedback storage for GitHub-independent submissions
-- Created: 2026-07-07

CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    category TEXT NOT NULL,
    severity TEXT NOT NULL,
    summary TEXT NOT NULL,
    details TEXT,
    related_files TEXT,
    context_json TEXT,
    prism_version TEXT,
    platform TEXT,
    install_method TEXT,
    runtime TEXT,
    hash TEXT NOT NULL,
    github_issue_number INTEGER,
    github_issue_url TEXT,
    reported_at INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_agent_reported ON feedback(agent_id, reported_at);
CREATE INDEX IF NOT EXISTS idx_feedback_hash ON feedback(hash);
