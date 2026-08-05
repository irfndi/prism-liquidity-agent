import type { GeckoOhlcvSignals } from "./gecko-ohlcv-service.js";
import type { RugCheckReport } from "./rugcheck-service.js";
import {
  evaluateFallenAngelGate,
  identifyAssetMint,
  type FallenAngelGateConfig,
} from "./fallen-angel-service.js";

/**
 * Fallen-angel discovery pass (Wave 19) — pure module.
 *
 * Takes the raw discovered pool list (any TVL) + per-pool fetched signals and
 * returns the pools that qualify as fallen-angel candidates. All network I/O
 * is the caller's job (injected via the `fetchSignals` callback); this module
 * only decides.
 *
 * The caller (program.ts) gates this whole pass on `FALLEN_ANGEL_ENABLED` and
 * `shouldDiscoverPools`, and feeds qualified pools into `poolsToScan` via the
 * same mechanism as autonomous candidates.
 */

export interface FallenAngelDiscoveredPool {
  readonly address: string;
  readonly tvlUsd: number;
  readonly tokenX: string;
  readonly tokenY: string;
}

export interface FallenAngelPoolSignals {
  readonly ohlcv: GeckoOhlcvSignals | null;
  readonly rugcheck: RugCheckReport | null;
}

export interface FallenAngelDiscoveryResult {
  /** Pools that passed every gate. */
  readonly qualified: ReadonlyArray<{
    readonly poolAddress: string;
    readonly assetMint: string;
    /** Drawdown from ATH (0..1) for display / entry scoring. */
    readonly drawdownPct: number;
  }>;
  /** Pools that failed, with the reasons (for logging). */
  readonly rejected: ReadonlyArray<{
    readonly poolAddress: string;
    readonly reasons: ReadonlyArray<string>;
  }>;
}

/**
 * Evaluate discovered pools against the fallen-angel gate.
 *
 * `fetchSignals(pool)` returns the OHLCV + RugCheck report for a pool (or
 * nulls when unavailable). It is called ONCE per pool that clears the TVL
 * floor, so the caller can cache per-mint RugCheck reports and pace requests.
 */
export function evaluateFallenAngelDiscovery(
  pools: ReadonlyArray<FallenAngelDiscoveredPool>,
  config: FallenAngelGateConfig,
  stablecoinMints: ReadonlySet<string> | undefined,
  solMint: string,
  fetchSignals: (pool: FallenAngelDiscoveredPool) => Promise<FallenAngelPoolSignals>,
): Promise<FallenAngelDiscoveryResult> {
  return (async () => {
    const qualified: Array<{
      poolAddress: string;
      assetMint: string;
      drawdownPct: number;
    }> = [];
    const rejected: Array<{ poolAddress: string; reasons: ReadonlyArray<string> }> = [];

    for (const pool of pools) {
      if (!Number.isFinite(pool.tvlUsd) || pool.tvlUsd < config.minTvlUsd) {
        // Below the floor — not a rejection, just out of universe.
        continue;
      }
      const assetMint = identifyAssetMint(pool.tokenX, pool.tokenY, stablecoinMints, solMint);
      if (assetMint === null) {
        rejected.push({
          poolAddress: pool.address,
          reasons: ["No identifiable asset leg (stablecoin pair or empty allowlist)"],
        });
        continue;
      }

      const signals = await fetchSignals(pool);
      const result = evaluateFallenAngelGate({
        poolTvlUsd: pool.tvlUsd,
        assetMint,
        ohlcv: signals.ohlcv,
        rugcheck: signals.rugcheck,
        config,
      });

      if (result.qualified) {
        qualified.push({
          poolAddress: pool.address,
          assetMint,
          drawdownPct: signals.ohlcv?.drawdownFromAth ?? 0,
        });
      } else {
        rejected.push({ poolAddress: pool.address, reasons: result.reasons });
      }
    }

    return { qualified, rejected };
  })();
}
