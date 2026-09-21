// prismd parity compare (Phase 3 exit criterion, wave 79+).
//
// Runs the Rust shadow host `prismd --ticks N` against a TWIN copy of a
// SQLite book and diffs its final `decision` verdict against the TS engine's
// own audit trail for the same book. The live DB is never opened: prismd
// writes to the ledger, so it gets a scratch copy in a temp dir (twin-copy
// pattern). Skip (don't fail) when prismd is not built.
//
// Pass bar (native/rust/README.md, "Parity plan vs Bun shadow" step 2):
//   decision open == TS open-position count (positions WHERE closed_at IS NULL)
//   exit_shadow  <=  TS Exits   (shadow never fires alone)
// Per-gate bar: each shadow leg that has a TS same-gate counterpart is
// compared by gate name, keyed off `audit.reasoning` via the engine's own
// exit taxonomy (`exitReasonTag`) — position_events EXIT metadata is
// pnl-only, so reasoning is the only per-gate source.
// When `bend` is absent from PATH, BEND_BIN=false is passed and the run says
// so — Bend kernels are part of the shadow surface, so the output must
// disclose that half was dark.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
// The EXIT taxonomy is engine-owned: reuse it so the parity bar classifies TS
// exits exactly like the engine does (one source of truth, no drift).
import { exitReasonTag } from "../engine/exit-reason.js";

function repoFile(rel: string): string {
  return new URL(`../${rel}`, import.meta.url).pathname;
}

/** Documented `decision` key order (native/rust/README.md parity plan step 1). */
const DECISION_KEYS = [
  "open",
  "exit_shadow",
  "enter_blocked_shadow",
  "danger_shadow",
  "drift_rejects_shadow",
  "capital_exits_shadow",
  "stop_loss_shadow",
  "band_health_shadow",
  "gas_hold_shadow",
  "recovery_hold_shadow",
  "interval_hold_shadow",
  "vol_exit_shadow",
  "exit_order_loss_shadow",
  "il_dominance_shadow",
  "paper_days",
  "paper_pass",
  "cooldown_holds",
  "drawdown_veto",
  "at_capacity",
];

/** Host decision key → the TS exit tag it mirrors (same gate, same book). */
const SHADOW_TO_TS_TAG: ReadonlyArray<readonly [string, string]> = [
  ["exit_shadow", "fee-il"],
  ["il_dominance_shadow", "il-dominance"],
  ["vol_exit_shadow", "volatility"],
];

const USAGE = `prismd parity compare — Rust shadow host vs TS audit trail

Usage: bun run bench/prismd-parity-compare.ts <db.sqlite> [--ticks N]

  <db.sqlite>   SQLite book to twin-copy and compare (required)
  --ticks N     shadow ticks to run prismd with (default 3)
  --help        this text

prismd is located at native/rust/target/release/prismd, else
native/rust/target/debug/prismd. Missing prismd -> SKIP (exit 0).
Exit 0 when decision open == TS open-position count, else 1.
Missing DB / bad flags -> exit 2.`;

/** Usage error: message + usage text, then exit 2. */
function usageError(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(2);
}

/** `--ticks N` / `--ticks=N` value; exits 2 on a non-positive integer. */
function parseTicksValue(raw: string | undefined): number {
  const n = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    usageError(`invalid --ticks value: ${JSON.stringify(raw)}`);
  }
  return n;
}

function parseArgs(argv: string[]) {
  let db: string | undefined;
  let ticks = 3;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === "--help" || a === "-h") {
      console.log(USAGE);
      process.exit(2);
    } else if (a === "--ticks") {
      ticks = parseTicksValue(argv[i + 1]);
      i++;
    } else if (a.startsWith("--ticks=")) {
      ticks = parseTicksValue(a.slice("--ticks=".length));
    } else if (a.startsWith("-")) {
      usageError(`unknown flag: ${a}`);
    } else if (db === undefined) {
      db = a;
    } else {
      usageError(`unexpected argument: ${a}`);
    }
  }
  if (db === undefined) {
    usageError("error: missing required <db.sqlite> argument");
  }
  return { db, ticks };
}

/** Resolve one candidate to an executable path, or undefined. */
function resolveCandidate(candidate: string): string | undefined {
  const home = process.env.HOME ?? "";
  const p = candidate.startsWith("~/") ? join(home, candidate.slice(2)) : candidate;
  if (p.includes("/")) return existsSync(p) ? p : undefined;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, p))) return join(dir, p);
  }
  return undefined;
}

/** Bend kernels are part of the shadow surface — probe PATH + the installer
 *  layouts (both the legacy `~/.bend/bin/bend` and the current
 *  `~/.bend/bend/bin/bend`, which the installer switched to in 2.0.21+). */
