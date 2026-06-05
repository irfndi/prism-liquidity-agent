/**
 * Fetch historical DLMM pool state from GeckoTerminal + on-chain bin_step,
 * reconstruct PoolSnapshot rows, and write them into the `pool_snapshots`
 * SQLite table for the replay backtest.
 *
 * Data sources:
 *   - GeckoTerminal OHLCV (hourly, 1000 candles = ~41 days back)
 *   - Solana RPC + @meteora-ag/dlmm SDK for bin_step + reference active bin
 *
 * What it produces per candle:
 *   - activeBinId   : computed from price via DLMM bin formula
 *   - tvlUsd        : current TVL (constant per pool; historical not available)
 *   - volume24hUsd  : REAL rolling 24h sum from GeckoTerminal OHLCV (sum of
 *                     the current hour plus the previous 23 hours, instead
 *                     of multiplying a single hour by 24)
 *   - fees24hUsd    : volume * feeRate (same formula as live engine)
 *   - apr           : (fees * 365 / tvl) * 100 (same formula as live engine)
 *   - currentPrice  : from OHLCV close
 *   - binStep       : from on-chain LbPair (stable, one fetch per pool)
 *   - tokenX/Y      : from GeckoTerminal pool name
 *   - binArray      : synthetic 41 bins (same as live engine)
 *
 * Usage:
 *   bun run ops/fetch-history.ts                          # 5 default pools
 *   bun run ops/fetch-history.ts --pools <addr1,addr2>    # custom pool set
 *   bun run ops/fetch-history.ts --db ./prism.db --clean  # wipe first
 */
import { Duration, Effect } from "effect";
import { Connection, PublicKey } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { createLogger } from "../engine/logger.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type { BinArray, BinData, PoolSnapshot } from "../engine/types.js";

const log = createLogger("FetchHistory");

// Top 5 SOL/USDC pools on Meteora DLMM by TVL (GeckoTerminal, 2026-06-04).
// Each pool has a different bin_step → different range widths → exercises
// the strategy's bin_step-aware range logic.
const DEFAULT_POOLS = [
  "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE", // ~$23M TVL
  "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv", // ~$4.7M TVL
  "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", // ~$2.8M TVL
  "DJNtGuBGEQiUCWE8F981M2C3ZghZt2XLD8f2sQdZ6rsZ", // ~$1.9M TVL
  "FksffEqnBRixYGR791Qw2MgdU7zNCpHVFYBL4Fa4qVuH", // ~$889K TVL
];

const SOLANA_RPC = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const GECKO_BASE = "https://api.geckoterminal.com/api/v2";
const OHLCV_LIMIT = 1000; // GeckoTerminal free tier max
const RATE_LIMIT_MS = 5000; // GeckoTerminal: 30 req/min → conservative 5s delay

interface OhlcvCandle {
  readonly timestamp: number;
  readonly close: number;
  readonly volume: number;
}

interface PoolMeta {
  readonly address: string;
  readonly binStep: number;
  readonly refActiveBinId: number;
  readonly refPrice: number;
  readonly tvlUsd: number;
  readonly tokenXSymbol: string;
  readonly tokenYSymbol: string;
}

interface CliArgs {
  pools: ReadonlyArray<string>;
  dbPath: string;
  clean: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): CliArgs {
  const out: CliArgs = { pools: DEFAULT_POOLS, dbPath: "./prism.db", clean: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--pools" && next) {
      out.pools = next
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      i++;
    } else if (a === "--db" && next) {
      out.dbPath = next;
      i++;
    } else if (a === "--clean") {
      out.clean = true;
    }
  }
  return out;
}

