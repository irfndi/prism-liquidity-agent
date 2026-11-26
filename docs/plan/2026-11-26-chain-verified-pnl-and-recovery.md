# Chain-verified PnL and recovery plan — 2026-11-26

**Status:** diagnosis complete and chain-verified. No code changed yet; this is the plan.

**Supersedes** the PnL sections of `2026-10-30-profitability-triage.md`. The triage measured the
ledger; this measures the wallet. They disagree by ~$230 and the wallet is right.

---

## 0. One-line answer

The agent has lost **1.87 SOL (−67% of the capital it was given)**. The database reports
**+$6.91 (break-even)** and, for the last three months, **+$222 of "profit"** that does not exist.

Two independent defects make the ledger lie, and one of them **disarmed every PnL-based safety
brake** — so the bleed ran unopposed for three months. Layered on top is a strategy whose fixed
costs exceed its fee income by roughly an order of magnitude at the configured position size.

---

## 1. Chain-verified PnL (the only number that matters)

Method: full wallet reconstruction from Helius enhanced transactions (2,924 txs, 2025-01-23 →
2026-11-26), separated into external funding legs vs protocol/vault legs, plus live balances and
Jupiter prices. Reproduce with the commands in §8.

| Item | Value |
| --- | ---: |
| Wallet | `72JLRhFo3u1qxA6qnH6tduqtw1oj88PChf67WNFhHxds` |
| External SOL funded in | **2.7745 SOL** |
| SOL sent back out | 0.2605 SOL |
| Native SOL now | 0.36999 SOL |
| Open position (mark) | ≈ 0.275 SOL ($19.54) |
| **Net trading PnL** | **−1.87 SOL ≈ −67%** |
| Tx fees burned (whole life) | 0.1099 SOL |
| Fees *earned* (whole life, DB) | $6.06 |

Monthly, SOL-denominated (chain) beside the DB's USD claim:

| Month | Chain (SOL) | DB realized (USD) | DB fees |
| --- | ---: | ---: | ---: |
| 2026-06 | **−1.686** | *ledger does not exist yet* | — |
| 2026-07 | −0.266 | −217.87 | $2.05 |
| 2026-08 | −0.369 | **+27.97** | $2.35 |
| 2026-09 | +0.594 | +2.47 | $0.75 |
| 2026-10 | −0.017 | **+44.70** | $0.00 |
| 2026-11 | −0.354 | **+149.65** | $0.90 |
| **Total** | **−1.87** | **+6.91** | **$6.06** |

Two things to read off this table:

1. **June is missing entirely.** The DB's first row is `2026-07-20 18:51`. June lost 1.69 SOL —
   ~90% of the loss — and the ledger has no record of it. Any "all-time" DB number is a
   four-month number wearing a five-month label.
2. **From August the two columns have opposite signs.** That is a reporting regression, not luck.

---

## 2. Defect A — a rent refund is booked as trading profit (regression, 2026-08-09)

### Proof (one position, chain vs DB)

`FvvHYF2XdngpHkE5s1urGhRRjrZicCMMfhZknTarAaV5`, 98sM/SOL, 26-minute hold, 2026-11-20:

| | Value |
| --- | ---: |
| On-chain open | −0.31708922 SOL |
| On-chain close | +0.317074508 SOL |
| **Round trip (excl. 15 µSOL fees)** | **−0.0000147 SOL** |
| DB `deposited_usd` | $19.8757 |
| DB EXIT `value_usd` | $23.0864 |
| **DB realized** | **+$3.15 (+16.1%)** |

Pool price moved +0.6% in that window; SOL/USD moved +0.55% (Binance 1m). There is no world in
which this trade made 16%. The position was **dead flat**.

### Mechanism

The two sides of the PnL identity are measured differently:

