# [BUG] Concurrent /internal/flush-alerts invocations double-select and double-deliver the same alert rows

**File:** [`cloudflare/workers/telegram-bot/index.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cloudflare/workers/telegram-bot/index.ts#L698-L759) (lines 698, 709, 751, 759)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** medium  •  **Slug:** `other-race-condition`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The flush endpoint (line 698) selects undelivered rows with a plain `SELECT ... WHERE delivered_at IS NULL AND delivery_attempts < 5` (line 709) and only marks `delivered_at` after the Telegram send succeeds (line 751). There is no row claim/lease (e.g. an atomic UPDATE ... WHERE delivered_at IS NULL RETURNING). Two overlapping invocations — possible because the endpoint is triggered by an external GitHub Actions cron, which can overlap if a run exceeds the cadence, or be invoked concurrently by anyone holding BOT_API_SECRET — read the same batch, both deliver to Telegram, and both run the follow-up UPDATE. On the failure path, `delivery_attempts` is incremented twice for one logical attempt (line 759), pushing rows to the FLUSH_ABANDON_ATTEMPTS=5 abandon threshold prematurely and permanently dropping alerts that were merely transiently undeliverable.

## Recommendation

Claim rows atomically before delivery, e.g. `UPDATE alerts SET delivery_attempts = delivery_attempts + 1 WHERE id IN (selected) AND delivered_at IS NULL RETURNING *` (or set an `in_flight_at` lease) so each row is owned by exactly one flush invocation; only set delivered_at on success.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-28)
- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
