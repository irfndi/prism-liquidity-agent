import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createErrorReporter,
  type ErrorReporter,
  type ErrorReporterConfig,
} from "../engine/error-reporter.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Replace globalThis.fetch with a mock suitable for capturing calls
 * in tests. The returned handle lets you assert on fetch invocations
 * via the vi.mocked API.
 */
function mockFetch(): void {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve(new Response(null, { status: 200 })),
  ) as unknown as typeof globalThis.fetch;
}

/**
 * Create a test reporter with sensible defaults.
 */
function makeReporter(overrides?: Partial<ErrorReporterConfig>): ErrorReporter {
  const r = createErrorReporter({
    endpoint: "https://errors.test.local/report",
    enabled: true,
    batchSize: 5,
    flushIntervalMs: 60_000,
    ...overrides,
  });
  r.setAppVersion("1.0.0-test");
  return r;
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

const ORIGINAL_ERROR_REPORTING = process.env.PRISM_ERROR_REPORTING;
const ORIGINAL_ERROR_ENDPOINT = process.env.PRISM_ERROR_ENDPOINT;

beforeEach(() => {
  mockFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL_ERROR_REPORTING === undefined) {
    delete process.env.PRISM_ERROR_REPORTING;
  } else {
    process.env.PRISM_ERROR_REPORTING = ORIGINAL_ERROR_REPORTING;
  }
  if (ORIGINAL_ERROR_ENDPOINT === undefined) {
    delete process.env.PRISM_ERROR_ENDPOINT;
  } else {
    process.env.PRISM_ERROR_ENDPOINT = ORIGINAL_ERROR_ENDPOINT;
  }
});

// ─── Sanitization ────────────────────────────────────────────────────────────

describe("sanitization", () => {
  it("redacts long base58 strings (≥64 chars, likely private keys)", () => {
    const r = makeReporter();
    const longBase58 =
      "5K3NEQrLEqrEv8PByNoxGmmLXdRNY4hvoM7pBEiCwJFp5K3NEQrLEqrEv8PByNoxGmmLXdRNY4hvoM7pBEiCwJFpXX";
    const err = new Error(`Connection failed for wallet ${longBase58}`);
    r.report(err);
    const pending = r.getPending();
    expect(pending[0]?.message).not.toContain(longBase58);
    expect(pending[0]?.message).toContain("[REDACTED]");
    r.dispose();
  });

  it("redacts hex private keys (0x-prefixed 64+ hex)", () => {
    const r = makeReporter();
    const hexKey = `0x${"a".repeat(64)}`;
    const err = new Error(`private key: ${hexKey}`);
    r.report(err);
    const pending = r.getPending();
    expect(pending[0]?.message).not.toContain(hexKey);
    expect(pending[0]?.message).toContain("[REDACTED]");
    r.dispose();
  });

  it("redacts raw hex strings 64+ chars", () => {
    const r = makeReporter();
    const rawHex = "f".repeat(64);
    const err = new Error(`Raw hex value ${rawHex} in config`);
    r.report(err);
    const pending = r.getPending();
    expect(pending[0]?.message).not.toContain(rawHex);
    expect(pending[0]?.message).toContain("[REDACTED]");
    r.dispose();
  });

  it("redacts secret_key= / private-key= patterns", () => {
    const r = makeReporter();
    const err = new Error("failed auth: private_key=deadbeef1234567890abc");
    r.report(err);
    const pending = r.getPending();
    expect(pending[0]?.message).toContain("[REDACTED]");
    expect(pending[0]?.message).not.toContain("deadbeef1234567890abc");
    r.dispose();
  });

  it("redacts password= patterns", () => {
    const r = makeReporter();
    const err = new Error("DB connection: password=PLACEHOLDER_VALUE");
    r.report(err);
    const pending = r.getPending();
    expect(pending[0]?.message).toContain("[REDACTED]");
    expect(pending[0]?.message).not.toContain("PLACEHOLDER_VALUE");
    r.dispose();
  });

  it("does NOT redact short base58 strings (e.g. pool addresses, 32-44 chars)", () => {
    const r = makeReporter();
    // Solana pool addresses are typically 32-44 base58 chars
    const poolAddr = "Abcd1234Abcd1234Abcd1234Abcd1234Abcd1234";
    expect(poolAddr.length).toBeLessThan(64);
    const err = new Error(`Pool ${poolAddr} error`);
    r.report(err);
    const pending = r.getPending();
    expect(pending[0]?.message).toContain(poolAddr);
    r.dispose();
  });

  it("sanitizes stack traces too", () => {
    const r = makeReporter();
    const longBase58 = "z".repeat(80);
    expect(longBase58.length).toBeGreaterThanOrEqual(64);
    const err = new Error("oops");
    err.stack = `Error: oops\n    at foo (file.ts:10:5)\n    value=${longBase58}`;
    r.report(err);
    const pending = r.getPending();
    expect(pending[0]?.stack).toContain("[REDACTED]");
    expect(pending[0]?.stack).not.toContain(longBase58);
    r.dispose();
  });
});

