# Decision kernel refactor — facts, rules, policy, attribution

**Status:** in progress, 2026-10-30. Phase 0 (attribution) and the first Phase 1 slice (pure facts module) are landed; the kernel itself is still not on the decision path.
**Scope:** `engine/program.ts` decision loop, `engine/cycle/evaluate-pool.ts` replay kernel, `engine/risk-service.ts` admission layer, `engine/config-service.ts` policy surface.
**Related:** `docs/plan/2026-09-18-rust-bend-hybrid.md` (this refactor is the TS-side precondition for porting the decision path to the Rust host), `docs/profitability-review-2026-09-05.md`.

---

## 1. Why

The engine is heavily tested (154 test files, ~53k lines) and well commented, but its **shape** blocks three things at once: adding a rule safely, proving a rule is profitable, and moving the decision path to Rust.

| Measurement | Value |
| --- | ---: |
| `engine/program.ts` | 15,754 lines |
| `evaluatePool` (one function) | lines 10,214 → 15,316 (~5,100 lines) |
| Gate helpers defined inside it (`check*`, `passes*`, `evaluate*`) | 57 |
| Decision emission sites (`action: "ENTER"/"EXIT"/…`) | 55 |
| `audit.recordDecision` call sites | 36 |
| Distinct `[tag]` vocabularies for gates | ~40 |
| Config fields feeding branches | ~145 |
| Replay kernel (`engine/cycle/evaluate-pool.ts`) | 193 lines, 3 rules |

Consequences:

1. **A rule is a branch in a 5,100-line effect.** Adding one means editing `evaluatePool`, threading new state through closures, and re-testing adjacent lanes. Rules cannot be listed, ordered, counted, or unit-tested in isolation.
2. **Live and replay are different engines.** The backtest uses 193 lines with hardcoded `0.65 / 0.10 / 0.15 / 0.4` and three rules (`ops/backtest.ts:892`). No offline experiment currently measures the live strategy, so tuning cannot converge.
3. **Only one economic gate exists, and it is a ratio.** Normal ENTER requires `feeIlRatio ≥ MIN_FEE_IL_RATIO`; its IL term is a documented "conservative upper-bound **ranking signal**" extrapolated from the last cycle's drift (`strategy-service.ts:64`). A cost-aware `expectedNetProfitUsd()` already exists (`fee-capture.ts:494`) and is called from exactly one place (`program.ts:4673`).
4. **Capacity is consumed in scan order.** Per-pool evaluation executes ENTERs as it iterates, so `MAX_OPEN_POSITIONS` slots go to the first qualifying pools in scan order rather than the best ones.

The fix is not "more rules". Rule evaluation is microseconds; the binding cost is RPC (4–8 calls per pool per cycle). The fix is to make decisions **pure, total-ordered, attributable and replayable**, so rules can be added and pruned on measured net expectancy.

---

## 2. Target shape

```
                   ┌─────────────────────────────────────────┐
   RPC / APIs ───▶ │  Facts plane (I/O, bounded concurrency)  │
                   │  CycleFacts: pool · positions · portfolio│
                   │  · wallet · regime · market              │
                   └───────────────────┬─────────────────────┘
                                       │ immutable snapshot
                   ┌───────────────────▼─────────────────────┐
                   │  Decision kernel (pure, no Effect/DB)    │
                   │  rules ─▶ proposals ─▶ arbitration       │
                   │  (tier, then net expectancy)             │
                   └───────────────────┬─────────────────────┘
                                       │ DecisionPlan + losing proposals
                   ┌───────────────────▼─────────────────────┐
                   │  Admission (risk gates, unchanged shape) │
                   └───────────────────┬─────────────────────┘
                                       │ approved plan
                   ┌───────────────────▼─────────────────────┐
                   │  Execution + persistence                 │
                   │  audit carries ruleIds + policyVersion   │
                   └───────────────────┬─────────────────────┘
                                       │ realized closes
                   ┌───────────────────▼─────────────────────┐
                   │  Attribution ledger (per rule, per pool) │
                   │  drives policy + rule enablement         │
                   └─────────────────────────────────────────┘
```

