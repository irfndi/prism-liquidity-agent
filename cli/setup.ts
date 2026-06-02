import { Command } from "commander";
import * as p from "@clack/prompts";
import fs from "fs";
import path from "path";
import os from "os";

export const setupCommand = new Command("setup")
  .description("Configure Prism trading agent")
  .option("--non-interactive", "Run without prompts (for agents/CI)")
  .option("--helius-key <key>", "Helius API key")
  .option("--wallet-key <key>", "Solana wallet private key (optional)")
  .option("--watchlist <pools>", "Comma-separated pool addresses")
  .option("--paper-trading", "Enable paper trading (default: true)")
  .action(async (options) => {
    const isNonInteractive = options.nonInteractive;

    let heliusKey: string;
    let walletKey: string;
    let watchlistPools: string;
    let paperTrading: boolean;

    if (isNonInteractive) {
      // Non-interactive mode (agent-driven)
      if (!options.heliusKey) {
        console.error("Error: --helius-key is required in non-interactive mode");
        process.exit(1);
      }
      heliusKey = options.heliusKey;
      walletKey = options.walletKey || "";
      watchlistPools = options.watchlist || "";
      paperTrading = options.paperTrading !== false;
    } else {
      // Interactive mode
      console.clear();
      p.intro("  Prism Setup  ");

      const answers = await p.group(
        {
          heliusKey: () =>
            p.text({
              message: "Helius API key",
              placeholder: "your-helius-api-key",
              validate: (v) =>
                v && v.length > 8 ? undefined : "Key too short",
            }),

          walletKey: () =>
            p.text({
              message: "Wallet private key (optional, for live trading)",
              placeholder: "leave blank for paper trading",
              initialValue: "",
            }),

          watchlistPools: () =>
            p.text({
              message:
                "Watchlist pools (comma-separated, leave blank for pool discovery)",
              placeholder: "ABC123...,DEF456...",
              initialValue: "",
            }),

          paperTrading: () =>
            p.confirm({
              message: "Enable paper trading?",
              initialValue: true,
            }),
        },
        {
          onCancel: () => {
            p.cancel("Setup cancelled.");
            process.exit(0);
          },
        },
      );

      heliusKey = answers.heliusKey as string;
      walletKey = (answers.walletKey as string) || "";
      watchlistPools = (answers.watchlistPools as string) || "";
      paperTrading = answers.paperTrading as boolean;
    }

    const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;

    const envContent = [
      "# Required",
      `HELIUS_API_KEY=${heliusKey}`,
      `SOLANA_RPC_URL=${rpcUrl}`,
      "",
      "# Wallet (optional — leave empty for paper trading)",
      `WALLET_PRIVATE_KEY=${walletKey}`,
      "",
      "# Trading mode",
      `PAPER_TRADING=${String(paperTrading)}`,
      "SCAN_INTERVAL_MS=600000",
      "MIN_POOL_TVL_USD=50000",
      "MIN_FEE_IL_RATIO=1.2",
      "TVL_DROP_EXIT_PCT=0.30",
      "VOLUME_AUTH_THRESHOLD=0.70",
      "MAX_CONCURRENT_POSITIONS=5",
      "CONFIDENCE_THRESHOLD=0.65",
      "TRAILING_STOP_PCT=0.10",
      "",
      "# SQLite",
      "SQLITE_DB_PATH=./prism.db",
      "",
      "# Pools",
      `WATCHLIST_POOLS=${watchlistPools}`,
    ].join("\n");

    const envPath = path.resolve(".env");
    fs.writeFileSync(envPath, envContent);

    if (!isNonInteractive) {
      p.note(
        [
          "✓ .env created",
          "",
          "Next steps:",
          "  1. Run agent:     prism dev",
          "  2. Run backtest:  prism backtest",
        ].join("\n"),
        "Setup complete",
      );
      p.outro("Happy rebalancing!");
    } else {
      console.log("✓ .env created");
    }
  });
