import { describe, expect, it } from "vitest";
import { applyCopySignalBoost, parseCopySignalPayload } from "../engine/copy-trading-signals.js";
import type { AgentDecision } from "../engine/types.js";

const wallet = "11111111111111111111111111111111";
const baseDecision = (action: AgentDecision["action"]): AgentDecision => ({
  action,
  poolAddress: "pool",
  confidence: 0.7,
  reasoning: "base",
});

describe("copy-trading signals", () => {
  it("boosts an eligible decision without exceeding the cap", () => {
    const result = applyCopySignalBoost(baseDecision("ENTER"), {
      boost: 0.2,
      wallets: [wallet],
      ignored: 0,
    });
    expect(result.confidence).toBe(0.75);
    expect(result.reasoning).toContain("copy-signal");
  });

  it("does not change deterministic EXIT decisions", () => {
    const result = applyCopySignalBoost(baseDecision("EXIT"), {
      boost: 0.05,
      wallets: [wallet],
      ignored: 0,
    });
    expect(result).toEqual(baseDecision("EXIT"));
  });

  it("ignores malformed and duplicate observations at the boundary", () => {
    const parsed = parseCopySignalPayload([
      { wallet, poolAddress: "pool", action: "ENTER", confidence: 0.8, observedAt: 1000 },
      { wallet, poolAddress: "pool", action: "INVALID", confidence: 0.8, observedAt: 1000 },
      {
        wallet: "not-a-wallet",
        poolAddress: "pool",
        action: "ENTER",
        confidence: 0.8,
        observedAt: 1000,
      },
    ]);
    expect(parsed).toHaveLength(1);
  });

  it("leaves disabled or zero-signal decisions unchanged", () => {
    const result = applyCopySignalBoost(baseDecision("HOLD"), {
      boost: 0,
      wallets: [],
      ignored: 2,
    });
    expect(result).toEqual(baseDecision("HOLD"));
  });
});
