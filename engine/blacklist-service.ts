import fs from "fs";
import { Context, Effect, Layer } from "effect";
import { BlacklistService, type BlacklistApi } from "./services.js";
import { BlacklistError } from "./errors.js";

export const BlacklistLive = (opts: {
  deployerBlacklistPath: string;
  tokenBlacklistPath: string;
}) =>
  Layer.succeed(
    BlacklistService,
    BlacklistService.of(
      ((): BlacklistApi => {
        function isDeployerBlacklisted(deployer: string): boolean {
          try {
            if (!fs.existsSync(opts.deployerBlacklistPath)) return false;
            const data = JSON.parse(
              fs.readFileSync(opts.deployerBlacklistPath, "utf-8"),
            ) as ReadonlyArray<string>;
            return data.includes(deployer);
          } catch {
            return false;
          }
        }

        function isTokenBlacklisted(mint: string): boolean {
          try {
            if (!fs.existsSync(opts.tokenBlacklistPath)) return false;
            const data = JSON.parse(
              fs.readFileSync(opts.tokenBlacklistPath, "utf-8"),
            ) as ReadonlyArray<string>;
            return data.includes(mint);
          } catch {
            return false;
          }
        }

        return {
          isDeployerBlacklisted,
          isTokenBlacklisted,
          checkPool(poolAddress, tokenXMint, tokenYMint) {
            return Effect.gen(function* () {
              if (isTokenBlacklisted(tokenXMint)) {
                return yield* Effect.fail(new BlacklistError({
                  message: `Token X ${tokenXMint} is blacklisted`,
                  poolAddress,
                }));
              }
              if (isTokenBlacklisted(tokenYMint)) {
                return yield* Effect.fail(new BlacklistError({
                  message: `Token Y ${tokenYMint} is blacklisted`,
                  poolAddress,
                }));
              }
              return;
            });
          },
        };
      })(),
    ),
  );
