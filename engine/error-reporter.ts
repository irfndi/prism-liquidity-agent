/**
 * Privacy-first error reporter for Prism.
 *
 * - Sanitizes stack traces and messages (replaces base58-like keys, private keys, passwords)
 * - Buffers reports in memory and flushes in batches (5 reports or 60 seconds)
 * - Sends to a configurable endpoint via fetch (PRISM_ERROR_ENDPOINT env var, defaults to production API)
 * - If the endpoint fetch fails, the batch is re-queued at the front of the pending buffer
 *   (oldest reports beyond MAX_PENDING_BUFFER are dropped to bound memory)
 * - Classifies errors by string match
 * - If PRISM_ERROR_REPORTING env var is "false", the reporter is a no-op (opt-out)
 * - For testability: flushAsync(), getPending(), and createErrorReporter(config) factory
 */

import { existsSync, readFileSync } from "fs";
import { Effect } from "effect";
import { join } from "path";
import { getPrismUserConfigDir } from "./paths.js";
import { readTelemetryPreference } from "./telemetry-preference.js";
import type { JsonValue } from "./services.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ErrorCategory =
  | "ONNX_BigInt"
  | "SQLite_Vec"
  | "RPC_RateLimit"
  | "UpdateFailure"
  | "Helius_Error"
  | "Solana_RPC"
  | "Config_Error"
  | "Unknown";

export type ErrorSeverity = "low" | "medium" | "high" | "critical";

export interface ReportContext {
  readonly cycleId?: string;
  readonly poolAddress?: string;
  readonly severity?: ErrorSeverity;
}

export interface ErrorReport {
  readonly id: string;
  readonly agentId: string;
  readonly ts: string;
  readonly message: string;
  readonly stack: string;
  readonly category: ErrorCategory;
  readonly severity: ErrorSeverity;
  cycleId?: string;
  poolAddress?: string;
  readonly metadata?: JsonValue;
}

export interface ErrorReporterConfig {
  readonly endpoint?: string;
  readonly enabled?: boolean;
  readonly optOut?: boolean;
  readonly agentId?: string;
  readonly flushIntervalMs?: number;
  readonly batchSize?: number;
}

export interface BatchPayload {
  readonly app: string;
  readonly version: string;
  readonly reports: ReadonlyArray<ErrorReport>;
}

/** Request headers built without ever assigning `undefined`. */
type ErrorBatchHeaders = Record<string, string>;

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULT_ERROR_ENDPOINT = "https://prism-api.irfndi.workers.dev/v1/errors/batch";
const DEFAULT_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 5;
const MAX_PENDING_BUFFER = 1000;

interface PrismEnv {
  readonly PRISM_ERROR_ENDPOINT?: string;
  readonly PRISM_ERROR_REPORTING?: string;
  readonly PRISM_AGENT_ID?: string;
}