- **Exit is measured.** `withdrawnUsd` = `beforeNativeSol → afterNativeSol` delta across the whole
  wallet (`engine/adapter-service.ts`, `measureWithdrawalDelta` → `priceExitLegs`). That delta
  includes the **rent refund** from closing the position account, its bin arrays and its ATAs.
- **Entry is not measured.** `deposited_usd` is the *planned* size:
  `depositedUsd: positionSizeUsd` (`engine/program.ts:3191`). Rent paid on entry is not in it.

So every clean round trip books `rent_paid` as revenue. Measured rent on that position: **0.0422 SOL
≈ $3.0 at $71**. On a $20 position that is **+16% of phantom profit per close**, which is exactly
the ~16% every recent close shows.

### Why this is the expensive bug, not a cosmetic one

`realized_pnl_usd` is the input to:

- `REALIZED_PNL_HALT` (rolling halt) — never tripped, because the rolling sum was positive.
- `POOL_PNL_KILL_SWITCH` — never tripped, same reason.
- `prism forensics` / rule attribution — learned that churn is profitable.
- The agent overlay (`AGENT_PROPOSAL_MODE=full`) — reviewed a winning book and approved more.
- You — the operator, reading `prism portfolio history`.

**The feedback loop was inverted. That is why −67% could happen with a dozen safety systems
installed.**

### Sizing the phantom

| Slice | Closes | DB PnL | Est. phantom rent | Adjusted |
| --- | ---: | ---: | ---: | ---: |
| Before #205 | 342 | −$217.80 | ~0 | −$217.80 |
| After #205 | 155 | **+$224.71** | ≈ $495 | **≈ −$270** |

Inflection check: per-close DB PnL is ~$0.01 before week 33 and ~$1.3–2.4 after, and commit
`1fb7fbd` (*"exit withdrawal measured from on-chain wallet delta (#205)"*) is dated **2026-08-09**
= week 33. Same week. The estimate is a constant-rent approximation; the chain total is the
authority.

---

## 3. Why the strategy loses even with honest books

Strip out the accounting and the strategy is still negative. Fees are real but tiny; costs are
fixed and large.

### 3.1 Fees are captured honestly — there just aren't enough of them

| Pool | Fee APR | Closes | Deposited | Fees earned | Fees / deposit |
| --- | ---: | ---: | ---: | ---: | ---: |
| 81GpCm HYPE-SOL | 71% | 27 | $537.84 | $0.2071 | **0.039%** |
| zxTpi4B STONK-SOL | 138% | 27 | $519.10 | $0.3936 | 0.076% |
| 8GTCUyG ANT-USDC | 450% | 9+ | — | — | 0.263% |

Those captures are *consistent with the advertised APR over a ~4-hour hold* (71% APR × 4h =
0.032% of principal). So the pool data is not lying and the fee accounting is not broken. The
problem is the arithmetic of the trade:

```
fee income, $20 position, 71% APR, 4h hold   =  $0.0065
exit swap at 0.30% on $20                    =  $0.0600
                                             →  −$0.054 per trade
```

### 3.2 Break-even hold time is 5–20× longer than the actual hold

`break-even days = round-trip cost % / (fee APR % / 365)`

| Round-trip cost | 25% APR | 71% APR | 138% APR | 450% APR |
| ---: | ---: | ---: | ---: | ---: |
| 0.3% | 4.4 d | **1.5 d** | 0.8 d | 0.24 d |
| 0.6% | 8.8 d | **3.1 d** | 1.6 d | 0.49 d |

Observed median hold in the active pools: **~250 min (0.17 d)**. At 71% APR the agent needs
1.5–3.1 days and gives it 4 hours — it pays a full round trip to collect ~5% of it.

### 3.3 Size makes it structural

`MAX_ENTRY_SIZE_USD=20`. Per position:

- rent locked: 0.042 SOL ≈ $3.0 → **15% of the trade** in locked capital (refunded, but only on a
  clean close — and it is the thing being miscounted as profit).
- fee income per 4h: **$0.0065**.
- one exit swap: **$0.06** — 9× the fee income.

