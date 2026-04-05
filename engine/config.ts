import { z } from "zod";
import "dotenv/config";

const ConfigSchema = z.object({
  // APIs
  ANTHROPIC_API_KEY: z.string().min(1),
  HELIUS_API_KEY: z.string().min(1),
  SOLANA_RPC_URL: z.string().url(),

  // Strategy
  PAPER_TRADING: z
    .string()
    .transform((v) => v === "true")
    .default("true"),
  SCAN_INTERVAL_MS: z.coerce.number().min(10000).default(600000),
  MIN_POOL_TVL_USD: z.coerce.number().min(0).default(50000),
  MIN_FEE_IL_RATIO: z.coerce.number().min(0).default(1.2),
  TVL_DROP_EXIT_PCT: z.coerce.number().min(0).max(1).default(0.3),
  VOLUME_AUTH_THRESHOLD: z.coerce.number().min(0).max(1).default(0.7),
  MAX_CONCURRENT_POSITIONS: z.coerce.number().min(1).default(5),
  CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.65),
  // Pools with fewer than this fraction of bins holding liquidity tend to be illiquid
  // on one side — rebalancing into them underestimates real slippage.
  MIN_BIN_UTILIZATION: z.coerce.number().min(0).max(1).default(0.30),
  // Hard cap on rebalance range width in bins. Ranges wider than this tie up capital
  // across too many price levels without proportional fee capture.
  MAX_REBALANCE_RANGE_BINS: z.coerce.number().min(10).default(50),

  // Pools
  WATCHLIST_POOLS: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),

  // Model
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-5-20251001"),

  // Memory
  CHROMA_URL: z.string().url().default("http://localhost:8000"),
});

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    console.error("❌ Invalid configuration:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();

