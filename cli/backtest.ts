import { Command } from "commander";
import { createLogger } from "../engine/logger.js";
import { runBacktest } from "../ops/backtest.js";
import { requireRegistered } from "./api.js";

const logger = createLogger("backtest");

export const backtestCommand = new Command("backtest")
  .description("Run historical simulation")
  .option("-d, --days <number>", "Simulation duration in days", "7")
  .option("-p, --pools <addresses>", "Comma-separated pool addresses")
  .option("-s, --source <type>", 'Data source: "synthetic" or "replay"', "synthetic")
  .option("--db <path>", "SQLite database path for replay source", "./prism.db")
  .action(async () => {
    try {
      await requireRegistered(true);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    logger.info("Starting backtest...");
    // Filter out the subcommand name so the underlying backtest parser sees only
    // its own flags (e.g. --days, --pools).
    const args = process.argv.slice(2).filter((a) => a !== "backtest");
    try {
      await runBacktest(args);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
  });
