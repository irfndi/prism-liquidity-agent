import { describe, it, expect, vi, afterEach } from "vitest";
import { Effect } from "effect";
import { ConfigService, ConfigLive } from "../engine/config-service.js";

async function loadConfig() {
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* ConfigService;
      }),
      ConfigLive,
      { local: true },
    ),
  );
}

describe("ConfigService upper-bound clamping", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("clamps SOL_PRICE_USD above 10000", async () => {
    vi.stubEnv("SOL_PRICE_USD", "50000");
    const cfg = await loadConfig();
    expect(cfg.solPriceUsd).toBe(10_000);
  });

  it("clamps MAX_PER_POOL_ALLOCATION_PCT above 1.0", async () => {
    vi.stubEnv("MAX_PER_POOL_ALLOCATION_PCT", "5.0");
    const cfg = await loadConfig();
    expect(cfg.maxPerPoolAllocationPct).toBe(1.0);
  });

  it("preserves in-range values", async () => {
    vi.stubEnv("SOL_PRICE_USD", "200");
    vi.stubEnv("MAX_PER_POOL_ALLOCATION_PCT", "0.5");
    const cfg = await loadConfig();
    expect(cfg.solPriceUsd).toBe(200);
    expect(cfg.maxPerPoolAllocationPct).toBe(0.5);
  });

  it("clamps values below the minimum instead of accepting an unsafe range", async () => {
    vi.stubEnv("PAPER_PORTFOLIO_USD", "-1");
    const cfg = await loadConfig();
    expect(cfg.paperPortfolioUsd).toBe(1);
  });

  it("rejects invalid watchlist public keys with an actionable config error", async () => {
    vi.stubEnv("WATCHLIST_POOLS", "not-a-public-key");
    await expect(loadConfig()).rejects.toThrow("WATCHLIST_POOLS");
  });
});

describe("ConfigService ENTRY_STRATEGY_TYPE", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to spot when unset", async () => {
    const cfg = await loadConfig();
    expect(cfg.entryStrategyType).toBe("spot");
  });

  it.each(["spot", "curve", "bidask", "auto"] as const)("accepts %s", async (value) => {
    vi.stubEnv("ENTRY_STRATEGY_TYPE", value);
    const cfg = await loadConfig();
    expect(cfg.entryStrategyType).toBe(value);
  });

  it("falls back to spot for invalid values", async () => {
    vi.stubEnv("ENTRY_STRATEGY_TYPE", "spiral");
    const cfg = await loadConfig();
    expect(cfg.entryStrategyType).toBe("spot");
  });

  it("falls back to spot for case-mismatched values", async () => {
    vi.stubEnv("ENTRY_STRATEGY_TYPE", "Curve");
    const cfg = await loadConfig();
    expect(cfg.entryStrategyType).toBe("spot");
  });
});

describe("ConfigService STABLECOIN_MINTS", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the three verified stablecoin mints when unset", async () => {
    const cfg = await loadConfig();
    expect(cfg.stablecoinMints).toEqual(
      new Set([
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
        "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      ]),
    );
  });

  it("yields an empty set when explicitly disabled with an empty string", async () => {
    vi.stubEnv("STABLECOIN_MINTS", "");
    const cfg = await loadConfig();
    expect(cfg.stablecoinMints).toEqual(new Set());
  });

  it("rejects invalid stablecoin mints with an actionable config error", async () => {
    vi.stubEnv("STABLECOIN_MINTS", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v,not-a-public-key");
    await expect(loadConfig()).rejects.toThrow("STABLECOIN_MINTS");
  });
});

