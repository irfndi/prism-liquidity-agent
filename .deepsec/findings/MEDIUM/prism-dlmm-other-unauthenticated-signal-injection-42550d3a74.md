# [MEDIUM] Copy-trading signal feed is unauthenticated; wallet allowlist is spoofable string matching

**File:** [`engine/copy-trading-signals.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/copy-trading-signals.ts#L97-L142) (lines 97, 101, 129, 133, 142)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `other-unauthenticated-signal-injection`

## Owners

**Suggested assignee:** `irfandi@users.noreply.github.com` _(via last-committer)_

## Finding

fetchSignals() fetches JSON from the operator-configured COPY_SIGNALS_ENDPOINT with no credentials, no payload signature verification, and no URL-scheme validation (config-service.ts accepts any string, so http:// endpoints are allowed). The wallet allowlist check `allowed.has(signal.wallet)` is a plain string match against payload data — an attacker who compromises the endpoint or MITMs an http:// feed can set `wallet` to any allowlisted address and inject fresh signals (observedAt is attacker-controlled). The `signature` field is only used as a dedup key and is never cryptographically verified against the claimed wallet's on-chain activity. Injected signals add up to +0.05 confidence via applyCopySignalBoost(), which is applied BEFORE risk evaluation and, per the comments in program.ts (~L3197 and ~L5958), is explicitly intended to lift borderline decisions over CONFIDENCE_THRESHOLD. On a live (PAPER_TRADING=false) deployment this could flip marginal ENTER/REBALANCE decisions toward attacker-preferred pools. Mitigations that limit severity: feature is disabled by default (COPY_SIGNALS_ENABLED=false), requires an explicit endpoint + wallet list, boost is hard-capped at 0.05 by both validatedNumber("COPY_SIGNALS_MAX_BOOST", 0, 0.05, 0.05) and Math.min in getBoost, signals must match the exact pool currently being evaluated and pass staleness filters, and all safety screens (blacklist/freeze/token-risk) and risk gates still run after the boost.

## Recommendation

Reject non-https endpoints at config validation; add payload authentication (e.g., HMAC shared secret in an Authorization header verified with constant-time comparison); and/or verify the Solana transaction `signature` actually references the claimed wallet and pool before counting a signal. Consider binding dedup keys to verified signatures only.

## Recent committers (`git log`)

- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
- irfandi marsya <join.mantap@gmail.com> (2026-07-19)