Three rules of the architecture:

- **Facts never call back into decision code, and the kernel never does I/O.** Every unknown is explicit (`*Known` flags, `null`).
- **One kernel for live, paper and backtest.** Backtest replays recorded `CycleFacts`; determinism comes from the facts, not a simplified twin.
- **Every decision names its rules.** No anonymous branches.

---

## 3. Rule contract

Rules are typed TS objects in a registry — **not** a DSL, YAML, or expression language. A DSL loses type safety, adds a parser, and doubles the cost of the Rust port.

```ts
type RulePhase = "guard" | "entry" | "manage" | "exit" | "portfolio";

interface Rule {
  id: string;                       // stable attribution key, e.g. "trailing-stop"
  phase: RulePhase;
  tier: DecisionTier;               // safety > protect > lifecycle > yield > rebalance > entry
  scope: "pool" | "position";
  evaluate(ctx: {
    facts: CycleFacts;
    position: PositionFacts | null;
    policy: DecisionPolicy;
  }): RuleHit | null;               // null = rule does not fire
}

interface RuleHit {
  action: ActionType;               // ENTER | EXIT | REBALANCE | HOLD
  confidence: number;
  reason: string;                   // still bracket-tagged for the existing audit vocabulary
  expectedValueUsd?: number;        // optional economics for arbitration
  costsUsd?: number;
}
```

Lifecycle is unchanged: guards run first (safety/admission), then per-position protect/manage/yield, then at most one ENTER per pool. Portfolio-level arbitration runs **after** all pools propose, in two phases:

1. **Propose:** every pool/position produces proposals independently. Safe to parallelize; no shared mutable state.
2. **Arbitrate:** portfolio slots (`MAX_OPEN_POSITIONS`), per-pool caps and per-pool position caps are allocated by rank, not scan order.

### Tiers (explicit, not incidental)

| Tier | Value | Examples | Notes |
| --- | ---: | --- | --- |
| `safety` | 100 | blacklist, freeze, rug block, token risk | hard veto; never overridden |
| `protect` | 80 | trailing stop, IL dominance, TVL drop, loss cap, dust | capital protection, age-free |
| `lifecycle` | 60 | launch timebox/decay, fallen-angel invalidation, TP ladder | lane-owned |
| `yield` | 40 | fee/IL < 0.5, volume-auth collapse, yield regression | maturity-gated |
| `rebalance` | 20 | recovery/range rebalance | management, no new exposure |
| `entry` | 10 | normal/market/runner/launch/FA/idle proposals | consumes new capital |

Within a tier, rank by `netExpectancyUsd` (expected fees − expected IL − round-trip costs); `null` ranks last. Final tiebreak is `ruleId` ascending, so the winner is deterministic regardless of iteration order.

The losing proposals are **kept** on the decision record. "Why did this pool enter while that one didn't" must be answerable from the ledger, not from a log grep.

---

## 4. Policy as data

`DecisionPolicy` is one versioned object per regime:

```ts
interface DecisionPolicy {
  version: string;                       // e.g. "majors-calm-v3"
  trailingStopPct: number;
  ilProtectionEnabled: boolean;
  ilDominanceExitFactor: number;
  ilDominanceMinUsd: number;
  tvlDropExitPct: number;
  volumeAuthExitThreshold: number;
  feeIlExitRatio: number;
  minYieldExitAgeMs: number;
  holdBiasEnabled: boolean;
  // …entry floors, lane enablement, sizing, cooldowns
}
```

`RegimeKey` selects the policy: pool class (majors / memecoin / new) × volatility band × pool age × depth. Env still selects the policy *set* and the safety switches; it stops being one flag per gate.

Why data: a policy can be replayed, diffed, shadowed, and — critically — ported. The Rust host can consume the same serialized policy and rule ids without porting Effect plumbing.

---

## 5. Attribution loop (the part that makes it profitable)

Existing primitives to build on: `audit` rows carry `reasoning` + `risk_result_json`; `positions` carry `closed_at` / `realized_pnl_usd`; realized PnL already debits modeled close costs; the engine already has a rolling realized-PnL halt and a per-pool kill switch.

Add:

