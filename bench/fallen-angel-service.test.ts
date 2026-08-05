import { describe, it, expect } from "vitest";
import {
  evaluateFallenAngelGate,
  identifyAssetMint,
  hasDangerRisks,
  type FallenAngelGateConfig,
} from "../engine/fallen-angel-service.js";
import type { GeckoOhlcvSignals } from "../engine/gecko-ohlcv-service.js";
import { parseRugCheckReport } from "../engine/rugcheck-service.js";

const CONFIG: FallenAngelGateConfig = {
  minTvlUsd: 50_000,
  minDrawdownPct: 0.6,
  maxDrawdownPct: 0.95,
  volBaselineMin: 0.02,
  volBaselineMax: 0.35,
  maxRugcheckScore: 60,
  minHolders: 300,
  maxTop10HolderPct: 0.5,
};

// A clean, deeply-drawn-down, calm token.
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
  topHolders: [
    { address: "a", amount: 1, pct: 10, owner: "o", insider: false },
    { address: "b", amount: 1, pct: 8, owner: null, insider: false },
  ],
  rugged: false,
});

describe("evaluateFallenAngelGate", () => {
  it("qualifies a clean, deeply-drawn-down, calm token", () => {
    const r = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: CLEAN_OHLCV,
      rugcheck: CLEAN_RUGCHECK,
      config: CONFIG,
    });
    expect(r.qualified).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it("rejects below the TVL floor", () => {
    const r = evaluateFallenAngelGate({
      poolTvlUsd: 10_000,
      assetMint: "asset",
      ohlcv: CLEAN_OHLCV,
      rugcheck: CLEAN_RUGCHECK,
      config: CONFIG,
    });
    expect(r.qualified).toBe(false);
    expect(r.reasons.join(" ")).toContain("TVL");
  });

  it("rejects when OHLCV is unavailable (fail-closed on drawdown)", () => {
    const r = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: null,
      rugcheck: CLEAN_RUGCHECK,
      config: CONFIG,
    });
    expect(r.qualified).toBe(false);
    expect(r.reasons.join(" ")).toContain("OHLCV");
  });

  it("rejects when RugCheck is unavailable (fail-closed on security)", () => {
    const r = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: CLEAN_OHLCV,
      rugcheck: null,
      config: CONFIG,
    });
    expect(r.qualified).toBe(false);
    expect(r.reasons.join(" ")).toContain("RugCheck");
  });

  it("rejects danger-level risks (mint authority, LP unlocked)", () => {
    const risky = parseRugCheckReport({
      mint: "asset",
      token: { mintAuthority: "MA", freezeAuthority: null },
      tokenMeta: { mutable: false },
      risks: [{ name: "Mint Authority still enabled", level: "danger" }],
      score_normalised: 20,
      totalHolders: 5000,
      topHolders: [],
      rugged: false,
    });
    const r = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: CLEAN_OHLCV,
      rugcheck: risky,
      config: CONFIG,
    });
    expect(r.qualified).toBe(false);
    expect(r.reasons.join(" ")).toContain("danger");
    expect(r.reasons.join(" ")).toContain("mint authority");
  });

  it("rejects high RugCheck risk score (score_normalised > max)", () => {
    const highScore = parseRugCheckReport({
      mint: "asset",
      token: { mintAuthority: null, freezeAuthority: null },
      tokenMeta: { mutable: false },
      risks: [],
      score_normalised: 90,
      totalHolders: 5000,
      topHolders: [],
      rugged: false,
    });
    const r = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: CLEAN_OHLCV,
      rugcheck: highScore,
      config: CONFIG,
    });
    expect(r.qualified).toBe(false);
    expect(r.reasons.join(" ")).toContain("risk score");
  });

  it("rejects insufficient drawdown (not fallen enough)", () => {
    const shallow = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: { ...CLEAN_OHLCV, drawdownFromAth: 0.2 },
      rugcheck: CLEAN_RUGCHECK,
      config: CONFIG,
    });
    expect(shallow.qualified).toBe(false);
    expect(shallow.reasons.join(" ")).toContain("minimum");
  });

  it("rejects an over-drawn token (dead, not fallen)", () => {
    const dead = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: { ...CLEAN_OHLCV, drawdownFromAth: 0.99 },
      rugcheck: CLEAN_RUGCHECK,
      config: CONFIG,
    });
    expect(dead.qualified).toBe(false);
    expect(dead.reasons.join(" ")).toContain("dead token");
  });

  it("rejects a token too dead to mean-revert (vol below floor)", () => {
    const flat = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: { ...CLEAN_OHLCV, dailyReturnStddev: 0.001 },
      rugcheck: CLEAN_RUGCHECK,
      config: CONFIG,
    });
    expect(flat.qualified).toBe(false);
    expect(flat.reasons.join(" ")).toContain("below volatility floor");
  });

  it("rejects a lunatic token (vol above ceiling)", () => {
    const wild = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: { ...CLEAN_OHLCV, dailyReturnStddev: 0.9 },
      rugcheck: CLEAN_RUGCHECK,
      config: CONFIG,
    });
    expect(wild.qualified).toBe(false);
    expect(wild.reasons.join(" ")).toContain("above volatility ceiling");
  });

  it("rejects a concentrated token (top-10 > max)", () => {
    const concentrated = parseRugCheckReport({
      mint: "asset",
      token: { mintAuthority: null, freezeAuthority: null },
      tokenMeta: { mutable: false },
      risks: [],
      score_normalised: 20,
      totalHolders: 5000,
      topHolders: [
        { address: "a", amount: 1, pct: 40, owner: null, insider: false },
        { address: "b", amount: 1, pct: 30, owner: null, insider: false },
      ],
      rugged: false,
    });
    const r = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: CLEAN_OHLCV,
      rugcheck: concentrated,
      config: CONFIG,
    });
    expect(r.qualified).toBe(false);
    expect(r.reasons.join(" ")).toContain("Top-10 holder concentration");
  });

  it("fails open on missing topHolders (concentration not enforced)", () => {
    const noHolders = parseRugCheckReport({
      mint: "asset",
      token: { mintAuthority: null, freezeAuthority: null },
      tokenMeta: { mutable: false },
      risks: [],
      score_normalised: 20,
      totalHolders: 5000,
      topHolders: null,
      rugged: false,
    });
    const r = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: CLEAN_OHLCV,
      rugcheck: noHolders,
      config: CONFIG,
    });
    expect(r.qualified).toBe(true);
  });

  it("rejects a token with too few holders", () => {
    const few = parseRugCheckReport({
      mint: "asset",
      token: { mintAuthority: null, freezeAuthority: null },
      tokenMeta: { mutable: false },
      risks: [],
      score_normalised: 20,
      totalHolders: 50,
      topHolders: [],
      rugged: false,
    });
    const r = evaluateFallenAngelGate({
      poolTvlUsd: 100_000,
      assetMint: "asset",
      ohlcv: CLEAN_OHLCV,
      rugcheck: few,
      config: CONFIG,
    });
    expect(r.qualified).toBe(false);
    expect(r.reasons.join(" ")).toContain("below minimum");
  });
});

