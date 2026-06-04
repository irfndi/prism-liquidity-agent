import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    paperTrading: true,
    scanIntervalMs: 600_000,
    minPoolTvlUsd: 50_000,
    minFeeIlRatio: 1.2,
    tvlDropExitPct: 0.3,
    volumeAuthThreshold: 0.7,
    maxConcurrentPositions: 5,
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
    githubToken,
    githubRepo,
    feedbackOptOut: optOut,
  });
  const baseLayer = Layer.merge(mockConfig, DbLive(":memory:"));
  return Layer.provide(FeedbackLive, baseLayer) as Layer.Layer<FeedbackService, never, never>;
}

function mockFetch(impl: typeof fetch): void {
  globalThis.fetch = vi.fn(impl) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  // Each test gets a fresh in-memory SQLite database via DbLive(":memory:").
  // The persisted agentId in ~/.config/prism/agent-id is shared across tests
  // but that's fine — the dedup/rate-limit logic uses the same agentId
  // across the whole test file.
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Submission without GITHUB_TOKEN (local-only mode) ─────────────────────

describe("feedback service — no GITHUB_TOKEN", () => {
  it("stores feedback locally and returns local_only when token is unset", async () => {
    const layer = buildLayer("");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(makeFeedback());
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("local_only");
    if (result.kind === "local_only") {
      expect(result.localId).toMatch(/^local-/);
    }
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

describe("feedback service — with GITHUB_TOKEN (mocked)", () => {
  it("creates a new GitHub issue when no duplicate found", async () => {
    mockFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = url.toString();
        if (u.includes("/search/issues")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (u.includes("/repos/") && init?.method === "POST") {
          return new Response(
            JSON.stringify({ number: 42, html_url: "https://github.com/x/y/issues/42" }),
            { status: 201 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch,
    );

    const layer = buildLayer("test-token");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(makeFeedback({ summary: "Brand new issue" }));
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("created");
    if (result.kind === "created") {
      expect(result.issueNumber).toBe(42);
      expect(result.issueUrl).toContain("issues/42");
    }
  });

  it("adds +1 comment to existing similar issue (Jaccard ≥ 0.7)", async () => {
    let commentCalled = false;
    mockFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = url.toString();
        if (u.includes("/search/issues")) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  number: 7,
                  title: "Install process requires manual Bun installation",
                  body: "After curl installer, had to manually install Bun. Same friction here too.",
                  html_url: "https://github.com/x/y/issues/7",
                  state: "open",
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (u.includes("/comments") && init?.method === "POST") {
          commentCalled = true;
          return new Response(JSON.stringify({ id: 1 }), { status: 201 });
        }
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch,
    );

    const layer = buildLayer("test-token");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(makeFeedback());
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(commentCalled).toBe(true);
    expect(result.kind).toBe("duplicate");
    if (result.kind === "duplicate") {
      expect(result.issueNumber).toBe(7);
    }
  });

  it("returns error kind when GitHub API returns non-OK on create", async () => {
    mockFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = url.toString();
        if (u.includes("/search/issues")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (u.includes("/repos/") && init?.method === "POST") {
          return new Response("server error", { status: 500 });
        }
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch,
    );

    const layer = buildLayer("test-token");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const result = yield* fb.submit(makeFeedback());
      return result;
    }).pipe(Effect.provide(layer));

    const result = await Effect.runPromise(program);
    expect(result.kind).toBe("error");
  });
});

// ─── Rate limiting ─────────────────────────────────────────────────────────

describe("feedback service — rate limiting", () => {
  it("rejects when exceeding per-hour limit (5)", async () => {
    let count = 0;
    mockFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = url.toString();
        if (u.includes("/search/issues")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (u.includes("/repos/") && init?.method === "POST") {
          count++;
          return new Response(
            JSON.stringify({ number: 100 + count, html_url: `https://x/y/issues/${100 + count}` }),
            { status: 201 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch,
    );

    const layer = buildLayer("test-token");
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
    const created = results.filter((r) => r.kind === "created").length;
    const rateLimited = results.filter((r) => r.kind === "rate_limited").length;
    expect(created).toBeGreaterThan(0);
    expect(rateLimited).toBeGreaterThan(0);
    expect(created + rateLimited).toBe(7);
  });

  it("rejects when minimum interval (60s) not elapsed since last feedback", async () => {
    let count = 0;
    mockFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = url.toString();
        if (u.includes("/search/issues")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (u.includes("/repos/") && init?.method === "POST") {
          count++;
          return new Response(
            JSON.stringify({ number: 200 + count, html_url: `https://x/y/issues/${200 + count}` }),
            { status: 201 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch,
    );

    const layer = buildLayer("test-token");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const first = yield* fb.submit(makeFeedback({ summary: "First feedback thing" }));
      const second = yield* fb.submit(makeFeedback({ summary: "Second feedback thing" }));
      return { first: first.kind, second: second.kind };
    }).pipe(Effect.provide(layer));

    const { first, second } = await Effect.runPromise(program);
    expect(first).toBe("created");
    expect(second).toBe("rate_limited");
  });
});

// ─── Local dedup (cooldown) ───────────────────────────────────────────────

describe("feedback service — local dedup cooldown", () => {
  it("returns duplicate for the same hash within 24h (after one successful submit)", async () => {
    let count = 0;
    mockFetch(
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const u = url.toString();
        if (u.includes("/search/issues")) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (u.includes("/repos/") && init?.method === "POST") {
          count++;
          return new Response(
            JSON.stringify({ number: 300 + count, html_url: `https://x/y/issues/${300 + count}` }),
            { status: 201 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }) as unknown as typeof fetch,
    );

    const layer = buildLayer("test-token");
    const program = Effect.gen(function* () {
      const fb = yield* FeedbackService;
      const first = yield* fb.submit(makeFeedback({ summary: "Same thing again" }));
      const second = yield* fb.submit(makeFeedback({ summary: "Same thing again" }));
      return { first: first.kind, second: second.kind };
    }).pipe(Effect.provide(layer));

    const { first, second } = await Effect.runPromise(program);
    expect(first).toBe("created");
    expect(second).toBe("duplicate");
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
    expect(result.kind).toBe("local_only");
    expect(entry).toBeDefined();
    expect(entry!.details).toBe("");
  });

  it("preserves null details as null when details is omitted", async () => {
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
    expect(result.kind).toBe("local_only");
    expect(entry).toBeDefined();
    expect(entry!.details).toBeNull();
  });
});
