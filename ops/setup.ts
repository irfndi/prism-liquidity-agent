import * as p from "@clack/prompts";
import fs from "fs";
import path from "path";

const isDirectSetupExecution =
  typeof Bun !== "undefined" &&
  (Bun.main?.endsWith("ops/setup.ts") || Bun.main?.endsWith("ops/setup.js"));

if (isDirectSetupExecution && process.env.PRISM_ALLOW_DIRECT !== "true") {
  console.error("Error: Direct setup execution is not allowed.");
  console.error('Use "prism setup" instead.');
  process.exit(1);
}

async function main() {
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
          message: "Jupiter API key (optional)",
          placeholder: "leave blank to use public fallback",
          initialValue: process.env.JUPITER_API_KEY ?? "",
        }),

      paperTrading: () =>
        p.confirm({
          message: "Enable paper trading mode (recommended for first run)?",
          initialValue: true,
        }),

      minTvl: () =>
        p.text({
          message: "Minimum pool TVL in USD",
          placeholder: "50000",
          initialValue: "50000",
          validate: (v) => (isNaN(Number(v)) ? "Must be a number" : undefined),
        }),

      watchlistPools: () =>
        p.text({
          message: "Comma-separated pool addresses to watch (leave blank to add later)",
          placeholder: "ABC123...,DEF456...",
          initialValue: "",
        }),
    },
    {
      onCancel: () => {
        p.cancel("Setup cancelled.");
        process.exit(0);
      },
    },
  );

  const heliusKey = (answers.heliusKey as string) || "";
  const rpcUrl =
    (answers.rpcUrl as string) ||
    (heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : "");
  if (!rpcUrl.trim()) {
    throw new Error("A primary RPC URL or Helius API key is required");
  }

  const envContent = [
    "# RPC providers",
    `HELIUS_API_KEY=${heliusKey}`,
    `SOLANA_RPC_URL=${rpcUrl}`,
    `SOLANA_RPC_FALLBACK_URL=${(answers.rpcFallbackUrl as string) || ""}`,
    `JUPITER_API_KEY=${(answers.jupiterApiKey as string) || ""}`,
    "",
    "# Strategy",
    `PAPER_TRADING=${String(answers.paperTrading)}`,
    "SCAN_INTERVAL_MS=600000",
    `MIN_POOL_TVL_USD=${answers.minTvl as string}`,
    "MIN_FEE_IL_RATIO=1.2",
    "TVL_DROP_EXIT_PCT=0.30",
    "VOLUME_AUTH_THRESHOLD=0.70",
    "MAX_OPEN_POSITIONS=3",
    "CONFIDENCE_THRESHOLD=0.65",
    "TRAILING_STOP_PCT=0.10",
    "",
    "# SQLite",
    "SQLITE_DB_PATH=./prism.db",
    "",
    "# Pools to watch (required for live trading; discovery is paper-only and opt-in)",
    `WATCHLIST_POOLS=${answers.watchlistPools as string}`,
    "ENABLE_POOL_DISCOVERY=false",
    "DISCOVERY_MIN_TVL_USD=1000000",
    "DISCOVERY_MIN_FEE_RATIO=1.5",
  ].join("\n");

  const envPath = path.resolve(".env");
  fs.writeFileSync(envPath, envContent, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);

  p.note(
    [
      "✓ .env created",
      "",
      "Next steps:",
      "  1. Run agent:     bun run dev",
      "  2. Run backtest:  bun run backtest",
    ].join("\n"),
    "Setup complete",
  );

  p.outro("Happy rebalancing!");
}

main().catch(console.error);
