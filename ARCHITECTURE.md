# Architecture

## Component Map

```
mantis/
├── engine/
│   ├── index.ts         ← entry point + scan loop
│   ├── config.ts        ← Zod-validated env config
│   ├── types.ts         ← all shared interfaces
│   ├── logger.ts        ← structured logger + JSONL audit trail
│   ├── memory/
│   │   └── store.ts     ← ChromaDB wrapper, TTL, cosine merge
│   ├── adapters/
│   │   └── meteora.ts   ← Meteora DLMM SDK + Helius RPC calls
│   ├── probes/
│   │   └── dlmm.ts      ← fee/IL ratio, volume auth, bin utilization
│   ├── risk/
│   │   └── gate.ts      ← confidence gate, drawdown, position caps
│   └── tools/
│       └── index.ts     ← 7 MCP tools exposed to Claude agent
├── ops/
│   ├── setup.ts         ← interactive .env wizard
│   └── backtest.ts      ← historical simulation
├── bench/
│   ├── strategy.test.ts
│   └── risk.test.ts
├── .agents/skills/
│   └── dlmm-rebalancer.md
└── .github/workflows/
    └── ci.yml
```

## Agent Loop

```
SCAN (every 10 min)
  └─ For each pool in WATCHLIST_POOLS:
       1. memory_query         ← retrieve past patterns/warnings
       2. meteora_get_pool_state
       3. meteora_get_bin_array
       4. volume_authenticity_check
       5. [optional] meteora_simulate_rebalance
       6. memory_write         ← persist new observation
       7. meteora_decision     ← intercepted: HOLD | REBALANCE | EXIT | ENTER
            └─ RiskEngine.evaluate()
                 └─ [PAPER] log | [LIVE] execute
                      └─ memory.recordOutcome()
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `meteora_get_pool_state` | TVL, volume, fees, APR, bin step |
| `meteora_get_bin_array` | ±20 bins, reserve amounts, active bin |
| `meteora_simulate_rebalance` | Estimate IL / fees before executing |
| `volume_authenticity_check` | Wash-trade detection (0–1 score) |
| `memory_query` | Retrieve past patterns via cosine similarity |
| `memory_write` | Persist new observation to Chroma |
| `meteora_decision` | Final verdict — intercepted by engine/index.ts |

## Memory TTL Policy

| Category | TTL |
|----------|-----|
| `pattern` | 90 days |
| `warning` | 60 days |
| `outcome` | 180 days |

Entries with cosine similarity > 0.70 are merged instead of duplicated.

## Risk Gates (in order)

1. Confidence < threshold → reject
2. Max concurrent positions → reject ENTER
3. Portfolio drawdown > 10% → pause ENTER
4. Position size > 30% portfolio → cap and approve
5. Invalid bin range → reject REBALANCE
6. EXIT → always approved (capital protection)