At $20 there is no hold time and no pool that makes this positive. The economics only work at
sizes where the fixed costs are rounding error, or with holds measured in days.

### 3.4 Entries are directional bets, not market making

Recent entries are `"depositMode":"single-sided-y"` — 100% SOL into a memecoin/SOL pool, because
the wallet holds only SOL. That is not neutral liquidity: it is a long-the-memecoin position with a
small fee rebate. When the token declines, the position absorbs it as IL (the loss lands as token
inventory that has to be sold lower). Exits are triggered by a TA rule
(`[ta-exhaustion] RSI(2) 93.9 > 90`) at 25–250 minutes, i.e. **it trades on 2-minute candles with
a 4-hour cost structure.**

### 3.5 The engine already knows — and is (correctly) refusing to trade

Last 2 days of ENTER decisions:

| Tag | Count |
| --- | ---: |
| `[expected-profit]` | **393** |
| `[alloc-gate]` | 217 |
| `[cooldown-gate]` | 90 |
| `[wallet-reserve]` | 53 |
| `[drift-gate]` | 38 |
| `Strong pool…` (admitted) | **5** |

The `[expected-profit]` gate added after the triage is doing its job and blocking almost
everything. That is the correct response at $20, and it means the system is currently **idle by
design** — 2 pools scanned/cycle, 0 executed.

### 3.6 The selection lane is dead

```
Market scan: universe gate refreshed { universe: 1695, passed: 0, active: 0, top: "" }
Scan cycle complete { scanned: 2, decided: 1, executed: 0 }
```

**0 of 1,695 pools pass the market gate.** The runner lane and launch radar admit nothing either
(`Launch radar: nothing admitted { universe: 486, age: 469 rejects }`). So the agent is not
selecting pools at all any more; it only manages the one position it still holds. The most likely
culprits are `MARKET_SCAN_MIN_HOLDERS=1000` (kills tokenized-equity and new-listing pools that
otherwise clear every numeric filter) and `MARKET_SCAN_REQUIRE_RENOUNCED_MINT=true`. Unlike the
launch radar, the market gate logs no rejection histogram, so this is currently unobservable —
which is itself a defect.

---

## 4. "Why do other systems work and we don't?"

Mostly, **they don't.** The measured base rate:

- **LoopholeTape, 47,232 Meteora positions, 288 wallets, 10 days (2026-11):**
  **−0.11% per deposited dollar** after a 1.5% charge on tokens leaving positions. Fees collected
  were 0.7% of deposits — *"most of the fee was given back to price moves."* Median position: $83,
  held **0.41 hours**. On capital actually at work the **median wallet made −0.60%/day**; only 30.6%
  were up. Note the trap: **82.1% of wallets were "up" on their closed positions** while the
  capital-day figure was negative — the closed-only view is exactly the illusion our DB has.
- **nomad-finance, 1,108 Meteora DLMM positions (30 days):** 76.4% beat HODL, IL $1.38M vs fees
  $97k, **median P&L ≈ $0**. The aggregate is a right tail, not a strategy.
- **Drossos et al. 2025 (arXiv 2501.07828), IL vs rewards by hold duration:** positions under one
  hour *"mostly lead to negative returns"*; 1h–1d runs IL −0.26%/day vs rewards +0.32%/day; only
  multi-month holds clearly net out (19.9% rewards vs 10.4% IL at >360d).
- **Zeller et al. 2025 (arXiv 2504.16542):** narrow ranges plus frequent reallocation lose —
  divergence loss and reallocation cost dominate; wide or never-rebalanced intervals win; the
  modelled reallocation cost was **$109.8 per reallocation**.

**Conclusion:** the differentiator is not a secret signal. It is (a) position size large enough to
amortize fixed costs, (b) hold time long enough for fees to cover a round trip, (c) selection on
*realized* fee density rather than trailing headline APR, and (d) refusal to rebalance/churn.
Prism is in the worst corner of all four: smallest size, shortest hold, narrow range, most churn,
and a 0/1695 selection lane.

