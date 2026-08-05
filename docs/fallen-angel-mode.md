# Fallen-angel mode — plan (decision-complete)

Status: **implemented and merged-ready** (Waves A-D2 complete). 7 feature commits + 1 follow-up,
PR #152. All 115 test files / 1464 tests pass.

## What "fallen-angel" means here

A **fallen-angel** pool is a Solana DLMM pool whose underlying token has:

- **fallen hard from its all-time high** (deep drawdown per GeckoTerminal OHLCV),
- **calm-enough volatility** to be a defensible mean-reversion (not a dying or
  lunatic token): daily-return stddev within a band,
- a **clean security profile** (RugCheck: no critical risks, no revoked/unknown
  authorities, sane holder concentration, ≥ min holders, above a score floor),
- **any TVL** — the discovery path deliberately drops the normal
  `DISCOVERY_MIN_TVL_USD` / `MIN_POOL_TVL_USD` floor so under-adopted fallen
  tokens are reachable.

The thesis is **mean-reversion / oversold bounce**: buy distressed-but-safe
tokens, take profit in a **ladder** of price targets, and cut the position on an
**invalidation stop** (price falls below the level that would break the thesis).

## The 3 locked user decisions

1. **DB-config precedence = env > DB > defaults.** The engine keeps its
   existing env-driven `ConfigService.loadConfig` as the source of truth. A new
   sidecar layer reads overrides from the SQLite `metadata` table (keys
   `config.<ENV_KEY>`) and applies them ONLY for keys whose env var is unset.
   Env always beats the DB; the DB beats the compiled-in default. Fail-open:
   a missing/unreadable DB leaves env/defaults untouched.

2. **Fallen-angel is opt-in, paper-first, and additive-only.** Master switch
   `FALLEN_ANGEL_ENABLED` (default `false`). When off, behaviour is
   byte-identical to today. When on, the mode adds (a) a new any-TVL discovery
   path, (b) a fallen-angel entry gate, and (c) a position lifecycle — all
   layered on top of the existing safety screening, risk, audit, execution,
   memory and alert pipeline. It never relaxes a safety gate (blacklist,
   freeze-authority, stablecoin allowlist, Data-API blacklist, RugCheck).

3. **TP-ladder + invalidation-stop is a full-close scale-out, not a
   partial-withdraw.** The adapter's `exitPosition` is full-close-only (no
   `bps` partial withdrawal) and W14 limit orders are blocked, so a rung death
   is implemented as **EXIT the whole position at confidence 1** with a
   `[tp-ladder]` reason, then re-open the remaining fraction as a fresh
   smaller fallen-angel position on the next scan cycle (scale-out via
   close-and-reopen). The invalidation stop is a full EXIT at confidence 1
   below the invalidation price. This reuses the existing exit/enter executors
   and keeps the whole feature additive.

## Gate mapping: fallen-angel flow vs existing capabilities

| Fallen-angel gate | Capability | Exists? | Work |
| --- | --- | --- | --- |
| Security (RugCheck) | token-risk overlay / Data-API `is_verified` | partial | **New** `RugCheck` fetcher + gate; reuses stablecoin allowlist exemption |
| Deep drawdown from ATH | `pool_snapshots` (14d) — too short | partial | **New** GeckoTerminal OHLCV fetch (ATH / drawdown / vol-baseline) |
| Volatility baseline | `computeBinVolatilityStddev` (intra-cycle bins) | yes | Reuse for live vol; **new** OHLCV daily-return stddev for the baseline |
| Any-TVL discovery | `screener.screenPools` (1M floor) | partial | **New** fallen-angel discovery pass with a floor of `FALLEN_ANGEL_MIN_TVL_USD` |
| ENTER gating | `evaluatePool` ENTER slot (fee-il-gate / weighted score / allocation / risk) | yes | Add a fallen-angel branch that swaps the *quality* eligibility for the fallen-angel gate; risk/confidence/allocation tail unchanged |
| TP-ladder lifecycle | none (no TP logic exists) | no | **New** `tp-ladder.ts` + position-mode stamping + per-cycle ladder/invalidation EXIT seam |
| Invalidation stop | trailing-stop / stop-loss exist | partial | **New** per-position invalidation price + EXIT at confidence 1 |

## Work breakdown

### Wave A — DB-backed config + `prism config` CLI (self-contained)

- `engine/db-config.ts` — pure registry (`DB_CONFIG_KEYS`: envKey → kind/field/clamp),
  `readDbConfigOverrides(db)`, `applyDbConfigOverrides(cfg, overrides)` (env-wins),
  `parseDbConfigValue`. Fail-open.
- Wire into `config-service.ts` `ConfigLive` so the DB layer sits under it
  (env > DB > defaults). Guarded so test mode never opens a DB.
- `cli/config.ts` — `prism config get|set|unset|list` against the `metadata`
  table via `DbService.getMetadata`/`setMetadata`. Register in `cli/index.ts`.
- Tests: `bench/db-config.test.ts`, `bench/cli-config.test.ts`.

### Wave B — Data fetchers (self-contained, live-verified contracts)

