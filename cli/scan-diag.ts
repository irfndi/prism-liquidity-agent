import { Command } from "commander";
import { Effect } from "effect";
import { ConfigLive, ConfigService } from "../engine/config-service.js";
import {
  gateAndRankMarketPools,
  resolveMarketScanConfig,
  summarizeRejections,
} from "../engine/market-gate.js";
import type { MarketGateConfig, MarketPoolRank } from "../engine/market-gate.js";
import type { DiscoveredPool } from "../engine/services.js";

/**
 * Market-scan diagnostics: run the LIVE admission gate against the LIVE
 * universe and say which filter is closing the door.
 *
 * The scan loop logs the same histogram once per refresh, but a refresh takes
 * up to 30 minutes and the answer is needed immediately after a config change.
 * This command reuses `resolveMarketScanConfig` and `gateAndRankMarketPools`
 * verbatim, so it cannot drift from production selection.
 */

interface RawPool {
  readonly address: string;
  readonly tvl: number;
  readonly apr: number;
  readonly volume: Record<string, number>;
  readonly fees: Record<string, number>;
  readonly pool_config: { readonly bin_step: number };
  readonly token_x: TokenLeg;
  readonly token_y: TokenLeg;
  readonly created_at: number;
  readonly launchpad?: boolean;
}

interface TokenLeg {
  readonly address: string;
  readonly symbol: string;
  readonly is_verified: boolean;
  readonly freeze_authority_disabled: boolean;
  readonly holders: number;
}

function toPool(raw: RawPool): DiscoveredPool {
  return {
    address: raw.address,
    tvlUsd: raw.tvl,
    volume24hUsd: raw.volume["24h"] ?? 0,
    fees24hUsd: raw.fees["24h"] ?? 0,
    apr: raw.apr,
    binStep: raw.pool_config.bin_step,
    tokenX: raw.token_x.address,
    tokenY: raw.token_y.address,
    tokenXSymbol: raw.token_x.symbol,
    tokenYSymbol: raw.token_y.symbol,
    tokenXVerified: raw.token_x.is_verified,
    tokenYVerified: raw.token_y.is_verified,
    tokenXFreezeDisabled: raw.token_x.freeze_authority_disabled,
    tokenYFreezeDisabled: raw.token_y.freeze_authority_disabled,
    tokenXHolders: raw.token_x.holders,
    tokenYHolders: raw.token_y.holders,
    createdAtMs: raw.created_at,
  };
}

const BASE_URL =
  "https://dlmm.datapi.meteora.ag/pools?page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc";

