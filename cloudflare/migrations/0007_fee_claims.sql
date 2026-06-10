-- Migration: Fee claims tracking table
-- Created: 2026-06-10

CREATE TABLE IF NOT EXISTS fee_claims (
    id TEXT PRIMARY KEY,
    install_id TEXT NOT NULL,
    user_id TEXT,
    pool_address TEXT NOT NULL,
    position_pubkey TEXT NOT NULL,
    fee_x REAL NOT NULL DEFAULT 0,
    fee_y REAL NOT NULL DEFAULT 0,
    platform_fee_x REAL NOT NULL DEFAULT 0,
    platform_fee_y REAL NOT NULL DEFAULT 0,
    net_fee_x REAL NOT NULL DEFAULT 0,
    net_fee_y REAL NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'free',
    tx_signature TEXT,
    fee_transfer_tx_signature TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_fee_claims_install ON fee_claims(install_id);
CREATE INDEX IF NOT EXISTS idx_fee_claims_pool ON fee_claims(pool_address);
CREATE INDEX IF NOT EXISTS idx_fee_claims_created ON fee_claims(created_at);