- `engine/gecko-ohlcv-service.ts` — `getGeckoPoolOhlcv` (OHLCV rows →
  ATH/drawdown/vol-baseline), injectable `fetchImpl`, pacing, fail-open.
  Contract verified: `GET /networks/solana/pools/{addr}/ohlcv/day?limit=N` →
  `data.attributes.ohlcv_list = [[ts, open, high, low, close, volume], …]`.
- `engine/rugcheck-service.ts` — `getRugCheckReport(mint)` →
  `{score, scoreNormalised, mintAuthority, freezeAuthority, tokenMetaMutable,
  topHolders, risks, …}`, injectable `fetchImpl`, fail-open.
  Contract verified: `GET /tokens/{mint}/report`.
- Tests: `bench/gecko-ohlcv.test.ts`, `bench/rugcheck.test.ts` (live fixtures).

### Wave C — fallen-angel gate pipeline + any-TVL discovery

- `engine/fallen-angel-service.ts` — pure `evaluateFallenAngelCandidate`
  (RugCheck security + drawdown + vol-band + min TVL) and
  `evaluateFallenAngelQuality` (re-confirm at ENTER time). Reuses the stablecoin
  allowlist for the "asset side" identification.
- Discovery: in `program.ts`, a gated `refreshFallenAngelCandidates(scanOrdinal)`
  consuming `adapter.discoverPools` with the lower floor, evaluating the gate,
  feeding qualified pools into `poolsToScan` (paper + live discovery modes).
- Config: `fallenAngelEnabled`, `fallenAngelMinTvlUsd`, `fallenAngelMinDrawdownPct`,
  `fallenAngelMaxDrawdownPct`, `fallenAngelVolBaselineMin`,
  `fallenAngelVolBaselineMax`, `fallenAngelMinRugcheckScore`,
  `fallenAngelMinHolders`, `fallenAngelMaxTop10HolderPct`.
- Tests: `bench/fallen-angel-service.test.ts`.

### Wave D — spot TP-ladder + invalidation-stop lifecycle

- `engine/tp-ladder.ts` — pure `buildTpLadder`, `evaluateTpLadder`,
  `shouldInvalidate`, ladder serialization.
- DB migration v22: `positions.position_mode`, `tp_ladder_json`,
  `invalidation_stop_price`. `PositionRecord` + `rowToPosition` + `savePosition`.
- `program.ts`:
  - stamp `positionMode: "fallen-angel"` + ladder + invalidation on the ENTER
    decision (and persist in `executePaper`/`executeLive`),
  - per-cycle evaluation: invalidation-stop EXIT + TP-ladder scale-out EXIT,
  - next-cycle remainder re-open (scale-out via close-and-reopen).
- Config: `fallenAngelTpRungs` (e.g. `[0.15,0.30,0.50]`), `fallenAngelTpFractions`
  (e.g. `[0.4,0.3,0.3]`), `fallenAngelInvalidationStopPct` (e.g. `0.25`).
- Tests: `bench/tp-ladder.test.ts`, `bench/fallen-angel-lifecycle.test.ts`.

### Wave E — verify + PR

- `bun run lint`, `bun run build`, `bun run test`, `bun run format:check`.
- Manual QA notes in `docs/fallen-angel-mode-qa.md`.
- Branch + `gh pr create`.

## Upgrade helper for NEXT releases (must-have)

Upgrades must not break existing installs or silently drop user config. The
helper for every future release is the existing **migration system** + the
**registry**, each with one enforced rule:

1. **Schema changes go through `engine/db.ts` `MIGRATIONS`** (additive
   `ALTER TABLE ... ADD COLUMN` numbered migrations, guarded by `hasColumn`).
   They auto-run on the next `createDatabase()` open — no manual step. The
   fallen-angel position columns (Wave D) are migration v22.
2. **New DB-config keys go through `engine/db-config.ts` `DB_CONFIG_KEYS`**
   with three forced steps:
   (a) add an **optional** field to `AppConfig` (optional so test fixtures that
   omit it keep compiling),
   (b) read it in `loadConfig` with `Config.string/boolean/number` +
   `orElseSucceed(default)` (env + default), and
   (c) add a `DB_CONFIG_KEYS` entry so the sidecar can override it when the env
   var is unset.
   A release that adds a key and forgets (c) is still safe — the feature just
   reads env/defaults — but a release that skips (a)/(b) breaks the build.
3. **`prism config list` and `prism doctor`** are the user-facing upgrade
   helpers: `config list` shows every overridable key and which env vars shadow
   it (so a stale DB row can never silently override a new default); a
   `doctor` config-plug check asserts the registry parses and the metadata
   table is reachable. Both fail open — an old DB without the metadata table,
   or an unreadable DB, degrades to env/defaults, never to a crash.
4. **Backwards compatibility is the default, not a mode**: the sidecar only
   applies rows whose env var is unset, so an environment that pinned a value
   in `.env` keeps winning after upgrade; `prism config unset` restores the
   default when a user wants to revert.

## Ordering rationale

A (config) and B (fetchers) are independent and fully testable in isolation —
they are the foundation the gate (C) and lifecycle (D) consume. C depends on A+B
config + fetchers. D depends on C's ENTER tagging + config. Each wave keeps the
tree green before the next starts (AGENTS.md: grow in layers, never trade a
working product for unfinished complexity).
