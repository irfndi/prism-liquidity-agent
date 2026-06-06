-- Migration: Referral system tables
-- Created: 2026-06-06

CREATE TABLE IF NOT EXISTS referral_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS referrals (
    id TEXT PRIMARY KEY,
    referrer_user_id TEXT NOT NULL,
    referee_user_id TEXT NOT NULL UNIQUE,
    referral_code TEXT NOT NULL,
    credited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (referrer_user_id) REFERENCES users(id),
    FOREIGN KEY (referee_user_id) REFERENCES users(id),
    FOREIGN KEY (referral_code) REFERENCES referral_codes(code)
);

CREATE TABLE IF NOT EXISTS user_credits (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    amount REAL NOT NULL,
    reason TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_user ON referral_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referee ON referrals(referee_user_id);
CREATE INDEX IF NOT EXISTS idx_user_credits_user ON user_credits(user_id);