describe("ConfigService freeze screening + IL protection flags", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults FREEZE_SMART_SCREENING to false", async () => {
    const cfg = await loadConfig();
    expect(cfg.freezeSmartScreening).toBe(false);
  });

  it("honours FREEZE_SMART_SCREENING=true", async () => {
    vi.stubEnv("FREEZE_SMART_SCREENING", "true");
    const cfg = await loadConfig();
    expect(cfg.freezeSmartScreening).toBe(true);
  });

  it("defaults IL_PROTECTION_ENABLED to true", async () => {
    const cfg = await loadConfig();
    expect(cfg.ilProtectionEnabled).toBe(true);
  });

  it("honours IL_PROTECTION_ENABLED=false", async () => {
    vi.stubEnv("IL_PROTECTION_ENABLED", "false");
    const cfg = await loadConfig();
    expect(cfg.ilProtectionEnabled).toBe(false);
  });

  it("defaults IL_DOMINANCE_EXIT_FACTOR to 2 and clamps below the minimum of 1", async () => {
    const cfg = await loadConfig();
    expect(cfg.ilDominanceExitFactor).toBe(2);

    vi.stubEnv("IL_DOMINANCE_EXIT_FACTOR", "0.5");
    const clamped = await loadConfig();
    expect(clamped.ilDominanceExitFactor).toBe(1);
  });

  it("defaults IL_DOMINANCE_MIN_USD to 5 and clamps below the minimum of 0", async () => {
    const cfg = await loadConfig();
    expect(cfg.ilDominanceMinUsd).toBe(5);

    vi.stubEnv("IL_DOMINANCE_MIN_USD", "-3");
    const clamped = await loadConfig();
    expect(clamped.ilDominanceMinUsd).toBe(0);
  });

  it("defaults DUST_EXIT_USD to 5 and clamps below the minimum of 0 (0 disables)", async () => {
    const cfg = await loadConfig();
    expect(cfg.dustExitUsd).toBe(5);

    vi.stubEnv("DUST_EXIT_USD", "-1");
    const clamped = await loadConfig();
    expect(clamped.dustExitUsd).toBe(0);
  });

  it("parses the market-scan block with sane defaults and clamps", async () => {
    const cfg = await loadConfig();
    expect(cfg.marketScanEnabled).toBe(false);
    expect(cfg.marketScanRefreshIntervalMs).toBe(1_800_000);
    expect(cfg.marketScanUniversePages).toBe(3);
    expect(cfg.marketScanMinTvlUsd).toBe(250_000);
    expect(cfg.marketScanMinFeeApr).toBe(25);
    expect(cfg.marketScanTopK).toBe(30);
    expect(cfg.marketScanMaxPools).toBe(60);
    expect(cfg.marketScanMinHolders).toBe(1000);
    expect(cfg.marketScanMinBinStep).toBe(2);
    expect(cfg.marketScanMaxBinStep).toBe(200);

    vi.stubEnv("MARKET_SCAN_ENABLED", "true");
    vi.stubEnv("MARKET_SCAN_TOP_K", "5");
    vi.stubEnv("MARKET_SCAN_MIN_BIN_STEP", "10");
    vi.stubEnv("MARKET_SCAN_REFRESH_INTERVAL_MS", "30000"); // below min 60s -> clamp
    const overridden = await loadConfig();
    expect(overridden.marketScanEnabled).toBe(true);
    expect(overridden.marketScanTopK).toBe(5);
    expect(overridden.marketScanMinBinStep).toBe(10);
    expect(overridden.marketScanRefreshIntervalMs).toBe(60_000);
  });
});