- `ruleIds[]` and `policyVersion` on every decision (starts as tags parsed from `reasoning`, then becomes a first-class column).
- A **per-rule ledger**: closes where the rule co-fired, credited PnL (fractional when several entry rules co-fire — no double counting), sole-rule PnL (uncontaminated), win rate, profit factor, reject count.
- **Prune/throttle on expectancy**: a rule whose credited net PnL over the last N closes is negative gets disabled or demoted to shadow, with the change recorded. This generalizes `REALIZED_PNL_HALT_*` and the pool kill switch from "the whole strategy" to "the specific rule".

`prism forensics` (this wave) is the first read-only version of this ledger.

---

## 6. Migration phases

Each phase is independently shippable and reversible. The recorded audit DB is the regression oracle throughout.

### Phase 0 — Instrument (no behavior change)

- Land `engine/rule-attribution.ts` + `prism forensics`.
- Export the production DB; establish per-rule / per-pool baselines over all history and the last 100 closes.
- Pass: the ledger reproduces the review's total closes/net within rounding.

### Phase 1 — Facts extraction

**First slice landed (2026-10-30):** `engine/cycle/facts.ts` is a pure module (no Effect, no services, no clock) holding `resolvePoolDriftMetrics`, `hodlBenchmarkUsd`, `assemblePoolFacts` and `assemblePositionFacts`. `evaluatePool` now reads its decision inputs from the assembled `poolFacts` (fee/IL, volume authenticity, TVL velocity, bin utilization) rather than raw metric fields, and the IL-dominance seam reads `assemblePositionFacts`. Behavior is unchanged: 2,278 tests green, no gate logic moved.

Remaining in Phase 1:

- Assemble the full `CycleFacts` (positions + portfolio + market) once per pool once the ENTER/EXIT tiers consume it; today positions are mapped per seam, not centralized.
- Move the remaining assembly out of `evaluatePool` into `cycle/` modules so `evaluatePool` becomes a thin adapter.
- Add the recorded-cycle golden-diff harness; the full test suite is the current zero-diff oracle.
- Pass (unchanged): identical decisions on N recorded cycles; cycle wall time within +5%.

### Phase 2 — Kernel extraction by tier

- Order: protect → yield → lifecycle → entry → guards.
- One tier per change; old path selectable behind a flag until the diff is zero.
- Pass: zero diffs per tier, then flag removal.

### Phase 3 — One kernel

- `ops/backtest.ts` drives the real kernel over recorded `CycleFacts`; delete `engine/cycle/evaluate-pool.ts`.
- Replace hardcoded `0.65 / 0.10 / 0.15 / 0.4` with the policy object.
- Pass: a backtest run and a live paper run with the same facts + policy produce identical decisions.

### Phase 4 — Economic admission

- Replace the ratio floor with `expectedNetProfitUsd(...) > 0` over the planned holding horizon, using measured volatility and the planned range width; include round-trip swap + gas + harvest.
- Expect **fewer entries**; that is the intended outcome, not a regression.
- Pass: net expectancy after conservative costs ≥ baseline on a disjoint evaluation window; churn (closes/day) falls.

### Phase 5 — Regime policies + auto-prune

- Policy selection by `RegimeKey`; shadow mode first.
- Enable rule throttling on negative credited expectancy with hysteresis (e.g. 30 closes, two consecutive windows).
- Pass: drawdown controlled, net expectancy positive across two disjoint windows.

---

## 7. Non-goals

- No YAML/JSON rule DSL, no expression evaluator, no workflow engine. Decisions are a pure function of current facts; long-running flows belong only to settlement/execution.
- No file-splitting for its own sake. The kernel boundary is semantic.
- No "parallel decisions". Parallelism belongs to I/O (fetch per pool) and to proposal generation across pools; arbitration is a single deterministic pass.
- No removal of the safety pipeline. Guards keep their fail-closed semantics exactly.

---

## 8. Portability to the Rust/Bend host

The pure kernel + serialized policy is what makes the native host tractable: the Rust side implements the same rule ids and tier table over the same `CycleFacts`/`DecisionPolicy` shapes, and parity is checked by replaying the same recorded facts through both. Bend kernels stay numeric helpers; rule identity and ordering never depend on a probabilistic layer.

