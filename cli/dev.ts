import { Command } from "commander";
import { pingInstall, requireRegistered, type PrismCredentials } from "./api.js";
import { acquireLock, releaseLock, LOCKFILE_PATH } from "./lockfile.js";
import { runEngine } from "../engine/run-engine.js";

interface DevCommandOptions {
  exitLive: boolean;
}

// Telemetry must never block agent startup — degrade to a warning when the
// API is unreachable so offline work keeps running.
export async function reportDevStartTelemetry(userId: string): Promise<void> {
  if (!(await pingInstall("dev_start", { userId }))) {
    console.warn("⚠️  Prism telemetry is unavailable; continuing without telemetry.");
    console.warn("Run 'prism doctor' to diagnose the account and API connection.");
  }
}

export const devCommand = new Command("dev")
  .description("Start the trading agent")
  .option(
    "--exit-live",
    "Execute live on-chain EXIT transactions even in paper mode (requires wallet — sends real transactions)",
    false,
  )
  .action(async (options: DevCommandOptions) => {
    let creds: PrismCredentials;
    try {
      creds = await requireRegistered(true);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    await reportDevStartTelemetry(creds.userId);

    const lock = acquireLock();
    if (!lock.acquired) {
      console.error(
        `prism dev is already running (PID ${lock.pid}). Run 'kill ${lock.pid}' or remove ${LOCKFILE_PATH} to force.`,
      );
      process.exit(1);
    }

    if (options.exitLive) {
      console.warn(
        "⚠️  PAPER_MODE_EXIT_LIVE enabled — paper mode will execute live transactions for EXIT",
      );
      process.env.PAPER_MODE_EXIT_LIVE = "true";
    }
    process.env.PRISM_ALLOW_DIRECT = "true";

    function cleanup(code?: number): void {
      releaseLock();
      if (code !== undefined) {
        process.exit(code);
      }
    }

    let cleanedUp = false;
    const doCleanup = (code?: number): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      cleanup(code);
    };

    process.on("exit", () => cleanup());
    process.on("SIGINT", () => doCleanup(130));
    process.on("SIGTERM", () => doCleanup(143));

    console.log("Starting Prism trading agent...");
    await runEngine();
    // runEngine blocks until the engine exits; the following line is only
    // reached if it returns without a fatal error.
    doCleanup(0);
  });
