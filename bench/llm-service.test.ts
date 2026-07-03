import { describe, it, expect, afterEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import { LlmNoOp, LlmLive } from "../engine/llm-service.js";
import { LlmService } from "../engine/services.js";
import { makePool, makeDecision, mockFetch } from "./helpers.js";
import type { PoolMetrics, MemoryEntry } from "../engine/types.js";
import type { DecisionRecord } from "../engine/services.js";
import type { AppConfig } from "../engine/config-service.js";
import type { AgentDecision } from "../engine/types.js";

function makeMetrics(overrides: Partial<PoolMetrics> = {}): PoolMetrics {
  const pool = overrides.pool ?? makePool();
  const binArray = overrides.binArray ?? { lowerBinId: 4980, upperBinId: 5020, bins: [], activeBinId: 5000 };
  return {
    pool,
    binArray,
    tvlVelocity: overrides.tvlVelocity ?? -0.05,
    feeIlRatio: overrides.feeIlRatio ?? 1.5,
    volumeAuthenticity: overrides.volumeAuthenticity ?? 0.85,
    binUtilization: overrides.binUtilization ?? 0.6,
  };
}

function makeContext(overrides: Partial<{ decision: AgentDecision; metrics: PoolMetrics; warnings: ReadonlyArray<MemoryEntry>; recentDecisions: ReadonlyArray<DecisionRecord> }> = {}) {
  return {
    pool: makePool(),
    metrics: makeMetrics(),
    warnings: [] as ReadonlyArray<MemoryEntry>,
    recentDecisions: [] as ReadonlyArray<DecisionRecord>,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    walletPrivateKey: "",
    heliusApiKey: "",
    solanaRpcUrl: "",
    paperTrading: true,
    scanIntervalMs: 600_000,
    minPoolTvlUsd: 50_000,
    minFeeIlRatio: 1.2,
    tvlDropExitPct: 0.3,
    volumeAuthThreshold: 0.7,
    minRebalanceIntervalMs: 86_400_000,
    minRebalanceNetBenefitUsd: 10,
    confidenceThreshold: 0.65,
    paperPortfolioUsd: 10_000,
    minBinUtilization: 0.3,
    maxRebalanceRangeBins: 50,
    watchlistPools: [],
    stopLossPct: 0.15,
    trailingStopPct: 0.1,
    oorGracePeriodCycles: 3,
    feeClaimIntervalMs: 86_400_000,
    enablePoolDiscovery: false,
    discoveryMinTvlUsd: 100_000,
    discoveryMinFeeRatio: 1.5,
    deployerBlacklistPath: "",
    tokenBlacklistPath: "",
    sqliteDbPath: "",
    enableSnapshotCapture: false,
    autoUpdate: true,
    updateCheckIntervalMs: 21_600_000,
    updateChannel: "stable",
    updateGithubRepo: "",
    updateAllowDirty: false,
    updateR2PublicUrl: "",
    forceUpdateEnabled: false,
    forceUpdateAfterDays: 14,
    githubToken: "",
    githubRepo: "",
    feedbackOptOut: false,
    paperModeExitLive: false,
    meteoraPoolsUrl: "",
    rebalanceGasCostSol: 0.01,
    solPriceUsd: 150,
    gasAwareMinDaysOfFeesPaidAhead: 3,
    volatilityExitStddev: 5,
    volatilityLookbackSnapshots: 12,
    volatilityWideHalfWidthBins: 50,
    autoCompoundFees: false,
    minCompoundFeesUsd: 0.5,
    compoundGasBufferUsd: 0.05,
    oorRecoveryLookbackCycles: 10,
    oorRecoveryHoldThreshold: 0.6,
    oorRecoveryForceRebalanceThreshold: 0.2,
    maxPerPoolAllocationPct: 0.4,
    maxOpenPositions: 3,
    paperValidationMinDays: 7,
    paperValidationEnforce: false,
    agentiveMode: false,
    llmApiKey: "",
    llmModel: "gpt-4o",
    llmBaseUrl: "https://api.openai.com/v1",
    llmMaxTokens: 1024,
    oorCooldownMs: 4 * 60 * 60 * 1000,
    repeatOorCooldownMs: 12 * 60 * 60 * 1000,
    maxOorCooldownExits: 3,
    evolutionInterval: 5,
    evolutionMaxChangePct: 0.20,
    signalWeightWindowDays: 60,
    signalWeightMinOutcomes: 10,
    signalWeightBoostFactor: 1.05,
    signalWeightDecayFactor: 0.95,
    signalWeightFloor: 0.3,
    signalWeightCeiling: 2.5,
    weightedEntryScoreThreshold: 1.8,
    ...overrides,
  };
}

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
  return Effect.runSync((Effect.provide as (e: Effect.Effect<T, unknown, unknown>, l: unknown) => Effect.Effect<T, unknown, never>)(effect, layer));
}

