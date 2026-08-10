# Changelog

All notable changes to Prism are documented here.

## [0.2.9] — 2026-08-10

### Fixed

- **clawpatch audit findings** (101-finding full audit, triaged by parallel agents; 24+ already fixed by earlier workflow hardening):
  - Build: tsconfig now typechecks `scripts/**/*` (release-critical scripts were oxlint-only); `start`/`dev` dedupe via `start:engine` (dev keeps direct `--watch` on the CLI process); the bigint-buffer bundle alias is guarded with an existsSync check at config load in both tsdown configs.
  - CI/release: BUN_VERSION and R2_PUBLIC_URL are single per-workflow envs (bun canary only publishes as a rolling tag — verified — so the env is the deliberate-bump path); all canary bundle URLs are HEAD-validated before the pointer flip (fail-closed jq count guard); alert-flush gains a concurrency group, timeout-minutes, and --connect-timeout; the cloudflare-tests shard drops bunx; release manifests only advertise signatures when one will exist and gate the source-tarball/checksum existence before writing.
  - Scripts: `version_gte` compares prerelease identifiers semver-aware (canary.10 > canary.2) with build metadata stripped before parsing; install.sh splits capture from fallback; publish-skills.sh rebuilds unconditionally, verifies the built entrypoint, and dry-runs clean checkouts.
  - Coverage governance: vitest branches:60 rationale documented; the hand-maintained exclude array carries a guard comment (#212)

### Changed

- Bumped version to 0.2.9.

## [0.2.8] — 2026-08-09

### Changed

- **RPC dedup — active-bin memoization** (verified by the performance audit: getActiveBin was fetched TWICE per pool per cycle — once in getPoolState, once in getBinArray — and getBinsAroundActiveBin re-fetched the same bin array getActiveBin just loaded; ~3 of the ~7 RPC/pool/cycle were pure waste). A short-TTL (3s) memo shared by both calls makes the within-cycle pair cost ONE SDK fetch each, invalidated on every mutation and pruned of expired entries (paper mode never mutates). Hardened through six review rounds: the memo aligns binId/price/binsAround to one snapshot (the bins fetch carries its own active bin), bounds derive from the fetched snapshot (a pool moving mid-cycle cannot produce newer bins filtered by an older range), an empty stored price is a miss (no currentPrice 0), the TTL starts at pool-state assembly end and only for fresh fetches (caller cadence cannot extend it), and the memo is range-keyed. ~7 → ~4 RPC/pool/cycle, zero behavior change (#211)

### Added

- 46 test cases (1729 total): memo proofs (one fetch per pair, TTL expiry on both halves), 24 launch-gate boundaries, 7 wash-forensics + 9 runner-dip thresholds, 4 decision-loop edges (no exit-and-reenter, timebox beats scale-in, wash gate rejection, launch-cap boundary) (#211)

### Changed

- Bumped version to 0.2.8.

## [0.2.7] — 2026-08-09

### Fixed

- **Launch pools excluded from the idle-redeploy queue** (found by the architecture audit): the three idle-redeploy capture sites were not guarded for launch pools, and the redeploy pass emits a STANDARD decision that never carries `positionMode: "launch"` — a redeploy entry on a launch-gated pool would have gotten neither the launch timebox/volume-decay/drawdown protection nor the runner dip shape. All three captures are now gated on the launch-lane predicate; the launch lane's own ENTER branch owns launch entries. Regression test drives a launch pool through the full scan with the portfolio full, a mid-cycle slot-freeing exit, and the redeploy's widened size passing — proven to fail without the guard (the pass enters the pool as a standard position) and pass with it (#210)

### Changed

- Bumped version to 0.2.7.

## [0.2.6] — 2026-08-09

### Added

- **Wash forensics** — the launch lane can now distinguish real volume from wash trading before capital enters: one Helius enhanced-API call per admitted pool per radar refresh scores wallet concentration (few payers across many trades), bot bursts (>5 trades/sec from ≤2 wallets) and fee uniformity, from the feePayer of each successful METEORA transaction (DLMM swaps are not in Helius's parsed models, but the payer survives). `LAUNCH_WASH_FORENSICS_ENABLED` (default off) logs the evidence in the radar payload and hard-rejects egregious evidence with an audited `[wash-forensics]` ENTER gate — before every specialized ENTER branch (fallen-angel included), launch-lane-only, fail-open on every fetch/parse failure, bounded in width (top-30) and concurrency (5), and served from the canonical api- enhanced API host. Validated against live data: the TOAD pool's recent txs came from 4 payers — 25 from one wallet — in a 4-second window (#209)

### Changed

- Bumped version to 0.2.6.

## [0.2.5] — 2026-08-09

### Added

- **Runner scale-in (Heart Attack step 2)** — when a runner position's price falls a full step below its band anchor (`LAUNCH_RUNNER_SCALE_IN_STEP_PCT`, default 5%), the engine re-anchors the band at dip% below the NEW price and tops up the position with fresh quote capital (`LAUNCH_RUNNER_SCALE_IN_SIZE_PCT` × wallet, capped by the per-pool allocation headroom and `LAUNCH_POSITION_MAX_SIZE_USD`, up to `LAUNCH_RUNNER_SCALE_IN_MAX_STEPS` steps). The scale-in is a position-targeted REBALANCE decision routed through the normal executor — risk gates (safety pause), the agent overlay (veto/supervised/full), and the paper/live dispatch; a topUp-carrying range is exempt from the contains-active-bin check because the below-market band is the point. The top-up is booked as capital (cost basis grows in lockstep, X basis credited), its SOL cost is reserved from the batch budget (`estimateEntrySolLamports`, skip-never-force), the quote leg is acquired via the xOnly prep, and the step count + anchor are persisted (migration v24) so a restart cannot re-scale a filled position. Paper mode evaluates the trigger and advances the state so paper validates the band-tracking (#208)

### Changed

- Bumped version to 0.2.5.

## [0.2.4] — 2026-08-09

### Added

- **Runner mode (Heart Attack)** — the launch lane's optional dip-capture posture, validated on the live TOAD runner (at-market entry + 15% stop lost ~15% on the run while a -12% below-market bid ladder made +50% the same hour): `LAUNCH_RUNNER_MODE_ENABLED` anchors launch ENTERs below the active bin (`LAUNCH_RUNNER_DIP_PCT`, bin math `ln(1-dip)/ln(1+binStep/1e4)`) in a tight band (`LAUNCH_RUNNER_HALF_WIDTH_BINS`, clamped to the range cap and strictly below-market), funds them single-sided-X (full size in the quote leg — the X that converts when the dip fills; the Y half is never swapped), and uses a shakeout-tolerant stop (`LAUNCH_RUNNER_DRAWDOWN_PCT`) pinned to how each position was ENTERED (persisted `launch_runner` on the row, restart-safe). Pre-fill runner positions are excluded from the generic OOR/rebalance machinery — the launch timebox/decay/drawdown owns their exits. Paper models the same single-sided exposure. OFF by default (#207)

### Changed

- Bumped version to 0.2.4.

## [0.2.3] — 2026-08-09

### Added

- **Launch radar multi-timeframe probes**: the radar now logs rolling-window fee-yield AND volume curves (30m/1h/2h/4h/12h/24h) per admitted pool from the same Data API payload — no extra calls — so wash patterns (a burst confined to one window) and hotness cross-checks are visible (#206)
- **Rejection histogram**: when nothing admits, the radar logs the top-6 rejection categories with counts and an example reason (`age: 121 — age 5.9h > 6h`) — the 0-admitted universe becomes diagnosable instead of a black box. Rejections are bucketed by a stable category, not the value-embedded reason string (#206)

### Fixed

- Launch volume-decay degradation is now visible: when the Data API is down (gecko/heuristic stats), an open launch position's 1h-fee decay rule cannot fire — escalated to a per-position warn (timebox + drawdown remain the backstop). The datapi-up-but-window-missing case (young zero-fee pool) stays at debug (#206)

### Changed

- Bumped version to 0.2.3.

## [0.2.2] — 2026-08-09

### Fixed

- Exit withdrawal accounting now measures each leg's actual withdrawal from the on-chain wallet balance delta around the close batch instead of trusting the SDK position snapshot (which under-read a live position by ~40%: a $41.91 all-USDC position reported $24.38, so the exit settlement sold only $24.38 and `finalizeSettlementGroup` recomputed the correct +$0.78 realized into -$16.78). The delta includes swept fees/rewards (`shouldClaimAndClose`); same-mint LM rewards are excluded because the exit books them separately. Falls back to the SDK snapshot only when the delta is unmeasurable (2s deadline under degraded RPC — the close is never delayed for accounting) or negative, with an audit-trail warn distinguishing measured from snapshot-derived withdrawals (#205)
- `finalizeSettlementGroup` no longer clobbers a resolved exit realized PnL with a settlement-output-derived recomputation (which was wrong when the settlement recovered only part of the withdrawal) — it only fills the NULL (unresolved pricing) case (#205)

### Changed

- Bumped version to 0.2.2.

## [0.2.1] — 2026-08-09

### Added

- **Launch Mode v2 — execution lane**: launch-gated pools now flow into a separate time-boxed execution lane. `launchPositionExit` (pure policy: 6h time-box, 1h-fee volume decay vs in-process peak, drawdown from peak seeded at deposit, fee/IL < 0.5) and `launchEntrySizeUsd` (min size cap, 0.5% TVL, 50% wallet); launch ENTERs run the FULL existing gate chain with a separate `LAUNCH_MAX_OPEN_POSITIONS` counter; per-position lifecycle exits via the normal EXIT path; measured Data-API fees only (gecko/heuristic never fire volume-decay). Position mode survives applied agent proposals; exits stay armed if the lane is disabled mid-position; executable set bounded to top-K (#202)

### Fixed

- Exit settlement amounts are reconciled with the live wallet balance at execution time: the sell amount is clamped to `min(job amount, wallet balance)` before quoting (a concurrent entry consuming the exit proceeds previously made the swap simulation fail forever — 130 attempts in the field), a fully-consumed balance terminalizes with a clear error instead of looping, and the orphan sweep now revives a terminal job's wallet-held excess even when the mint is position-backed (position liquidity lives in the position account, not the wallet). Entry preparation reserves pending settlement claims from the spendable balance, so a new entry can no longer consume funds an exit settlement is about to sell (#203)

### Changed

- Bumped version to 0.2.1.

## [0.2.0] — 2026-08-09

### Added

- **Launch Mode v1 — hot-pool radar**: a sub-minute discovery feed for the highest fee-yield DLMM pools (the data path for high-cadence launch capture). `discoverHotPools` fetches `/pools?sort_by=fee_tvl_ratio_24h:desc` (curl-verified payload paths), a pure `launch-gate` admits only young pools (age ≤ 6h, TVL $5k–$1M, ≥$50k 1h volume, base fee ≥1%, binStep 50–200, wash-turnover cap, token-safety legs) ranked by 1h fee yield, and the per-cycle radar logs the top-K with address, fee yield, volume, and age. Off by default (`LAUNCH_SCAN_ENABLED`); screening only — the execution lane is the next milestone (#199)

### Fixed

- Jupiter API traffic gate: every api.jup.ag request (swap quote/build, price, token search — one shared keyless rate-limit bucket at 0.5 RPS sustained with a ~5-request burst cap) now routes through a process-wide gate that paces requests to 0.4 RPS and opens an escalating cooldown (1 min → 60 min) on 429, honoring the documented `x-ratelimit-reset` backoff target — a self-inflicted rate-limit ban can no longer be refreshed by retry loops and capital-lock the wallet (#198)
- Route-probe quote cache: the autonomous-candidate refresh's per-cycle fan-out (up to ~80 identical probe quotes — the dominant Jupiter traffic term) now caches successful probes for at least one scan interval (10-minute minimum), cutting steady-state probe traffic to ~zero (#198)

### Changed

- Bumped version to 0.2.0.

## [0.1.12] — 2026-08-08

### Fixed

- The `settlement_overdue` safety pause no longer latches on jobs that are progressing per policy: a settlement with a FUTURE `nextRetryAt` (e.g. a rate-limited 429 backing off) is excluded from the overdue-age computation, and the pause auto-resolves as soon as no genuinely stuck job remains (a job with NO scheduled retry, like the operator-reconciliation state, still latches). A sustained Jupiter rate limit can no longer halt the whole agent while the scheduled retry waits. `prism status` gains an `Overdue:` line listing settlements past the max-pending window that are not final, so prolonged rate-limit stalls stay operator-visible without halting trading (#196)
- Settlement retry backoff caps at 30 minutes instead of 5: a sustained rate-limit ban outlasted the old cap, so capped retries re-429ed forever and added quote pressure to the ban; the exponential ramp still retries normal blips quickly (#196)

### Changed

- Bumped version to 0.1.12.

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
