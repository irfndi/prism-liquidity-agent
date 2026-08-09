import { describe, expect, it } from "vitest";
import { scoreWashEvidence, type WashTradeRow } from "../engine/wash-forensics.js";

const T0 = 1_800_000_000;
function row(payer: string, i: number, fee = 5_000): WashTradeRow {
  return { payer, timestamp: T0 + i, feeLamports: fee };
}

describe("scoreWashEvidence", () => {
  it("flags a concentrated sample: few wallets, many trades (the live TOAD shape)", () => {
    // 40 trades from 4 wallets in a 4-second window — the pattern observed
    // on the live pool (25 from one wallet alone).
    const rows = Array.from({ length: 40 }, (_, i) => row(`wallet${i % 4}`, i));
    const e = scoreWashEvidence(rows);
    expect(e.suspicious).toBe(true);
    expect(e.distinctPayers).toBe(4);
    expect(e.uniquePayerRate).toBeCloseTo(0.1, 2);
    expect(e.reason).toContain("wash pattern");
  });

  it("flags a 2-wallet sample outright", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`bot${i % 2}`, i));
    const e = scoreWashEvidence(rows);
    expect(e.suspicious).toBe(true);
    expect(e.reason).toContain("concentrated");
  });

  it("flags a bot burst: 2 wallets at >5 trades/sec", () => {
    // 12 trades from 2 wallets within 2 seconds = 6 tps.
    const rows = Array.from({ length: 12 }, (_, i) => row(`bot${i % 2}`, Math.floor(i / 6)));
    const e = scoreWashEvidence(rows);
    expect(e.suspicious).toBe(true);
    expect(e.reason).toContain("bot burst");
  });

  it("passes organic volume: many distinct wallets over time", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(`wallet${i}`, i * 30));
    const e = scoreWashEvidence(rows);
    expect(e.suspicious).toBe(false);
    expect(e.uniquePayerRate).toBe(1);
    expect(e.reason).toBeNull();
  });

  it("never flags a thin sample (fewer than the judgment floor)", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`wallet${i % 2}`, i));
    const e = scoreWashEvidence(rows);
    expect(e.suspicious).toBe(false);
  });

  it("passes a concentrated but slow sample (one wallet, minutes apart)", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row("lone", i * 60));
    // 1 wallet, 25 trades over 24 min = ~0.017 tps — not a bot burst, but
    // 1 wallet IS ≤ 2 → concentrated rule fires (≥20 trades). Document the
    // tradeoff: a lone wallet doing 25 trades is genuinely suspect.
    const e = scoreWashEvidence(rows);
    expect(e.suspicious).toBe(true);
    expect(e.reason).toContain("concentrated");
  });

  it("reports fee uniformity as advisory data (uniform fees, organic wallets)", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`wallet${i}`, i * 30, 5_000));
    const e = scoreWashEvidence(rows);
    expect(e.feeCv).toBe(0);
    expect(e.suspicious).toBe(false); // uniform fees alone prove nothing
  });

  it("handles an empty sample", () => {
    const e = scoreWashEvidence([]);
    expect(e.suspicious).toBe(false);
    expect(e.tradeCount).toBe(0);
    expect(e.feeCv).toBeNull();
  });
});
