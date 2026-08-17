/** Market-scan gate unit tests: ranking, IL-safety pre-filter, cadence. */
import { describe, it, expect } from "vitest";
import {
  gateAndRankMarketPools,
  marketLegPasses,
  mintAuthorityRejectReason,
  type MarketGateConfig,
} from "../engine/market-gate.js";
import type { DiscoveredPool } from "../engine/services.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

function makePool(overrides: Partial<DiscoveredPool> & { address: string }): DiscoveredPool {
  const { address, ...rest } = overrides;
  return {
    address,
    tvlUsd: 1_000_000,
    volume24hUsd: 500_000,
    fees24hUsd: 1_500,
    apr: 0.55,
    binStep: 20,
    tokenX: SOL,
    tokenY: USDC,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tokenXVerified: true,
    tokenYVerified: true,
    tokenXFreezeDisabled: true,
    tokenYFreezeDisabled: true,
    tokenXHolders: 3_000_000,
    tokenYHolders: 2_000_000,
    ...rest,
  };
}

const config: MarketGateConfig = {
  minTvlUsd: 250_000,
  minFeeApr: 25,
  minVolumeTurnover: 0.02,
  maxVolumeTurnover: 50,
  minHolders: 1000,
  minPoolAgeHours: 0,
  minBinStep: 2,
  maxBinStep: 200,
  stablecoinMints: new Set([USDC, USDT]),
};

describe("gateAndRankMarketPools", () => {
  it("admits a liquid fee-dense verified pool and ranks by fee APR", () => {
    // 1500*365/1M*100 = 54.75% APR
    const result = gateAndRankMarketPools([makePool({ address: "p1" })], config);
    expect(result.ranked).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.ranked[0]!.feeAprPct).toBeCloseTo(54.75, 2);
    expect(result.ranked[0]!.score).toBeGreaterThan(0);
  });

  it("ranks higher-fee-APR pools first", () => {
    const low = makePool({ address: "low", fees24hUsd: 1_000 }); // 36.5% APR
    const high = makePool({ address: "high", fees24hUsd: 3_000 }); // 109.5% APR
    const result = gateAndRankMarketPools([low, high], config);
    expect(result.ranked.map((r) => r.pool.address)).toEqual(["high", "low"]);
  });

  it("rejects below-TVL, fee-less, low-turnover, and wash-turnover pools", () => {
    const cases = [
      makePool({ address: "tiny", tvlUsd: 100_000 }),
      makePool({ address: "nofees", fees24hUsd: 0 }),
      makePool({ address: "slow", volume24hUsd: 1_000 }), // turnover 0.001 < 0.02
      makePool({ address: "wash", volume24hUsd: 100_000_000 }), // turnover 100 > 50
    ];
    const result = gateAndRankMarketPools(cases, config);
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected.map((r) => r.address).sort()).toEqual(
      ["nofees", "slow", "tiny", "wash"].sort(),
    );
  });

  it("rejects ultra-fine and ultra-wide bin steps (churn / dilution)", () => {
    const result = gateAndRankMarketPools(
      [makePool({ address: "fine", binStep: 1 }), makePool({ address: "wide", binStep: 250 })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
  });

  it("rejects an unverified low-holder leg (rug/IL pre-filter)", () => {
    const bad = makePool({
      address: "bad",
      tokenX: "SomeMemecoin11111111111111111111111111111111",
      tokenXSymbol: "MEME",
      tokenXVerified: false,
      tokenXHolders: 50,
      tokenXFreezeDisabled: true,
    });
    const result = gateAndRankMarketPools([bad], config);
    expect(result.ranked).toHaveLength(0);
    // Now caught by the verification-blind hard holder floor (fires earlier
    // than the token-safety pre-filter) — still a valid rug/IL rejection.
    expect(result.rejected[0]!.reason).toMatch(/holders|token safety/);
  });

  it("rejects a freeze-enabled unverified leg", () => {
    const bad = makePool({
      address: "freeze",
      tokenX: "SomeFreezeToken111111111111111111111111111111",
      tokenXSymbol: "FRZ",
      tokenXVerified: false,
      tokenXFreezeDisabled: false,
      tokenXHolders: 50_000,
    });
    const result = gateAndRankMarketPools([bad], config);
    expect(result.ranked).toHaveLength(0);
  });

  it("admits a verified freeze-enabled leg with a real holder base (trust decision)", () => {
    const ok = makePool({
      address: "vfreeze",
      tokenX: "VerifiedFreezeToken111111111111111111111111111",
      tokenXSymbol: "VFRZ",
      tokenXVerified: true,
      tokenXFreezeDisabled: false,
      tokenXHolders: 500_000,
    });
    const result = gateAndRankMarketPools([ok], config);
    expect(result.ranked).toHaveLength(1);
  });

  it("passes stablecoin and SOL legs regardless of metadata", () => {
    expect(
      marketLegPasses(
        { isStableOrSol: true, verified: false, freezeDisabled: false, holders: 0 },
        config.minHolders,
      ),
    ).toBe(true);
    expect(
      marketLegPasses(
        { isStableOrSol: false, verified: true, freezeDisabled: true, holders: 10 },
        config.minHolders,
      ),
    ).toBe(true);
  });

  it("fails open when token metadata is absent (per-pool screen still gates)", () => {
    // Metadata-less pool (legacy mapping) with NON-stable legs so the
    // holder/freeze checks are actually exercised: absent verified /
    // freezeDisabled / holders must be treated as unknown and pass, never
    // coerced to holders=0 and rejected — the per-pool screen still gates
    // ENTER.
    const bare: DiscoveredPool = {
      address: "bare",
      tvlUsd: 1_000_000,
      volume24hUsd: 500_000,
      fees24hUsd: 1_500,
      apr: 0.55,
      binStep: 20,
      tokenX: "BareTokenX1111111111111111111111111111111111",
      tokenY: "BareTokenY1111111111111111111111111111111111",
    };
    const result = gateAndRankMarketPools([bare], config);
    expect(result.ranked).toHaveLength(1);
  });

  it("fails open on an absent holder count (undefined is unknown, not 0)", () => {
    expect(
      marketLegPasses(
        { isStableOrSol: false, verified: false, freezeDisabled: true, holders: undefined },
        config.minHolders,
      ),
    ).toBe(true);
    expect(
      marketLegPasses(
        { isStableOrSol: false, verified: true, freezeDisabled: false, holders: undefined },
        config.minHolders,
      ),
    ).toBe(true);
    // A KNOWN low holder count still fails closed.
    expect(
      marketLegPasses(
        { isStableOrSol: false, verified: false, freezeDisabled: true, holders: 50 },
        config.minHolders,
      ),
    ).toBe(false);
  });
});

