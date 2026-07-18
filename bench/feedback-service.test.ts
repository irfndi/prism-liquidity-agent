import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Effect, Layer } from "effect";
import { ConfigService } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { FeedbackLive } from "../engine/feedback-service.js";
import {
  FeedbackService,
  type AgentFeedback,
  type FeedbackContext,
  type FeedbackResult,
} from "../engine/services.js";

const ctx = (): FeedbackContext => ({
  prismVersion: "1.2.3-test",
  installMethod: "test",
  platform: "linux-x64",
  runtime: "bun test",
});

function makeFeedback(overrides: Partial<AgentFeedback> = {}): AgentFeedback {
  return {
    category: "friction",
    severity: "medium",
    summary: "Install process requires manual Bun installation",
    details: "After curl installer, had to manually install Bun",
    context: ctx(),
    ...overrides,
  };
}

function buildLayer(
  githubToken: string,
  githubRepo = "irfndi/prism-liquidity-agent",
  optOut = false,
): Layer.Layer<FeedbackService, never, never> {
  const mockConfig = Layer.succeed(ConfigService, {
    walletPrivateKey: "",
    heliusApiKey: "",
    solanaRpcUrl: "",
    solanaRpcFallbackUrl: "",
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
    forceUpdateEnabled: false,
    forceUpdateAfterDays: 14,
    updateR2PublicUrl: "",
    githubToken,
    githubRepo,
    feedbackOptOut: optOut,
    paperModeExitLive: false,
    meteoraPoolsUrl:
      "https://dlmm.datapi.meteora.ag/pools?page=1&page_size=1000&filter_by=is_blacklisted=false&sort_by=tvl:desc",
    meteoraDatapiBaseUrl: "https://dlmm.datapi.meteora.ag",
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
    agentRuntime: "none",
    agentAcpCommand: "hermes",
    agentAcpArgs: ["acp"],
    agentGatewayUrl: "ws://127.0.0.1:18789",
    agentGatewayToken: "",
    agentPromptTimeoutMs: 15_000,
    agentCheckinIntervalMs: 3_600_000,
    agentCheckinOnEvents: true,
    agentCheckinIncludeHistory: true,
    agentCheckinMaxPositions: 10,
    agentOpenclawWebhookUrl: "",
    agentHermesApiUrl: "",
    agentHttpPort: 18_790,
    agentMcpEnabled: true,
    agentProposalMode: "veto",
    agentProposalToken: "",
    agentApprovalToken: "",
    agentProposalTimeoutMs: 15_000,
    agentProposalMaxBatchSize: 10,
    agentProposalMaxQueueSize: 50,
    agentProposalStaleMs: 300_000,
    agentProposalBackoffBaseMs: 60_000,
    agentProposalBackoffMaxMs: 3_600_000,
    agentProposalMaxPositionSizePct: 0.4,
    agentProposalMinConfidence: 0.65,
    agentProposalCircuitBreakerThreshold: 5,
    agentProposalCircuitBreakerCooldownMs: 300_000,
    oorCooldownMs: 4 * 60 * 60 * 1000,
    repeatOorCooldownMs: 12 * 60 * 60 * 1000,
    maxOorCooldownExits: 3,
    evolutionInterval: 5,
    evolutionMaxChangePct: 0.2,
    signalWeightWindowDays: 60,
    signalWeightMinOutcomes: 10,
    signalWeightBoostFactor: 1.05,
    signalWeightDecayFactor: 0.95,
    signalWeightFloor: 0.3,
    signalWeightCeiling: 2.5,
    weightedEntryScoreThreshold: 1.8,
    autoSwapEntry: false,
    snapshotRetentionDays: 14,
  });
  const baseLayer = Layer.merge(mockConfig, DbLive(":memory:"));
  return Layer.provide(FeedbackLive, baseLayer) as Layer.Layer<FeedbackService, never, never>;
}

function mockFetch(impl: typeof fetch): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

const credentialsFile = join(tmpdir(), "prism-feedback-service-test-credentials.json");

function enableCredentials(): void {
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      apiKey: "test-prism-api-key",
      userId: "test-user",
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  process.env.PRISM_CREDENTIALS_FILE = credentialsFile;
}

beforeEach(() => {
  process.env.PRISM_CREDENTIALS_FILE = credentialsFile;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.PRISM_CREDENTIALS_FILE;
  try {
    unlinkSync(credentialsFile);
  } catch {}
});

