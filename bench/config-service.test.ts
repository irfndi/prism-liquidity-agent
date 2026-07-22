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
