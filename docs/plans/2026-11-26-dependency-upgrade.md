# Dependency upgrade, Effect 4.1 adoption, verification trail

Run date 2026-11-26. Branch `t3/upgrade-deps-effect-tla-bend2-tests`.

## Goal

Move every dependency to the newest version the project can actually run, adopt the
newer Effect 4.1 APIs where they replace hand-rolled code, and extend the formal
gate (Bend + TLA+) only where the upgrade changes an invariant worth proving.

Definition of done, falsifiable:

- `bun pm ls` shows no stale direct dependency except the ones pinned by a peer
  requirement, and each exception is recorded with the requirement that pins it.
- `bun run verify` passes all five gates (lint, format, tests, Bend, TLA+ fixed,
  TLA+ buggy must fail).
- `bun run coverage` still clears the configured thresholds with the Vitest 5
  matcher semantics.
- Any new invariant gets a Bend law and a TLA+ fixed/buggy pair.

## Baseline (before any change)

| Check | Result |
| --- | --- |
| `bun run lint` | exit 0 |
| `bun run test` | 161 files, 2323 tests passed, 68.73 s |
| effect | `4.0.0-rc.111` |
| vitest | `4.1.10` |

## Version matrix decision

| Package | From | To | Why |
| --- | --- | --- | --- |
| `effect` | 4.0.0-rc.111 | 4.1.6 | latest stable |
| `@effect/tsgo` | 0.36.5 | 0.73.4 | must match effect 4.1 |
| `oxlint` | 1.77.0 | see trail | tsgo 0.73.4 supports 1.91.0-1.94.0 only |
| `oxlint-tsgolint` | 7.0.2001 | 7.0.2008 | supported by tsgo 0.73.4 |
| `@oxlint/plugins` | 1.79.0 | match oxlint | plugin API is version-locked |
| `vitest` | 4.1.10 | 5.1.2 | latest |
| `@vitest/coverage-istanbul` | 4.1.10 | 5.1.2 | must match vitest |
| `oxfmt` | 0.64.0 | 0.80.0 | latest |
| `tsdown` | 0.22.14 | 0.23.7 | latest |
| `typescript` | 7.0.2 | 7.0.2 | already latest, the only supported pin |
| `bs58` | 4.0.1 | 6.0.0 | latest |
| `dotenv` | 17.4.2 | 18.0.10 | latest |
| `@clack/prompts` | 1.7.0 | 1.9.0 | latest |
| `commander` | 15.0.0 | 15.1.0 | latest |
| `chalk` | 6.0.0 | 6.0.1 | latest |
| `semver` | 7.8.5 | 7.8.6 | latest |
| `@types/node` | 26.1.2 | 26.6.11 | latest |
| `bun-types` | 1.4.0 | 1.4.5 | matches the 1.4.5 runtime |
| `fast-check` | 4.9.0 | 4.11.0 | latest |

Held back, with the constraint that holds them:

| Package | Installed | Latest | Blocker |
| --- | --- | --- | --- |
| `@solana/web3.js` | 1.98.4 | 3.2.1 | `@meteora-ag/dlmm@1.9.14` peer `^1.91.6`. v3 rewrote the connection/transaction API; the DLMM SDK plus our adapter are written against 1.x. |
| `@coral-xyz/anchor` | 0.31.0 | 0.32.1 | `@meteora-ag/dlmm@1.9.14` peers the exact string `0.31.0`. |
| `@meteora-ag/dlmm` | 1.9.14 | 1.9.14 | already latest |
| `@solana/spl-token` | 0.4.15 | 0.4.15 | already latest |
| `@xenova/transformers` | 2.17.2 | 2.17.2 | already latest |
| `sqlite-vec` | 0.1.9 | 0.1.9 | already latest |

## Phases

1. Baseline captured (above).
2. Effect + Effect language toolchain, verified by typecheck, lint, tests.
3. Vitest 5 + coverage, verified by tests and coverage.
4. Format/lint/build tools, verified by `format:check` and `build`.
5. Runtime deps with code changes (bs58, dotenv), verified by tests.
6. Effect 4.1 API adoption, verified per adoption with its own test.
7. Formal gate extension, verified by `verify.sh` gate 5 failing on the buggy model.
8. Full `bun run verify`.

## Trail