The honest framing for the operator: **this is not "we lack their edge"; it is "we designed the
trade backwards relative to the arithmetic."**

---

## 5. Plan

### Phase 0 — Make the numbers honest (blocking, ~1–2 days)

| # | Change | Where | Verification |
| --- | --- | --- | --- |
| P0.1 | Measure the entry the same way as the exit: `depositedUsd` from the on-chain wallet delta at open (deposit + rent + fees), not the planned size | `engine/program.ts:3191`, `engine/adapter-service.ts` | replay the 2026-11-20 position: DB realized ⇒ ≈ −$0.001, not +$3.15 |
| P0.2 | Persist `entryCostBasisUsd` + `rentUsd` explicitly; never let a *plan* number stand in for a *measured* one | `engine/types.ts`, positions schema | new column non-null on new rows |
| P0.3 | `prism forensics --reconcile`: DB realized vs chain wallet delta over a window, fails on >2% drift | `cli/forensics.ts` | on current DB it must report ≈ **−$270**, not +$224 |
| P0.4 | Backfill the 155 post-#205 closes from chain | one-off script | post-backfill total ≈ −$490 all-time |
| P0.5 | E2E test (project rule: artifact, not assertion): open→close on the paper venue, assert DB realized == chain delta ±$0.01 | `bench/` | test fails on the pre-fix build |

**Do not skip P0.3/P0.5.** The reason this bug survived three months is that nothing compared the
ledger to the chain. That comparison is the durable fix; the arithmetic fix alone can regress again.

### Phase 1 — Stop the bleed (same PR as Phase 0 or immediately after)

| # | Change | Why |
| --- | --- | --- |
| P1.1 | Re-verify `REALIZED_PNL_HALT` / `POOL_PNL_KILL_SWITCH` actually trip once books are honest | they were calibrated on phantom profit |
| P1.2 | Hard, non-fail-open size gate: `requiredSize = roundTripCostUsd × 365 / (feeAprPct/100 × 1)`, refuse when break-even hold > planned hold | makes §3.2 impossible to violate by config |
| P1.3 | Log the market-gate rejection histogram (parity with launch radar), then relax `MARKET_SCAN_MIN_HOLDERS` and the renounce rule per the data | 0/1695 is blindness, not selectivity |
| P1.4 | `AGENT_PROPOSAL_MODE=veto` (or `suggest`) until the base is profitable | 30 s veto timeouts on a 120 s cadence, per pool |
| P1.5 | Decide: keep trading live during the fix? Recommendation: **no new entries** until P0.3 is green | −67% is enough tuition |

### Phase 2 — Find one edge, or stay flat (1–2 weeks, paper only)

Three configs, chain-verified accounting, SOL-denominated comparison:

| Lane | Shape | Exit | Rationale |
| --- | --- | --- | --- |
| A — passive | wide (≥100 bins), top fee-density pools, ≥$500/position | 3–7 day time box, no rebalance | matches Drossos/Zeller: cost amortized, no reallocation |
| B — runner | ≥450% measured APR, dip-anchored | 12–24 h time box, drawdown stop | break-even at 0.6% cost is 0.49 d |
| C — baseline | current config | current | control |

Kill criteria, decided **before** the run: a lane that does not clear **+0 SOL over 30 closes**
is not shipped. A flat result means "do not trade this" — that is a valid, money-saving outcome.

### Phase 3 — Ops

| # | Change | Evidence |
| --- | --- | --- |
| P3.1 | Move the 4 `autoresearch/loop.ts` workers off the trading box | load **7.69 on 4 cores**, 64% CPU each |
| P3.2 | `SOLANA_RPC_URL` → Helius (key is already in the env, unused) | currently `api.mainnet-beta.solana.com` at `RPC_MIN_INTERVAL_MS=500` |
| P3.3 | Retire or rehome `prism-paper-verify` + `prism-paper-growth` | two more bun processes on the same 4 cores |
| P3.4 | Size decision: at $60 of capital no lane in §3 works | see §6, decision 1 |