describe("ConfigService fee-density cooldown floor guards", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the default floor (1 h) below the default static cooldown (4 h)", async () => {
    const cfg = await loadConfig();
    expect(cfg.feeDensityCooldownMinMs).toBe(3_600_000);
    expect(cfg.oorCooldownMs).toBe(14_400_000);
  });

  it("clamps the default floor under a static cooldown lowered below it", async () => {
    // Operator lowers OOR_COOLDOWN_MS under the 1 h default floor without
    // touching FEE_DENSITY_COOLDOWN_MIN_MS; OOR_COOLDOWN_MS stays untouched.
    vi.stubEnv("OOR_COOLDOWN_MS", "1800000");
    const cfg = await loadConfig();
    expect(cfg.oorCooldownMs).toBe(1_800_000);
    expect(cfg.feeDensityCooldownMinMs).toBe(1_799_999);
  });

  it("clamps a floor that equals the static cooldown", async () => {
    vi.stubEnv("OOR_COOLDOWN_MS", "3600000"); // floor default == static
    const cfg = await loadConfig();
    expect(cfg.feeDensityCooldownMinMs).toBe(3_599_999);
  });

  it("clamps an explicit floor above the static cooldown", async () => {
    vi.stubEnv("OOR_COOLDOWN_MS", "3600000");
    vi.stubEnv("FEE_DENSITY_COOLDOWN_MIN_MS", "7200000");
    const cfg = await loadConfig();
    expect(cfg.feeDensityCooldownMinMs).toBe(3_599_999);
  });

  it("preserves an in-range floor untouched", async () => {
    vi.stubEnv("OOR_COOLDOWN_MS", "7200000");
    vi.stubEnv("FEE_DENSITY_COOLDOWN_MIN_MS", "1800000");
    const cfg = await loadConfig();
    expect(cfg.feeDensityCooldownMinMs).toBe(1_800_000);
  });
});

describe("ConfigService MAX_SWAP_SLIPPAGE_BPS integer validation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects fractional values with a configuration error naming the variable", async () => {
    // Given: MAX_SWAP_SLIPPAGE_BPS is set to a fractional value
    vi.stubEnv("MAX_SWAP_SLIPPAGE_BPS", "12.5");
    // When: the config is loaded
    // Then: it throws a ConfigError that mentions MAX_SWAP_SLIPPAGE_BPS
    await expect(loadConfig()).rejects.toThrow("MAX_SWAP_SLIPPAGE_BPS");
  });

  it("accepts integer 12 and preserves it before the hard 50 bps cap", async () => {
    // Given: MAX_SWAP_SLIPPAGE_BPS is set to a valid integer
    vi.stubEnv("MAX_SWAP_SLIPPAGE_BPS", "12");
    // When: the config is loaded
    const cfg = await loadConfig();
    // Then: the value is accepted and not clamped by the 50 bps ceiling
    expect(cfg.maxSwapSlippageBps).toBe(12);
  });

  it("clamps values above 50 to the hard adapter cap", async () => {
    // Given: MAX_SWAP_SLIPPAGE_BPS is set above the hard cap
    vi.stubEnv("MAX_SWAP_SLIPPAGE_BPS", "100");
    // When: the config is loaded
    const cfg = await loadConfig();
    // Then: the value is clamped to 50
    expect(cfg.maxSwapSlippageBps).toBe(50);
  });

  it("defaults to 50 when unset", async () => {
    // Given: MAX_SWAP_SLIPPAGE_BPS is not set
    // When: the config is loaded
    const cfg = await loadConfig();
    // Then: it falls back to the default of 50
    expect(cfg.maxSwapSlippageBps).toBe(50);
  });
});

describe("ConfigService agent runtime timeout", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults AGENT_PROMPT_TIMEOUT_MS to 60000 (slow-model first-token latency)", async () => {
    // Explicit removal so a dev/CI export of the var can't silently bypass the
    // default assertion; the shared afterEach(unstubAllEnvs) restores it.
    vi.stubEnv("AGENT_PROMPT_TIMEOUT_MS", undefined);
    const cfg = await loadConfig();
    expect(cfg.agentPromptTimeoutMs).toBe(60_000);
  });

  it("honours AGENT_PROMPT_TIMEOUT_MS and clamps below the minimum of 1000", async () => {
    vi.stubEnv("AGENT_PROMPT_TIMEOUT_MS", "120000");
    const cfg = await loadConfig();
    expect(cfg.agentPromptTimeoutMs).toBe(120_000);

    vi.stubEnv("AGENT_PROMPT_TIMEOUT_MS", "10");
    const clamped = await loadConfig();
    expect(clamped.agentPromptTimeoutMs).toBe(1_000);
  });
});
