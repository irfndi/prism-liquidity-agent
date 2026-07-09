import { Command } from "commander";
import { runBacktest } from "../ops/backtest.js";

export const backtestCommand = new Command("backtest")
  .description("Run historical simulation")
  .option("-d, --days <number>", "Simulation duration in days", "7")
  .option("-p, --pools <addresses>", "Comma-separated pool addresses")
  .option("-s, --source <type>", 'Data source: "synthetic" or "replay"', "synthetic")
  .option("--db <path>", "SQLite database path for replay source", "./prism.db")
  .action(async () => {
    console.log("Starting backtest...");
    // Filter out the subcommand name so the underlying backtest parser sees only
    // its own flags (e.g. --days, --pools).
    const args = process.argv.slice(2).filter((a) => a !== "backtest");
    await runBacktest(args);
  });