async function runAsync<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): Promise<T> {
  return Effect.runPromise((Effect.provide as (e: Effect.Effect<T, unknown, unknown>, l: unknown) => Effect.Effect<T, unknown, never>)(effect, layer));
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockJsonFetch(body: object, status = 200): () => void {
  return mockFetch((async () => jsonResponse(body, status)) as unknown as typeof fetch);
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── LlmNoOp ───────────────────────────────────────────────────────────────

describe("LlmNoOp", () => {
  it("returns null for any decision", () => {
    const layer = Layer.succeed(LlmService, LlmNoOp);
    const decision = makeDecision({ action: "ENTER", confidence: 0.8 });

    const result = run(
      Effect.gen(function* () {
        const llm = yield* LlmService;
        return yield* llm.enhanceDecision(decision, makeContext());
      }),
      layer,
    );

    expect(result).toBeNull();
  });
});

// ─── LlmLive early exits ───────────────────────────────────────────────────

describe("LlmLive", () => {
  it("returns null when agentiveMode is false", () => {
    const config = makeConfig({ agentiveMode: false, llmApiKey: "test-key" });
    const layer = LlmLive(config);
    const decision = makeDecision();

    const result = run(
      Effect.gen(function* () {
        const llm = yield* LlmService;
        return yield* llm.enhanceDecision(decision, makeContext());
      }),
      layer,
    );

    expect(result).toBeNull();
  });

  it("returns null when llmApiKey is empty", () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "" });
    const layer = LlmLive(config);
    const decision = makeDecision();

    const result = run(
      Effect.gen(function* () {
        const llm = yield* LlmService;
        return yield* llm.enhanceDecision(decision, makeContext());
      }),
      layer,
    );

    expect(result).toBeNull();
  });

  it("returns original decision when API returns non-200", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({}, 500);

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "HOLD", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      // On non-200, the service returns the original decision
      expect(result).not.toBeNull();
      expect(result!.action).toBe("HOLD");
      expect(result!.confidence).toBe(0.75);
    } finally {
      restore();
    }
  });

  it("returns original decision when LLM returns empty content", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: "" } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "HOLD", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).not.toBeNull();
      expect(result!.action).toBe("HOLD");
    } finally {
      restore();
    }
  });

  it("returns original decision when LLM returns unparseable response", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: "not json at all" } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "HOLD", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).not.toBeNull();
      expect(result!.action).toBe("HOLD");
    } finally {
      restore();
    }
  });

  // ─── Confidence reduction logic ──────────────────────────────────────────

  it("returns null when LLM wants no override (empty action+confidence+reasoning)", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: '{"action":"","confidence":0.75,"reasoning":""}' } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "HOLD", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it("accepts lower confidence from LLM", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: '{"confidence":0.4,"reasoning":"Lower confidence due to risk"}' } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "HOLD", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.4);
      expect(result!.reasoning).toContain("[LLM overlay]");
    } finally {
      restore();
    }
  });

  it("rejects higher confidence from LLM and returns original decision", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: '{"confidence":0.95,"reasoning":"Increase confidence"}' } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "HOLD", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  // ─── Veto logic ──────────────────────────────────────────────────────────

  it("accepts LLM changing action to HOLD", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: '{"action":"HOLD","reasoning":"Market too volatile"}' } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "REBALANCE", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).not.toBeNull();
      expect(result!.action).toBe("HOLD");
    } finally {
      restore();
    }
  });

  it("rejects LLM changing action to ENTER", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: '{"action":"ENTER","reasoning":"Looks good"}' } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "HOLD", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it("rejects LLM changing action to REBALANCE", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: '{"action":"REBALANCE","reasoning":"Shift range"}' } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "HOLD", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it("rejects LLM changing action to EXIT", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: '{"action":"EXIT","reasoning":"Too risky"}' } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "REBALANCE", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).toBeNull();
    } finally {
      restore();
    }
  });

  it("parses markdown-fenced JSON response", async () => {
    const config = makeConfig({ agentiveMode: true, llmApiKey: "test-key" });
    const restore = mockJsonFetch({ choices: [{ message: { content: '```json\n{"confidence":0.5,"reasoning":"Lower"}\n```' } }] });

    try {
      const layer = LlmLive(config);
      const decision = makeDecision({ action: "HOLD", confidence: 0.75 });

      const result = await runAsync(
        Effect.gen(function* () {
          const llm = yield* LlmService;
          return yield* llm.enhanceDecision(decision, makeContext());
        }),
        layer,
      );

      expect(result).not.toBeNull();
      expect(result!.confidence).toBe(0.5);
    } finally {
      restore();
    }
  });
});
