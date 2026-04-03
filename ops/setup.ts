import * as p from "@clack/prompts";
import fs from "fs";
import path from "path";

async function main() {
  console.clear();

  p.intro("  Mantis Setup  ");

  const answers = await p.group(
    {
      anthropicKey: () =>
        p.text({
          message: "Anthropic API key",
          placeholder: "sk-ant-...",
          validate: (v) => (v.startsWith("sk-") ? undefined : "Must start with sk-"),
        }),

      heliusKey: () =>
        p.text({
          message: "Helius API key",
          placeholder: "your-helius-api-key",
          validate: (v) => (v.length > 8 ? undefined : "Key too short"),
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

      chromaUrl: () =>
        p.text({
          message: "Chroma vector DB URL",
          placeholder: "http://localhost:8000",
          initialValue: "http://localhost:8000",
        }),

      claudeModel: () =>
        p.select({
          message: "Claude model",
          options: [
            { value: "claude-sonnet-4-5-20251001", label: "Claude Sonnet 4.5 (recommended)" },
            { value: "claude-opus-4-6", label: "Claude Opus 4.6 (more capable, slower)" },
            { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
          ],
        }),
    },
    {
      onCancel: () => {
        p.cancel("Setup cancelled.");
        process.exit(0);
      },
    }
  );

  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${answers.heliusKey as string}`;

  const envContent = [
    "# Required",
    `ANTHROPIC_API_KEY=${answers.anthropicKey as string}`,
    `HELIUS_API_KEY=${answers.heliusKey as string}`,
    `SOLANA_RPC_URL=${rpcUrl}`,
    "",
    "# Strategy",
    `PAPER_TRADING=${String(answers.paperTrading)}`,
    "SCAN_INTERVAL_MS=600000",
    `MIN_POOL_TVL_USD=${answers.minTvl as string}`,
    "MIN_FEE_IL_RATIO=1.2",
    "TVL_DROP_EXIT_PCT=0.30",
    "VOLUME_AUTH_THRESHOLD=0.70",
    "MAX_CONCURRENT_POSITIONS=5",
    "CONFIDENCE_THRESHOLD=0.65",
    "",
    "# Pools to watch",
    `WATCHLIST_POOLS=${answers.watchlistPools as string}`,
    "",
    "# Model",
    `CLAUDE_MODEL=${answers.claudeModel as string}`,
    "",
    "# Memory",
    `CHROMA_URL=${answers.chromaUrl as string}`,
  ].join("\n");

  const envPath = path.resolve(".env");
  fs.writeFileSync(envPath, envContent);

  p.note(
    [
      "✓ .env created",
      "",
      "Next steps:",
      "  1. Start Chroma:  docker-compose up chromadb -d",
      "  2. Run agent:     bun run dev",
      "  3. Run backtest:  bun run backtest",
    ].join("\n"),
    "Setup complete"
  );

  p.outro("Happy rebalancing!");
}

main().catch(console.error);