async function fetchPage(page: number): Promise<RawPool[]> {
  const res = await fetch(`${BASE_URL}&page=${page}`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`page ${page}: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body?.data)) return [];
  // SAFETY: the Data API list envelope is `{ data: RawPool[] }`; the Array
  // guard above establishes the shape, and toPool only reads known fields.
  return body.data as RawPool[];
}

async function loadUniverse(pages: number): Promise<DiscoveredPool[]> {
  const raw: RawPool[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const batch = await fetchPage(page);
    if (batch.length === 0) break;
    raw.push(...batch);
  }
  return raw.filter((p) => p.launchpad !== true).map(toPool);
}

async function loadAppConfig() {
  // The tag's value IS the resolved AppConfig (same contract cli/status uses).
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* ConfigService;
      }),
      ConfigLive,
    ),
  );
}

interface DiagResult {
  readonly universe: number;
  readonly admitted: number;
  readonly gateConfig: MarketGateConfig;
  readonly histogram: ReadonlyArray<{ category: string; count: number; example: string }>;
  readonly ranked: ReadonlyArray<MarketPoolRank>;
  readonly top: number;
}

function gateConfigFrom(config: Awaited<ReturnType<typeof loadAppConfig>>): MarketGateConfig {
  return {
    ...resolveMarketScanConfig(config),
    minVolumeTurnover: 0.02,
    maxVolumeTurnover: 50,
  };
}

function printJson(result: DiagResult): void {
  const g = result.gateConfig;
  console.log(
    JSON.stringify(
      {
        universe: result.universe,
        admitted: result.admitted,
        gateConfig: {
          minTvlUsd: g.minTvlUsd,
          minFeeApr: g.minFeeApr,
          minFees24hUsd: g.minFees24hUsd,
          minVolume24hUsd: g.minVolume24hUsd,
          minHolders: g.minHolders,
          minPoolAgeHours: g.minPoolAgeHours,
          minBinStep: g.minBinStep,
          maxBinStep: g.maxBinStep,
        },
        histograms: result.histogram,
        top: result.ranked.slice(0, result.top).map((r) => ({
          pool: r.pool.address,
          pair: `${r.pool.tokenXSymbol}/${r.pool.tokenYSymbol}`,
          feeAprPct: Number(r.feeAprPct.toFixed(1)),
          tvlUsd: Math.round(r.pool.tvlUsd),
          turnover: Number(r.volumeTurnover.toFixed(2)),
          score: Number(r.score.toFixed(1)),
        })),
      },
      null,
      2,
    ),
  );
}

function printText(result: DiagResult): void {
  const g = result.gateConfig;
  console.log(`universe   ${result.universe}`);
  console.log(`admitted   ${result.admitted}`);
  console.log(`rejected   ${result.universe - result.admitted}`);
  console.log("\ngate");
  console.log(
    `  TVL >= $${g.minTvlUsd}  fees24h >= $${g.minFees24hUsd ?? 0}  vol24h >= $${g.minVolume24hUsd ?? 0}`,
  );
  console.log(
    `  feeAPR >= ${g.minFeeApr}% (majors >= ${g.majorMinFeeApr ?? "—"}%)  holders >= ${g.minHolders}  age >= ${g.minPoolAgeHours}h`,
  );
  console.log(`  binStep ${g.minBinStep}..${g.maxBinStep}`);
  console.log("\nrejections by category");
  if (result.histogram.length === 0) console.log("  (none)");
  for (const bucket of result.histogram) {
    console.log(
      `  ${bucket.category.padEnd(14)} ${String(bucket.count).padStart(5)}  ${bucket.example.slice(0, 78)}`,
    );
  }
  console.log("\ntop admitted");
  if (result.ranked.length === 0) console.log("  (none)");
  for (const r of result.ranked.slice(0, result.top)) {
    const pair = `${r.pool.tokenXSymbol}/${r.pool.tokenYSymbol}`;
    console.log(
      `  ${pair.padEnd(18)} ${r.feeAprPct.toFixed(0).padStart(6)}% APR  TVL $${Math.round(r.pool.tvlUsd).toLocaleString().padStart(10)}  turn ${r.volumeTurnover.toFixed(2)}`,
    );
  }
}

export function registerScanDiagCommand(program: Command): void {
  program
    .command("scan-diag")
    .description(
      "Run the live market gate against the live universe and print the rejection histogram.",
    )
    .option("-p, --pages <n>", "Universe pages of 1000 (default 3, max 10)", "3")
    .option("-t, --top <n>", "How many admitted pools to list", "10")
    .option("-j, --json", "Emit JSON")
    .action(async (options: { pages?: string; top?: string; json?: boolean }) => {
      const pages = Math.min(Math.max(Number(options.pages ?? 3) || 3, 1), 10);
      const top = Math.min(Math.max(Number(options.top ?? 10) || 10, 0), 50);
      const gateConfig = gateConfigFrom(await loadAppConfig());
      const universe = await loadUniverse(pages);
      const { ranked, rejected } = gateAndRankMarketPools(universe, gateConfig);
      const result: DiagResult = {
        universe: universe.length,
        admitted: ranked.length,
        gateConfig,
        histogram: summarizeRejections(rejected),
        ranked,
        top,
      };
      if (options.json) {
        printJson(result);
        return;
      }
      printText(result);
    });
}
