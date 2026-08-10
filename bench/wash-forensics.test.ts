import { describe, expect, it } from "vitest";
import {
  scoreWashEvidence,
  WASH_MAX_TPS_FOR_BURST,
  WASH_MAX_UNIQUE_PAYER_RATE,
  WASH_MIN_TRADES,
  type WashTradeRow,
} from "../engine/wash-forensics.js";

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
    // 12 trades from 2 wallets spanning [0, 2] seconds = 12/2 = 6 tps.
    const rows = Array.from({ length: 12 }, (_, i) => row(`bot${i % 2}`, Math.floor(i / 6) * 2));
    const e = scoreWashEvidence(rows);
    expect(e.suspicious).toBe(true);
    expect(e.txsPerSecond).toBe(6);
    expect(e.reason).toContain("bot burst");
  });

  it("passes a burst under the threshold (exactly 5 tps does NOT fire at 2 wallets... it fires at >= 5)", () => {
    // 10 trades from 2 wallets spanning [0, 2] seconds = 5 tps — the >=
    // threshold fires (bot-burst rule) but the 2-wallet concentration rule
    // also fires (10 < 20 trades so it does not) — document the boundary.
    const rows = Array.from({ length: 10 }, (_, i) => row(`bot${i % 2}`, Math.floor(i / 5) * 2));
    const e = scoreWashEvidence(rows);
    expect(e.txsPerSecond).toBe(5);
    expect(e.suspicious).toBe(true);
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

  it("draws the trade-count line exactly at WASH_MIN_TRADES (19 pass, 20 flag)", () => {
    // 19 trades from 2 wallets at ~1 tps: every rule needs >= 20 trades
    // (concentration, unique-payer-rate) or >= 5 tps (burst) — nothing fires.
    const under = Array.from({ length: WASH_MIN_TRADES - 1 }, (_, i) => row(`bot${i % 2}`, i));
    const eUnder = scoreWashEvidence(under);
    expect(eUnder.suspicious).toBe(false);
    expect(eUnder.tradeCount).toBe(WASH_MIN_TRADES - 1);
    expect(eUnder.txsPerSecond).toBeLessThan(WASH_MAX_TPS_FOR_BURST);

    // 20 trades from 2 wallets at the same ~1 tps: concentration fires.
    const at = Array.from({ length: WASH_MIN_TRADES }, (_, i) => row(`bot${i % 2}`, i));
    const eAt = scoreWashEvidence(at);
    expect(eAt.suspicious).toBe(true);
    expect(eAt.reason).toContain("concentrated");
  });

  it("draws the unique-payer-rate line exactly at WASH_MAX_UNIQUE_PAYER_RATE (0.15)", () => {
    // 3 distinct payers / 20 trades = exactly 0.15 — the wash-pattern rule
    // fires (>= 20 trades, rate <= 0.15). 3 wallets also beats the
    // 2-wallet concentration rule, so only the rate rule can fire.
    const at = Array.from({ length: 20 }, (_, i) => row(`wallet${i % 3}`, i));
    const eAt = scoreWashEvidence(at);
    expect(eAt.uniquePayerRate).toBe(WASH_MAX_UNIQUE_PAYER_RATE);
    expect(eAt.suspicious).toBe(true);
    expect(eAt.reason).toContain("wash pattern");
  });

  it("passes a sample just over WASH_MAX_UNIQUE_PAYER_RATE", () => {
    // 5 distinct payers / 33 trades = 0.1515... > 0.15 — rate rule passes.
    // 5 wallets beats concentration; ~1 tps beats the burst bar.
    const justOver = Array.from({ length: 33 }, (_, i) => row(`wallet${i % 5}`, i));
    const e = scoreWashEvidence(justOver);
    expect(e.uniquePayerRate).toBeGreaterThan(WASH_MAX_UNIQUE_PAYER_RATE);
    expect(e.suspicious).toBe(false);
  });

  it("fires the burst rule at exactly WASH_MAX_TPS_FOR_BURST (5.0 tps)", () => {
    // 10 trades from 2 wallets spanning [0, 2]s = 10/2 = 5.0 tps — the >=
    // bar fires. Fewer than 20 trades, so only the burst rule can fire.
    const rows = Array.from({ length: 10 }, (_, i) => row(`bot${i % 2}`, Math.floor(i / 5) * 2));
    const e = scoreWashEvidence(rows);
    expect(e.txsPerSecond).toBe(WASH_MAX_TPS_FOR_BURST);
    expect(e.suspicious).toBe(true);
    expect(e.reason).toContain("bot burst");
  });

  it("passes a burst just under WASH_MAX_TPS_FOR_BURST (4.5 tps)", () => {
    // 9 trades from 2 wallets spanning [0, 2]s = 9/2 = 4.5 tps — under the
    // >= 5.0 bar and under the 20-trade floor, so nothing fires.
    const rows = Array.from({ length: 9 }, (_, i) => row(`bot${i % 2}`, Math.floor(i / 5) * 2));
    const e = scoreWashEvidence(rows);
    expect(e.txsPerSecond).toBe(4.5);
    expect(e.suspicious).toBe(false);
  });

  it("never flags a single payer below WASH_MIN_TRADES (the judgment floor)", () => {
    // One wallet, 19 trades at ~1 tps: the concentration rule needs >= 20
    // trades and the burst rule needs >= 5 tps — a lone wallet under the
    // floor is a possible honest burst.
    const rows = Array.from({ length: WASH_MIN_TRADES - 1 }, (_, i) => row("lone", i));
    const e = scoreWashEvidence(rows);
    expect(e.distinctPayers).toBe(1);
    expect(e.suspicious).toBe(false);
  });

  it("keeps feeCv null at exactly 2 fees and computes it at exactly 3", () => {
    // feeCv needs >= 3 positive fees; exactly 2 stays null.
    const two = [row("a", 0), row("b", 30)];
    const eTwo = scoreWashEvidence(two);
    expect(eTwo.feeCv).toBeNull();

    // Crossing the floor: exactly 3 identical fees -> CV 0 (not null).
    const three = [row("a", 0), row("b", 30), row("c", 60)];
    const eThree = scoreWashEvidence(three);
    expect(eThree.feeCv).toBe(0);
  });
});
