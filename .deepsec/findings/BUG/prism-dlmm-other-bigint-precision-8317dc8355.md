# [BUG] BigInt→Number precision loss on liquidity supply in concentration multiplier

**File:** [`engine/strategy-service.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/strategy-service.ts#L53) (lines 53)
**Project:** prism-dlmm
**Severity:** BUG  •  **Confidence:** low  •  **Slug:** `other-bigint-precision`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

In computeConcentrationMultiplier, `const weight = Number(b.liquiditySupply)` converts the SDK's bigint (types.ts declares `liquiditySupply: bigint`) to a JS number. For pools with large liquidity (9-decimal tokens, high TVL), lambda values exceed Number.MAX_SAFE_INTEGER (2^53 ≈ 9.0e15) and Number() silently rounds. The codebase's own documented pattern (AGENTS.md / engine/bigint-json.ts) explicitly forbids Number() on SDK bigints in favor of stringified-safe conversion. The numerator/denominator ratio partially cancels the error, so the impact is limited to a slightly distorted concentration multiplier feeding estimateDailyIlUsd → feeIlRatio → ENTER/EXIT gates, but it is a genuine, silent precision deviation in decision-critical math. The scanner's 'weak cipher' flags at L291/L331 are false positives (no crypto anywhere in this file).

## Recommendation

Compute the ratio in bigint arithmetic (e.g., multiply distance by 10^18 divided by weightSum via bigint division) or convert via a string-safe decimal routine before Number() conversion, per the project's bigint-json.ts pattern.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-23)
- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
