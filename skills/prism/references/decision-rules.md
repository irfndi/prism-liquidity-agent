# Prism Decision Rules

This reference mirrors the logic in `engine/program.ts`.

## Per-cycle flow

For every pool in the watchlist:

1. Fetch pool state and bin array.
2. Compute `PoolMetrics`.
3. Pre-filter: skip if TVL, volume auth, or bin utilization below thresholds.
4. Check memory for recent warnings.
5. Evaluate EXIT conditions.
6. Evaluate REBALANCE conditions.
7. HOLD or ENTER.
8. Apply agent-runtime overlay if `AGENTIC_MODE=true`.
9. Run risk gates.
10. Execute (paper or live).
11. Record audit, snapshot, and agent check-in.

## EXIT conditions

TVL velocity drops more than `TVL_DROP_EXIT_PCT` (default 30%).
Volume authenticity falls below evolved threshold.
Fee/IL ratio drops below 0.5.
Trailing stop triggered (drawdown from peak exceeds `TRAILING_STOP_PCT`).
Stop-loss exceeded (`STOP_LOSS_PCT`).
High volatility + drift > 60% → EXIT to wallet instead of rebalancing.

## REBALANCE conditions

Drift > 60% or OOR grace expired.
Time since last rebalance > `MIN_REBALANCE_INTERVAL_MS` (default 24h).
Net benefit USD > `MIN_REBALANCE_NET_BENEFIT_USD`.
Gas cost repaid by N days of fees (`GAS_AWARE_MIN_DAYS_OF_FEES_PAID_AHEAD`).
OOR recovery probability below `OOR_RECOVERY_FORCE_REBALANCE_THRESHOLD` forces rebalance.

## ENTER conditions

No existing position in pool.
Not on cooldown.
`feeIlRatio > MIN_FEE_IL_RATIO * 1.5`.
`volumeAuth > 0.8`.
`binUtilization > 0.4`.
`pool.tvlUsd > MIN_POOL_TVL_USD * 2`.
Weighted entry score > `WEIGHTED_ENTRY_SCORE_THRESHOLD`.
Per-pool allocation cap respected.
Max open positions not exceeded.

## Agent overlay rules

The agent runtime may only:

- Reduce confidence.
- Change action to HOLD.

It may never increase confidence or promote a non-ENTER action to ENTER.
