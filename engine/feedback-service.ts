import { Effect, Layer } from "effect";
import { createHash, randomUUID } from "crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { ConfigService } from "./config-service.js";
import { DbService } from "./services.js";
import { createLogger } from "./logger.js";
import {
  FeedbackService,
  type AgentFeedback,
  type FeedbackContext,
  type FeedbackEntry,
  type FeedbackResult,
} from "./services.js";
import { getCurrentVersion } from "./version.js";
import { detectInstallMethod } from "./install-method.js";
import { getPrismConfigDir } from "./paths.js";

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

function submitCloudFeedback(
  apiUrl: string,
  payload: CloudFeedbackPayload,
  apiKey: string,
): Effect.Effect<
  { readonly id: string; readonly duplicate: boolean } | { readonly authFailure: true } | null,
  never
> {
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
    const json = (yield* Effect.tryPromise(() => res.json())) as Record<string, unknown>;
    if (typeof json.id !== "string") return null;
    return { id: json.id, duplicate: json.duplicate === true };
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
}

function hashFeedback(summary: string, details: string | undefined, category: string): string {
  const normalized = `${category}:${summary.trim().toLowerCase()}:${(details ?? "").trim().toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

const OPT_OUT_FILE = join(homedir(), ".config", "prism", "feedback-opt-out");

function readOptOut(): Effect.Effect<boolean, never> {
  return Effect.try({
    try: () => existsSync(OPT_OUT_FILE) && readFileSync(OPT_OUT_FILE, "utf-8").trim() === "true",
    catch: (cause) => cause,
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));
}

function writeOptOut(value: boolean): Effect.Effect<void, never> {
  return Effect.try({
    try: () => {
      mkdirSync(join(homedir(), ".config", "prism"), { recursive: true });
      writeFileSync(OPT_OUT_FILE, value ? "true" : "false");
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchAll(() => Effect.void),
    Effect.asVoid,
  );
}

function buildContext(): FeedbackContext {
  const ctx: {
    prismVersion: string;
    installMethod: string;
    platform: string;
    runtime: string;
    nodeVersion?: string;
  } = {
    prismVersion: getCurrentVersion(),
    installMethod: detectInstallMethod(),
    platform: `${process.platform}-${process.arch}`,
    runtime: typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`,
  };
  if (typeof Bun === "undefined") {
    ctx.nodeVersion = process.version;
  }
  return ctx;
}

function detectAgentId(): Effect.Effect<string, never> {
  const walletPath = join(homedir(), ".config", "prism", "agent-id");
  return Effect.gen(function* () {
    const existing = yield* Effect.try({
      try: () => (existsSync(walletPath) ? readFileSync(walletPath, "utf-8").trim() : null),
      catch: (cause) => cause,
    }).pipe(Effect.catchAll(() => Effect.succeed(null)));
    if (existing) return existing;

    const fingerprint = `${process.platform}-${process.arch}-${homedir()}-${process.cwd()}`;
    const id = createHash("sha256").update(fingerprint).digest("hex").slice(0, 8);
    yield* Effect.try({
      try: () => {
        const dir = join(homedir(), ".config", "prism");
        mkdirSync(dir, { recursive: true });
        writeFileSync(walletPath, id, { mode: 0o600 });
      },
      catch: (cause) => cause,
    }).pipe(Effect.catchAll(() => Effect.void));
    return id;
  });
}