describe("rug-prevention: pool age floor", () => {
  it("rejects a brand-new pool younger than the age floor", () => {
    const fresh = makePool({ address: "fresh", createdAtMs: Date.now() - 2 * 3_600_000 });
    const result = gateAndRankMarketPools([fresh], { ...config, minPoolAgeHours: 24 });
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain("2.0h < 24h");
  });

  it("admits a pool older than the age floor", () => {
    const mature = makePool({ address: "mature", createdAtMs: Date.now() - 48 * 3_600_000 });
    const result = gateAndRankMarketPools([mature], { ...config, minPoolAgeHours: 24 });
    expect(result.ranked.map((r) => r.pool.address)).toEqual(["mature"]);
  });

  it("fails open on an unknown age (createdAtMs absent)", () => {
    const unknown = makePool({ address: "unknown" });
    const result = gateAndRankMarketPools([unknown], { ...config, minPoolAgeHours: 24 });
    expect(result.ranked.map((r) => r.pool.address)).toEqual(["unknown"]);
  });
});

describe("rug-prevention: hard holder floor (verification-blind)", () => {
  it("rejects a VERIFIED token with dust holders — the single-cluster rug setup", () => {
    const thin = makePool({
      address: "thin",
      tokenX: "VerifiedThin1111111111111111111111111111111111",
      tokenXSymbol: "VTHIN",
      tokenXVerified: true, // verification does not exempt a dust holder base
      tokenXFreezeDisabled: true,
      tokenXHolders: 50,
    });
    const result = gateAndRankMarketPools([thin], config);
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected[0]!.reason).toContain("below 1000 holders");
  });

  it("passes a stablecoin/SOL leg even with a low holder count", () => {
    const stable = makePool({ address: "stable", tokenXHolders: 10, tokenYHolders: 10 });
    const result = gateAndRankMarketPools([stable], config);
    expect(result.ranked.map((r) => r.pool.address)).toEqual(["stable"]);
  });

  it("fails open on an unknown holder count for the hard floor", () => {
    const bare: DiscoveredPool = {
      address: "bare",
      tvlUsd: 1_000_000,
      volume24hUsd: 500_000,
      fees24hUsd: 1_500,
      apr: 0.55,
      binStep: 20,
      tokenX: "BareTokenX1111111111111111111111111111111111",
      tokenY: "BareTokenY1111111111111111111111111111111111",
    };
    const result = gateAndRankMarketPools([bare], config);
    expect(result.ranked.map((r) => r.pool.address)).toEqual(["bare"]);
  });
});

describe("rug-prevention: mint-authority-renounced gate", () => {
  const STABLES = new Set([USDC, USDT]);
  const MEME = "SomeMemecoin11111111111111111111111111111111";

  it("rejects a non-stable leg with a live (un-renounced) mint authority", () => {
    const reason = mintAuthorityRejectReason(
      [{ symbol: "MEME", mint: MEME, mintAuthority: "dev-pubkey" }],
      STABLES,
      true,
    );
    expect(reason).not.toBeNull();
    expect(reason).toContain("live mint authority");
  });

  it("passes a non-stable leg whose mint authority is renounced (null/undefined)", () => {
    expect(
      mintAuthorityRejectReason(
        [{ symbol: "MEME", mint: MEME, mintAuthority: null }],
        STABLES,
        true,
      ),
    ).toBeNull();
    expect(
      mintAuthorityRejectReason(
        [{ symbol: "MEME", mint: MEME, mintAuthority: undefined }],
        STABLES,
        true,
      ),
    ).toBeNull();
  });

  it("exempts stablecoin and SOL legs even with a mint authority", () => {
    const reason = mintAuthorityRejectReason(
      [
        { symbol: "SOL", mint: SOL, mintAuthority: "sol-authority" },
        { symbol: "USDC", mint: USDC, mintAuthority: "usdc-authority" },
      ],
      STABLES,
      true,
    );
    expect(reason).toBeNull();
  });

  it("disables when requireRenounced is false", () => {
    expect(
      mintAuthorityRejectReason(
        [{ symbol: "MEME", mint: MEME, mintAuthority: "x" }],
        STABLES,
        false,
      ),
    ).toBeNull();
  });
});