---

## 9. Package boundaries — after the kernel, not instead of it

A workspace split is boundary enforcement, not architecture. Splitting today would move the 5,100-line function into `packages/engine` unchanged and add install/build/release overhead to a product that ships one binary.

The split is worth doing at the moment the **pure kernel exists**, because it is the only module with a genuinely different dependency profile:

```
packages/core          decision kernel, facts/policy types, rule registry
                       zero Effect, zero Bun APIs, zero network
packages/engine        facts assembly, services, adapters (Effect + Bun)
packages/backtest      recorded-fact replayer over core
packages/cli           user-facing commands
```

`packages/core` earns its keep immediately: it can run under Node in the Rust host's parity harness, in the backtest, and in any future consumer (MCP server, dashboard) without dragging in Effect, SQLite, or RPC. The root bundle, Docker image and release pipeline keep building from `packages/engine` / `packages/cli` exactly as today.

Do **not** split by file count or by "separation of concerns" alone. Trigger the split when either (a) the kernel is green on the golden-diff harness and has no Effect/Bun imports, or (b) a second consumer needs the decision types without the runtime. Until then, keep the flat `engine/` layout the project already understands.

## 10. Database engine — stay on `bun:sqlite`

Turso Database (the Rust SQLite rewrite, `@tursodatabase/database` 0.8.x) is **not** a drop-in for this engine today:

- **Hard blocker: extensions.** The JS binding documents `loadExtension()` as *not supported*, and `pragma()`, `backup()` and `serialize()` are also unsupported. `engine/db.ts` loads the `vec0` extension via `db.loadExtension()`; without it the vector-memory table cannot be created, `prism doctor` fails, and memory recall/recording dies. Turso's native vector support is a column type with its own query surface, not a `vec0` virtual table — porting memory would be a feature rewrite, not a driver swap.
- **Sync → async.** `bun:sqlite` is synchronous; the Turso JS API is promise-based (`await connect`, `await stmt.all`). The persistence layer (`db-service.ts`, `db.ts`, 25 migrations, every transaction path) would have to become async end to end.
- **No workload benefit.** One process, one writer, modest data volume. The database is not the bottleneck — RPC is (4–8 calls per pool per cycle). Turso's MVCC/concurrent-write story solves a problem this deployment does not have.
- **Pre-1.0 on a money path.** 0.8.x with documented compatibility gaps; the safe default for `PAPER_TRADING=false` is the engine SQLite has tested for decades.

Where Turso *does* fit, and the triggers to revisit:

1. **`prismd` (Rust host)** — the `turso` crate is a natural embedded engine there. Because the on-disk file format is SQLite-compatible, the native host can adopt it independently while the TS engine keeps `bun:sqlite` on the same file. Decide in the native-host phase, not here.
2. **Vector memory 2.0** — Turso's native vectors could replace `sqlite-vec`, but ANN indexing is still on their roadmap; that is a memory feature with its own parity tests.
3. **Multi-process writers** — if CLI, daemon and tools ever write concurrently, MVCC becomes relevant. Today only the daemon writes; CLI tools (portfolio, forensics) are read-only.

If a spike is ever run, gate it on: schema + all 25 migrations replayed on a copy, `vec0`-equivalent memory results on a fixture, kill-9/WAL recovery, p50/p99 on a recorded workload with **no regression**, and Bun compatibility.

## 11. Open questions

1. Should `ruleIds` be a first-class `audit` column (migration) or parsed from `reasoning` until Phase 2? Parsing works today and is zero-risk; a column is cleaner and cheap to add.
2. Fractional credit for co-firing entry rules (implemented) vs. an explicit "primary rule" field. Fractional is honest but can understate a genuinely dominant rule; sole-rule stats are reported alongside.
3. Regime boundaries: fixed bands first, or a learned classifier later? Fixed bands are auditable; start there.
4. Whether `EXIT` may ever be arbitrated against a higher-tier HOLD — no. Capital protection stays non-overridable, matching `risk-service.ts` gate 1.
