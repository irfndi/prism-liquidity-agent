# Architecture

## Component Map

```
engine/
├── index.ts             22-line bootstrap: Effect.runPromise(program)
├── program.ts           Scan loop + all decision logic (~820 lines)
├── services.ts          Context.Tag definitions (one per service)
├── config-service.ts    Env loader (Effect Config.string/number/boolean)
├── adapter-service.ts   Meteora SDK + Helius RPC calls (~685 lines)
├── strategy-service.ts  Pure strategy math (fee/IL, vol auth, bin util)
├── risk-service.ts      Pre-execution gates with early return
├── memory-service.ts    Thin wrapper over db-service for memory ops
├── db-service.ts        SQLite queries (positions, audit, memory, snapshots)
├── db.ts                Schema + sqlite-vec vec0 table, auto-migration
├── audit-service.ts     JSONL audit logger
├── blacklist-service.ts Deployer/token blacklist checks
├── screener-service.ts  Pool discovery (ENABLE_POOL_DISCOVERY=true)
├── embeddings.ts        Hash fallback or ONNX (Xenova/all-MiniLM-L6-v2)
├── logger.ts            createLogger(component) -> console + jsonl
├── update-utils.ts      Semver, GitHub API helpers
├── revenue-service.ts   Subscription / fee modeling
├── feedback-service.ts  Agent feedback, dedup, rate-limit, GitHub Issues
├── bigint-json.ts       BigInt-safe JSON serializer
├── error-reporter.ts    Privacy-first error telemetry (sanitizes secrets)
├── errors.ts            Shared error types
├── version.ts           Read version from package.json
├── types.ts             Shared interfaces
└── data/                deployer-blacklist.json, token-blacklist.json
```

All engine files are flat in `engine/`. No subdirectories for adapters, probes, risk, or tools.

## Agent Loop (per cycle, per pool)

```
SCAN (every SCAN_INTERVAL_MS, default 10 min)
  For each pool in WATCHLIST_POOLS:
    1. adapter.getPoolState + adapter.getBinArray  ← fetch on-chain
    2. [optional] db.saveSnapshot                  ← if ENABLE_SNAPSHOT_CAPTURE
    3. blacklist.checkPool                         ← token blacklist (errors swallowed)
    4. strategy.computeMetrics                     ← fee/IL, vol auth, bin util
    5. Pre-filter: TVL < minTvl OR volAuth < threshold OR binUtil < threshold → skip
    6. memory.getRelevantContext                   ← recent warnings (errors swallowed)
    7. Decision rules (first match):
       a. TVL drop > exitPct → EXIT
       b. Volume authenticity < threshold → EXIT
       c. Fee/IL ratio < 0.5 → EXIT
       d. Trailing stop triggered → EXIT
       e. Bin drift > 60% OR OOR grace expired → REBALANCE
       f. Existing position → HOLD
       g. Passes strict ENTER thresholds → ENTER
    8. risk.evaluate                               ← 7 gates, early return
    9. audit.recordDecision                        ← JSONL log
    10. Execute: paper (Map.set/delete) or live (adapter.enterPosition etc.)
```

## Memory TTL Policy

| Category | TTL |
|----------|-----|
| `pattern` | 90 days |
| `warning` | 60 days |
| `outcome` | 180 days |

sqlite-vec stores embeddings in a `vec0` virtual table. Queries return rows by cosine distance (`distance` column). Ranking blends similarity (70%) with recency decay (30%, 30-day half-life).

## Risk Gates (in order, early return)

1. Confidence < `CONFIDENCE_THRESHOLD` → reject
2. Max concurrent positions reached → reject ENTER
   → Duplicate pool guard → reject ENTER if same pool held
3. EXIT → always approved (capital protection)
4. Portfolio drawdown > 10% → pause new entries
5. Stop-loss triggered (`STOP_LOSS_PCT` exceeded) → reject HOLD/REBALANCE
6. Position size > 30% portfolio → cap and allow
7. Rebalance range invalid or exceeds `MAX_REBALANCE_RANGE_BINS` → reject REBALANCE

## Snapshot Capture & Replay

Set `ENABLE_SNAPSHOT_CAPTURE=true` (paper trading only). Every cycle dumps pool state + bin array into the `pool_snapshots` table (migration v4). BigInt-safe JSON serialization preserves fidelity.

Replay via `bun run backtest --source replay --db ./prism.db --days 7 --pools <addr>`. Reads snapshots from SQLite and runs them through the same strategy loop as synthetic data.
