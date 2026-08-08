import { Command } from "commander";
import { Effect, Layer } from "effect";
import { ConfigLive, ConfigService } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import { getPrismDbPath } from "../engine/paths.js";
import { resolveEffectivePubkey } from "./wallet.js";

class ResumeCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeCommandError";
  }
}

function buildProgram(): Layer.Layer<DbService | ConfigService, Error, never> {
  const dbLayer = DbLive(process.env.SQLITE_DB_PATH ?? getPrismDbPath());
  return Layer.merge(dbLayer, ConfigLive);
}

export const resumeCommand = new Command("resume")
  .description("Clear the current wallet's active autonomous safety pause")
  .addHelpText(
    "after",
    `
This command only resolves the local safety-pause record for the effective
wallet and configured agent instance. It does not submit or sign any transaction.`,
  )
  .action(async () => {
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const effectiveWallet = resolveEffectivePubkey();
          if (effectiveWallet === null || effectiveWallet.error !== undefined) {
            return yield* Effect.fail(
              new ResumeCommandError(
                "No valid effective wallet is configured; run prism wallet show",
              ),
            );
          }

          const db = yield* DbService;
          const config = yield* ConfigService;
          const pause = yield* db.getSafetyPause(effectiveWallet.pubkey, config.agentInstanceId);
          if (pause === null) {
            console.log("No autonomous safety pause is recorded for the current wallet.");
            return;
          }
          if (pause.resolvedAt !== null) {
            console.log("The current wallet's autonomous safety pause is already resolved.");
            return;
          }

          yield* db.saveSafetyPause({ ...pause, resolvedAt: Date.now() });
          console.log("Autonomous safety pause resolved for the current wallet.");
        }).pipe(Effect.provide(buildProgram())),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`✗ Failed to resume autonomous operation: ${message}`);
      process.exit(1);
    }
  });
