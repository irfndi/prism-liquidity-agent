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
      console.error("Error: Registration required to start the trading agent.");
      console.error("Run 'prism register' first to create an account.");
      console.error("");
      console.error("The trading agent requires a valid API key for:");
      console.error("  - Subscription/tier management");
      console.error("  - Referral tracking");
      console.error("  - Platform fee processing");
      process.exit(1);
    }

    await pingInstall("dev_start", { userId: creds.userId });

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

    const cleanup = (): void => {
      releaseLock();
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => {
      cleanup();
      process.exit(130);
    });
    process.on("SIGTERM", () => {
      cleanup();
      process.exit(143);
    });

    console.log("Starting Prism trading agent...");
    const child = spawn("bun", ["run", "dev"], {
      stdio: "inherit",
      shell: false,
      env,
    });

    child.on("exit", (code) => {
      cleanup();
      process.exit(code ?? 0);
    });
  });
