# Changelog

All notable changes to Prism are documented here.

## [0.1.11] — 2026-08-08

### Added

- **Effect type-aware linting** via `@effect/tsgo`: the Effect LSP-derived rules now run in oxlint's type-aware mode (prepare-script patched, `effecttsgo` plugin, exact-pinned toolchain) (#185)
- **Zero-warning sweep**: 1579 findings eliminated across 80 files — every Effect error channel typed (1464), stringification and floating-promise classes fixed (114) — and the five rules enforced as errors, so the type-aware lint gates every future change (#190)

### Fixed

- The `execution_failures` safety pause is no longer a permanent one-way latch: each cycle auto-resolves when the failure counter is below `MAX_CONSECUTIVE_EXECUTION_FAILURES` (a fresh process starts at 0, so a restart alone clears a stale latch), and the counter decays to 0 after every quiet cycle so a transient spike clears itself mid-run; the pause re-arms only when a cycle genuinely breaches again, and `prism resume` stays an operator override (#187)
- Unpriceable wallet tokens are dust for the orphan sweep: a token with no resolvable USD price is value-unknown ⇒ $0, so the sweep skips it and the settlement processor dust-confirms existing jobs with a distinct "settlement dust skipped (no USD price)" error instead of quoting them — the Jupiter 400 no-route retry loop is gone, and tokens re-qualify automatically once a price resolves. `prism status` reconciles the Stranded line with the dust policy: sub-dust terminal settlements are excluded (intentionally never re-queued), priceable stranded capital shows its USD value, and unpriceable terminals get a separate Unpriceable line (#188)
- `prism update` detects a running agent after a successful update (dev lockfile or process scan, including the bundled `dist/cli/index.mjs dev` systemd pattern) and prints a prominent restart-required notice with the exact restart command, exiting non-zero (code 2, distinct from update-failure's 1) so scripts can tell "updated, restart needed" apart from "update failed" — the running agent keeps executing the old build until restarted (#189)
- Stranded settlement classification: deduplicated lookups and outage-specific wording for unreachable price feeds (#192), and no fabricated fallback prices in the stranded classification (#193)
- Pinned the issue #191 settlement_overdue latch scenario with a regression test (#194)

### Changed

- Bumped version to 0.1.11.

## [0.1.10] — 2026-08-08

### Fixed

- **Broken v0.1.9 bundles (#179)**: the release bundles externalized `effect` and shipped without node_modules, so the installed CLI resolved the runtime from bun's global cache — which held effect 3.x — and crashed at startup (`Context.Service is not a function`). All runtime dependencies (effect, @solana/web3.js, @meteora-ag/dlmm, commander, chalk, dotenv, @clack/prompts, semver, bs58, @solana/spl-token, sqlite-vec) are now bundled into the engine and CLI artifacts, making release tarballs self-contained and version-consistent. Verified in a node_modules-less directory: `--version`, `--help`, and `prism status` all boot. `@xenova/transformers` stays external (optional ONNX backend; import failure falls back to hash vectors).
- **Update never leaves the agent unrecoverable (#179)**: `prism update` keeps ONE persistent backup of the previous install (`<installDir>.bak-<previousVersion>`) instead of deleting it after the smoke test — including the `--skip-smoke-test` path that previously installed a broken bundle with no way back. The backup is failure-safe (stale backups are only removed after the new one is in place), named after the version it contains, and persistence runs inside the rollback-protected path so a failure restores the previous install.

### Changed

- Bumped version to 0.1.10.

## [0.1.9] — 2026-08-07

### Added

- **Effect 4.0.0-beta.105 migration**: engine, CLI, bench suite, and the Cloudflare workers move to one unified Effect tree (`Context.Service` tags, `catch`/`catchCause`, `Result`, `callback`, `timeoutOrElse`, `forkChild`, Schema v4, per-build env snapshot in `ConfigLive` so vitest stubs and CLI-set env are honored) (#172)
- **Settlement 429 recovery (#166, #169, #175)**: transient settlement failures (HTTP 408/425/429/5xx and network errors) retry with bounded backoff and never terminalize — a rate-limited rollback resumes once the outage clears. An orphan-token sweep re-queues wallet tokens with no backing position or active settlement: terminal rows are revived in place (attempts carried so backoff escalates across generations, sells the current wallet amount) while signature-carrying terminal rows spawn fresh jobs; the `settlement_overdue` safety pause auto-resolves once nothing is in flight; `prism status` reports terminal settlements with unspent balance (order-aware — a recurring stranding stays visible)
- Batch wallet-reserve gate for SOL-funded entries: per-cycle free-SOL budget (wallet SOL minus gas reserve, refreshed after every live mutation) gates each live ENTER in autonomous canary/live mode, skipping capacity-limited entries as audited `[wallet-reserve]` decisions instead of submitting doomed swaps. The `execution_failures` safety pause can no longer be armed by batch over-commitment — funding-condition ENTER failures (insufficient token balance / SOL / USDC) are treated as capacity-limited and excluded from the pause breaker and pool-failure counts (the entry-failure backoff still arms). Pools are funded in scan order, which is fee-APR rank order in market-scan mode (#170)
- Stable dependency bump: effect 3.22.1, @meteora-ag/dlmm 1.9.14, hono 4.13.1, oxlint/oxfmt/tsdown latest (#173)

### Fixed

- **Cloudflare deploy**: alchemy requires `Schema.TaggedErrorClass`, removed from effect in beta.105 — `infra/` pinned to the effect 4.0.0-beta.102 line it needs (workers stay on beta.105); deploys green again (#176, #177)
- `SOL_PRICE_USD=0` (validated with min 0) no longer zeroes the wallet-reserve USD→lamports reservation — SOL-funded entries skip fail-closed instead of approving full-size entries (#172)
- The `settlement_overdue` safety pause excludes terminal settlement jobs from its age computation (#168)
- Transient-error classification is anchored to HTTP-status context — deterministic messages like "need 500 lamports" no longer retry forever (#175)

### Changed

- Removed 48 unused imports and dead locals across engine, CLI, and tests — `tsc --noUnusedLocals` clean repo-wide (#174)
- Bumped version to 0.1.9.

## [0.1.8] — 2026-08-07

### Added

- Agent decision context now carries the targeted position state: EXIT/REBALANCE/targeted-HOLD decisions render a `POSITION:` block (current value vs basis, range, hours held, out-of-range duration) into both the veto overlay and sync-proposal prompts, so the advisor reviews are grounded in the position being acted on — not just pool metrics (#163)
- Sync advisor proposals get a latency skip mirroring the veto path: when the rolling p95 of proposal latencies exceeds the proposal budget, the round trip is skipped fail-open WITHOUT arming backoff or the circuit breaker (a slow model is not a bad advisor), plus an outer deadline that bounds the entire proposal op including transport reconnect (#164)
- High-frequency rotation profile: `MAX_ENTRY_SIZE_USD` cap threaded through the normal ENTER path (and idle-redeploy), session-level rotation metrics, and a fast-churn config profile for sub-minute scan cadences (#165)

### Fixed

- Sync-proposal path receives the same conditional position state as the veto path (position context was only wired into the veto request) (#163)
- `hoursHeld`/OOR duration rendered in agent prompts are precomputed at context construction and clamped against clock skew — no render-time `Date.now()` divergence, no negative ages (#163)

### Changed

- Bumped version to 0.1.8.

## [0.1.7] — 2026-08-07

### Added

- Market-scan universe trading — the watchlist becomes an optional overlay: with `MARKET_SCAN_ENABLED=true` the engine continuously scans the TVL-ranked Meteora universe and trades the best pools through the full existing gate chain (safety screening, metrics, fee/IL, volume auth, risk gates). New `MARKET_SCAN_*` config block: universe pages, TVL/fee-APR/turnover/bin-step gates, top-K active set, token-safety pre-filter (#158)
- DB-tunable config allowlist extended to the market-scan and tuning knobs (`MARKET_SCAN_*`, `DUST_EXIT_USD`, `TRAILING_STOP_CONFIRM_CYCLES`, `VOLATILITY_EXIT_STDDEV`, range-width and cooldown keys, `IDLE_REDEPLOY_*`) — changeable at runtime via `prism config set` without a restart (#159)
- `prism doctor` gains a `config` check that fully loads the config (env + .env + DB sidecar, every numeric clamp) and FAILs on broken values before engine startup (#159)

### Fixed

- Real on-chain position mark replaces the bin-drift heuristic — kills the trailing-stop/OOR churn that opened 340+ positions in 2.5 weeks with ~zero P&L. Fallback chain (HODL revaluation of entry legs → cost basis) never fabricates a drawdown (#157)
- Dust entries below the $10 `ENTRY_SIZE_FLOOR_USD` are rejected; new `DUST_EXIT_USD` (default 5) deterministically exits residual dust positions and reclaims their per-pool slot; portfolio equity no longer counts idle wallet balance as unrealized gain (#157)
- `prism setup` now MERGES into an existing `.env` instead of replacing it — re-running no longer wipes user keys, custom comments, or unknown vars (backup-only before) (#159)
- Market-gate token pre-filter fails open on absent token metadata (unknown holder count passes; known counts keep their threshold checks), and per-page universe fetch failures are isolated (#158)

### Changed

- Bumped version to 0.1.7.

## [0.1.6] — 2026-08-05

### Fixed

- Trailing-stop EXITs now require the drawdown breach to persist across consecutive cycles (`TRAILING_STOP_CONFIRM_CYCLES`, default 2) — kills the phantom EXIT churn caused by unstable tracked-peak references (#153, #156)
- GeckoTerminal OHLCV fetches are resilient: last-good series cached per pool (6h TTL, 24h retention), failing pools back off exponentially (5 min → 1 h), and stale data is reused on transient outages so fallen-angel discovery is no longer starved of drawdown/vol signals (#154, #155)

### Changed

- Bumped version to 0.1.6.

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
