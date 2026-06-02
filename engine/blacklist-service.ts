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
        function loadSet(path: string): Set<string> {
          try {
            if (!fs.existsSync(path)) return new Set();
            const data = JSON.parse(fs.readFileSync(path, "utf-8")) as ReadonlyArray<string>;
            return new Set(data);
          } catch (err) {
            console.error(`Failed to load blacklist from ${path}: ${String(err)}`);
            return new Set();
          }
        }

        const deployerSet = loadSet(opts.deployerBlacklistPath);
        const tokenSet = loadSet(opts.tokenBlacklistPath);

        function isDeployerBlacklisted(deployer: string): boolean {
          return deployerSet.has(deployer);
        }

        function isTokenBlacklisted(mint: string): boolean {
          return tokenSet.has(mint);
        }

        return {
          isDeployerBlacklisted,
          isTokenBlacklisted,
          checkPool(poolAddress, tokenXMint, tokenYMint, tokenXDeployer, tokenYDeployer) {
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
              if (tokenXDeployer && isDeployerBlacklisted(tokenXDeployer)) {
                return yield* Effect.fail(new BlacklistError({
                  message: `Token X deployer ${tokenXDeployer} is blacklisted`,
                  poolAddress,
                }));
              }
              if (tokenYDeployer && isDeployerBlacklisted(tokenYDeployer)) {
                return yield* Effect.fail(new BlacklistError({
                  message: `Token Y deployer ${tokenYDeployer} is blacklisted`,
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
