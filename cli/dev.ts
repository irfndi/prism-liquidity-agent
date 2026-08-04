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
    } else {
      // Do not let an ambient PAPER_MODE_EXIT_LIVE silently enable live on-chain
      // EXITs in paper mode; the explicit --exit-live flag is the only opt-in.
      delete process.env.PAPER_MODE_EXIT_LIVE;
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

    // The engine owns SIGINT/SIGTERM: its gracefulShutdown posts a final
    // "stopped" status to the API before exiting, so Telegram /status updates
    // on shutdown. If the CLI also handled these signals here and called
    // process.exit first, that stopped report would never run and /status would
    // show a stale "running" until the KV TTL expired. We hook only "exit" to
    // guarantee the lockfile is released once the process actually ends.
    process.on("exit", () => cleanup());

    console.log("Starting Prism trading agent...");
    await runEngine();
    // runEngine blocks until the engine exits; the following line is only
    // reached if it returns without a fatal error.
    doCleanup(0);
  });
