# DLMM Strategy Skill

Use this skill when reasoning about Meteora DLMM pool rebalancing decisions.

## Decision Framework

### HOLD
- Fee/IL ratio ≥ 1.2 (fees are covering impermanent loss)
- Active bin is within 60% of range center
- Volume authenticity score ≥ 0.70
- TVL has not dropped > 30% from peak

### REBALANCE
- Active bin has drifted > 60% toward one edge of the range
- Simulation shows positive net benefit (fees > IL)
- Volume authenticity ≥ 0.70 (don't rebalance into a dying pool)
- Confidence must reflect uncertainty in price direction

### EXIT
- TVL dropped > 30% in a single scan interval → **immediate exit**
- Volume authenticity < 0.70 → liquidity is being gamed
- Fee/IL ratio < 0.5 for 3+ consecutive cycles → position is unprofitable
- Confidence in EXIT should be high (0.80+) — this is capital protection

### ENTER
- Pool passes all pre-filters (TVL, authenticity, fee/IL)
- No existing position in this pool
- Portfolio has capacity (< MAX_CONCURRENT_POSITIONS)
- Recent memory shows no warnings for this pool

## Bin Range Selection

Optimal range width depends on bin step:
- binStep ≤ 10: ±15 bins (tight range, low volatility pairs)
- binStep 11–25: ±10 bins (medium range)
- binStep > 25: ±7 bins (wide bins = volatile — stay narrow)

## Memory Usage Pattern

Always query memory FIRST before analyzing any tool data.
Look for:
- Past warnings on this specific pool address
- Pattern memories about similar fee/IL conditions
- Outcome memories to calibrate confidence

Always write to memory AFTER forming your reasoning:
- If you see an unusual pattern → `warning` category
- If you confirm a recurring behaviour → `pattern` category
- Outcomes are written automatically by the agent after execution