describe("identifyAssetMint", () => {
  const stables = new Set(["USDC", "USDT"]);
  const SOL = "So11111111111111111111111111111111111111112";

  it("picks the non-stablecoin, non-SOL leg", () => {
    expect(identifyAssetMint(SOL, "USDC", stables, SOL)).toBeNull(); // SOL+stable → no asset
    expect(identifyAssetMint("USDC", "JUP", stables, SOL)).toBe("JUP");
  });

  it("treats SOL as a settlement leg, never the asset", () => {
    // SOL/JUP with a stable allowlist: SOL is excluded → JUP is the asset.
    expect(identifyAssetMint(SOL, "JUP", stables, SOL)).toBe("JUP");
    expect(identifyAssetMint("JUP", SOL, stables, SOL)).toBe("JUP");
  });

  it("returns null for a stablecoin pair (no asset leg)", () => {
    expect(identifyAssetMint("USDC", "USDT", stables, SOL)).toBeNull();
  });

  it("returns null when the allowlist is empty (no notion of stable)", () => {
    expect(identifyAssetMint("USDC", "USDT", undefined, SOL)).toBeNull();
  });
});

describe("hasDangerRisks", () => {
  it("detects danger-level risks", () => {
    const r = parseRugCheckReport({
      mint: "x",
      token: { mintAuthority: null, freezeAuthority: null },
      tokenMeta: { mutable: false },
      risks: [{ name: "LP Unlocked", level: "danger" }],
      score_normalised: 20,
      totalHolders: 100,
      topHolders: [],
      rugged: false,
    })!;
    expect(hasDangerRisks(r)).toBe(true);
  });

  it("returns false for warn-only or no risks", () => {
    const r = parseRugCheckReport({
      mint: "x",
      token: { mintAuthority: null, freezeAuthority: null },
      tokenMeta: { mutable: false },
      risks: [{ name: "Mutable metadata", level: "warn" }],
      score_normalised: 20,
      totalHolders: 100,
      topHolders: [],
      rugged: false,
    })!;
    expect(hasDangerRisks(r)).toBe(false);
  });
});
