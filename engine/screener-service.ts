import { Context, Effect, Layer } from "effect";
import { ScreenerService, type ScreenerApi, type ScreenedPool } from "./services.js";
import { AdapterService, type DiscoveredPool } from "./services.js";
import { StrategyService } from "./services.js";
import { createLogger } from "./logger.js";
import { DiscoverPoolsError } from "./errors.js";

const logger = createLogger("screener");

export interface ScreenerConfig {
  readonly minTvlUsd: number;
  readonly minFeeRatio: number;
  readonly volumeAuthThreshold: number;
  readonly minBinUtilization: number;
}

/**
 * Bin utilization is not part of the Data API discovery payload, so the
 * screener enriches at most this many surviving candidates with on-chain bin
 * data and applies minBinUtilization only where reserves are known. Candidates
 * beyond the cap (or whose bin fetch fails) pass through unfiltered — the
 * per-pool scan loop re-applies the gate with full data before any ENTER.
 */
const MAX_BIN_UTILIZATION_CHECKS = 10;

export const ScreenerLive = (screenerConfig: ScreenerConfig) =>
  Layer.effect(
    ScreenerService,
    Effect.gen(function* () {
      const adapter = yield* AdapterService;
      const strategy = yield* StrategyService;

      const api: ScreenerApi = {
        screenPools: () =>
          Effect.gen(function* () {
            const pools: ReadonlyArray<DiscoveredPool> = yield* adapter.discoverPools().pipe(
              Effect.catchAll((err) => {
                if (
                  err instanceof DiscoverPoolsError ||
                  (err as { _tag?: string })?._tag === "DiscoverPoolsError"
                ) {
                  logger.warn(
                    "Pool discovery failed; falling back to watchlist-only mode:",
                    err.message,
                  );
                  return Effect.succeed([] as ReadonlyArray<DiscoveredPool>);
                }
                return Effect.fail(err);
              }),
            );
            const screened: ScreenedPool[] = [];

            for (const pool of pools) {
              const candidate = yield* Effect.try({
                try: () => {
                  if (pool.tvlUsd < screenerConfig.minTvlUsd) return null;

                  const poolState = {
                    address: pool.address,
                    tokenX: pool.tokenX,
                    tokenY: pool.tokenY,
                    tokenXSymbol: pool.tokenX.slice(0, 4),
                    tokenYSymbol: pool.tokenY.slice(0, 4),
                    tvlUsd: pool.tvlUsd,
                    volume24hUsd: pool.volume24hUsd,
                    fees24hUsd: pool.fees24hUsd,
                    apr: pool.apr,
                    activeBinId: 0,
                    binStep: pool.binStep,
                    currentPrice: 0,
                    timestamp: Date.now(),
                  };

                  // Discovery data is Data-API-sourced, so these fees are measured
                  // and the fee-rate-band check legitimately runs.
                  const auth = strategy.checkVolumeAuthenticity(poolState, true);
                  if (auth.score < screenerConfig.volumeAuthThreshold) return null;

                  // Annualized fee-to-TVL heuristic for screening (not the same as
                  // StrategyService.computeFeeIlRatio which uses bin-drift IL)
                  const discoveryFeeToTvlRatio =
                    pool.fees24hUsd > 0 && pool.tvlUsd > 0
                      ? (pool.fees24hUsd * 365) / pool.tvlUsd
                      : 0;

                  if (discoveryFeeToTvlRatio < screenerConfig.minFeeRatio) return null;

                  return {
                    address: pool.address,
                    tvlUsd: pool.tvlUsd,
                    volume24hUsd: pool.volume24hUsd,
                    fees24hUsd: pool.fees24hUsd,
                    apr: pool.apr,
                    feeIlRatio: discoveryFeeToTvlRatio,
                    volumeAuth: auth.score,
                    binUtilization: 0,
                    tokenX: pool.tokenX,
                    tokenY: pool.tokenY,
                  };
                },
                catch: (error) => error,
              }).pipe(Effect.catchAll(() => Effect.succeed(null)));

              if (candidate) screened.push(candidate);
            }

            const sorted = screened.sort((a, b) => b.feeIlRatio - a.feeIlRatio);

            // minBinUtilization filter: only applied where on-chain bin data
            // exists (see MAX_BIN_UTILIZATION_CHECKS). Fail-open otherwise.
            const enriched: ScreenedPool[] = [];
            for (const candidate of sorted.slice(0, MAX_BIN_UTILIZATION_CHECKS)) {
              const binArray = yield* adapter.getBinArray(candidate.address).pipe(
                Effect.catchAll((err) => {
                  logger.warn("Bin data unavailable for candidate — skipping utilization gate", {
                    pool: candidate.address,
                    error: String(err),
                  });
                  return Effect.succeed(null);
                }),
              );
              if (binArray === null || binArray.reservesKnown === false) {
                enriched.push(candidate);
                continue;
              }
              const utilization = strategy.computeBinUtilization(binArray);
              if (utilization < screenerConfig.minBinUtilization) {
                logger.info("Candidate filtered by bin utilization", {
                  pool: candidate.address,
                  utilization: utilization.toFixed(2),
                  minBinUtilization: screenerConfig.minBinUtilization,
                });
                continue;
              }
              enriched.push({ ...candidate, binUtilization: utilization });
            }
            enriched.push(...sorted.slice(MAX_BIN_UTILIZATION_CHECKS));

            return enriched;
          }),
      };

      return api;
    }),
  );
