import { Effect, Layer } from "effect";
import { createHash, randomUUID } from "crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ConfigService } from "./config-service.js";
import { DbService, type DbApi } from "./services.js";
import { createLogger } from "./logger.js";
import {
  FeedbackService,
  type AgentFeedback,
  type FeedbackCategory,
  type FeedbackContext,
  type FeedbackEntry,
  type FeedbackResult,
  type FeedbackSeverity,
} from "./services.js";
import { getCurrentVersion } from "./version.js";
import { detectInstallMethod } from "./install-method.js";
import { getPrismUserConfigDir } from "./paths.js";

const logger = createLogger("feedback");

const FEEDBACK_LIMITS = {
  perHour: 5,
  perDay: 10,
  minIntervalMs: 60_000,
  duplicateCooldownMs: 24 * 60 * 60 * 1000,
} as const;

const DEFAULT_CLOUD_FEEDBACK_URL = "https://prism-api.irfndi.workers.dev/v1/feedback";

interface CloudFeedbackPayload {
  id: string;
  agentId: string;
  category: string;
  severity: string;
  summary: string;
  details?: string | undefined;
  relatedFiles?: string[] | undefined;
  context: FeedbackContext;
  hash: string;
  reportedAt: number;
}

interface CloudFeedbackResponse {
  readonly id?: unknown;
  readonly duplicate?: unknown;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

function readString<T>(value: T): string | null {
  // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
  return Object.prototype.toString.call(value) === "[object String]" ? (value as string) : null;
}

function submitCloudFeedback(
  apiUrl: string,
  payload: CloudFeedbackPayload,
  apiKey: string,
): Effect.Effect<CloudFeedbackResult, never> {
  return Effect.gen(function* () {
    const res = yield* Effect.tryPromise(() =>
      fetch(apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      }),
    );
    if (res.status === 401 || res.status === 403) return { authFailure: true as const };
    if (!res.ok) return null;
    // SAFETY: The value is intentionally opaque at this boundary and is validated by the enclosing parser or schema before domain use.
    const json = (yield* Effect.tryPromise(() => res.json())) as unknown;
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    const response = isNonNullObject(json) ? (json as CloudFeedbackResponse) : null;
    if (response === null || readString(response.id) === null) return null;
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    return { id: response.id as string, duplicate: response.duplicate === true };
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function hashFeedback(summary: string, details: string | undefined, category: string): string {
  const normalized = `${category}:${summary.trim().toLowerCase()}:${(details ?? "").trim().toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

const OPT_OUT_FILE = join(homedir(), ".config", "prism", "feedback-opt-out");

function readOptOut(): Effect.Effect<boolean, never> {
  return Effect.try({
    try: () => existsSync(OPT_OUT_FILE) && readFileSync(OPT_OUT_FILE, "utf-8").trim() === "true",
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch(() => Effect.succeed(false)));
}

function writeOptOut(value: boolean): Effect.Effect<void, never> {
  return Effect.try({
    try: () => {
      mkdirSync(join(homedir(), ".config", "prism"), { recursive: true });
      writeFileSync(OPT_OUT_FILE, value ? "true" : "false");
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.catch(() => Effect.void),
    Effect.asVoid,
  );
}

// SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
const bunRuntime = (globalThis as { readonly Bun?: { readonly version?: string } }).Bun;
const runningOnBun = bunRuntime !== undefined;

/** Owner contract for the mutable build of a FeedbackContext. */
interface MutableFeedbackContext {
  prismVersion: string;
  installMethod: string;
  platform: string;
  runtime: string;
  nodeVersion?: string;
}

function buildContext(): FeedbackContext {
  const ctx: MutableFeedbackContext = {
    prismVersion: getCurrentVersion(),
    installMethod: detectInstallMethod(),
    platform: `${process.platform}-${process.arch}`,
    runtime: runningOnBun ? `bun ${bunRuntime?.version ?? ""}` : `node ${process.version}`,
  };
  if (!runningOnBun) {
    ctx.nodeVersion = process.version;
  }
  return ctx;
}

function detectAgentId(): Effect.Effect<string, never> {
  const walletPath = join(homedir(), ".config", "prism", "agent-id");
  return Effect.gen(function* () {
    const existing = yield* Effect.try({
      try: () => (existsSync(walletPath) ? readFileSync(walletPath, "utf-8").trim() : null),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (existing) return existing;

    const fingerprint = `${process.platform}-${process.arch}-${homedir()}-${process.cwd()}`;
    const id = createHash("sha256").update(fingerprint).digest("hex").slice(0, 8);
    yield* Effect.try({
      try: () => {
        const dir = join(homedir(), ".config", "prism");
        mkdirSync(dir, { recursive: true });
        writeFileSync(walletPath, id, { mode: 0o600 });
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(Effect.catch(() => Effect.void));
    return id;
  });
}

function readPrismApiKey(): Effect.Effect<string | null, never> {
  return Effect.try({
    try: () => {
      const credentialsFile =
        process.env.PRISM_CREDENTIALS_FILE ?? join(getPrismUserConfigDir(), "credentials.json");
      if (!existsSync(credentialsFile)) return null;
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      const value = JSON.parse(readFileSync(credentialsFile, "utf-8")) as {
        apiKey?: unknown;
      };
      const apiKey = readString(value.apiKey);
      return apiKey !== null && apiKey.length > 0 ? apiKey : null;
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(Effect.catch(() => Effect.succeed(null)));
}

function toFeedbackEntry(row: {
  id: string;
  agentId: string;
  category: string;
  severity: string;
  summary: string;
  details: string | null;
  relatedFiles: ReadonlyArray<string>;
  contextJson: string;
  githubIssueNumber: number | null;
  githubIssueUrl: string | null;
  reportedAt: number;
  hash: string;
}): FeedbackEntry {
  return {
    id: row.id,
    agentId: row.agentId,
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    category: row.category as FeedbackEntry["category"],
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    severity: row.severity as FeedbackEntry["severity"],
    summary: row.summary,
    details: row.details,
    relatedFiles: row.relatedFiles,
    contextJson: row.contextJson,
    githubIssueNumber: row.githubIssueNumber,
    githubIssueUrl: row.githubIssueUrl,
    reportedAt: row.reportedAt,
    hash: row.hash,
  };
}

type CloudFeedbackResult =
  | { readonly id: string; readonly duplicate: boolean }
  | { readonly authFailure: true }
  | null;

function resolveCloudFeedbackUrl(envApiUrl: string | undefined): string {
  if (!envApiUrl) return DEFAULT_CLOUD_FEEDBACK_URL;
  return `${envApiUrl}/v1/feedback`;
}

function duplicateCooldownResult(local: FeedbackEntry | null, now: number): FeedbackResult | null {
  if (local === null) return null;
  const ageMs = now - local.reportedAt;
  if (ageMs >= FEEDBACK_LIMITS.duplicateCooldownMs) return null;
  logger.info(`Skipping duplicate feedback (cooldown ${Math.round(ageMs / 1000)}s)`);
  return { kind: "local_only", localId: local.id };
}

function countRecentSubmissions(
  entries: ReadonlyArray<{ readonly reportedAt: number }>,
  now: number,
  windowMs: number,
): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (const entry of entries) {
    if (entry.reportedAt > cutoff) count += 1;
  }
  return count;
}

function lastSubmissionAt(entries: ReadonlyArray<{ readonly reportedAt: number }>): number | null {
  if (entries.length === 0) return null;
  return Math.max(...entries.map((entry) => entry.reportedAt));
}

function rateLimitResult(
  entries: ReadonlyArray<{ readonly reportedAt: number }>,
  now: number,
): FeedbackResult | null {
  if (countRecentSubmissions(entries, now, 60 * 60 * 1000) >= FEEDBACK_LIMITS.perHour) {
    return { kind: "rate_limited", reason: `Exceeded ${FEEDBACK_LIMITS.perHour} per hour` };
  }
  if (countRecentSubmissions(entries, now, 24 * 60 * 60 * 1000) >= FEEDBACK_LIMITS.perDay) {
    return { kind: "rate_limited", reason: `Exceeded ${FEEDBACK_LIMITS.perDay} per day` };
  }
  const last = lastSubmissionAt(entries);
  if (last !== null && now - last < FEEDBACK_LIMITS.minIntervalMs) {
    return {
      kind: "rate_limited",
      reason: `Minimum interval is ${FEEDBACK_LIMITS.minIntervalMs / 1000}s`,
    };
  }
  return null;
}

function buildCloudPayload(
  cloudId: string,
  agentId: string,
  category: FeedbackCategory,
  severity: FeedbackSeverity,
  summary: string,
  details: string | undefined,
  relatedFiles: ReadonlyArray<string> | undefined,
  context: FeedbackContext,
  hash: string,
  reportedAt: number,
): CloudFeedbackPayload {
  return {
    id: cloudId,
    agentId,
    category,
    severity,
    summary,
    details,
    relatedFiles: relatedFiles ? [...relatedFiles] : undefined,
    context,
    hash,
    reportedAt,
  };
}

function buildStoredFeedbackEntry(
  id: string,
  agentId: string,
  category: FeedbackCategory,
  severity: FeedbackSeverity,
  summary: string,
  details: string | undefined,
  relatedFiles: ReadonlyArray<string> | undefined,
  contextJson: string,
  reportedAt: number,
  hash: string,
): FeedbackEntry {
  return {
    id,
    agentId,
    category,
    severity,
    summary,
    details: details ?? null,
    relatedFiles: relatedFiles ?? [],
    contextJson,
    githubIssueNumber: null,
    githubIssueUrl: null,
    reportedAt,
    hash,
  };
}

function persistCloudOrLocal(
  db: DbApi,
  cloudResult: CloudFeedbackResult,
  entry: FeedbackEntry,
  summary: string,
): Effect.Effect<FeedbackResult, Error> {
  return Effect.gen(function* () {
    if (cloudResult && "authFailure" in cloudResult) {
      return {
        kind: "error" as const,
        error: "Prism cloud rejected the stored credentials. Run 'prism login' again.",
      } satisfies FeedbackResult;
    }
    if (cloudResult) {
      const cloudEntry: FeedbackEntry = { ...entry, id: cloudResult.id };
      yield* db.saveFeedback(cloudEntry);
      logger.info(`Submitted feedback to Prism cloud: ${summary}`);
      return { kind: "cloud" as const, id: cloudResult.id, duplicate: cloudResult.duplicate };
    }
    yield* db.saveFeedback(entry);
    logger.warn(`Cloud feedback unavailable; feedback stored locally: ${summary}`);
    return { kind: "local_only" as const, localId: entry.id };
  });
}

export const FeedbackLive = Layer.effect(
  FeedbackService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const db = yield* DbService;
    const agentId = yield* detectAgentId();
    const state = { optOut: config.feedbackOptOut || (yield* readOptOut()) };

    const submit = (rawFeedback: AgentFeedback): Effect.Effect<FeedbackResult, never> =>
      Effect.gen(function* () {
        if (state.optOut) {
          return { kind: "opt_out" as const };
        }
        const context: FeedbackContext = rawFeedback.context ?? buildContext();
        const feedback: AgentFeedback = {
          ...rawFeedback,
          context,
        };
        const hash = hashFeedback(feedback.summary, feedback.details, feedback.category);
        const apiKey = yield* readPrismApiKey();
        if (!apiKey) {
          return {
            kind: "error" as const,
            error: "Prism account required. Run 'prism register' first.",
          } satisfies FeedbackResult;
        }

        const localRow = yield* db.getFeedbackByHash(hash, agentId);
        const duplicate = duplicateCooldownResult(
          localRow ? toFeedbackEntry(localRow) : null,
          Date.now(),
        );
        if (duplicate) {
          return duplicate;
        }

        const allRecent = yield* db.listFeedbackForAgent(agentId);
        const limited = rateLimitResult(allRecent, Date.now());
        if (limited) {
          return limited;
        }

        const reportedAt = Date.now();
        const cloudResult = yield* submitCloudFeedback(
          resolveCloudFeedbackUrl(process.env.PRISM_API_URL),
          buildCloudPayload(
            randomUUID(),
            agentId,
            feedback.category,
            feedback.severity,
            feedback.summary,
            feedback.details,
            feedback.relatedFiles,
            context,
            hash,
            reportedAt,
          ),
          apiKey,
        );
        const entry = buildStoredFeedbackEntry(
          `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          agentId,
          feedback.category,
          feedback.severity,
          feedback.summary,
          feedback.details,
          feedback.relatedFiles,
          JSON.stringify(context),
          reportedAt,
          hash,
        );
        return yield* persistCloudOrLocal(db, cloudResult, entry, feedback.summary);
      }).pipe(
        Effect.catch(<T>(err: T) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(`Feedback submission failed: ${message}`);
          return Effect.succeed({
            kind: "error" as const,
            error: message,
          } satisfies FeedbackResult);
        }),
      );

    return {
      submit,
      list: () => Effect.map(db.listFeedbackForAgent(agentId), (rows) => rows.map(toFeedbackEntry)),
      listForAgent: (id: string) =>
        Effect.map(db.listFeedbackForAgent(id), (rows) => rows.map(toFeedbackEntry)),
      getByHash: (hash: string) =>
        Effect.flatMap(db.getFeedbackByHash(hash, agentId), (row) =>
          Effect.succeed(row ? toFeedbackEntry(row) : null),
        ),
      setOptOut: (value: boolean) =>
        Effect.gen(function* () {
          state.optOut = value;
          yield* writeOptOut(value);
        }),
      getOptOut: () => Effect.sync(() => state.optOut),
    };
  }),
);
