# Changelog

All notable changes to Mantis are documented here.

## [1.0.0] — 2026-04-02

### Added
- Autonomous DLMM rebalancing loop (SCAN → REASON → DECIDE → LEARN)
- Claude Agent SDK integration via 7-tool MCP surface
- Chroma-backed memory with TTL pruning and cosine-similarity merge (threshold 0.70)
- Volume authenticity scoring — detects wash trading patterns (0–1 score)
- Fee/IL ratio computation per pool per cycle
- Risk gate: confidence, drawdown, position cap, bin range validation
- Paper trading mode (default) — all decisions logged, no on-chain execution
- `ops/backtest.ts` — historical simulation with Sharpe ratio output
- `ops/setup.ts` — interactive `.env` wizard via `@clack/prompts`
- Docker + Chroma compose stack

### Memory TTL Policy
- `pattern` — 90 days
- `warning` — 60 days  
- `outcome` — 180 days

