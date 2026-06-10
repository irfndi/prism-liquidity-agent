-- Migration: Add operator fee columns to revenue_events
-- Created: 2026-06-10

ALTER TABLE revenue_events ADD COLUMN operator_fee_x REAL NOT NULL DEFAULT 0;
ALTER TABLE revenue_events ADD COLUMN operator_fee_y REAL NOT NULL DEFAULT 0;
