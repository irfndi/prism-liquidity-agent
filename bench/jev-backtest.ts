/** Jev backtest: consult judgments on entry-state reconstruction, join to realized.
 * Usage: bun bench/jev-backtest.ts [--cohort growth|verify|both] [--split A|B|all]
 *   [--max N] [--out /tmp/jev_bt.json] [--dry-run]
 * Reads TSV from /tmp/jev_cohort_<name>.tsv (server export). Entry state:
 * snapshot row fields + recomputed metrics via DLMMStrategy + drift/vol from
 * bins12 ring (most-recent-first 12 active bins, reversed to chronological).
 * Split: A = entry_ts below median, B = at/above median (time-split, no peeking).
 * consultJevJudgments with live fetch; dry-run skips network (state build only).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { consultJevJudgments, type JevPoolState } from "../engine/jev-service.js";
import { computeBinVolatilityStddev, DLMMStrategy } from "../engine/strategy-service.js";
import type { BinArray, PoolState } from "../engine/types.js";

interface CohortRow {
  pool: string;
  entryTs: number;
  pnl: number;
  dep: number;
  holdMs: number;
  lagMs: number;
  tvl: number;
  vol: number;
  fees: number;
  price: number;
  bin: number;
  step: number;
  tx: string;
  ty: string;
  src: string;
  bins12: number[];
}

function parseTsv(path: string): CohortRow[] {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const head = lines[0]!.split("\t");
  const idx = (k: string) => head.indexOf(k);
  const rows: CohortRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    // bins12 is most-recent-first (entry bin first — verified 224/224);
    // reverse to chronological for vol/drift.
    const binsRaw = c[idx("bins12")] ?? "";
    const binsMostRecentFirst = binsRaw
      .split(",")
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    rows.push({
      pool: c[idx("pool_address")]!,
      entryTs: Number(c[idx("entry_ts")]),
      pnl: Number(c[idx("realized_pnl_usd")]),
      dep: Number(c[idx("deposited_usd")]),
      holdMs: Number(c[idx("hold_ms")]),
      lagMs: Number(c[idx("lag_ms")]),
      tvl: Number(c[idx("tvl")]),
      vol: Number(c[idx("vol")]),
      fees: Number(c[idx("fees")]),
      price: Number(c[idx("price")]),
      bin: Number(c[idx("bin")]),
      step: Number(c[idx("step")]),
      tx: c[idx("tx")] ?? "?",
      ty: c[idx("ty")] ?? "?",
      src: c[idx("src")] ?? "unknown",
      bins12: [...binsMostRecentFirst].reverse(),
    });
  }
  return rows;
}

const EMPTY_BINS: BinArray = {
  lowerBinId: 0,
  upperBinId: 0,
  bins: [],
  activeBinId: 0,
  reservesKnown: false,
};

/** Parse the TSV `src` column into the real PoolState union — throws on an
 * unrecognized value instead of silently poisoning the backtest math. */
function parseStatsSource(src: string): PoolState["statsSource"] {
  if (src === "datapi" || src === "geckoterminal" || src === "heuristic") return src;
  throw new Error(`unknown statsSource in cohort TSV: ${JSON.stringify(src)}`);
}

export function buildJevBacktestState(row: CohortRow) {
  const pool: PoolState = {
    address: row.pool,
    tokenX: "",
    tokenY: "",
    tokenXSymbol: row.tx,
    tokenYSymbol: row.ty,
    tvlUsd: row.tvl,
    volume24hUsd: row.vol,
    fees24hUsd: row.fees,
    apr: 0,
    activeBinId: row.bin,
    binStep: row.step,
    currentPrice: row.price,
    timestamp: row.entryTs,
    statsSource: parseStatsSource(row.src),
  };
  const metrics = DLMMStrategy.computeMetrics(pool, EMPTY_BINS, row.tvl);
  const lookback = row.bins12.length > 12 ? row.bins12.slice(-12) : row.bins12;
  const vol = computeBinVolatilityStddev(lookback);
  const drift = lookback.length >= 2 ? lookback[lookback.length - 1]! - lookback[0]! : 0;
  // ENTRY_STRATEGY_TYPE default spot on both servers (VOL_EXIT_STDDEV=8):
  // heuristic deposit is always "spot" — no recommendStrategy/drift call.
  return {
    state: {
      poolAddress: row.pool,
      tokenXSymbol: row.tx,
      tokenYSymbol: row.ty,
      tvlUsd: row.tvl,
      volume24hUsd: row.vol,
      fees24hUsd: row.fees,
      statsSource: row.src,
      volumeAuthenticityKnown: metrics.volumeAuthenticityKnown,
      feeIlRatioKnown: metrics.feeIlRatioKnown,
      binUtilizationKnown: false,
      feeIlRatio: metrics.feeIlRatio,
      volumeAuthenticity: metrics.volumeAuthenticity,
      binUtilization: 0,
      volatilityStddev: vol,
      netDriftBins: lookback.length >= 2 ? drift : null,
      activeBinId: row.bin,
      binStep: row.step,
    },
    heuristicDeposit: "spot",
    feeIl: metrics.feeIlRatio,
    auth: metrics.volumeAuthenticity,
  };
}

