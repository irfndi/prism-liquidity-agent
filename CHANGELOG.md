# Changelog

All notable changes to Prism are documented here.

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
