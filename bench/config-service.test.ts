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