function readPrismApiKey(): Effect.Effect<string | null, never> {
  return Effect.try({
    try: () => {
      const credentialsFile =
        process.env.PRISM_CREDENTIALS_FILE ?? join(getPrismConfigDir(), "credentials.json");
      if (!existsSync(credentialsFile)) return null;
      const value = JSON.parse(readFileSync(credentialsFile, "utf-8")) as {
        apiKey?: unknown;
      };
      return typeof value.apiKey === "string" && value.apiKey.length > 0 ? value.apiKey : null;
    },
    catch: (cause) => cause,
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
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
    category: row.category as FeedbackEntry["category"],
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
        const local = localRow ? toFeedbackEntry(localRow) : null;
        if (local) {
          const ageMs = Date.now() - local.reportedAt;
          if (ageMs < FEEDBACK_LIMITS.duplicateCooldownMs) {
            logger.info(`Skipping duplicate feedback (cooldown ${Math.round(ageMs / 1000)}s)`);
            return {
              kind: "local_only" as const,
              localId: local.id,
            };
          }
        }

        const allRecent = yield* db.listFeedbackForAgent(agentId);
        const now = Date.now();
        const rateHourCount = allRecent.filter((f) => f.reportedAt > now - 60 * 60 * 1000).length;
        if (rateHourCount >= FEEDBACK_LIMITS.perHour) {
          return {
            kind: "rate_limited" as const,
            reason: `Exceeded ${FEEDBACK_LIMITS.perHour} per hour`,
          };
        }
        const rateDayCount = allRecent.filter(
          (f) => f.reportedAt > now - 24 * 60 * 60 * 1000,
        ).length;
        if (rateDayCount >= FEEDBACK_LIMITS.perDay) {
          return {
            kind: "rate_limited" as const,
            reason: `Exceeded ${FEEDBACK_LIMITS.perDay} per day`,
          };
        }
        if (allRecent.length > 0) {
          const lastSubmission = Math.max(...allRecent.map((f) => f.reportedAt));
          if (now - lastSubmission < FEEDBACK_LIMITS.minIntervalMs) {
            return {
              kind: "rate_limited" as const,
              reason: `Minimum interval is ${FEEDBACK_LIMITS.minIntervalMs / 1000}s`,
            };
          }
        }

        const cloudUrl = process.env.PRISM_API_URL
          ? `${process.env.PRISM_API_URL}/v1/feedback`
          : DEFAULT_CLOUD_FEEDBACK_URL;
        const reportedAt = Date.now();
        const cloudId = randomUUID();
        const cloudResult = yield* submitCloudFeedback(
          cloudUrl,
          {
            id: cloudId,
            agentId,
            category: feedback.category,
            severity: feedback.severity,
            summary: feedback.summary,
            details: feedback.details,
            relatedFiles: feedback.relatedFiles ? [...feedback.relatedFiles] : undefined,
            context,
            hash,
            reportedAt,
          },
          apiKey,
        );

        if (cloudResult && "authFailure" in cloudResult) {
          return {
            kind: "error" as const,
            error: "Prism cloud rejected the stored credentials. Run 'prism login' again.",
          } satisfies FeedbackResult;
        }

        if (cloudResult) {
          const entry: FeedbackEntry = {
            id: cloudResult.id,
            agentId,
            category: feedback.category,
            severity: feedback.severity,
            summary: feedback.summary,
            details: feedback.details ?? null,
            relatedFiles: feedback.relatedFiles ?? [],
            contextJson: JSON.stringify(context),
            githubIssueNumber: null,
            githubIssueUrl: null,
            reportedAt,
            hash,
          };
          yield* db.saveFeedback(entry);
          logger.info(`Submitted feedback to Prism cloud: ${feedback.summary}`);
          return { kind: "cloud" as const, id: cloudResult.id, duplicate: cloudResult.duplicate };
        }

        const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const entry: FeedbackEntry = {
          id: localId,
          agentId,
          category: feedback.category,
          severity: feedback.severity,
          summary: feedback.summary,
          details: feedback.details ?? null,
          relatedFiles: feedback.relatedFiles ?? [],
          contextJson: JSON.stringify(context),
          githubIssueNumber: null,
          githubIssueUrl: null,
          reportedAt,
          hash,
        };
        yield* db.saveFeedback(entry);
        logger.warn(`Cloud feedback unavailable; feedback stored locally: ${feedback.summary}`);
        return { kind: "local_only" as const, localId };
      }).pipe(
        Effect.catchAll((err: unknown) => {
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
