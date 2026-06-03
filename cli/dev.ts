import { Command } from "commander";
import { spawn } from "child_process";
import { pingInstall } from "./api.js";

export const devCommand = new Command("dev")
  .description("Start the trading agent")
  .action(() => {
    pingInstall("dev_start");
    console.log("Starting Prism trading agent...");
    const child = spawn("bun", ["run", "dev"], {
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
  });
