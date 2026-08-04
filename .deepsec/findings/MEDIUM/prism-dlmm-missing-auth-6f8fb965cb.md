# [MEDIUM] Unauthenticated status endpoints expose portfolio, positions, and decisions to local processes

**File:** [`engine/http-status-server.ts`](https://github.com/irfndi/prism-liquidity-agent/blob/fix/pr-review-remediation/blob/fix/engine/http-status-server.ts#L331-L381) (lines 331, 333, 346, 355, 363, 377, 381)
**Project:** prism-dlmm
**Severity:** MEDIUM  •  **Confidence:** medium  •  **Slug:** `missing-auth`

## Owners

**Suggested assignee:** `join.mantap@gmail.com` _(via last-committer)_

## Finding

The Bun.serve HTTP server (started when AGENT_HTTP_PORT > 0) exposes /health, /status, /positions, /decisions, /config, and /agent-policy with NO authentication. The /status endpoint returns snapshot.portfolio (totalValueUsd, unrealizedPnlUsd, realizedPnlUsd, openPositions, walletBalanceUsd), /positions returns all held positions with pool addresses and bin ranges, /decisions returns recent decisions with reasoning, and /agent-policy returns the proposal mode and hard caps. Only /propose and /approve require Bearer tokens (agentProposalToken / agentApprovalToken). While the server binds hardcoded hostname "127.0.0.1" (line 333), which blocks remote attackers, the loopback binding is not a complete mitigation: any local process — another user on a shared machine, a compromised local service, a malicious browser extension, or (on WSL2) the Windows host — can query these endpoints and read the agent's live financial state and strategy without any credential. There is no CORS header (limiting browser-based exfiltration), but a local process can read the responses directly. This is relevant to the threat model since the wallet and strategy state are sensitive (positions, PnL, watchlist-derived decisions).

## Recommendation

Require the same Bearer-token authentication used by /propose and /approve for the read endpoints (/status, /positions, /decisions, /config, /agent-policy), or gate them behind a dedicated read-only token (e.g., AGENT_STATUS_TOKEN) with the same constant-time comparison. Alternatively, bind the server to a Unix domain socket with restrictive permissions (0o600) so only the owning user can connect.

## Recent committers (`git log`)

- irfandi marsya <join.mantap@gmail.com> (2026-07-19)
