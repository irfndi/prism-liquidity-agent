import { Command } from "commander";
import { spawn } from "child_process";
import { pingInstall, readCredentials } from "./api.js";
import { acquireLock, releaseLock, LOCKFILE_PATH } from "./lockfile.js";

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

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PRISM_ALLOW_DIRECT: "true",
    };
    if (options.exitLive) {
      console.warn(
        "⚠️  PAPER_MODE_EXIT_LIVE enabled — paper mode will execute live transactions for EXIT",
      );
      env.PAPER_MODE_EXIT_LIVE = "true";
    }

    const cleanup = (code?: number): void => {
      releaseLock();
      if (code !== undefined) {
        process.exit(code);
      }
    };

    let cleanedUp = false;
    const doCleanup = (code?: number): void => {
      if (cleanedUp) return;
      cleanedUp = true;
      cleanup(code);
    };

    process.on("exit", () => cleanup());
    process.on("SIGINT", () => {
      child.kill("SIGINT");
      doCleanup(130);
    });
    process.on("SIGTERM", () => {
      child.kill("SIGTERM");
      doCleanup(143);
    });

    console.log("Starting Prism trading agent...");
    const child = spawn("bun", ["run", "dev"], {
      stdio: "inherit",
      shell: false,
      env,
    });

    child.on("exit", (code) => {
      doCleanup(code ?? 0);
    });
  });
