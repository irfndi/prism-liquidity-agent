# Changelog

All notable changes to Prism are documented here.

## [0.1.5] — 2026-08-05

### Added

- Fallen-angel mode — mean-reversion strategy with DB-backed config, Gecko OHLCV + RugCheck fetchers, any-TVL discovery, and TP-ladder + invalidation-stop lifecycle (#152)
- Sharded worker and engine test suites across parallel CI runners

### Fixed

- `prism portfolio` / `prism status` now surface true wallet equity (#151)
- Mode-aware auto-resolve for the latched daily-drawdown safety pause (#150)
- Remediated deepsec & clawpatch security review findings (#147)

### Changed

- Bumped version to 0.1.5.

## [0.1.4] — 2026-08-04

### Added

- Autonomous multi-token agent mode (#143)
- Telemetry default-on: D1 summary migration, report deduplication, archive bucket, `prism telemetry` preference commands, credential-bounded error reporting

### Fixed

- Telegram `/status` now returns real engine data via KV-backed status reporting (#141)
- Audit findings from the 0.1.3 release run (P0/P1/P2) (#142)
- deepsec & clawpatch security review findings (#147)

## [0.1.3] — 2026-07-28

### Added

- Fee-density-driven exit cooldowns (#128)
- Idle capital auto-redeploy gate (opt-in) (#129)
- Pyth Hermes price poller service with optional API key (#139)
- Alerts delivered via D1 poll + bot flush endpoint (error 1042 workaround) (#140)

### Fixed

- Real secondary stats source (GeckoTerminal), 60s veto timeout, adaptive ranges on by default, silent bigint fallback (#124)
- Veto timeout budget, elapsed telemetry, transport error unwrapping (#125)
- Redeploy follow-ups — portfolio base, candidate iteration, known-signal confidence, overlay bookkeeping (#133, #135)
- Cloudflare infra: Alchemy IaC migration, transient-error retries, wrangler-created worker adoption, esbuild prebuild with un-bundled upload (#127, #132, #134, #136)
- Atomic Telegram link + API errors surfaced in bot replies (#137)
- Bot→API calls routed over Cloudflare service bindings (error 1042) (#138)

### Changed

- Coverage gate enforced in CI; property, memory, and API-route test suites added (#126)

## [0.1.2] — 2026-07-22

### Fixed

- Stablecoin allowlist + token-risk smart screening, IL protection, sqlite-vec memory repair, veto robustness (#122)
- Realized PnL fee leg at EXIT + wallet chain reconciliation (#123)

## [0.1.1] — 2026-07-20

### Added

- Canary release channel — `prism update --canary` (#120)

### Fixed

- Gateway probe settles before close to fix Bun false-negative (#116)
- Helius RPC URL normalization + live connectivity probes in `prism doctor` (#119)
- Agent runtime transports (OpenClaw gateway, ACP, Hermes HTTP) + CLI/install/wallet bugs (#118)

### Changed

- Updated all dependencies to latest (#121)

## [0.1.0] — 2026-07-20

### Added

- Per-position PnL accounting (Wave 4) (#99)
- Atomic rebalance via SDK `rebalancePosition` (Wave 6) (#100)
- DLMM strategy shapes + single-sided entry (Wave 7) (#101)
- DLMM farm reward awareness (Wave 8) (#102)
- Volatility-adaptive range width (Wave 9) (#103)
- Multiple positions per pool (Wave 10) (#104)
- Backtest fidelity (Wave 11) (#105)
- Automatic fee accumulation (Wave 13) (#107)
- Stablecoin depeg and liquidity-drain alerts (W15) (#108)
- Opt-in copy-trading signals (W16) (#109)
- W14 limit-order fail-closed seam — blocked/deferred, not a working feature (#110)

### Fixed

- 20 unresolved PR review findings from #95–#110 (#111)

## [0.0.31] — 2026-07-13

### Fixed

- Live DLMM entries now reject insufficient token balances before building a transaction.
- SOL entries now account for wallet-funded position, bin-array, ATA and wrapped SOL instructions before submission.
- `prism update` migrates legacy versioned install directories to stable paths and rewrites generated wrappers.

## [0.0.30] — 2026-07-13

### Changed

- Bumped version to 0.0.30.

## [0.0.3] — 2026-06-06

### Fixed

- Release workflow — tarball now written outside source tree to prevent "file changed as we read it" tar error (#42)
- `prism backtest` — CLI arguments (`--days`, `--pools`, `--source`, `--db`) now correctly passed through to backtest engine
- `prism wallet import` — added `--file <path>` and `--stdin` secure import paths; positional arg now emits a security warning

### Changed

- Bumped version to 0.0.3

## [0.0.2] — 2026-06-04

### Added

- Position persistence to SQLite — restart no longer loses OOR counters, trailing-stop state, or position history
- Snapshot capture & replay backtest — full pool state + bin array dumped to `pool_snapshots` every cycle, replayable offline via `bun run backtest --source replay`
- R2-based update mechanism (`prism update`) — self-updates from Cloudflare R2 tarballs with SHA-256 verification, graceful fallback to GitHub Releases
- AGENTS.md — authoritative doc reconciling stale README with reality (no MCP, sqlite-vec, Effect-TS wiring, live deployment details)
- Embeddings fallback — hash-based embeddings by default (skips ~80MB ONNX download); `EMBEDDINGS_BACKEND=onnx` to opt in
- Agent feedback system — GitHub Issues filing via `prism feedback` with SHA-256 dedup, Jaccard similarity merge, and per-agent rate limiting (5/hr, 10/day)
- Install telemetry — 4 anonymous events (install, setup, dev_start, register) via D1, no PII, opt-out via `PRISM_FEEDBACK_OPT_OUT`
- CLI expanded from 4 commands to 14 — `register`, `login`, `setup`, `whoami`, `wallet`, `link-telegram`, `subscription`, `issue`, `support`, `dev`, `backtest`, `update`, `version`, `feedback`

### Changed

- Memory backend migrated from Chroma to sqlite-vec — removes external vector DB dependency, uses `bun:sqlite` native virtual tables
- Engine fully migrated to Effect-TS (Context.Tag + Layer pattern) — all side effects through service layers, explicit `provide` chain in `buildLayer()`
- Embeddings default changed from ONNX (`@xenova/transformers`) to deterministic hash-based fallback — cuts cold-start time from ~80MB download to under 1 second
- Engine dir flattened — all service files live in `engine/` (no `probes/`, `adapters/`, `risk/`, `memory/` subdirectories)

### Removed

- Claude Agent SDK / MCP integration — no more 7-tool MCP surface, no `@anthropic-ai/sdk` calls in the hot path (`@anthropic-ai/sdk` removed from `package.json` entirely)
- Chroma vector DB — `docker-compose.yml` deleted, `CHROMA_URL` config loaded but never consumed
- Old CLI commands (`analyze`, `reason`, `decide`) — consolidated into 14-command `prism` CLI

## Memory TTL Policy

- `pattern` — 90 days
- `warning` — 60 days
- `outcome` — 180 days
