import { Command } from "commander";
import { pingInstall, readCredentials } from "./api.js";
import { acquireLock, releaseLock, LOCKFILE_PATH } from "./lockfile.js";
import { runEngine } from "../engine/run-engine.js";

interface DevCommandOptions {
  exitLive: boolean;
}

export const devCommand = new Command("dev")
  .description("Start the trading agent")
  .option(
    "--exit-live",
    "Execute live on-chain EXIT transactions even in paper mode (requires wallet — sends real transactions)",
    false,
  )
  .action(async (options: DevCommandOptions) => {
    const creds = readCredentials();

    if (!creds) {
      console.warn(
        "Warning: No Prism account found. Run 'prism register' to enable cloud features.",
      );
      console.warn("Continuing in local-only mode (paper trading works without registration).");
      console.warn("");
    }

    await pingInstall("dev_start", creds ? { userId: creds.userId } : {});

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