describe("feedback service — no credentials", () => {
  it("requires a registered Prism account", async () => {
    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(makeFeedback());
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.error).toContain("prism register");
  });

  it("still works when no feedback context is provided (builds a default)", async () => {
    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit({
        category: "suggestion",
        severity: "low",
        summary: "Add --yes flag to setup",
        context: ctx(),
      });
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("error");
  });
});

// ─── Cloud feedback fallback ───────────────────────────────────────────────

describe("feedback service — cloud fallback", () => {
  it("submits to the D1-backed cloud endpoint", async () => {
    enableCredentials();
    mockFetch(
      vi.fn(async (url: string | URL | Request) => {
        const u = url.toString();
        if (u.includes("/v1/feedback")) {
          return new Response(JSON.stringify({ id: "cloud-test-id" }), { status: 200 });
        }
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch,
    );

    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      return yield* fb.submit(makeFeedback({ summary: "Cloud fallback success test" }));
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("cloud");
    if (result.kind === "cloud") {
      expect(result.id).toBe("cloud-test-id");
    }
  });

  it("falls back to local storage when the cloud endpoint fails", async () => {
    enableCredentials();
    mockFetch(
      (async () => new Response("service unavailable", { status: 500 })) as unknown as typeof fetch,
    );

    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      return yield* fb.submit(makeFeedback({ summary: "Cloud fallback failure test" }));
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("local_only");
  });
});

// ─── Opt-out ───────────────────────────────────────────────────────────────

describe("feedback service — opt-out", () => {
  it("returns opt_out when agent has disabled feedback", async () => {
    const layer = buildLayer("", "irfndi/prism-liquidity-agent", true);
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(makeFeedback());
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("opt_out");
  });

  it("setOptOut toggles state and is reflected in getOptOut", async () => {
    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const before = yield* fb.getOptOut();
      yield* fb.setOptOut(true);
      const during = yield* fb.getOptOut();
      yield* fb.setOptOut(false);
      const after = yield* fb.getOptOut();
      return { before, during, after };
    }).pipe(Effect.provide(layer));

    const states = await Effect.runPromise(program);
    expect(states.before).toBe(false);
    expect(states.during).toBe(true);
    expect(states.after).toBe(false);
  });
});

// ─── Submission with GITHUB_TOKEN (mocked) ────────────────────────────────

describe("feedback service — D1 cloud submissions", () => {
  it("stores a new feedback item in the cloud", async () => {
    enableCredentials();
    mockFetch(
      vi.fn(async (url: string | URL | Request) =>
        url.toString().includes("/v1/feedback")
          ? new Response(JSON.stringify({ id: "cloud-new" }), { status: 200 })
          : new Response("unexpected", { status: 500 }),
      ) as unknown as typeof fetch,
    );

    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(makeFeedback({ summary: "Brand new feedback" }));
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("cloud");
    if (result.kind === "cloud") {
      expect(result.id).toBe("cloud-new");
      expect(result.duplicate).toBe(false);
    }
  });

  it("preserves the D1 duplicate marker", async () => {
    enableCredentials();
    mockFetch(
      (async () =>
        new Response(JSON.stringify({ id: "cloud-existing", duplicate: true }), {
          status: 200,
        })) as unknown as typeof fetch,
    );

    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(makeFeedback());
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("cloud");
    if (result.kind === "cloud") {
      expect(result.id).toBe("cloud-existing");
      expect(result.duplicate).toBe(true);
    }
  });

  it("falls back to local storage when D1 returns an error", async () => {
    enableCredentials();
    mockFetch(
      (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch,
    );

    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(makeFeedback());
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("local_only");
  });
});

// ─── Rate limiting ─────────────────────────────────────────────────────────

describe("feedback service — rate limiting", () => {
  it("rejects when exceeding per-hour limit (5)", async () => {
    enableCredentials();
    mockFetch(
      (async () =>
        new Response(JSON.stringify({ id: "cloud-rate" }), {
          status: 200,
        })) as unknown as typeof fetch,
    );

    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const results: FeedbackResult[] = [];
      for (let i = 0; i < 7; i++) {
        const r = yield* fb.submit(
          makeFeedback({ summary: `Unique report ${i} about topic ${i}` }),
        );
        results.push(r);
      }
      return results;
    }).pipe(Effect.provide(layer));

    const results = await Effect.runPromise(program);
    const created = results.filter((r) => r.kind === "cloud").length;
    const rateLimited = results.filter((r) => r.kind === "rate_limited").length;
    expect(created).toBeGreaterThan(0);
    expect(rateLimited).toBeGreaterThan(0);
    expect(created + rateLimited).toBe(7);
  });

  it("rejects when minimum interval (60s) not elapsed since last feedback", async () => {
    enableCredentials();
    mockFetch(
      (async () =>
        new Response(JSON.stringify({ id: "cloud-interval" }), {
          status: 200,
        })) as unknown as typeof fetch,
    );

    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const first = yield* fb.submit(makeFeedback({ summary: "First feedback thing" }));
      const second = yield* fb.submit(makeFeedback({ summary: "Second feedback thing" }));
      return { first: first.kind, second: second.kind };
    }).pipe(Effect.provide(layer));

    const { first, second } = await Effect.runPromise(program);
    expect(first).toBe("cloud");
    expect(second).toBe("rate_limited");
  });
});

