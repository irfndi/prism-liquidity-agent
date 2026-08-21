import { Command } from "commander";
import { createLogger } from "../engine/logger.js";
import { runBacktest } from "../ops/backtest.js";

const logger = createLogger("backtest");

export const backtestCommand = new Command("backtest")
  .description("Run historical simulation")
  .option("-d, --days <number>", "Simulation duration in days", "7")
  .option("-p, --pools <addresses>", "Comma-separated pool addresses")
  .option("-s, --source <type>", 'Data source: "synthetic" or "replay"', "synthetic")
  .option("--db <path>", "SQLite database path for replay source", "./prism.db")
  .option("--seed <number>", "Unsigned 32-bit seed for repeatable synthetic runs")
  .option(
    "--seeds <numbers>",
    "Comma-separated unique unsigned 32-bit seeds for a synthetic robustness sweep (max 32)",
  )
  .option("--entry-cost-bps <number>", "Entry execution cost in basis points (0-10000)", "0")
  .option("--exit-cost-bps <number>", "Exit execution cost in basis points (0-10000)", "0")
  .option(
    "--fixed-action-cost-usd <number>",
    "Fixed USD cost applied to each entry or exit (0-100000)",
    "0",
  )
  .option(
    "--fee-share-ref-width <bins>",
    "Reference width in bins for concentration-aware fee share (0-10000)",
  )
  .action(async () => {
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
