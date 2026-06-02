import { Command } from "commander";
import { spawn } from "child_process";

export const backtestCommand = new Command("backtest")
  .description("Run historical simulation")
  .action(() => {
    console.log("Starting backtest...");
    const child = spawn("bun", ["run", "backtest"], {
      stdio: "inherit",
      shell: false,
    });

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
  });