// ─── Local dedup (cooldown) ───────────────────────────────────────────────

describe("feedback service — local dedup cooldown", () => {
  it("returns duplicate for the same hash within 24h (after one successful submit)", async () => {
    enableCredentials();
    mockFetch(
      (async () =>
        new Response(JSON.stringify({ id: "cloud-dedup" }), {
          status: 200,
        })) as unknown as typeof fetch,
    );

    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const first = yield* fb.submit(makeFeedback({ summary: "Same thing again" }));
      const second = yield* fb.submit(makeFeedback({ summary: "Same thing again" }));
      return { first: first.kind, second: second.kind };
    }).pipe(Effect.provide(layer));

    const { first, second } = await Effect.runPromise(program);
    expect(first).toBe("cloud");
    expect(second).toBe("local_only");
  });
});

// ─── getByHash ─────────────────────────────────────────────────────────────

describe("feedback service — getByHash", () => {
  it("returns null for unknown hash", async () => {
    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      return yield* fb.getByHash("nonexistent-hash");
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result).toBeNull();
  });

  it("returns the stored entry for a known hash", async () => {
    const { createHash } = await import("crypto");
    enableCredentials();
    mockFetch(
      (async () =>
        new Response(JSON.stringify({ id: "cloud-hash" }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    const layer = buildLayer("");
    const knownSummary = "Get by hash test thing";
    const knownDetails = "Test details";
    const expectedHash = createHash("sha256")
      .update(`friction:${knownSummary.toLowerCase()}:${knownDetails.toLowerCase()}`)
      .digest("hex")
      .slice(0, 16);
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      yield* fb.submit(makeFeedback({ summary: knownSummary, details: knownDetails }));
      return yield* fb.getByHash(expectedHash);
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result).not.toBeNull();
    expect(result!.summary).toBe(knownSummary);
  });
});

describe("feedback service — details round-trip", () => {
  it("preserves empty-string details as '' (not null) on read-back", async () => {
    enableCredentials();
    mockFetch(
      (async () =>
        new Response(JSON.stringify({ id: "cloud-empty-details" }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(
        makeFeedback({ summary: "Empty details round-trip unique-marker-aaa", details: "" }),
      );
      const all = yield* fb.list();
      const entry = all.find((e) => e.summary === "Empty details round-trip unique-marker-aaa");
      return { result, entry };
    }).pipe(Effect.provide(layer));

    const { result, entry } = await Effect.runPromise(program);
    expect(result.kind).toBe("cloud");
    expect(entry).toBeDefined();
    expect(entry!.details).toBe("");
  });

  it("preserves null details as null when details is omitted", async () => {
    enableCredentials();
    mockFetch(
      (async () =>
        new Response(JSON.stringify({ id: "cloud-null-details" }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit({
        category: "friction",
        severity: "medium",
        summary: "Null details round-trip unique-marker-bbb",
        context: ctx(),
      });
      const all = yield* fb.list();
      const entry = all.find((e) => e.summary === "Null details round-trip unique-marker-bbb");
      return { result, entry };
    }).pipe(Effect.provide(layer));

    const { result, entry } = await Effect.runPromise(program);
    expect(result.kind).toBe("cloud");
    expect(entry).toBeDefined();
    expect(entry!.details).toBeNull();
  });
});
