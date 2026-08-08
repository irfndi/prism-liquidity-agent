import { describe, it, expect } from "vitest";
import { parseRugCheckReport, getRugCheckReport } from "../engine/rugcheck-service.js";

// Live-verified payload (2026-08-05, ANTFUN CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt):
// score_normalised 56 = RISKY (higher=riskier); has danger risks + topHolders.
const LIVE_RISKY = {
  mint: "CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt",
  token: { mintAuthority: null, freezeAuthority: null, decimals: 6 },
  tokenMeta: { name: "AntFun", symbol: "ANTFUN", mutable: false },
  topHolders: [
    {
      address: "hA1",
      amount: 1000,
      decimals: 6,
      pct: 31.8,
      uiAmount: 1000,
      owner: "o1",
      insider: false,
    },
    {
      address: "hA2",
      amount: 500,
      decimals: 6,
      pct: 12.0,
      uiAmount: 500,
      owner: "o2",
      insider: null,
    },
    {
      address: "hA3",
      amount: 300,
      decimals: 6,
      pct: 5.0,
      uiAmount: 300,
      owner: null,
      insider: true,
    },
  ],
  risks: [
    {
      name: "Large Amount of LP Unlocked",
      value: "100.00%",
      description:
        "A large amount of LP tokens are unlocked, allowing the owner to remove liquidity at any point.",
      score: 11000,
      level: "danger",
    },
    {
      name: "Mutable metadata",
      value: "Yes",
      description: "The token metadata is mutable.",
      score: 500,
      level: "warn",
    },
  ],
  score: 15218,
  score_normalised: 56,
  rugged: false,
  totalHolders: 1234,
};

// Live-verified payload (2026-08-05, JitoSOL J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn):
// mint authority still enabled → danger; top-10 = 32.5%; normalised 71.
const LIVE_JITO = {
  mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  token: { mintAuthority: "MINT_AUTH_ADDR", freezeAuthority: null },
  tokenMeta: { mutable: true },
  topHolders: [
    { address: "hj1", amount: 1, decimals: 9, pct: 10.0, owner: "oj1", insider: false },
    { address: "hj2", amount: 1, decimals: 9, pct: 9.0, owner: null, insider: false },
    { address: "hj3", amount: 1, decimals: 9, pct: 8.0, owner: null, insider: false },
    { address: "hj4", amount: 1, decimals: 9, pct: 5.5, owner: null, insider: false },
  ],
  risks: [
    {
      name: "Mint Authority still enabled",
      value: "Yes",
      description: "The mint authority is still set.",
      score: 20000,
      level: "danger",
    },
  ],
  score: 50101,
  score_normalised: 71,
  rugged: false,
  totalHolders: 549967,
};

describe("parseRugCheckReport", () => {
  it("parses the live-verified risky payload", () => {
    const r = parseRugCheckReport(LIVE_RISKY);
    expect(r).not.toBeNull();
    expect(r!.mint).toBe("CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt");
    expect(r!.scoreNormalised).toBe(56);
    expect(r!.rugged).toBe(false);
    expect(r!.mintAuthority).toBeNull();
    expect(r!.freezeAuthority).toBeNull();
    expect(r!.tokenMetaMutable).toBe(false);
    expect(r!.totalHolders).toBe(1234);
    expect(r!.dangerRiskCount).toBe(1);
    expect(r!.risks.map((x) => x.level)).toEqual(["danger", "warn"]);
  });

  it("computes top-10 holder concentration", () => {
    const r = parseRugCheckReport(LIVE_RISKY)!;
    expect(r.top10HolderPct).toBeCloseTo(31.8 + 12.0 + 5.0, 6);
    expect(r.topHolders.length).toBe(3);
  });

  it("parses a mint-authority-enabled report", () => {
    const r = parseRugCheckReport(LIVE_JITO)!;
    expect(r.mintAuthority).toBe("MINT_AUTH_ADDR");
    expect(r.dangerRiskCount).toBe(1);
    expect(r.top10HolderPct).toBeCloseTo(32.5, 6);
    expect(r.scoreNormalised).toBe(71);
  });

  it("returns null for non-object / mint-less payloads", () => {
    expect(parseRugCheckReport(null)).toBeNull();
    expect(parseRugCheckReport({})).toBeNull();
    expect(parseRugCheckReport({ mint: 42 })).toBeNull();
    expect(parseRugCheckReport({ mint: "" })).toBeNull();
  });

  it("degrades missing fields to null/empty", () => {
    const r = parseRugCheckReport({ mint: "abc" })!;
    expect(r.scoreNormalised).toBeNull();
    expect(r.totalHolders).toBeNull();
    expect(r.top10HolderPct).toBeNull();
    expect(r.dangerRiskCount).toBe(0);
    expect(r.tokenMetaMutable).toBeNull();
  });
});

describe("getRugCheckReport", () => {
  it("returns null on HTTP error (fail-open)", async () => {
    const fetchImpl = async () => new Response("{}", { status: 404 });
    expect(await getRugCheckReport("abc", { fetchImpl })).toBeNull();
  });

  it("returns null on unparseable body", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 });
    expect(await getRugCheckReport("abc", { fetchImpl })).toBeNull();
  });

  it("returns a parsed report on a valid payload", async () => {
    const fetchImpl = async () => new Response(JSON.stringify(LIVE_JITO), { status: 200 });
    const r = await getRugCheckReport("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn", {
      fetchImpl,
    });
    expect(r).not.toBeNull();
    expect(r!.mintAuthority).toBe("MINT_AUTH_ADDR");
  });

  it("hits the /tokens/{mint}/report endpoint", async () => {
    let calledUrl = "";
    const fetchImpl = async (input: string | URL | Request) => {
      calledUrl = String(input as unknown);
      return new Response(JSON.stringify(LIVE_RISKY), { status: 200 });
    };
    await getRugCheckReport("abc123", { fetchImpl, baseUrl: "https://x.example/v1" });
    expect(calledUrl).toBe("https://x.example/v1/tokens/abc123/report");
  });
});
