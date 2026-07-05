# Meteora DLMM Concepts

Meteora Dynamic Liquidity Market Maker (DLMM) is a concentrated liquidity AMM on Solana.

## Bin

A bin is a discrete price slot. Each bin has a fixed price and holds reserves of
token X and token Y. Liquidity positions cover a contiguous range of bins.

- `activeBinId`: The bin where the current price lives.
- `binStep`: Price increment between bins, in basis points.
- Position range: `[lowerBinId, upperBinId]`.

## Impermanent loss (IL)

When price moves, the position's value relative to holding the original tokens
decreases. Concentrated positions suffer higher IL than full-range AMMs, but earn
more fees when price stays in range.

## Fee/IL ratio

Prism computes `feeIlRatio = estimatedFees / estimatedIL`. A ratio > 1 means
fees compensate for IL. Ratio > 1.2 is healthy to hold; > 1.8 is strong for new
entry.

## Volume authenticity

A 0–1 score that penalizes:

- Volume/TVL ratio above 10x.
- Fee rate outside 0.02%–2%.
- Low TVL with outsized volume.

Pools below 0.70 are skipped.

## Bin utilization

Fraction of bins in the position range that currently hold liquidity. Higher is
better — it means the active price is near the position center.

## Rebalancing

When price drifts outside the position range, the position stops earning fees and
accumulates IL. Prism exits or shifts the bin range based on:

- Drift percentage from range center.
- Net benefit of rebalancing (fees gained vs gas/IL cost).
- OOR recovery probability (mean reversion estimate).
- Recent bin volatility.
