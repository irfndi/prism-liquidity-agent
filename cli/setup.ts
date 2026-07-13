import { Command } from "commander";
import * as p from "@clack/prompts";
import fs from "fs";
import path from "path";
import os from "os";
import { pingInstall, requireRegistered, type PrismCredentials } from "./api.js";
import { ensurePrismConfigDir, getPrismEnvPath, getPrismDbPath } from "../engine/paths.js";

export const setupCommand = new Command("setup")
  .description("Configure Prism trading agent")
  .option("--non-interactive", "Run without prompts (for agents/CI)")
  .option("--helius-key <key>", "Optional Helius API key")
  .option("--rpc-url <url>", "Primary Solana RPC URL")
  .option("--rpc-fallback-url <url>", "Optional fallback Solana RPC URL")
  .option("--jupiter-api-key <key>", "Optional Jupiter API key")
  .option("--wallet-key-file <path>", "Path to Solana wallet keypair file (optional)")
  .option("--watchlist <pools>", "Comma-separated pool addresses")
  .option("--paper-trading", "Enable paper trading (default: true)")
  .action(async (options) => {
    const isNonInteractive = options.nonInteractive;
    let credentials: PrismCredentials;
    try {
      credentials = await requireRegistered(true);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    let heliusKey: string;
    let walletKey: string;
    let watchlistPools: string;
    let paperTrading: boolean;
    let rpcUrl: string;
    let rpcFallbackUrl: string;
    let jupiterApiKey: string;

    if (isNonInteractive) {
      const configuredHeliusKey = options.heliusKey || process.env.HELIUS_API_KEY || "";
      rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || "";
      if (!rpcUrl && configuredHeliusKey) {
        rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${configuredHeliusKey}`;
      }
      if (!rpcUrl) {
        console.error("Error: provide --rpc-url or --helius-key in non-interactive mode");
        process.exit(1);
      }
      heliusKey = configuredHeliusKey;
      rpcFallbackUrl = options.rpcFallbackUrl || process.env.SOLANA_RPC_FALLBACK_URL || "";
      jupiterApiKey = options.jupiterApiKey || process.env.JUPITER_API_KEY || "";
      // Read wallet key from file if provided, otherwise from env
      if (options.walletKeyFile) {
        try {
          walletKey = fs.readFileSync(options.walletKeyFile, "utf-8").trim();
        } catch (err) {
          console.error(`Error: Could not read wallet key file: ${options.walletKeyFile}`);
          process.exit(1);
        }
      } else {
        walletKey = process.env.WALLET_PRIVATE_KEY || "";
      }
      watchlistPools = options.watchlist || "";
      paperTrading = options.paperTrading !== false;

      // Validate: live trading requires wallet key
      if (!paperTrading && !walletKey.trim()) {
        console.error("Error: Wallet private key is required when paper trading is disabled.");
        console.error("Provide via --wallet-key-file or WALLET_PRIVATE_KEY env var.");
        process.exit(1);
      }
    } else {
      // Interactive mode
      console.clear();
      p.intro("  Prism Setup  ");

      const answers = await p.group(
        {
          heliusKey: () =>
            p.text({
              message: "Helius API key (optional with a custom RPC)",
              placeholder: "leave blank when using another RPC",
              initialValue: process.env.HELIUS_API_KEY ?? "",
              validate: (v) => (v && v.length <= 8 ? "Key too short" : undefined),
            }),

          rpcUrl: () =>
            p.text({
              message: "Primary Solana RPC URL (optional with Helius key)",
              placeholder: "https://...",
              initialValue: process.env.SOLANA_RPC_URL ?? "",
            }),

          rpcFallbackUrl: () =>
            p.text({
              message: "Fallback Solana RPC URL (optional)",
              placeholder: "https://...",
              initialValue: process.env.SOLANA_RPC_FALLBACK_URL ?? "",
            }),

          jupiterApiKey: () =>
            p.text({
              message: "Jupiter API key (optional, improves price API limits)",
              placeholder: "leave blank to use public fallback",
              initialValue: process.env.JUPITER_API_KEY ?? "",
            }),

          walletKey: () =>
            p.text({
              message: "Wallet private key (optional, for live trading)",
              placeholder: "leave blank for paper trading",
              initialValue: "",
            }),

          watchlistPools: () =>
            p.text({
              message: "Watchlist pools (comma-separated, leave blank for pool discovery)",
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

      heliusKey = (answers.heliusKey as string) || "";
      rpcUrl = (answers.rpcUrl as string) || "";
      rpcFallbackUrl = (answers.rpcFallbackUrl as string) || "";
      jupiterApiKey = (answers.jupiterApiKey as string) || "";
      if (!rpcUrl.trim() && heliusKey.trim()) {
        rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
      }
      if (!rpcUrl.trim()) {
        p.cancel("A primary RPC URL or Helius API key is required.");
        process.exit(1);
      }
      walletKey = (answers.walletKey as string) || "";
      watchlistPools = (answers.watchlistPools as string) || "";
      paperTrading = answers.paperTrading as boolean;

      // Validate: live trading requires wallet key
      if (!paperTrading && !walletKey.trim()) {
        p.cancel("Wallet private key is required when paper trading is disabled.");
        process.exit(1);
      }
    }

    // Escape values to prevent .env injection
    function escapeEnv(value: string): string {
      if (value.includes("\n") || value.includes("\r")) {
        throw new Error("Environment values cannot contain newlines");
      }
      return value;
    }

    const envContent = [
      "# RPC providers",
      `HELIUS_API_KEY=${escapeEnv(heliusKey)}`,
      `SOLANA_RPC_URL=${escapeEnv(rpcUrl)}`,
      `SOLANA_RPC_FALLBACK_URL=${escapeEnv(rpcFallbackUrl)}`,
      `JUPITER_API_KEY=${escapeEnv(jupiterApiKey)}`,
      "",
      "# Wallet (optional — leave empty for paper trading)",
      `WALLET_PRIVATE_KEY=${escapeEnv(walletKey)}`,
      "",
      "# Trading mode",
      `PAPER_TRADING=${String(paperTrading)}`,
      "SCAN_INTERVAL_MS=600000",
      "MIN_POOL_TVL_USD=50000",
      "MIN_FEE_IL_RATIO=1.2",
      "TVL_DROP_EXIT_PCT=0.30",
      "VOLUME_AUTH_THRESHOLD=0.70",
      "MAX_OPEN_POSITIONS=3",
      "CONFIDENCE_THRESHOLD=0.65",
      "TRAILING_STOP_PCT=0.10",
      "",
      "# SQLite",
      `SQLITE_DB_PATH=${escapeEnv(getPrismDbPath())}`,
      "",
      "# Pools",
      `WATCHLIST_POOLS=${escapeEnv(watchlistPools)}`,
    ].join("\n");

    ensurePrismConfigDir();
    const envPath = getPrismEnvPath();
    if (fs.existsSync(envPath)) {
      const backupPath = `${envPath}.backup.${Date.now()}`;
      fs.copyFileSync(envPath, backupPath);
      console.warn(`⚠ Existing .env found. Backup created at: ${backupPath}`);
    }
    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    await pingInstall("setup", { userId: credentials.userId });

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