### Phase 4 — Verification harness

Per the repo rule (E2E, repeatable artifact): one command that opens, holds, closes and reconciles a
position against the chain, emitting a signed JSON artifact with both ledgers. Every future PnL
claim cites that artifact.

---

## 6. Decisions needed from you

1. **Toy or business?** At `MAX_OPEN_POSITIONS=3 × MAX_ENTRY_SIZE_USD=20` ($60 max deployed), no
   configuration is profitable — fixed costs exceed fee income by ~9×. Either fund it to
   ≥$1,000–2,000/position ($3–6k deployed), or accept that it is a research harness and stop
   measuring it in dollars.
2. **Pause live trading while Phase 0 lands?** Recommended yes (no new entries; let the open
   position run out).
3. **Which lane to test first** — A (passive/wide) or B (runner)? A is the better-evidenced bet per
   §4; B is the only one that fits a small bankroll *if* holds stretch to 12–24 h.

---

## 7. What NOT to do

- Do not lower `[expected-profit]`, `MIN_FEE_IL_RATIO`, TVL floors or cooldowns to "get trades
  flowing". Those gates are the only thing currently protecting the wallet — 393 rejections in two
  days is the system working.
- Do not tune on USD PnL while the book is SOL-denominated and the principal is SOL. Judge in SOL.
- Do not trust `prism portfolio history` for any decision until P0.3 ships.
- Do not add a new lane before the market gate admits a non-zero number of pools.

---

## 8. Reproduce

```bash
# 1. snapshot (safe while the service writes)
ssh root@217.216.35.77 'sqlite3 /root/.local/share/prism/prism.db ".backup /tmp/snap.db"'

# 2. chain reconstruction (reads HELIUS_API_KEY from the box env, never leaves the box)
ssh root@217.216.35.77 'node /tmp/chain-ledger.mjs'   # emit per-tx net SOL ledger
ssh root@217.216.35.77 'node /tmp/chain-pnl.mjs'      # emit balances + current holdings

# 3. the two numbers that must agree
#    chain: 0.36999 native + 0.275 open  − (2.7745 funded − 0.2605 withdrawn) = −1.87 SOL
#    db:    SELECT round(sum(realized_pnl_usd),2) FROM positions WHERE closed_at IS NOT NULL;
```

Artifacts: `/tmp/chain-ledger.json` (2,924 txs), `/tmp/chain-pnl.json` (holdings + prices).

---

## 9. What landed — 2026-11-26

Phase 0 is implemented and Phase 1's code parts are in. Everything below passes
`bun run verify` (§10).

### The fix

| Area | Change |
| --- | --- |
| `engine/adapter-service.ts` | `enterPosition` now measures the **same wallet delta** the exit uses (pre-entry snapshot → confirmed entry → post-entry snapshot) and returns `entryOverheadUsd` = cash spent beyond the deposit (rent + tx fee + wSOL wrap). New pure helpers: `computeEntryOverheadUsd`, `netWithdrawnUsd`, `solSpendUnits`, `splSpendUnits`, `cappedSpend`. |
| `engine/adapter-service.ts` (exit) | Takes `options.entryOverheadUsd` and subtracts it from the measured gross withdrawal. Realized PnL is now a difference of **like-measured** numbers: a dead-flat round trip books 0, not +rent. Returns `grossWithdrawnUsd` + `entryOverheadUsd` for audit. |
| `engine/db.ts` | Migration **v26** `entry_overhead_usd` (additive; legacy rows stay NULL). |
| `engine/db-service.ts` / `engine/services.ts` | `PositionRecord.entryOverheadUsd` persisted, read, and exposed on every position query. |
| `engine/program.ts` | Stores the measured overhead at ENTER (position row + ENTER event metadata); passes it to the EXIT; EXIT event metadata now carries `grossWithdrawnUsd` + `entryOverheadUsd` so the ledger can be recomputed either way. |
| `engine/pnl-audit.ts` (new) | Regression guard: re-derives every closed position's realized value from its stored legs and flags `drift` (identity broken) or `rent-unaccounted` (live close after 2026-08-09 with no measured basis). |
| `cli/pnl-audit.ts` (new) | `prism audit-pnl [--db] [--apply-rent-backfill] [--json]` — prints reported vs **trusted-only** PnL, exits 1 on drift, and with `--apply-rent-backfill` voids the phantom rows to NULL with a `pricing: "rentUnaccounted"` marker (same convention as an unpriced exit: unknown, never 0). |

