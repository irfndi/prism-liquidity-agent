-- Migration: alert delivery retry tracking
-- Created: 2026-07-28
--
-- The Telegram bot now delivers alerts by POLLING the `alerts` table (the
-- bot's `POST /internal/flush-alerts` endpoint, flushed by an external GitHub
-- Actions cron) instead of the dead API->bot worker->worker forward, which
-- Cloudflare rejects on the same workers.dev zone with error 1042. Each failed
-- send bumps `delivery_attempts`; a row that reaches 5 attempts is abandoned
-- (filtered out of future flushes) so a permanently undeliverable alert cannot
-- be retried forever. `delivered_at IS NULL` still means "not yet delivered".

ALTER TABLE alerts ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0;
