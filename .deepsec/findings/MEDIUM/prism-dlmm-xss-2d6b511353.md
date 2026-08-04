# [MEDIUM] Unescaped HTML interpolation into Telegram parse_mode:HTML messages in /register, /whoami and /status replies

**File:** [`cloudflare/workers/telegram-bot/index.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/cloudflare/workers/telegram-bot/index.ts#L250-L341) (lines 250, 251, 253, 306, 339, 341)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** low  •  **Slug:** `xss`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

handleRegister (lines 250-253) interpolates `data.user_id` and `data.api_key` raw into `parse_mode: "HTML"` messages, and handleWhoami (line 306) interpolates `data.user_id` and `data.tier` raw (handleStatus lines 339-341 likewise interpolate `data.status`/`data.pnl`). This contradicts the file's own documented contract (lines 560-562: 'All engine/pool-controlled text is escaped before going into a parse_mode: HTML message') and the pattern used everywhere else (escapeHtml on firstName in handleStart, and on all alert fields in formatAlertLines). The values are currently server-derived (userId = Date.now()+base36 generateId(), api_key = 20 CSPRNG bytes, tier = 'free'), so the injection is not attacker-controllable today, but any future API response field that echoes user input through these shapes (e.g. a user-modifiable tier label, or a registration field) becomes stored HTML injection rendered in the victim's Telegram client, and the failure-mode strings (`result.error`) are also interpolated unescaped. This is a defense-in-depth gap that should be closed to match the rest of the file.

## Recommendation

Wrap every interpolated value in escapeHtml() before building the HTML message (including `data.user_id`, `data.api_key`, `data.tier`, `data.status`, and all `result.error` strings), or switch those messages to plain text (no parse_mode) so raw HTML is not interpreted.

## Recent committers (`git log`)

- Irfandi Marsya <join.mantap@gmail.com> (2026-07-28)
- irfandi marsya <irfandi@users.noreply.github.com> (2026-07-20)