| # | Unit | Evidence | Outcome |
| --- | --- | --- | --- |
| 1 | Baseline captured | `bun run lint` exit 0; `bun run test` 161 files / 2323 tests, 68.73 s | green |
| 2 | `effect` 4.1.6 + `@effect/tsgo` 0.73.4 + `oxlint` 1.94.0 + `oxlint-tsgolint` 7.0.2008 + `@oxlint/plugins` 1.94.0 | `tsc --noEmit` | failed: `Config.string/number/boolean` removed (102 sites), and `ConfigLive` carried a phantom `ConfigError` |
| 3 | Renamed to `Config.String/Number/Boolean`; `FEE_DESTINATION` read no longer relied on `withDefault` alone (it does not absorb a provider source error); startup config validation made a defect everywhere (its siblings already were); explicit `ConfigLive: Layer<ConfigService, never, never>` contract; deleted the `buildLayer` cast | `tsc --noEmit` exit 0 | green |
| 4 | tsgo 0.73.4 added `unsafe-effect-type-assertion` | `oxlint` flagged 5 assertions | fixed by typing test layers from `Effect.Services<typeof effect>` (3) and deleting the now-unneeded `buildLayer` + adapter-rebalance casts (2) |
| 5 | Rebuilt the anti-slop Oxlint bundles against `@oxlint/plugins` 1.94.0 | bundle header now names 1.94.0; `oxlint` exit 0 | green |
| 6 | Full suite with Effect 4.1.6 | 1 failure: `momentum-gate` drift-gate test | control run at the pre-upgrade commit in a separate worktree reproduced the **same** failure (run 1 failed, run 2 passed): pre-existing flake, not a regression |
| 7 | Fixed the flake: the test waited 8 s of wall clock for a loop whose throughput collapses under load (it saw 2 decisions, both `[token-block]`). It now polls the audit trail until the `[drift-gate]` verdict lands and interrupts the loop | in-suite green; that test's body dropped 8.04 s → 2.29 s | green |
| 8 | `vitest` 5.1.2 + `@vitest/coverage-istanbul` 5.1.2 | 161 files / 2323 tests pass, 72.5 s | green |
| 9 | `bs58` 6, `dotenv` 18, `@clack/prompts` 1.9, `commander` 15.1, `chalk` 6.0.1, `semver` 7.8.6, `tsdown` 0.23.7, `fast-check` 4.11, `@types/node` 26.6.11 | `tsc` failed on two `fs.readFileSync` spies (overload set changed) | replaced the spies with a real temp `credentials.json` per test (better fidelity, no assertion) |
| 10 | Bun 1.4.5 alignment: `packageManager`, `bun-types`, both Dockerfile `FROM` tags, CI `BUN_VERSION` | `bun run check:toolchain` | green |
| 11 | New gate `scripts/check-toolchain.ts` wired into `verify.sh` step 0 and CI before lint | positive run green; negative run (see below) fails with the named requirement | green |
| 12 | Bend 2: `momentum_scaled` + `normal_conf_h` kernels, 12 laws (68 total), 2 parity tests with golden vectors | `bend PROOF.bend` → `300n`; 19 parity tests pass | green |
| 13 | TLA+: `Resilience.tla` (retry budget + circuit breaker) with `ResilienceFixed.cfg` and `ResilienceBuggy.cfg`; `scripts/tla-verify.sh` extended | fixed: 288 distinct states, no error; buggy: `BusinessErrorDoesNotOpen is violated` | green |
| 14 | Full gate | `bun run verify` | green: toolchain, lint, format, 2325 tests, Bend `300n`, 6 TLA checks |
| 15 | CI restructure | `.github/workflows/ci.yml` parses; job graph | `build` split into parallel `lint` / `test` / `build` / `compiled-binaries`; canary now gates on `[lint, test, build]` so a red suite still blocks a publish |
| 16 | CI staleness + waste | review of every job | PR runs cancel on push (main never cancels); docs-only main pushes skip; lockfile-keyed `~/.bun/install/cache` in all 8 install sites; `--frozen-lockfile`; per-job `timeout-minutes`; Rust cache added to `rust-host`; Bend install cached (keyed `bend-2.0`, bump to adopt a release) |
| 17 | Formal gate in CI | new `tla-proof` job | Java + digest-pinned `tla2tools.jar` cached; runs `scripts/tla-verify.sh`, so the negative controls execute on every push |
| 18 | `release.yml` redundancy | diff | `Run lint` removed from each of the 4 test shards into one `lint` job; caches added; release still `needs` lint → test → bundles |

## CI changes and why

