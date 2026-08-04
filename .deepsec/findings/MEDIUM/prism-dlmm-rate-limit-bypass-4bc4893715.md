# [MEDIUM] All KV rate limiters use a non-atomic get→check→put counter (TOCTOU race)

**File:** [`cloudflare/workers/api/index.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cloudflare/workers/api/index.ts#L703-L2169) (lines 703, 733, 823, 831, 944, 1416, 1485, 1635, 1838, 2169)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `rate-limit-bypass`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

Every rate limiter in the worker follows the pattern `count = await CACHE.get(rateKey); if (count >= LIMIT) 429; ... await CACHE.put(rateKey, String(count + 1))` — e.g. /v1/register (limit 5/h/IP, lines 703-733), /v1/link-telegram/confirm (10/h/IP, lines 823-831), /v1/register-telegram (lines 944-952), /v1/issue & /v1/feedback (10/h/IP), /v1/errors/report (100/h/IP, lines 1416-1424), /v1/errors/batch (50/h/IP), /v1/alerts (60/h/user, lines 1635-1644), /v1/installs/ping (100/h/IP), /v1/revenue/log (200/h/IP). Concurrent requests all read the same counter before any write lands, so a parallel burst of N requests passes the check with count=0 and admits all N — the per-IP cap is exceeded by the burst width in a single shot. Concrete impact: mass Sybil account creation through /v1/register in one burst (each account gets a free subscription and can participate in the credit-bearing referral program), and burst confirm attempts against /v1/link-telegram/confirm far beyond 10. Full link-code brute force remains infeasible (64-bit CSPRNG codes + 5-strike burn), so this is abuse amplification rather than account takeover. Corrupted/non-numeric KV values also reset the counter to 0 (parseInt NaN → 0), fail-open.

## Recommendation

Use an atomic increment primitive (e.g. a D1 counter table with `UPDATE ... SET n = n + 1` + read-back, KV CAS retry loop, or Cloudflare Rate Limiting bindings) instead of read-modify-write on KV, so concurrent bursts cannot all pass the check.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
