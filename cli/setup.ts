import { Command } from "commander";
import * as p from "@clack/prompts";
import fs from "fs";
import { pingInstall, requireRegistered, type PrismCredentials } from "./api.js";
import { ensurePrismConfigDir, getPrismEnvPath, getPrismDbPath } from "../engine/paths.js";
import { mergeEnvContent } from "./env-merge.js";

/** Parsed flags of the setup command (commander supplies the option bag). */
interface SetupOptions {
  nonInteractive?: boolean;
  heliusKey?: string;
  rpcUrl?: string;
  rpcFallbackUrl?: string;
  jupiterApiKey?: string;
  walletKeyFile?: string;
  watchlist?: string;
  paperTrading?: boolean;
}

/** Values collected from either the flag path or the interactive wizard. */
interface SetupAnswers {
  heliusKey: string;
  walletKey: string;
  watchlistPools: string;
  paperTrading: boolean;
  rpcUrl: string;
  rpcFallbackUrl: string;
  jupiterApiKey: string;
}

function escapeEnv(value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    throw new Error("Environment values cannot contain newlines");
  }
  return value;
}

/** Wallet key from the keypair file if provided, otherwise from env (untrimmed). */
function readWalletKey(options: SetupOptions): string {
  if (!options.walletKeyFile) {
    return process.env.WALLET_PRIVATE_KEY || "";
  }
  try {
    return fs.readFileSync(options.walletKeyFile, "utf-8").trim();
  } catch {
    console.error(`Error: Could not read wallet key file: ${options.walletKeyFile}`);
    process.exit(1);
  }
}

function loadNonInteractiveAnswers(options: SetupOptions): SetupAnswers {
  const configuredHeliusKey = options.heliusKey || process.env.HELIUS_API_KEY || "";
  let rpcUrl = options.rpcUrl || process.env.SOLANA_RPC_URL || "";
  if (!rpcUrl && configuredHeliusKey) {
    rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${configuredHeliusKey}`;
  }
  if (!rpcUrl) {
    console.error("Error: provide --rpc-url or --helius-key in non-interactive mode");
    process.exit(1);
  }
  const paperTrading = options.paperTrading !== false;
  const walletKey = readWalletKey(options);

  // Validate: live trading requires wallet key
  if (!paperTrading && !walletKey.trim()) {
    console.error("Error: Wallet private key is required when paper trading is disabled.");
    console.error("Provide via --wallet-key-file or WALLET_PRIVATE_KEY env var.");
    process.exit(1);
  }

  return {
    heliusKey: configuredHeliusKey,
    walletKey,
    watchlistPools: options.watchlist || "",
    paperTrading,
    rpcUrl,
    rpcFallbackUrl: options.rpcFallbackUrl || process.env.SOLANA_RPC_FALLBACK_URL || "",
    jupiterApiKey: options.jupiterApiKey || process.env.JUPITER_API_KEY || "",
  };
}

async function promptInteractiveSetup(): Promise<SetupAnswers> {
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

  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  const heliusKey = (answers.heliusKey as string) || "";
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  let rpcUrl = (answers.rpcUrl as string) || "";
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  const rpcFallbackUrl = (answers.rpcFallbackUrl as string) || "";
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  const jupiterApiKey = (answers.jupiterApiKey as string) || "";
  if (!rpcUrl.trim() && heliusKey.trim()) {
    rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  }
  if (!rpcUrl.trim()) {
    p.cancel("A primary RPC URL or Helius API key is required.");
    process.exit(1);
  }
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  const walletKey = (answers.walletKey as string) || "";
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  const watchlistPools = (answers.watchlistPools as string) || "";
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  const paperTrading = answers.paperTrading as boolean;

  // Validate: live trading requires wallet key
  if (!paperTrading && !walletKey.trim()) {
    p.cancel("Wallet private key is required when paper trading is disabled.");
    process.exit(1);
  }

  return {
    heliusKey,
    walletKey,
    watchlistPools,
    paperTrading,
    rpcUrl,
    rpcFallbackUrl,
    jupiterApiKey,
  };
}

function buildEnvContent(answers: SetupAnswers): string {
  return [
    "# RPC providers",
    `HELIUS_API_KEY=${escapeEnv(answers.heliusKey)}`,
    `SOLANA_RPC_URL=${escapeEnv(answers.rpcUrl)}`,
    `SOLANA_RPC_FALLBACK_URL=${escapeEnv(answers.rpcFallbackUrl)}`,
    `JUPITER_API_KEY=${escapeEnv(answers.jupiterApiKey)}`,
    "",
    "# Wallet (optional — leave empty for paper trading)",
    `WALLET_PRIVATE_KEY=${escapeEnv(answers.walletKey)}`,
    "",
    "# Trading mode",
    `PAPER_TRADING=${String(answers.paperTrading)}`,
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
    `WATCHLIST_POOLS=${escapeEnv(answers.watchlistPools)}`,
  ].join("\n");
}

function writeEnvFile(envContent: string): void {
  ensurePrismConfigDir();
  const envPath = getPrismEnvPath();
  const existingEnv = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : null;
  if (existingEnv !== null) {
    const backupPath = `${envPath}.backup.${Date.now()}`;
    // Backup may contain WALLET_PRIVATE_KEY: write with 0o600 and never
    // clobber an existing destination (exclusive create).
    fs.writeFileSync(backupPath, existingEnv, { mode: 0o600, flag: "wx" });
    console.warn(`⚠ Existing .env found. Backup created at: ${backupPath}`);
  }
  // MERGE, never replace: unknown user keys (WATCHLIST_POOLS, MARKET_SCAN_*,
  // AGENTIC_MODE, custom comments) survive a re-run; managed keys get the
  // fresh wizard values; new defaults are appended. An empty wizard value
  // never wipes a non-empty existing value.
  const mergedEnv = existingEnv === null ? envContent : mergeEnvContent(existingEnv, envContent);
  fs.writeFileSync(envPath, mergedEnv, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}

function printSetupComplete(isNonInteractive: boolean): void {
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
}

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

    const answers = isNonInteractive
      ? loadNonInteractiveAnswers(options)
      : await promptInteractiveSetup();

    writeEnvFile(buildEnvContent(answers));
    await pingInstall("setup", { userId: credentials.userId });
    printSetupComplete(isNonInteractive);
  });