| Change | Saving |
| --- | --- |
| `concurrency` with `cancel-in-progress` on PRs | A superseded push stops consuming runners immediately |
| `paths-ignore` on `push` only | Docs-only main pushes skip the whole pipeline; deliberately not on PRs, where a path-filtered required check never reports and blocks merge |
| Lockfile-keyed `~/.bun/install/cache` | `bun install` becomes a link step; the global store makes this the only useful cache with the isolated linker |
| `--frozen-lockfile` | Skips resolution and fails on a stale lockfile instead of silently resolving |
| `lint` / `test` / `build` as parallel jobs | Wall clock is the slowest job (tests), not lint + tests + build |
| `compiled-binaries` isolated and non-blocking | `bun build --compile` (the slowest step, informational because bun#42664 is open) leaves the required path |
| `rust-host` gets `Swatinem/rust-cache` | The rusqlite build was recompiled from scratch every run |
| Bend install cached | Skips the installer download; the cache key pins the prover version deliberately |
| `tla-proof` job with a cached jar | Adds the formal gate to CI without adding wall time (runs in parallel) |
| `lint` deduped in `release.yml` | One typecheck instead of four identical ones |
| `timeout-minutes` on every job | A hung test fails in 15-25 min instead of occupying a runner for the 6 h default |

## Decisions that are not "latest"

- **`@solana/web3.js` stays 1.98.4 and `@coral-xyz/anchor` stays 0.31.0.** `@meteora-ag/dlmm@1.9.14`
  declares `@solana/web3.js ^1.91.6` and `@coral-xyz/anchor 0.31.0` as dependencies (exact for anchor),
  and the DLMM SDK plus `engine/adapter-service.ts` are written against that API. web3.js 3.x rewrote
  the connection/transaction surface. `check:toolchain` fails if either pin drifts outside the range.
- **`oxlint` stays 1.94.0, not 1.95.0.** `@effect/tsgo@0.73.4` publishes support for Oxlint
  1.91.0-1.94.0 and tsgolint 7.0.2005/2006/2008 only. `check:toolchain` parses that table.
- **`typescript` stays 7.0.2.** 7.1 is beta-only; tsdown 0.23.7 warns that its `tsgo` type generator is
  deprecated on 7.0 and will be removed in a future minor, which is a reason to plan the 7.1 move, not
  to take a beta today.
- **No new Effect API was adopted just because it exists.** `adapter-retry.ts` keeps its hand-rolled
  loop: it overrides the delay per error with the server's `retry-after` and a rate-limit base, which
  `Schedule` cannot express without a custom schedule that would need its own tests. The adoptions that
  did land (`Config.*` constructors, `Effect.Services<typeof effect>`, `Effect.orElseSucceed`, the
  stricter tsgo assertion rule) each removed code or removed a lie.
- **The momentum kernels use thousandths, not hundredths.** Hundredths is the repo's default
  fixed-point unit, but a pool 2 bins into a 20-bin reference at the 0.05 weight earns 0.005 of
  confidence: `2 × 5 / 20 = 0` truncated it away, so the Bend kernel reported 0.560 where
  `normalEntryConfidence` returns 0.565. A formal kernel that disagrees with the source of truth on
  the smallest real momentum proves nothing about that line, so the unit is 10× finer and the parity
  test carries the 0.565 vector.

## Review follow-ups (PR #248)

| Finding | Verdict | Change |
| --- | --- | --- |
| `compiled-binaries` red on the known bun#42664 anchor initializer | real, but the check was wrong | The job no longer swallows every outcome: the known signature is a `::notice`, any other failure still fails. Caught because a red check for a known upstream bug is noise, and `continue-on-error` also hid the real ones. |
| Canary can publish while `tla-proof` is red | real | `canary-prepare` now needs `[lint, test, build, bend-proof, tla-proof]`. |
| `OpensNow` can fire on a rejected observation | real | `Admitted` gates it, and `RejectedNeverOpens` is a new invariant in both configs. The breaker must not feed itself. |
| Momentum kernel truncates sub-unit drift (Codex P2) | real | Kernels moved to thousandths; `confidence_sub_unit_momentum` and `momentum_sub_unit_kept` laws, plus the 0.565 parity vector. |
| Test timeout leaves 5 s over a 25 s poll budget | real | Poll budget cut to 15 s and the `it` timeout raised to 45 s, so the poll deadline reports a real failure instead of a generic abort. |
| `check:toolchain` never reads CI `BUN_VERSION` | real | It now scans every workflow for `BUN_VERSION` and compares to `packageManager`; negative control run proves it fails. |
| `check-toolchain` uses `console.*` | dismissed | `console.*` is what a CLI diagnostic needs: the structured logger appends to the audit trail and is meant for the engine. `scripts/compile-binary.ts`, `build-bundle.ts` and `generate-vec-embed.ts` all print the same way, and this output is read by a person looking at a failed gate. |
