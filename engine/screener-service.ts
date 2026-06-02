import { Context, Effect, Layer } from "effect";
import { ScreenerService, type ScreenerApi, type ScreenedPool } from "./services.js";
import { AdapterService } from "./services.js";
import { StrategyService } from "./services.js";

export interface ScreenerConfig {
  readonly minTvlUsd: number;
  readonly minFeeRatio: number;
  readonly volumeAuthThreshold: number;
  readonly minBinUtilization: number;
}

export const ScreenerLive = (screenerConfig: ScreenerConfig) =>
  Layer.effect(
    ScreenerService,
    Effect.gen(function* () {
      const adapter = yield* AdapterService;
      const strategy = yield* StrategyService;

      const api: ScreenerApi = {
        screenPools: () =>
          Effect.gen(function* () {
            const pools = yield* adapter.discoverPools();
            const screened: ScreenedPool[] = [];

            for (const pool of pools) {
              try {
                if (pool.tvlUsd < screenerConfig.minTvlUsd) continue;

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

                const auth = strategy.checkVolumeAuthenticity(poolState);
                if (auth.score < screenerConfig.volumeAuthThreshold) continue;

                // Annualized fee-to-TVL heuristic for screening (not the same as
                // StrategyService.computeFeeIlRatio which uses bin-drift IL)
                const discoveryFeeToTvlRatio =
                  pool.fees24hUsd > 0 && pool.tvlUsd > 0
                    ? (pool.fees24hUsd * 365) / pool.tvlUsd
                    : 0;

                if (discoveryFeeToTvlRatio < screenerConfig.minFeeRatio) continue;

                screened.push({
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
                });
              } catch {
                continue;
              }
            }

            return screened.sort((a, b) => b.feeIlRatio - a.feeIlRatio);
          }),
      };

      return api;
    }),
  );
