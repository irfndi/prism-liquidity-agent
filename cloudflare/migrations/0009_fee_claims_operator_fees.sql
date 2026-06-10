-- Migration: Add operator fee columns to fee_claims
-- Created: 2026-06-10

ALTER TABLE fee_claims ADD COLUMN operator_fee_x REAL NOT NULL DEFAULT 0;
ALTER TABLE fee_claims ADD COLUMN operator_fee_y REAL NOT NULL DEFAULT 0;