// ─── Classification ──────────────────────────────────────────────────────────

describe("classification", () => {
  it("classifies BigInt serialization errors as ONNX_BigInt", () => {
    const r = makeReporter();
    r.report(new Error("Failed to serialize BigInt value in ONNX pipeline"));
    expect(r.getPending()[0]?.category).toBe("ONNX_BigInt");
    r.dispose();
  });

  it("classifies sqlite-vec errors as SQLite_Vec", () => {
    const r = makeReporter();
    r.report(new Error("sqlite-vec error: table vec0 not found"));
    expect(r.getPending()[0]?.category).toBe("SQLite_Vec");
    r.dispose();
  });

  it("classifies rate limit errors as RPC_RateLimit", () => {
    const r = makeReporter();
    r.report(new Error("Rate limit exceeded: 429 Too Many Requests"));
    expect(r.getPending()[0]?.category).toBe("RPC_RateLimit");
    r.dispose();
  });

  it("classifies Helius errors", () => {
    const r = makeReporter();
    r.report(new Error("Helius API key invalid"));
    expect(r.getPending()[0]?.category).toBe("Helius_Error");
    r.dispose();
  });

  it("classifies update/tarball errors as UpdateFailure", () => {
    const r = makeReporter();
    r.report(new Error("Failed to download tarball: connection reset"));
    expect(r.getPending()[0]?.category).toBe("UpdateFailure");
    r.dispose();
  });

  it("classifies unknown patterns as Unknown", () => {
    const r = makeReporter();
    r.report(new Error("Something completely unexpected happened"));
    expect(r.getPending()[0]?.category).toBe("Unknown");
    r.dispose();
  });
});

// ─── Buffering ───────────────────────────────────────────────────────────────

describe("buffering", () => {
  it("accumulates reports in pending buffer", () => {
    const r = makeReporter();
    r.report(new Error("err1"));
    r.report(new Error("err2"));
    expect(r.getPending()).toHaveLength(2);
    r.dispose();
  });

  it("flushes when batch size threshold is reached", async () => {
    const r = makeReporter({ batchSize: 3 });
    r.report(new Error("e1"));
    r.report(new Error("e2"));
    // Not flushed yet
    expect(r.getPending()).toHaveLength(2);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();

    // Third report triggers flush
    r.report(new Error("e3"));
    // Wait for the async flush
    await new Promise((res) => setTimeout(res, 10));
    expect(r.getPending()).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    r.dispose();
  });

  it("flushAsync waits for the in-flight flush to complete", async () => {
    const r = makeReporter();
    r.report(new Error("e1"));
    r.report(new Error("e2"));
    expect(r.getPending()).toHaveLength(2);

    await r.flushAsync();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled();
    expect(r.getPending()).toHaveLength(0);
    r.dispose();
  });

  it("getPending returns a copy of pending reports", () => {
    const r = makeReporter();
    r.report(new Error("e1"));
    const copy = r.getPending();
    expect(copy).toHaveLength(1);

    // Mutating the copy should not affect internal state
    (copy as unknown[]).push({} as never);
    expect(r.getPending()).toHaveLength(1);
    r.dispose();
  });
});

