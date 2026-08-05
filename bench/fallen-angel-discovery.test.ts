import { describe, it, expect } from "vitest";
import {
  evaluateFallenAngelDiscovery,
  type FallenAngelDiscoveredPool,
  type FallenAngelPoolSignals,
} from "../engine/fallen-angel-discovery.js";
import { parseRugCheckReport } from "../engine/rugcheck-service.js";
import type { GeckoOhlcvSignals } from "../engine/gecko-ohlcv-service.js";

const CONFIG = {
  minTvlUsd: 50_000,
  minDrawdownPct: 0.6,
  maxDrawdownPct: 0.95,
  volBaselineMin: 0.02,
  volBaselineMax: 0.35,
  maxRugcheckScore: 60,
  minHolders: 300,
  maxTop10HolderPct: 0.5,
};

const STABLES = new Set(["USDC", "USDT"]);
const SOL = "So11111111111111111111111111111111111111112";

const CLEAN_OHLCV: GeckoOhlcvSignals = {
  bars: [],
  atlHigh: 10,
  latestClose: 2,
  drawdownFromAth: 0.8,
  dailyReturnStddev: 0.05,
  totalVolumeQuote: 1_000_000,
  barCount: 30,
};

const CLEAN_RUGCHECK = parseRugCheckReport({
  mint: "asset",
  token: { mintAuthority: null, freezeAuthority: null },
  tokenMeta: { mutable: false },
  risks: [{ name: "Mutable metadata", level: "warn" }],
  score_normalised: 20,
  totalHolders: 5000,
  topHolders: [{ address: "a", amount: 1, pct: 10, owner: null, insider: false }],
  rugged: false,
});

const RISKY_RUGCHECK = parseRugCheckReport({
  mint: "asset",
  token: { mintAuthority: "MA", freezeAuthority: null },
  tokenMeta: { mutable: false },
  risks: [{ name: "Mint Authority still enabled", level: "danger" }],
  score_normalised: 20,
  totalHolders: 5000,
  topHolders: [],
  rugged: false,
});

function pool(overrides: Partial<FallenAngelDiscoveredPool> = {}): FallenAngelDiscoveredPool {
  return {
    address: overrides.address ?? "Pool111111111111111111111111111111111111111",
    tvlUsd: overrides.tvlUsd ?? 100_000,
    tokenX: overrides.tokenX ?? "ASSET",
    tokenY: overrides.tokenY ?? "USDC",
  };
}

function signals(overrides: Partial<FallenAngelPoolSignals> = {}): FallenAngelPoolSignals {
  return {
    ohlcv: overrides.ohlcv ?? CLEAN_OHLCV,
    rugcheck: overrides.rugcheck ?? CLEAN_RUGCHECK,
  };
}

describe("evaluateFallenAngelDiscovery", () => {
  it("qualifies a clean fallen-angel pool", async () => {
    const result = await evaluateFallenAngelDiscovery([pool()], CONFIG, STABLES, SOL, async () =>
      signals(),
    );
    expect(result.qualified).toHaveLength(1);
    expect(result.qualified[0]!.poolAddress).toBe("Pool111111111111111111111111111111111111111");
    expect(result.qualified[0]!.assetMint).toBe("ASSET");
    expect(result.qualified[0]!.drawdownPct).toBeCloseTo(0.8, 6);
    expect(result.rejected).toHaveLength(0);
  });

  it("skips pools below the TVL floor without rejecting them", async () => {
    let fetched = 0;
    const result = await evaluateFallenAngelDiscovery(
      [pool({ tvlUsd: 10_000 })],
      CONFIG,
      STABLES,
      SOL,
      async () => {
        fetched++;
        return signals();
      },
    );
    expect(result.qualified).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(fetched).toBe(0); // never fetched — out of universe
  });

  it("rejects a pool with danger risks and records the reason", async () => {
    const result = await evaluateFallenAngelDiscovery([pool()], CONFIG, STABLES, SOL, async () =>
      signals({ rugcheck: RISKY_RUGCHECK }),
    );
    expect(result.qualified).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("danger");
  });

  it("rejects a stablecoin pair (no asset leg)", async () => {
    const result = await evaluateFallenAngelDiscovery(
      [pool({ tokenX: "USDC", tokenY: "USDT" })],
      CONFIG,
      STABLES,
      SOL,
      async () => signals(),
    );
    expect(result.qualified).toHaveLength(0);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("asset leg");
  });

  it("rejects when signals are unavailable (fail-closed)", async () => {
    const result = await evaluateFallenAngelDiscovery([pool()], CONFIG, STABLES, SOL, async () => ({
      ohlcv: null,
      rugcheck: null,
    }));
    expect(result.qualified).toHaveLength(0);
    expect(result.rejected[0]!.reasons.join(" ")).toContain("OHLCV");
    expect(result.rejected[0]!.reasons.join(" ")).toContain("RugCheck");
  });

  it("fetches signals only for pools that clear the TVL floor", async () => {
    const fetched = new Set<string>();
    const result = await evaluateFallenAngelDiscovery(
      [pool({ address: "a", tvlUsd: 10_000 }), pool({ address: "b" })],
      CONFIG,
      STABLES,
      SOL,
      async (p) => {
        fetched.add(p.address);
        return signals();
      },
    );
    expect(fetched.has("a")).toBe(false);
    expect(fetched.has("b")).toBe(true);
    expect(result.qualified.map((q) => q.poolAddress)).toEqual(["b"]);
  });
});
