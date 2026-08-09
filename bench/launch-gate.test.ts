/** Launch-gate unit tests: hot-young admission, fail-closed rejections,
 * fee-yield ranking. */
import { describe, it, expect } from "vitest";
import {
  gateAndRankLaunchPools,
  summarizeLaunchRejections,
  type LaunchGateConfig,
  type LaunchGateResult,
  type LaunchPoolRank,
} from "../engine/launch-gate.js";
import type { DiscoveredPool } from "../engine/services.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

const NOW = 1_800_000_000_000;

function makePool(overrides: Partial<DiscoveredPool> & { address: string }): DiscoveredPool {
  const { address, ...rest } = overrides;
  return {
    address,
    tvlUsd: 100_000,
    volume24hUsd: 800_000,
    fees24hUsd: 1_500,
    apr: 2.5,
    binStep: 100,
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
    createdAtMs: NOW - 60 * 60_000, // 1h old
    volume1hUsd: 300_000,
    fees1hUsd: 6_000,
    feeYield1hPct: 12,
    baseFeePct: 2.5,
    ...rest,
  };
}

const config: LaunchGateConfig = {
  minTvlUsd: 5_000,
  maxTvlUsd: 1_000_000,
  maxAgeHours: 6,
  minVolume1hUsd: 50_000,
  minBaseFeePct: 1,
  minBinStep: 50,
  maxBinStep: 200,
  maxVolumeTurnover: 50,
  minHolders: 1000,
  stablecoinMints: new Set([USDC, USDT]),
  now: NOW,
};

function rejectedFor(result: LaunchGateResult, address: string): string[] {
  const reasons: string[] = [];
  for (const r of result.rejected) {
    if (r.address === address) reasons.push(r.reason);
  }
  return reasons;
}

describe("gateAndRankLaunchPools", () => {
  it("admits a hot young pool and reports its rank fields", () => {
    const result = gateAndRankLaunchPools([makePool({ address: "p1" })], config);
    expect(result.ranked).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    const rank = result.ranked[0]!;
    expect(rank.feeYield1hPct).toBe(12);
    expect(rank.volume1hUsd).toBe(300_000);
    expect(rank.score).toBe(12);
    expect(rank.notes.join(" ")).toContain("age");
  });

  it("rejects a pool older than maxAgeHours", () => {
    const result = gateAndRankLaunchPools(
      [makePool({ address: "old", createdAtMs: NOW - 7 * 60 * 60_000 })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "old")[0]).toContain("age");
  });

  it("rejects a pool with missing createdAt", () => {
    const { createdAtMs: _omit, ...noCreatedAt } = makePool({ address: "nocreated" });
    const result = gateAndRankLaunchPools([noCreatedAt], config);
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "nocreated")[0]).toContain("createdAt");
  });

  it("rejects a pool below min TVL", () => {
    const result = gateAndRankLaunchPools([makePool({ address: "lowtvl", tvlUsd: 1_000 })], config);
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "lowtvl")[0]).toContain("tvl");
  });

  it("rejects a pool above max TVL (established, not a launch)", () => {
    const result = gateAndRankLaunchPools(
      [makePool({ address: "hightvl", tvlUsd: 2_000_000 })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "hightvl")[0]).toContain("tvl");
  });

  it("rejects a pool with low 1h volume", () => {
    const result = gateAndRankLaunchPools(
      [makePool({ address: "lowvol", volume1hUsd: 10_000 })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "lowvol")[0]).toContain("1h volume");
  });

  it("rejects a pool with low base fee", () => {
    const result = gateAndRankLaunchPools(
      [makePool({ address: "lowfee", baseFeePct: 0.5 })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "lowfee")[0]).toContain("base fee");
  });

  it("rejects a pool with missing 1h fee yield (hotness is the point)", () => {
    const { feeYield1hPct: _omit, ...noYield } = makePool({ address: "noyield" });
    const result = gateAndRankLaunchPools([noYield], config);
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "noyield")[0]).toContain("fee yield");
  });

  it("rejects binStep outside the band (both sides)", () => {
    const fine = makePool({ address: "fine", binStep: 10 });
    const wide = makePool({ address: "wide", binStep: 300 });
    const result = gateAndRankLaunchPools([fine, wide], config);
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "fine")[0]).toContain("binStep");
    expect(rejectedFor(result, "wide")[0]).toContain("binStep");
  });

  it("rejects wash turnover (24h volume/TVL above the ceiling)", () => {
    // 100_000_000 / 100_000 = 1000 > 50
    const result = gateAndRankLaunchPools(
      [makePool({ address: "wash", volume24hUsd: 100_000_000 })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "wash")[0]).toContain("wash");
  });

  it("rejects a risky (unverified, low-holder) token leg", () => {
    const result = gateAndRankLaunchPools(
      [
        makePool({
          address: "risky",
          tokenY: "Risky111111111111111111111111111111111111111",
          tokenYSymbol: "RUG",
          tokenYVerified: false,
          tokenYFreezeDisabled: false,
          tokenYHolders: 10,
        }),
      ],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(rejectedFor(result, "risky")[0]).toContain("token safety");
  });

  it("ranks admitted pools by 1h fee yield, highest first", () => {
    const low = makePool({ address: "low", feeYield1hPct: 5 });
    const hot = makePool({ address: "hot", feeYield1hPct: 20 });
    const mid = makePool({ address: "mid", feeYield1hPct: 12 });
    const result = gateAndRankLaunchPools([low, hot, mid], config);
    const rankedAddresses = result.ranked.map((r: LaunchPoolRank) => r.pool.address);
    expect(rankedAddresses).toEqual(["hot", "mid", "low"]);
    expect(result.rejected).toHaveLength(0);
  });
});

describe("summarizeLaunchRejections", () => {
  it("groups by stable category and keeps one example reason per bucket", () => {
    const summary = summarizeLaunchRejections([
      { category: "age", reason: "age 5.9h > 6h" },
      { category: "age", reason: "age 40h > 6h" },
      { category: "tvl", reason: "tvl 200000 > 1000000 (established, not a launch)" },
      { category: "age", reason: "age 7.2h > 6h" },
    ]);
    expect(summary[0]!.category).toBe("age");
    expect(summary[0]!.count).toBe(3);
    expect(summary[0]!.example).toBe("age 5.9h > 6h");
    expect(summary[1]!.category).toBe("tvl");
    expect(summary[1]!.count).toBe(1);
    expect(summary).toHaveLength(2);
  });

  it("returns empty for an empty rejection list", () => {
    expect(summarizeLaunchRejections([])).toEqual([]);
  });

  it("clamps topN to at least one", () => {
    const summary = summarizeLaunchRejections(
      [{ category: "age", reason: "a" }, { category: "tvl", reason: "b" }],
      0,
    );
    expect(summary).toHaveLength(1);
  });
});