// ─── No-op mode ──────────────────────────────────────────────────────────────

describe("no-op mode", () => {
  it("does nothing when PRISM_ERROR_REPORTING=false (enabled: false)", () => {
    const r = makeReporter({ enabled: false });
    r.report(new Error("should be ignored"));
    expect(r.getPending()).toHaveLength(0);
    r.flushAsync();
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    r.dispose();
  });

  it("does nothing when PRISM_ERROR_REPORTING env is 'false'", () => {
    process.env.PRISM_ERROR_REPORTING = "false";
    // Create a reporter that reads from env (no explicit enabled override)
    const r = createErrorReporter({
      endpoint: "https://errors.test.local/report",
      flushIntervalMs: 60_000,
    });
    r.setAppVersion("1.0.0-test");
    r.report(new Error("should be ignored"));
    expect(r.getPending()).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    r.dispose();
  });
});

// ─── Batch payload ───────────────────────────────────────────────────────────

describe("batch payload", () => {
  it("sends well-formed JSON with expected structure", async () => {
    let capturedBody: string | undefined;
    vi.mocked(globalThis.fetch).mockImplementation(
      (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        capturedBody = init?.body as string;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    );

    const r = makeReporter({ batchSize: 2 });
    r.report(new Error("test error 1"));
    r.report(new Error("test error 2"));

    // Wait for async flush
    await new Promise((res) => setTimeout(res, 10));

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalled();
    expect(capturedBody).toBeDefined();

    const parsed = JSON.parse(capturedBody!);
    expect(parsed).toHaveProperty("app", "prism-liquidity-agent");
    expect(parsed).toHaveProperty("version", "1.0.0-test");
    expect(parsed).toHaveProperty("reports");
    expect(parsed.reports).toBeInstanceOf(Array);
    expect(parsed.reports).toHaveLength(2);

    const first = parsed.reports[0]!;
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("ts");
    expect(first).toHaveProperty("message");
    expect(first).toHaveProperty("stack");
    expect(first).toHaveProperty("category");
    expect(first).toHaveProperty("severity");
    r.dispose();
  });
});

// ─── Failure resilience ──────────────────────────────────────────────────────

describe("failure resilience", () => {
  it("re-queues reports when fetch fails (network error)", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.reject(new Error("Network failure")),
    );

    const r = makeReporter({ batchSize: 1 });
    expect(() => {
      r.report(new Error("test"));
    }).not.toThrow();

    await new Promise((res) => setTimeout(res, 10));
    expect(r.getPending()).toHaveLength(1);
    r.dispose();
  });

  it("re-queues reports when fetch returns non-OK status", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(new Response(null, { status: 500, statusText: "Internal Server Error" })),
    );

    const r = makeReporter({ batchSize: 1 });
    expect(() => {
      r.report(new Error("test"));
    }).not.toThrow();

    await new Promise((res) => setTimeout(res, 10));
    expect(r.getPending()).toHaveLength(1);
    r.dispose();
  });

  it("does not buffer reports when no endpoint is configured", () => {
    const r = createErrorReporter({ enabled: true });
    r.setAppVersion("1.0.0-test");
    expect(() => {
      r.report(new Error("should be dropped without an endpoint"));
    }).not.toThrow();
    expect(r.getPending()).toHaveLength(0);
    r.dispose();
  });
});

// ─── Factory ─────────────────────────────────────────────────────────────────

describe("createErrorReporter factory", () => {
  it("returns an ErrorReporter instance", () => {
    const r = createErrorReporter({ enabled: false });
    expect(r).toBeInstanceOf(Object);
    expect(typeof r.report).toBe("function");
    expect(typeof r.flushAsync).toBe("function");
    expect(typeof r.getPending).toBe("function");
    expect(typeof r.dispose).toBe("function");
    r.dispose();
  });
});
