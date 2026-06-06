import { Command } from "commander";
import { spawn } from "child_process";
import { pingInstall, readCredentials } from "./api.js";

export const devCommand = new Command("dev")
  .description("Start the trading agent")
  .action(() => {
    pingInstall("dev_start");

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

    console.log("Starting Prism trading agent...");
    const child = spawn("bun", ["run", "dev"], {
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
  });