function pf(rows: CohortRow[]): number {
  const win = rows.filter((r) => r.pnl > 0).reduce((s, r) => s + r.pnl, 0);
  const loss = rows.filter((r) => r.pnl <= 0).reduce((s, r) => s + r.pnl, 0);
  return loss === 0 ? (win > 0 ? Number.POSITIVE_INFINITY : 0) : win / Math.abs(loss);
}

interface CliOptions {
  cohort: string;
  split: string;
  max: number;
  out: string;
  dryRun: boolean;
}

function parseArgs(args: string[]): CliOptions {
  const opt = (k: string, d: string): string => {
    const i = args.indexOf(k);
    return i >= 0 && args[i + 1] ? args[i + 1]! : d;
  };
  return {
    cohort: opt("--cohort", "both"),
    split: opt("--split", "all"),
    max: Number(opt("--max", "1000000")),
    out: opt("--out", "/tmp/jev_bt.json"),
    dryRun: args.includes("--dry-run"),
  };
}

/** Load, filter to datapi-only, time-split, and cap the cohort rows. */
function loadCohortRows(opts: Pick<CliOptions, "cohort" | "split" | "max">): CohortRow[] {
  const names = opts.cohort === "both" ? ["growth", "verify"] : [opts.cohort];
  let rows: CohortRow[] = [];
  for (const n of names) rows.push(...parseTsv(`/tmp/jev_cohort_${n}.tsv`));
  rows = rows.filter((r) => Number.isFinite(r.pnl) && r.src === "datapi");
  rows.sort((a, b) => a.entryTs - b.entryTs);
  const med = rows[Math.floor(rows.length / 2)]!.entryTs;
  const kept =
    opts.split === "A"
      ? rows.filter((r) => r.entryTs < med)
      : opts.split === "B"
        ? rows.filter((r) => r.entryTs >= med)
        : rows;
  return kept.slice(0, opts.max);
}

interface JudgedRow {
  row: CohortRow;
  deposit: string | null;
  conf: number | null;
  toxic: number | null;
  stress: number | null;
  heuristicDeposit: string;
}

type BuiltRow = { row: CohortRow } & ReturnType<typeof buildJevBacktestState>;

/** Sequential Jev consult loop (rate-limited: 2.1s between calls). */
async function consultAll(
  built: BuiltRow[],
  apiKey: string,
): Promise<{ ok: number; fail: number; judged: JudgedRow[] }> {
  let ok = 0;
  let fail = 0;
  const judged: JudgedRow[] = [];
  for (const b of built) {
    const j = await consultJevJudgments(b.state, { jevEnabled: true, jevApiKey: apiKey });
    if (j.ok) {
      ok++;
      judged.push({
        row: b.row,
        deposit: j.depositPick,
        conf: j.depositConfidence,
        toxic: j.toxicFlowNoul,
        stress: j.regimeStressNoul,
        heuristicDeposit: b.heuristicDeposit,
      });
    } else {
      fail++;
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 2100);
    await promise;
  }
  return { ok, fail, judged };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const cohortRows = loadCohortRows(opts);
  const built = cohortRows.map((r) => ({ row: r, ...buildJevBacktestState(r) }));
  if (opts.dryRun) {
    writeFileSync(
      opts.out,
      JSON.stringify(
        { n: built.length, baselinePf: pf(cohortRows), sample: built.slice(0, 3) },
        null,
        2,
      ),
    );
    console.log(`dry-run n=${built.length} baselinePF=${pf(cohortRows).toFixed(3)} -> ${opts.out}`);
    return;
  }
  const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.TYPESAFEAI_API ?? "";
  if (!apiKey) throw new Error("need TYPESAFE_API_KEY or TYPESAFEAI_API");
  const { ok, fail, judged } = await consultAll(built, apiKey);
  writeFileSync(opts.out, JSON.stringify({ n: built.length, ok, fail, judged }, null, 2));
  console.log(`consulted ok=${ok} fail=${fail} -> ${opts.out}`);
}

await main();