/** Reads Prism-specific env vars without touching `process` in non-Node runtimes. */
function getPrismEnv(): PrismEnv {
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const processEnv = (globalThis as { readonly process?: { readonly env?: Readonly<PrismEnv> } })
    .process?.env;
  return processEnv ?? {};
}
function readPrismApiKey(): Effect.Effect<string | null, never> {
  return Effect.try({
    try: () => {
      const credentialsFile = join(getPrismUserConfigDir(), "credentials.json");
      if (!existsSync(credentialsFile)) return null;
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      const value = JSON.parse(readFileSync(credentialsFile, "utf-8")) as {
        apiKey?: unknown;
      };
      // SAFETY: The enclosing statement has validated or constructed the asserted contract before this value is consumed.
      return Object.prototype.toString.call(value.apiKey) === "[object String]" &&
        // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
        (value.apiKey as string).length > 0
        ? // SAFETY: The runtime guard or typed fixture immediately above this assertion establishes the required invariant.
          // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
          (value.apiKey as string)
        : null;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

// ─── Sanitization patterns ───────────────────────────────────────────────────
// Base58 chars (no 0/O/I/l): 1-9 A-H J-N P-Z a-k m-z
// Private keys on Solana are 64 bytes → 88 base58 chars typically.
// We target strings >= 64 chars to avoid false-positives on pool addresses.

const BASE58_LONG_PATTERN = /[1-9A-HJ-NP-Za-km-z]{64,}/g;
const HEX_KEY_PATTERN = /\b0x[0-9a-fA-F]{64,}\b/g;
const RAW_HEX_PATTERN = /\b[0-9a-fA-F]{64,}\b/g;
const SECRET_PATTERN =
  /(?:private[-_]?key|secret[-_]?key|mnemonic|seed[-_]?phrase|secret[-_]?recovery)\s*[:=]\s*[^\s,;"]+/gi;
const PASSWORD_PATTERN = /password\s*[:=]\s*[^\s,;"]+/gi;

function sanitizeMessage(msg: string): string {
  let sanitized = msg;
  sanitized = sanitized.replace(BASE58_LONG_PATTERN, "[REDACTED]");
  sanitized = sanitized.replace(HEX_KEY_PATTERN, "[REDACTED]");
  sanitized = sanitized.replace(RAW_HEX_PATTERN, "[REDACTED]");
  sanitized = sanitized.replace(SECRET_PATTERN, (match) => {
    const keyPart = match.split(/[:=]/)[0] ?? match;
    return `${keyPart}=[REDACTED]`;
  });
  sanitized = sanitized.replace(PASSWORD_PATTERN, (match) => {
    const keyPart = match.split(/[:=]/)[0] ?? match;
    return `${keyPart}=[REDACTED]`;
  });
  return sanitized;
}

function sanitizeStack(stack: string): string {
  return stack
    .split("\n")
    .map((line) => sanitizeMessage(line))
    .join("\n");
}

// ─── Error classification ────────────────────────────────────────────────────

/** Ordered: every substring must hit in the combined message+stack. Checked first. */
const COMBINED_ALL_RULES: ReadonlyArray<readonly [ReadonlyArray<string>, ErrorCategory]> = [
  [["bigint", "serializ"], "ONNX_BigInt"],
  [["sqlite", "vec"], "SQLite_Vec"],
];

/** Ordered: first substring hit wins. Covers any-of semantics without predicate helpers. */
const COMBINED_ANY_RULES: ReadonlyArray<readonly [string, ErrorCategory]> = [
  ["rate limit", "RPC_RateLimit"],
  [" 429 ", "RPC_RateLimit"],
  ["helius", "Helius_Error"],
  ["solana", "Solana_RPC"],
  ["rpc error", "Solana_RPC"],
  ["config", "Config_Error"],
];

const UPDATE_MESSAGE_KEYWORDS: ReadonlyArray<string> = ["update", "tarball", "download"];

function matchCombinedRule(combined: string): ErrorCategory | null {
  for (const rule of COMBINED_ALL_RULES) {
    if (rule[0].every((part) => combined.includes(part))) return rule[1];
  }
  for (const rule of COMBINED_ANY_RULES) {
    if (combined.includes(rule[0])) return rule[1];
  }
  return null;
}

function classifyError(error: Error): ErrorCategory {
  const combined = `${error.message ?? ""} ${error.stack ?? ""}`.toLowerCase();
  const matched = matchCombinedRule(combined);
  if (matched !== null) return matched;
  // Only inspect the error message for update-related keywords; stack traces
  // from test frameworks or Vitest internals (e.g. "updateSnapshot") must not
  // cause unrelated errors to be classified as UpdateFailure.
  const lowerMsg = (error.message ?? "").toLowerCase();
  if (UPDATE_MESSAGE_KEYWORDS.some((keyword) => lowerMsg.includes(keyword))) return "UpdateFailure";
  return "Unknown";
}

// ─── ID generator ────────────────────────────────────────────────────────────

let idCounter = 0;

function generateId(): string {
  idCounter++;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveReportingActive(
  configEnabled: boolean | undefined,
  reportingEnv: string | undefined,
  configOptOut: boolean | undefined,
): boolean {
  if (reportingEnv === "false") return false;
  if (configOptOut ?? !readTelemetryPreference().enabled) return false;
  if (configEnabled !== undefined) return configEnabled;
  return reportingEnv !== "false";
}

function resolveReporterEndpoint(
  explicitEndpoint: string | undefined,
  active: boolean,
): string | undefined {
  if (explicitEndpoint !== undefined) return explicitEndpoint;
  if (active) return DEFAULT_ERROR_ENDPOINT;
  return undefined;
}

function resolveAgentId(configAgentId: string | undefined, envAgentId: string | undefined): string {
  if (configAgentId !== undefined) return configAgentId;
  if (envAgentId !== undefined) return envAgentId;
  return "engine";
}

function unrefFlushTimer(timerId: ReturnType<typeof setInterval>): void {
  if (timerId instanceof Object && "unref" in timerId) {
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    (timerId as NodeJS.Timeout).unref();
  }
}

function buildErrorReport(
  agentId: string,
  error: Error,
  severity: ErrorSeverity | undefined,
  cycleId: string | undefined,
  poolAddress: string | undefined,
): ErrorReport {
  const report: ErrorReport = {
    id: generateId(),
    agentId,
    ts: new Date().toISOString(),
    message: sanitizeMessage(error.message),
    stack: error.stack ? sanitizeStack(error.stack) : "",
    category: classifyError(error),
    severity: severity ?? "medium",
  };
  if (cycleId !== undefined) report.cycleId = cycleId;
  if (poolAddress !== undefined) report.poolAddress = poolAddress;
  return report;
}

// ─── ErrorReporter class ─────────────────────────────────────────────────────

export class ErrorReporter {
  private readonly endpoint: string | undefined;
  private readonly enabled: boolean;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly agentId: string;
  private readonly pending: Array<ErrorReport> = [];
  private timerId: ReturnType<typeof setInterval> | null = null;
  private appVersion: string = "0.0.0";
  private _missingCredentialWarned = false;

  constructor(config: ErrorReporterConfig = {}) {
    const env = getPrismEnv();
    const active = resolveReportingActive(config.enabled, env.PRISM_ERROR_REPORTING, config.optOut);
    this.endpoint = resolveReporterEndpoint(config.endpoint ?? env.PRISM_ERROR_ENDPOINT, active);
    this.enabled = active;
    this.agentId = resolveAgentId(config.agentId, env.PRISM_AGENT_ID);
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    if (this.enabled && this.endpoint) {
      this.startFlushTimer();
    }
  }

  private startFlushTimer(): void {
    this.timerId = setInterval(() => {
      Effect.runFork(this.flushEffect());
    }, this.flushIntervalMs);
    // Allow the process to exit even if the timer is still active (Bun/Node return a Timeout object)
    unrefFlushTimer(this.timerId);
  }

  setAppVersion(version: string): void {
    this.appVersion = version;
  }

  report(error: Error, context?: ReportContext): void {
    if (!this.enabled || !this.endpoint) {
      return;
    }
    const report = buildErrorReport(
      this.agentId,
      error,
      context?.severity,
      context?.cycleId,
      context?.poolAddress,
    );
    this.enqueueReport(report);
  }

  private enqueueReport(report: ErrorReport): void {
    if (this.pending.length >= MAX_PENDING_BUFFER) {
      this.pending.shift();
    }
    this.pending.push(report);

    if (this.pending.length >= this.batchSize) {
      Effect.runFork(this.flushEffect());
    }

    console.error(`[ErrorReporter] ${report.category}: ${report.message}`);
  }

  flushEffect(timeoutMs = 10_000): Effect.Effect<void, never> {
    if (!this.enabled || !this.endpoint || this.pending.length === 0) {
      return Effect.void;
    }

    const batch = this.pending.splice(0, this.pending.length);
    const endpoint = this.endpoint;

    return Effect.gen({ self: this }, function* () {
      const apiKey = yield* readPrismApiKey();
      if (!apiKey && endpoint === DEFAULT_ERROR_ENDPOINT) {
        // Credential-bounded: never send without an API key. Re-queue the
        // batch so reports are not lost, but avoid spamming warnings on
        // every flush when credentials are absent.
        if (!this._missingCredentialWarned) {
          this._missingCredentialWarned = true;
          console.warn("[ErrorReporter] Skipping error report batch: no API key available");
        }
        this.requeueBatch(batch);
        return;
      }
      this._missingCredentialWarned = false;
      const payload: BatchPayload = {
        app: "prism-liquidity-agent",
        version: this.appVersion,
        reports: batch,
      };
      const headers: ErrorBatchHeaders = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      });
      if (!response.ok) {
        this.requeueBatch(batch);
        console.error(
          `[ErrorReporter] Failed to send batch: ${response.status} ${response.statusText} (${batch.length} reports re-queued)`,
        );
      }
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          this.requeueBatch(batch);
          console.error("[ErrorReporter] Failed to send error report batch, re-queued:", err);
        }),
      ),
    );
  }

  private requeueBatch(batch: ReadonlyArray<ErrorReport>): void {
    this.pending.unshift(...batch);
    const overflow = this.pending.length - MAX_PENDING_BUFFER;
    if (overflow > 0) {
      this.pending.splice(MAX_PENDING_BUFFER, overflow);
    }
  }

  /**
   * Trigger an async flush and return a Promise that resolves when it
   * completes. Useful for shutdown paths and tests that need to assert
   * the network call happened. Aborts the fetch after `timeoutMs` so a
   * hung endpoint cannot block process exit.
   */
  flushAsync(timeoutMs = 10_000): Promise<void> {
    return Effect.runPromise(this.flushEffect(timeoutMs));
  }

  getPending(): ReadonlyArray<ErrorReport> {
    return [...this.pending];
  }

  disposeEffect(): Effect.Effect<void, never> {
    return Effect.gen({ self: this }, function* () {
      if (this.timerId !== null) {
        clearInterval(this.timerId);
        this.timerId = null;
      }
      yield* this.flushEffect(2_000);
    });
  }

  dispose(): Promise<void> {
    return Effect.runPromise(this.disposeEffect());
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createErrorReporter(config?: ErrorReporterConfig): ErrorReporter {
  return new ErrorReporter(config);
}

// ─── Module-level singleton ──────────────────────────────────────────────────

export const errorReporter: ErrorReporter = new ErrorReporter();
