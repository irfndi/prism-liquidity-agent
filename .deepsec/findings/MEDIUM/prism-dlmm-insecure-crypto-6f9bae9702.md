# [MEDIUM] Math.random() used to generate money-bearing referral codes (CWE-338)

**File:** [`cloudflare/workers/api/index.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cloudflare/workers/api/index.ts#L338-L1926) (lines 338, 342, 1926)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `insecure-crypto`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

generateReferralCode() (lines 338-344) builds 8-character referral codes with `chars[Math.floor(Math.random() * chars.length)]`. Referral codes are value-bearing credentials: /v1/referral/apply credits $5 to the referrer, $10 to the referee, and $25/$50 milestone bonuses into user_credits, and the only authorization for crediting is possession of the code string. V8's Math.random() is xorshift128+, whose internal state can be reconstructed from observed outputs; an attacker can observe outputs directly (their own code via GET /v1/referral/code, one code per registered account, with registration throttled only by the racy KV limiter) and then predict codes subsequently generated in the same isolate, collapsing the assumed 2^40 code space to PRNG-state entropy. Compounding this, /v1/referral/apply has no rate limit and no per-code attempt cap, so code-guessing/enumeration responses ('Invalid referral code' vs 'Cannot refer yourself' vs success) are unlimited. Every other secret generator in this file correctly uses crypto.getRandomValues (generateApiKey, link codes), making this an inconsistent weak path.

## Recommendation

Generate referral codes with crypto.getRandomValues over the same alphabet (as linkTelegramStartHandler does), and add a per-IP/per-user rate limit plus distinct-error-response hardening on /v1/referral/apply.

## Recent committers (`git log`)

- irfndi <join.mantap@gmail.com> (2026-08-03)