function fetchPoolMeta(address: string, connection: Connection): Effect.Effect<PoolMeta, Error> {
  return Effect.tryPromise({
    try: async () => {
      const dlmm = await DLMM.create(connection, new PublicKey(address));
      const lbPair = dlmm.lbPair;
      const activeBin = await dlmm.getActiveBin();

      let poolRes = await fetch(`${GECKO_BASE}/networks/solana/pools/${address}`);
      for (let attempt = 0; attempt < 3 && poolRes.status === 429; attempt++) {
        await new Promise((r) => setTimeout(r, RATE_LIMIT_MS * (attempt + 2)));
        poolRes = await fetch(`${GECKO_BASE}/networks/solana/pools/${address}`);
      }
      if (!poolRes.ok) {
        throw new Error(`GeckoTerminal pool ${address}: HTTP ${poolRes.status}`);
      }
      const poolJson = (await poolRes.json()) as {
        data?: { attributes?: Record<string, unknown> };
      };
      const attrs = poolJson.data?.attributes ?? {};
      const name = (attrs.name as string | undefined) ?? "";
      const [xSym, ySym] = name.split("/").map((s) => s.trim());
      const tvlStr = attrs.reserve_in_usd as string | undefined;
      const tvlUsd = tvlStr ? Number(tvlStr) : 0;

      return {
        address,
        binStep: lbPair.binStep,
        refActiveBinId: activeBin.binId,
        refPrice: Number(activeBin.price),
        tvlUsd,
        tokenXSymbol: xSym ?? "",
        tokenYSymbol: ySym ?? "",
      };
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}

function fetchOhlcv(address: string): Effect.Effect<OhlcvCandle[], Error> {
  return Effect.tryPromise({
    try: async () => {
      let res = await fetch(
        `${GECKO_BASE}/networks/solana/pools/${address}/ohlcv/hour?aggregate=1&limit=${OHLCV_LIMIT}&currency=usd`,
      );
      for (let attempt = 0; attempt < 3 && res.status === 429; attempt++) {
        await new Promise((r) => setTimeout(r, RATE_LIMIT_MS * (attempt + 2)));
        res = await fetch(
          `${GECKO_BASE}/networks/solana/pools/${address}/ohlcv/hour?aggregate=1&limit=${OHLCV_LIMIT}&currency=usd`,
        );
      }
      if (!res.ok) {
        throw new Error(`GeckoTerminal OHLCV ${address}: HTTP ${res.status}`);
      }
      const json = (await res.json()) as {
        data?: { attributes?: { ohlcv_list?: number[][] } };
      };
      const raw = json.data?.attributes?.ohlcv_list ?? [];
      return raw.map((c) => ({
        timestamp: c[0]! * 1000,
        close: c[4]!,
        volume: c[5] ?? 0,
      }));
    },
    catch: (e) => (e instanceof Error ? e : new Error(String(e))),
  });
}

function computeActiveBinId(
  refBinId: number,
  refPrice: number,
  price: number,
  binStep: number,
): number {
  if (refPrice <= 0 || price <= 0) return refBinId;
  const ratio = Math.log(price / refPrice) / Math.log(1 + binStep / 10000);
  return refBinId + Math.round(ratio);
}

function buildBinArray(activeBinId: number, currentPrice: number, binStep: number): BinArray {
  const halfRange = 20;
  const lowerBinId = activeBinId - halfRange;
  const upperBinId = activeBinId + halfRange;
  const bins: BinData[] = [];
  for (let i = lowerBinId; i <= upperBinId; i++) {
    bins.push({
      binId: i,
      price: currentPrice * Math.pow(1 + binStep / 10000, i - activeBinId),
      reserveX: 0n,
      reserveY: 0n,
      liquiditySupply: 1n,
    });
  }
  return { lowerBinId, upperBinId, bins, activeBinId, binStep };
}

function rollingVolume24h(candles: ReadonlyArray<OhlcvCandle>, index: number): number {
  let sum = 0;
  const end = Math.min(candles.length, index + 24);
  for (let j = index; j < end; j++) {
    sum += candles[j]!.volume;
  }
  return sum;
}

function buildSnapshot(meta: PoolMeta, candle: OhlcvCandle, volume24hUsd: number): PoolSnapshot {
  const activeBinId = computeActiveBinId(
    meta.refActiveBinId,
    meta.refPrice,
    candle.close,
    meta.binStep,
  );
  const binArray = buildBinArray(activeBinId, candle.close, meta.binStep);
  const feeRate = 0.0025 + meta.binStep / 10000;
  const fees24hUsd = volume24hUsd * feeRate;
  const apr = meta.tvlUsd > 0 ? ((fees24hUsd * 365) / meta.tvlUsd) * 100 : 0;
  return {
    poolAddress: meta.address,
    timestamp: candle.timestamp,
    activeBinId,
    tvlUsd: meta.tvlUsd,
    volume24hUsd,
    fees24hUsd,
    apr,
    currentPrice: candle.close,
    binStep: meta.binStep,
    tokenXSymbol: meta.tokenXSymbol,
    tokenYSymbol: meta.tokenYSymbol,
    binArray,
  };
}

const args = parseArgs(process.argv.slice(2));

const program = Effect.gen(function* () {
  const db = yield* DbService;
  const connection = new Connection(SOLANA_RPC, "confirmed");

  if (args.clean) {
    log.info(`--clean: wiping all pool_snapshots`);
    yield* db.pruneSnapshots(Number.MAX_SAFE_INTEGER);
  }

  for (const addr of args.pools) {
    const short = `${addr.slice(0, 8)}…${addr.slice(-4)}`;
    log.info(`[${short}] fetching meta from Solana RPC + GeckoTerminal…`);
    const meta = yield* fetchPoolMeta(addr, connection);
    log.info(
      `  binStep=${meta.binStep} refBin=${meta.refActiveBinId} refPrice=$${meta.refPrice.toFixed(4)} TVL=$${meta.tvlUsd.toFixed(0)} ${meta.tokenXSymbol}/${meta.tokenYSymbol}`,
    );

    yield* Effect.sleep(Duration.millis(RATE_LIMIT_MS));
    log.info(`[${short}] fetching hourly OHLCV (max ${OHLCV_LIMIT} candles)…`);
    const candles = yield* fetchOhlcv(addr);
    if (candles.length === 0) {
      log.warn(`  no OHLCV data, skipping`);
      continue;
    }
    const first = new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10);
    const last = new Date(candles[0]!.timestamp).toISOString().slice(0, 10);
    log.info(`  ${candles.length} candles: ${first} → ${last}`);

    let saved = 0;
    for (let i = 0; i < candles.length; i++) {
      const candle = candles[i]!;
      const volume24hUsd = rollingVolume24h(candles, i);
      const snap = buildSnapshot(meta, candle, volume24hUsd);
      yield* db.saveSnapshot(snap);
      saved++;
    }
    log.info(`[${short}] saved ${saved} snapshots`);
  }

  const pools = yield* db.getSnapshotPools();
  let total = 0;
  for (const p of pools) {
    const c = yield* db.getSnapshotCount(p);
    log.info(`  ${p}: ${c} snapshots`);
    total += c;
  }
  log.info(`done. ${pools.length} pool(s) in pool_snapshots, ${total} snapshot row(s) total`);
});

await Effect.runPromise(program.pipe(Effect.provide(DbLive(args.dbPath))));