### Proof, not just tests

| Artifact | What it establishes |
| --- | --- |
| `bench/pnl-entry-overhead.test.ts` (15 tests) | The rent gap is measured; a flat round trip realizes exactly 0 across a grid of deposits; legacy NULL subtracts nothing; the column round-trips through SQLite. |
| `bench/pnl-audit.test.ts` (11 tests) | The 2026-11 shape is classified `rent-unaccounted`; pre-regression rows are not; drift is caught at ±$0.05; the backfill is idempotent. |
| `native/bend/kernels.bend` + `LAWS.bend` + `PROOF.bend` (21 new laws) | **Proved**: `realized = net_withdrawn + fees + rewards − deposit`, `flat_round_trip = 0`, `rent_booked_as_profit_without_overhead = +rent` (the regression, pinned as a law), overhead is never a credit, break-even-hold arithmetic. `bend PROOF.bend` fails on any wrong constant (verified by deliberately breaking one). |
| `native/tla/Ledger.tla` + `LedgerFixed.cfg` / `LedgerBuggy.cfg` | **Model-checked**: the fixed model holds `HaltImpliesLoss`, `NoPhantomProfit`, `LedgerMatchesTruePnl` and eventually arms the halt; the buggy model **violates** `LedgerMatchesTruePnl` (TLC exit 12) with the counterexample trace. |

### What this does NOT do

- It does **not** make the strategy profitable. §3–§4 stand: at $20 positions and ~4h holds,
  costs exceed fee income by ~9×, and the market gate admits 0/1695 pools. Phases 2–3 are still
  open, and Phase 2's honest outcome may be "do not trade this".
- It does **not** repair the 155 historical closes by itself. Run
  `prism audit-pnl --apply-rent-backfill` on a copy first: it voids them to NULL rather than
  inventing a per-row rent figure.

### Operator actions still required (they are config/host, not code)

| # | Action | Why |
| --- | --- | --- |
| 1 | Deploy this build, then `prism audit-pnl --apply-rent-backfill` | The live process still runs the pre-fix build. |
| 2 | `AGENT_PROPOSAL_MODE=veto` (or `suggest`) | 30 s veto timeouts on a 120 s cadence, per pool. |
| 3 | `SOLANA_RPC_URL` → Helius | Currently the public endpoint at `RPC_MIN_INTERVAL_MS=500` (2 req/s). |
| 4 | Move the 4 `autoresearch` workers off the box | load 7.69 on 4 cores. |
| 5 | Decide size (toy vs business) | no lane profits at $60 deployed. |

---

## 10. The verification gate

```bash
bun run verify          # 5 gates, ~2 min
```

1. typecheck + lint + format
2. 2,314 tests (unit/property/persistence)
3. `bend PROOF.bend` — every law proved, exit 1 on any failure
4. TLC on `LedgerFixed.cfg` — all invariants hold, halt arms
5. TLC on `LedgerBuggy.cfg` — **must fail**, proving the model still detects the regression it was
   written for

Gate 5 is the negative control. A suite that cannot fail is decoration, so it is checked on every
run.