function bendBin(): string | undefined {
  const candidates = [
    process.env.BEND_BIN,
    "~/.bend/bin/bend",
    "~/.bend/bend/bin/bend",
    "bend",
  ];
  for (const c of candidates) {
    if (!c) continue;
    const found = resolveCandidate(c);
    if (found) return found;
  }
  return undefined;
}

/** Extract `k=v` tokens from a prefixed prismd line. */
function kv(line: string, prefix: string): Record<string, string> | undefined {
  if (!line.startsWith(prefix)) return undefined;
  const out: Record<string, string> = {};
  for (const tok of line.slice(prefix.length).split(" ")) {
    const eq = tok.indexOf("=");
    if (eq <= 0) continue;
    out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

/** Last `k=v` line of stdout that starts with `prefix`. */
function lastKvLine(stdout: string, prefix: string): Record<string, string> | undefined {
  let found: Record<string, string> | undefined;
  for (const line of stdout.split("\n").map((l) => l.trim())) {
    const got = kv(line, prefix);
    if (got) found = got;
  }
  return found;
}

type Cycle = {
  cycleId: string;
  at: number;
  hist: Record<string, number>;
  executed: number;
};

/** bun:sqlite row shapes for the twin read (aliases set by the SELECTs below). */
type OpenRow = { n: number };
type CycleRow = { cycleId: string; at: number };
type HistRow = { action: string; n: number; executed: number };
type ExitRow = { reasoning: string | null };

type TsSide = {
  open: number;
  cycles: Cycle[];
  exits: number;
  decided: number;
  exitTags: Record<string, number>;
};

const EMPTY_TS: TsSide = { open: 0, cycles: [], exits: 0, decided: 0, exitTags: {} };

/** Read the twin's book with bun:sqlite. The twin is a scratch copy nothing
 *  else touches, so it opens writable — bun:sqlite's readonly mode fails every
 *  statement on a copied file (`unable to open database file`) even though the
 *  sqlite3 CLI reads the same copy fine; writable open is the working path. */
function readTsSide(twin: string, ticks: number): TsSide {
  const db = new Database(twin);
  try {
    // SAFETY: the SELECT aliases the COUNT(*) column to `n`, a BIGINT in SQLite.
    const openRow = db.prepare("SELECT COUNT(*) AS n FROM positions WHERE closed_at IS NULL").get() as OpenRow;
    const open = openRow.n;

    // SAFETY: aliases cycle_id->cycleId and MAX(timestamp)->at with the CycleRow shape.
    const cycleRows = db
      .prepare(
        `SELECT cycle_id AS cycleId, MAX(timestamp) AS at
         FROM audit WHERE cycle_id IS NOT NULL
         GROUP BY cycle_id ORDER BY at DESC LIMIT ?`,
      )
      .all(ticks) as CycleRow[];

    const histStmt = db.prepare(
      `SELECT action AS action, COUNT(*) AS n, COALESCE(SUM(executed), 0) AS executed
       FROM audit WHERE cycle_id IS ? GROUP BY action`,
    );
    // Per-cycle EXIT reasoning: the gate name lives in `audit.reasoning`
    // (position_events EXIT metadata is pnl-only), so the per-gate bar reads
    // the same column the engine wrote its tagged reasons into.
    const exitStmt = db.prepare(
      `SELECT reasoning FROM audit WHERE cycle_id IS ? AND action = 'EXIT'`,
    );

    const cycles: Cycle[] = cycleRows.map(({ cycleId, at }) => {
      const hist: Record<string, number> = {};
      let executed = 0;
      // SAFETY: aliases action/n/executed with the HistRow shape.
      const rows = histStmt.all(cycleId) as HistRow[];
      for (const r of rows) {
        hist[r.action] = (hist[r.action] ?? 0) + r.n;
        executed += r.executed;
      }
      return { cycleId, at, hist, executed };
    });

    const exitTags: Record<string, number> = {};
    for (const c of cycleRows) {
      // SAFETY: the SELECT aliases reasoning with the ExitRow shape.
      const rows = exitStmt.all(c.cycleId) as ExitRow[];
      for (const r of rows) {
        const tag = exitReasonTag(r.reasoning);
        exitTags[tag] = (exitTags[tag] ?? 0) + 1;
      }
    }

    return {
      open,
      cycles,
      exits: cycles.reduce((acc, c) => acc + (c.hist["EXIT"] ?? 0), 0),
      decided: cycles.reduce((acc, c) => acc + c.executed, 0),
      exitTags,
    };
  } catch (e) {
    console.error(`# ts audit read failed: ${e instanceof Error ? e.message : String(e)}`);
    return EMPTY_TS;
  } finally {
    db.close();
  }
}

function main(): void {
  const { db, ticks } = parseArgs(process.argv.slice(2));
  const dbPath = resolve(db);
  if (!existsSync(dbPath)) {
    console.error(`error: database not found: ${dbPath}`);
    process.exit(2);
  }

  const bin = locatePrismd();
  if (!bin) {
    console.log(
      "SKIP: prismd not built — run `cargo build --release` in native/rust " +
        "(or `cargo build` for the debug binary); parity cannot be checked.",
    );
    process.exit(0);
  }

  // Twin copy: prismd writes to the ledger, the live book must stay untouched.
  // Copy the DB (+ a non-empty WAL so committed-but-uncheckpointed rows come
  // along); NEVER copy `-shm` — shared-memory files are per-connection
  // transient state SQLite recreates on open, and a stale copy makes the open
  // block (measured: 60s+ hang with it, 13s without).
  const dir = mkdtempSync(join(tmpdir(), "prismd-parity-"));
  const twin = join(dir, "twin.db");
  try {
    cpSync(dbPath, twin);
    if (existsSync(dbPath + "-wal")) cpSync(dbPath + "-wal", twin + "-wal");

    const bend = bendBin();
    // Interval comes from env like the host. Default is the HOST's fail-closed
    // floor (10s), not the TS 600000 default: prismd ticks are slow on real
    // books (bend probes per position per tick), and a 10-minute inter-tick
    // sleep would push multi-tick runs past the exec timeout for no gain —
    // in `--ticks` mode the interval only bounds the sleep between ticks.
    const interval = process.env.SCAN_INTERVAL_MS ?? "10000";
    const run = runPrismd(bin, twin, ticks, interval, bend);
    if (!run.ok) {
      console.error(`prismd exited ${run.status}:`);
      if (run.stdout) console.error(run.stdout);
      if (run.stderr) console.error(run.stderr);
      console.error("PARITY: FAIL (prismd errored — see output above)");
      process.exit(1);
    }

    const v = verdict(run.stdout, readTsSide(twin, ticks));
    printVerdict(v, bin, bend, interval, ticks, dbPath);
    process.exit(v.pass ? 0 : 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** prismd: release build preferred, debug build otherwise, else skip. */
function locatePrismd(): string | undefined {
  const release = repoFile("native/rust/target/release/prismd");
  const debug = repoFile("native/rust/target/debug/prismd");
  if (existsSync(release)) return release;
  if (existsSync(debug)) return debug;
  return undefined;
}

type RunOutcome =
  | { ok: true; stdout: string }
  | { ok: false; status: string; stdout?: string | undefined; stderr?: string | undefined };

/** One bounded prismd run against the twin (never the live book). */
function runPrismd(
  bin: string,
  twin: string,
  ticks: number,
  interval: string,
  bend: string | undefined,
): RunOutcome {
  try {
    // SAFETY: encoding "utf8" makes execFileSync return a string, never a Buffer.
    const stdout = execFileSync(bin, ["--ticks", String(ticks)], {
      env: {
        ...process.env,
        SQLITE_DB_PATH: twin,
        SCAN_INTERVAL_MS: interval,
        BEND_BIN: bend ?? "false",
        // Opt in to the host's write seam: this runs against a scratch twin,
        // so persisting per-tick shadow rows here is both wanted (audit trail
        // for the cutover compare) and harmless (the twin is discarded).
        PRISMD_SHADOW_LOG: "1",
      },
      encoding: "utf8",
      timeout: 300_000,
    }) as string;
    return { ok: true, stdout };
  } catch (e) {
    // SAFETY: execFileSync failures are Error-shaped with optional string fields.
    const err = e as { stdout?: string; stderr?: string; status?: number | null };
    return {
      ok: false,
      status: err.status === null || err.status === undefined ? "nonzero" : String(err.status),
      stdout: err.stdout,
      stderr: err.stderr,
    };
  }
}

type GateRow = { gate: string; prismd: number; ts: number; note: string };

/**
 * Per-gate compare for legs that have a TS counterpart. A shadow firing where
 * TS's same gate did not is a real divergence (both read the same book). A
 * shadow silent where TS fired is EXPECTED — the host has no candidate
 * decisions, so hold-bias / age / maturity / confirm-cycle legs stay TS-only.
 */
function gateCompare(decision: Record<string, string>, ts: TsSide): GateRow[] {
  return SHADOW_TO_TS_TAG.map(([key, tag]) => {
    const shadow = Number(decision[key] ?? 0);
    const tsCount = ts.exitTags[tag] ?? 0;
    const note =
      shadow > tsCount
        ? "divergence: shadow exceeds TS same-gate exits"
        : tsCount > 0
          ? "coverage: TS fired, host silent (expected — no candidate decisions)"
          : "both-zero";
    return { gate: tag, prismd: shadow, ts: tsCount, note };
  });
}

type Verdict = {
  pass: boolean;
  decision: Record<string, string> | undefined;
  ts: TsSide;
  failReason?: string;
};

/** Parse the last `decision` line and compare against the TS audit trail. */
function verdict(stdout: string, ts: TsSide): Verdict {
  // prismd prefixes every line with `[prismd] ` — trim first (stdout may carry
  // trailing \r or leading blanks), then strip the prefix and keep the line.
  const logPrefix = "[prismd] ";
  const clean = stdout
    .split("\n")
    .map((l) => l.trim())
    .map((l) => (l.startsWith(logPrefix) ? l.slice(logPrefix.length) : l))
    .join("\n");
  const decision = lastKvLine(clean, "decision ");
  if (!decision) {
    return { pass: false, decision, ts, failReason: "no `decision` line in prismd output" };
  }
  const prismdOpen = Number(decision.open);
  if (prismdOpen !== ts.open) {
    return { pass: false, decision, ts, failReason: "decision open != TS open-position count" };
  }
  const exitShadow = Number(decision.exit_shadow ?? 0);
  const ilShadow = Number(decision.il_dominance_shadow ?? 0);
  if (exitShadow > ts.exits || ilShadow > ts.exits) {
    return {
      pass: false,
      decision,
      ts,
      failReason: `exit_shadow=${exitShadow} il_dominance_shadow=${ilShadow} exceed ts EXIT=${ts.exits}`,
    };
  }
  return { pass: true, decision, ts };
}

/** Diff lines + verdict; pass/fail printing is separated from the decision. */
function printVerdict(
  v: Verdict,
  bin: string,
  bend: string | undefined,
  interval: string,
  ticks: number,
  dbPath: string,
): void {
  const fmt = (kvs: Record<string, string> | undefined): string =>
    kvs ? Object.entries(kvs).map(([k, val]) => `${k}=${val}`).join(" ") : "none";
  const decision = v.decision ?? {};
  console.log(`# prismd parity compare — ticks=${ticks} db=${dbPath}`);
  console.log(
    `# prismd=${bin} bend=${bend ? bend : "ABSENT (BEND_BIN=false, kernels not consulted)"} scan_interval_ms=${interval}`,
  );
  console.log(`# prismd decision: ${fmt(v.decision)}`);
  console.log(`# ts cycles (last ${ticks}):`);
  for (const c of v.ts.cycles) {
    const hist = Object.entries(c.hist)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${k}=${val}`)
      .join(" ");
    console.log(`#   cycle=${c.cycleId} ${hist} executed=${c.executed}`);
  }

  // TS companion for each documented shadow key; `->` when TS has no leg.
  const tsCompanion = (k: string): string => {
    if (k === "open") return String(v.ts.open);
    if (k === "exit_shadow" || k === "il_dominance_shadow") return String(v.ts.exits);
    return "->";
  };
  for (const k of DECISION_KEYS) {
    console.log(`${k}: prismd=${decision[k] ?? "MISSING"} ts=${tsCompanion(k)}`);
  }
  printGateBar(decision, v.ts);
  if (v.failReason) {
    console.error(`PARITY: FAIL (${v.failReason})`);
    return;
  }
  console.log("PARITY: PASS (open matches, exit shadows within TS exits)");
}

/** Per-gate bar: open parity, exit-shadow totals, tag histogram, gate rows. */
function printGateBar(decision: Record<string, string>, ts: TsSide): void {
  console.log(`PARITY open: prismd=${decision.open ?? "?"} ts=${ts.open}`);
  const exitShadow = Number(decision.exit_shadow ?? 0);
  const ilShadow = Number(decision.il_dominance_shadow ?? 0);
  console.log(
    `EXIT_SHADOWS: prismd exit_shadow=${exitShadow} il_dominance_shadow=${ilShadow} vs ts EXIT=${ts.exits}`,
  );
  const tags = Object.entries(ts.exitTags)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}=${n}`)
    .join(" ");
  console.log(`TS_EXIT_TAGS: ${tags || "none"}`);
  for (const g of gateCompare(decision, ts)) {
    console.log(`GATE ${g.gate}: prismd=${g.prismd} ts=${g.ts} ${g.note}`);
  }
}

main();
