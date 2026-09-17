import { describe, expect, it } from "vitest";
import {
  consultJevJudgments,
  JEV_DISABLED,
  resolveJevApiKey,
  type JevConfigLike,
  type JevPoolState,
} from "../engine/jev-service.js";
import type { FetchLike } from "../engine/token-risk-service.js";

interface JevAnswerEnvelope {
  readonly model: string;
  readonly answers: {
    readonly deposit_pick: {
      readonly type: string;
      readonly choice: string;
      readonly confidence: number;
    };
    readonly toxic_flow: { readonly type: string; readonly noul: number };
    readonly recovery_hold: { readonly type: string; readonly noul: number };
    readonly regime_stress: { readonly type: string; readonly noul: number };
  };
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

function jsonResponse(
  status: number,
  envelope: JevAnswerEnvelope | Record<string, never>,
): Response {
  return new Response(JSON.stringify(envelope), { status });
}

function throwingFetch(): FetchLike {
  return async () => {
    throw new Error("must not fetch");
  };
}

interface FixedFetch {
  readonly fetchImpl: FetchLike;
  readonly calls: () => number;
}

function fixedFetch(response: Response): FixedFetch {
  let count = 0;
  const calls = () => count;
  const fetchImpl: FetchLike = async () => {
    count += 1;
    return response;
  };
  return { fetchImpl, calls };
}

describe("resolveJevApiKey", () => {
  it("prefers canonical TYPESAFE_API_KEY over legacy alias", () => {
    expect(resolveJevApiKey({ TYPESAFE_API_KEY: "canon", TYPESAFEAI_API: "legacy" })).toBe("canon");
  });
  it("falls back to TYPESAFEAI_API alias", () => {
    expect(resolveJevApiKey({ TYPESAFEAI_API: "legacy" })).toBe("legacy");
  });
  it("returns empty when neither is set", () => {
    expect(resolveJevApiKey({})).toBe("");
  });
});

describe("consultJevJudgments", () => {
  const pool: JevPoolState = {
    poolAddress: "pool",
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tvlUsd: 100000,
    volume24hUsd: 50000,
    fees24hUsd: 100,
    statsSource: "datapi",
    volumeAuthenticityKnown: true,
    feeIlRatioKnown: true,
    binUtilizationKnown: true,
    feeIlRatio: 2,
    volumeAuthenticity: 0.9,
    binUtilization: 0.5,
    volatilityStddev: 1.5,
    netDriftBins: 2,
    activeBinId: 100,
    binStep: 20,
  };
  const config: JevConfigLike = { jevEnabled: true, jevApiKey: "k" };

  it("returns disabled when an explicit empty key is configured", async () => {
    const out = await consultJevJudgments(
      pool,
      { jevEnabled: true, jevApiKey: "" },
      {
        fetchImpl: throwingFetch(),
      },
    );
    expect(out).toEqual(JEV_DISABLED);
  });

  it("parses the four judgments from one batched call", async () => {
    const { fetchImpl, calls } = fixedFetch(
      jsonResponse(200, {
        model: "jev-1.13.0",
        answers: {
          deposit_pick: { type: "choice", choice: "bidask", confidence: 0.8 },
          toxic_flow: { type: "noul", noul: 0.72 },
          recovery_hold: { type: "noul", noul: 0.3 },
          regime_stress: { type: "noul", noul: 0.1 },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const out = await consultJevJudgments(pool, config, { fetchImpl });
    expect(out.ok).toBe(true);
    expect(out.depositPick).toBe("bidask");
    expect(out.depositConfidence).toBe(0.8);
    expect(out.toxicFlowNoul).toBe(0.72);
    expect(out.recoveryHoldNoul).toBe(0.3);
    expect(out.regimeStressNoul).toBe(0.1);
    expect(calls()).toBe(1);
  });

  it("fails open on 429 without retry", async () => {
    const { fetchImpl, calls } = fixedFetch(jsonResponse(429, {}));
    const out = await consultJevJudgments(pool, config, { fetchImpl });
    expect(out.ok).toBe(false);
    expect(out.failure).toBe("rate_limited");
    expect(calls()).toBe(1);
  });

  it("fails open on transport error", async () => {
    const out = await consultJevJudgments(pool, config, { fetchImpl: throwingFetch() });
    expect(out.ok).toBe(false);
    expect(out.failure).toBe("error");
  });
});

describe("jevStressHalvesSize (paper-only soft gate)", () => {
  it("halves on stress at/above threshold with ok:true", async () => {
    const { jevStressHalvesSize } = await import("../engine/program.js");
    expect(jevStressHalvesSize({ ok: true, regimeStressNoul: 0.35 }, 0.35)).toBe(true);
    expect(jevStressHalvesSize({ ok: true, regimeStressNoul: 0.61 }, 0.35)).toBe(true);
  });

  it("fails open below threshold, on !ok, null, or NaN stress", async () => {
    const { jevStressHalvesSize } = await import("../engine/program.js");
    expect(jevStressHalvesSize({ ok: true, regimeStressNoul: 0.34 }, 0.35)).toBe(false);
    expect(jevStressHalvesSize({ ok: false, regimeStressNoul: 0.9 }, 0.35)).toBe(false);
    expect(jevStressHalvesSize({ ok: true, regimeStressNoul: null }, 0.35)).toBe(false);
    expect(jevStressHalvesSize({ ok: true, regimeStressNoul: Number.NaN }, 0.35)).toBe(false);
    expect(jevStressHalvesSize(null, 0.35)).toBe(false);
  });
});
