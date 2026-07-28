# 0.1.3 Audit Findings

> **Date:** 2026-07-28
> **Run:** Release 0.1.3 on mainnet (SOL/USDC pools via Meteora DLMM)
> **Method:** Cross-referenced engine ledger with on-chain wallet truth (Jupiter spot portfolio, Solscan token accounts, RPC `getBalance`)

---

## Priority Index

| # | Priority | Title | Status |
|---|----------|-------|--------|
| 1 | **P0** | Realized PnL under-attributes value change | 🔴 Open |
| 2 | **P0** | Wallet SOL tracker drifts from chain truth | 🔴 Open |
| 3 | P1 | Entry sizing ignores rent + fee reserve | 🟡 Open |
| 4 | P1 | Veto timeout exceeded; minimal thinking effort needed | 🟡 Open |
| 5 | P2 | Fail-closed price exclusion is unauditable | 🔵 Open |

---

## Body 1 (P0) — Realized PnL under-attributes value change

**Evidence.** Post-0.1.2 rows are right-scaled per exit (±$0.07, good) but the booked `realized_pnl_usd` no longer equals actual value change. Concrete example (07-28, pool `BGmt…`):

| Field | Value |
|-------|-------|
| `deposited_usd` | $41.45 |
| Exit `current_value_usd` | $34.81 |
| Δ | **−$6.57** |
| Booked `realized_pnl_usd` | −$0.07 |
| `cumulative_fees_claimed_usd` | $0.03 |
| **Unattributed delta** | **−$6.50** |

The −$6.50 delta is unattributed — not in `realized_pnl_usd`, not in `cumulative_fees_claimed_usd`, and unrecoverable once closed (can't be unrealized on a closed position).

**Aggregate proof.** 0.1.2+ ledger shows −$31.70 realized + $1.32 fees vs chain wallet delta **+$6.61** → approximately **$38 unattributed**.

**Root cause.** `realized_pnl_usd` is computed as `withdrawnUsd + cumulativeFeesClaimedUsd + cumulativeRewardsClaimedUsd − depositedUsd`, but `withdrawnUsd` pulls from a mint-price snapshot that may not reflect the entry leg prices or the actual exit-time market value. The position's on-chain `currentValueUsd` (a heuristic mark) and the exit withdrawal price can disagree by more than accumulated fees.

**Fix.** `realized_pnl_usd` must be:
```
(exit_token_X · P_exit + exit_token_Y · P_exit)
  − (entry_token_X · P_entry + entry_token_Y · P_entry)
```
with both legs priced at their own timestamps, claims additive on top.

Additionally, add a reconciliation invariant to `prism doctor`:
```
|on_chain_wallet_usd − ledger_wallet_usd| < ε  →  WARN with delta when violated
```
This would have caught every accounting regression automatically.

---

## Body 2 (P0) — Wallet SOL tracker drifts from chain truth

**Evidence.** Ledger `walletBalanceUsd` $85.36 vs Jupiter spot portfolio chain truth **$98.91** — a **$13.55 gap** (15.9%).

| Component | Ledger | Chain truth | Delta |
|-----------|--------|-------------|-------|
| USDC | $49.72 | $49.72 | $0.00 ✓ |
| SOL | ≈0.49 SOL | 0.6729 SOL | **−0.18 SOL / $13.55** |

**Root cause.** The incremental-delta wallet tracker loses flows: claim proceeds, swap dust, rent returns, and direct SOL transfers are never credited back to the cached `lastWalletBalanceUsd`. The tracker only increments on explicit ENTER/EXIT events, so any wallet change outside the engine's own transactions causes permanent drift.

**Fix.** Periodic full reconcile from `getTokenAccountBalance` on the wallet ATAs (every N cycles or on drift detection). Correct the ledger and log the correction amount. Make this the source of truth for sizing inputs rather than the incremental tracker.

---

## Body 3 (P1) — Entry sizing ignores rent + fee reserve

**Evidence.** Live failed attempt:
```
Transfer: insufficient lamports 175533507, need 182798329
```

Simulation caught it (zero loss), but sizing allocated more SOL than the wallet actually holds after accounting for rent-exempt reserves and priority fees.

**Root cause.** `computeEntrySizeUsd` considers wallet balance and position size but does not deduct:
- Rent-exempt reserve for ATAs and position PDAs
- Estimated priority fee buffer for the entry transaction

**Fix.** Sizing must clamp to `available_lamports − rent_exempt_reserve(ATA + position PDAs) − estimated_priority_fee_buffer` pre-flight, and reject with an explicit reason string (`available: X, needed: Y, reserve: Z`) instead of failing at simulation.

---

## Body 4 (P1) — Veto timeout exceeded; minimal thinking effort needed

**Evidence.** Even at 60s (now 150s operator-side):
```
Agent veto review timed out after 60000ms (transport connect/session
establishment + prompt exceeded the veto budget)
```

**Root cause.** The veto ride shares the gateway's default extended thinking on a yes/no binary review. Most of the timeout budget is consumed by the LLM's extended reasoning, not transport.

**Fix.**
1. Veto calls should request **minimal thinking effort** — it's a binary review (approve/reject the engine's decision), not generation
2. Add adaptive timeout: skip veto when rolling round-trip P95 exceeds budget, fail-open with a WARN (avoid the per-cycle timeout tax)

---

## Body 5 (P2) — Fail-closed price exclusion is unauditable

**Evidence.** Log line:
```
Wallet token has no resolvable USD price — excluded from wallet balance (fail-closed)
```

This fires without identifying the token — no mint, symbol, amount, attempted sources, or reason.

**Root cause.** The price-resolve function logs the exclusion message but does not include the token identity in the structured log payload.

**Fix.** The exclusion log must include `{mint, symbol, amount, attempted_sources, reason}` so excluded value is auditable and dust vs material exclusions are distinguishable (current blind spot: can't tell if $0.07 dust or $15 of SOL got dropped).

---

## Summary

**Chain truth is +$6.61 (+7.2%)** from inception through a −5% SOL dip (≈+12% vs market) — the strategy is genuinely ahead. But the ledger still can't steer by:

| Issue | Impact |
|-------|--------|
| Wallet drift (Body 2) | `lastWalletBalanceUsd` under-reports by ~$13.50 |
| Unattributed exits (Body 1) | ~$38 of flows not traced to PnL |
| Combined | `prism status` and sizing inputs are unreliable for steering |

**Until Body 1 + 2 land**, treat Jupiter spot portfolio + on-chain position value as the real P&L, and the engine's ledger as directional only.

**Recommended next release:** Body 1 + 2 — the two that restore trust in the numbers.
