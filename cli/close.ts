import { Command } from "commander";
import { Effect, Layer } from "effect";
import { DbLive, type PositionRecord } from "../engine/db-service.js";
import { DbService, AdapterService, type DbApi } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigLive, ConfigService } from "../engine/config-service.js";
import { computeRealizedPnlUsd } from "../engine/pnl.js";
import { getPrismDbPath } from "../engine/paths.js";
import { SOL_MINT } from "../engine/constants.js";
import { createLogger } from "../engine/logger.js";

const logger = createLogger("close-cli");

/**
 * Mirror of `rugBlockMints` in engine/program.ts (kept local so the CLI does
 * not import the whole scan program). Returns the non-stable legs that must be
 * rug-blocked when a close realizes a catastrophic loss (≥ rugExitLossPct of
 * the cost basis). SOL and operator-declared stablecoin mints are never blocked.
 */
function rugBlockMints(input: {
  readonly realizedPnlUsd: number | null;
  readonly depositedUsd: number;
  readonly rugExitLossPct: number;
  readonly stablecoinMints: ReadonlySet<string> | undefined;
  readonly tokenX: string | undefined;
  readonly tokenY: string | undefined;
}): ReadonlyArray<string> {
  const { realizedPnlUsd, depositedUsd, rugExitLossPct } = input;
  if (realizedPnlUsd === null || depositedUsd <= 0) return [];
  if (-realizedPnlUsd / depositedUsd < rugExitLossPct) return [];
  const isStable = (mint: string) =>
    mint === SOL_MINT || (input.stablecoinMints?.has(mint) ?? false);
  return [input.tokenX, input.tokenY].filter(
    (mint): mint is string => mint !== undefined && mint !== "" && !isStable(mint),
  );
}

function computeClosePnl(
  withdrawnUsd: number | null,
  isEmptyReap: boolean | undefined,
  pos: PositionRecord,
): number | null {
  // An empty-reap (zero-liquidity on-chain account) realizes 0: there is
  // nothing to withdraw and the heuristic mark was phantom, so no loss
  // against the (suspect) deposited basis and no rug-block is booked.
  if (isEmptyReap) return 0;
  if (withdrawnUsd === null) return null;
  return computeRealizedPnlUsd(
    withdrawnUsd,
    pos.cumulativeFeesClaimedUsd,
    pos.depositedUsd,
    pos.cumulativeRewardsClaimedUsd,
  );
}

function recordEmptyReap(db: DbApi, positionPubKey: string) {
  // Mirror the engine's reaped-empty tombstone (same key + 24h TTL as
  // engine/program.ts): stop reconcile from re-discovering the lingering
  // ghost account when rent reclaim failed, avoiding EXIT->reap churn.
  return db
    .setMetadata(`reaped_empty:${positionPubKey}`, String(Date.now() + 24 * 60 * 60 * 1000))
    .pipe(Effect.catch(() => Effect.void));
}

function blockRugMints(db: DbApi, mints: ReadonlyArray<string>, expiresAt: number) {
  return Effect.gen(function* () {
    for (const mint of mints) {
      yield* db
        .setMetadata(`token_rug_block:${mint}`, String(expiresAt))
        .pipe(Effect.catch(() => Effect.void));
    }
  });
}

function buildProgram(): Layer.Layer<DbService | AdapterService | ConfigService, Error, never> {
  const dbPath = process.env.SQLITE_DB_PATH ?? getPrismDbPath();
  const dbLayer = DbLive(dbPath);
  const configLayer = ConfigLive;
  const adapterLayer = Layer.provide(AdapterLive, Layer.merge(configLayer, dbLayer));
  return Layer.mergeAll(dbLayer, configLayer, adapterLayer);
}

function resolvePosition(
  db: DbApi,
  idOrPubkey: string,
): Effect.Effect<PositionRecord | null, Error, never> {
  return Effect.gen(function* () {
    const byId = yield* db.getPosition(idOrPubkey);
    if (byId) return byId;
    const active = yield* db.getAllPositions();
    return (
      active.find((p) => p.positionId === idOrPubkey || p.positionPubKey === idOrPubkey) ?? null
    );
  });
}

export const closeCommand = new Command("close")
  .description("Close an open position: withdraw on-chain and settle the ledger")
  .argument("<positionId>", "position id or on-chain position public key")
  .addHelpText(
    "after",
    `\nExamples:
  $ prism close <positionId>   # live on-chain exit + ledger close\n`,
  );

closeCommand.action(async function (this: Command, positionId: string) {
  const program = buildProgram();
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DbService;
      const adapter = yield* AdapterService;
      const config = yield* ConfigService;

      const pos = yield* resolvePosition(db, positionId);
      if (!pos) {
        console.error(`✗ Position not found: ${positionId}`);
        process.exitCode = 1;
        return;
      }
      if (!pos.positionPubKey) {
        console.error(
          `✗ Position ${pos.positionId} has no on-chain public key (paper row) — nothing to close on-chain.`,
        );
        process.exitCode = 1;
        return;
      }

      console.log(
        `Closing ${pos.tokenXSymbol}/${pos.tokenYSymbol} (${pos.poolAddress}) position ${pos.positionId} (${pos.positionPubKey})…`,
      );
      const result = yield* adapter.exitPosition(pos.poolAddress, pos.positionPubKey);

      const withdrawnUsd = result.withdrawnUsd ?? null;
      const realizedPnlUsd = computeClosePnl(withdrawnUsd, result.isEmptyReap, pos);

      yield* db.closePosition(pos.positionId, realizedPnlUsd);

      if (result.isEmptyReap && pos.positionPubKey != null) {
        yield* recordEmptyReap(db, pos.positionPubKey);
      }

      // Rug-block the non-stable legs when the close realized a catastrophic
      // loss (mirrors the live executor). Pool mints come from the adapter;
      // a failed pool-state read fails open (no block) like the engine's path.
      let rugBlockedMints: ReadonlyArray<string> = [];
      const poolState = yield* adapter
        .getPoolState(pos.poolAddress)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (poolState) {
        rugBlockedMints = rugBlockMints({
          realizedPnlUsd,
          depositedUsd: pos.depositedUsd,
          rugExitLossPct: config.rugExitLossPct ?? 0.5,
          stablecoinMints: config.stablecoinMints,
          tokenX: poolState.tokenX,
          tokenY: poolState.tokenY,
        });
        if (rugBlockedMints.length > 0) {
          yield* blockRugMints(
            db,
            rugBlockedMints,
            Date.now() + (config.rugTokenBlockMs ?? 604_800_000),
          );
        }
      }

      console.log(
        JSON.stringify(
          {
            positionId: pos.positionId,
            pool: pos.poolAddress,
            txSignature: result.txSignature,
            withdrawnUsd,
            realizedPnlUsd,
            rugBlockedMints,
          },
          null,
          2,
        ),
      );
    }).pipe(
      Effect.provide(program),
      Effect.catch((err: Error) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Close failed: ${message}`);
        console.error(`✗ Close failed: ${message}`);
        process.exitCode = 1;
        return Effect.void;
      }),
    ),
  );
});
