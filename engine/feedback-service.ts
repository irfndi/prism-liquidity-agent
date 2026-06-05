import { Effect, Layer } from "effect";
import { createHash } from "crypto";
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

const logger = createLogger("feedback");

const FEEDBACK_LIMITS = {
  perHour: 5,
  perDay: 10,
  minIntervalMs: 60_000,
  duplicateCooldownMs: 24 * 60 * 60 * 1000,
} as const;

const SIMILARITY_THRESHOLD = 0.7;
const MAX_KEYWORDS = 5;
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "and",
  "or",
  "but",
  "if",
  "then",
  "else",
  "when",
  "where",
  "while",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "it",
  "this",
  "that",
  "these",
  "those",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "its",
  "me",
  "him",
  "us",
  "them",
]);

function hashFeedback(summary: string, details: string | undefined, category: string): string {
  const normalized = `${category}:${summary.trim().toLowerCase()}:${(details ?? "").trim().toLowerCase()}`;
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function extractKeywords(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)),
    ),
  ).slice(0, MAX_KEYWORDS);
}

function jaccardSimilarity(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function detectInstallMethod(): string {
  const prismDir = join(homedir(), ".prism");
  if (existsSync(join(prismDir, ".tarball-install"))) return "tarball";
  if (process.env.PRISM_TARBALL_INSTALL === "1") return "tarball";
  const wrapperPath = join(homedir(), ".local", "bin", "prism");
  if (existsSync(wrapperPath)) return "curl";
  if (existsSync(join(process.cwd(), ".git"))) return "git";
  return "unknown";
}

const OPT_OUT_FILE = join(homedir(), ".config", "prism", "feedback-opt-out");

function readOptOut(): boolean {
  try {
    if (existsSync(OPT_OUT_FILE)) {
      return readFileSync(OPT_OUT_FILE, "utf-8").trim() === "true";
    }
  } catch {}
  return false;
}

function writeOptOut(value: boolean): void {
  try {
    mkdirSync(join(homedir(), ".config", "prism"), { recursive: true });
    writeFileSync(OPT_OUT_FILE, value ? "true" : "false");
  } catch {}
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

function detectAgentId(): string {
  const walletPath = join(homedir(), ".config", "prism", "agent-id");
  if (existsSync(walletPath)) {
    return readFileSync(walletPath, "utf-8").trim();
  }
  const fingerprint = `${process.platform}-${process.arch}-${homedir()}-${process.cwd()}`;
  const id = createHash("sha256").update(fingerprint).digest("hex").slice(0, 8);
  try {
    const dir = join(homedir(), ".config", "prism");
    mkdirSync(dir, { recursive: true });
    writeFileSync(walletPath, id, { mode: 0o600 });
  } catch {
    // best-effort
  }
  return id;
}

interface GitHubIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly html_url: string;
  readonly state: string;
}

interface GitHubSearchResponse {
  readonly items: ReadonlyArray<GitHubIssue>;
}

interface GitHubCreateResponse {
  readonly number: number;
  readonly html_url: string;
}

const ghHeaders = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "prism-feedback",
});

function searchGitHubIssues(
  token: string,
  repo: string,
  keywords: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<GitHubIssue>, unknown> {
  if (keywords.length === 0) return Effect.succeed([]);
  const query = encodeURIComponent(
    `repo:${repo} label:agent-feedback is:open ${keywords.join(" ")}`,
  );
  return Effect.tryPromise({
    try: () =>
      fetch(`https://api.github.com/search/issues?q=${query}&per_page=50`, {
        headers: ghHeaders(token),
      }).then(async (res) => {
        if (!res.ok) {
          logger.warn(`GitHub search returned ${res.status}; treating as no duplicates`);
          return [] as ReadonlyArray<GitHubIssue>;
        }
        const data = (await res.json()) as GitHubSearchResponse;
        return data.items;
      }),
    catch: (err: unknown) => err,
  });
}

function createGitHubIssue(
  token: string,
  repo: string,
  title: string,
  body: string,
): Effect.Effect<GitHubCreateResponse, unknown> {
  return Effect.tryPromise({
    try: () =>
      fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: "POST",
        headers: { ...ghHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, labels: ["agent-feedback"] }),
      }).then(async (res) => {
        if (!res.ok) {
          const errBody = await res.text();
          throw new Error(`GitHub create issue failed: ${res.status} ${errBody.slice(0, 200)}`);
        }
        return (await res.json()) as GitHubCreateResponse;
      }),
    catch: (err: unknown) => err,
  });
}

function commentOnGitHubIssue(
  token: string,
  repo: string,
  issueNumber: number,
  body: string,
): Effect.Effect<void, unknown> {
  return Effect.tryPromise({
    try: () =>
      fetch(`https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`, {
        method: "POST",
        headers: { ...ghHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      }).then(async (res) => {
        if (!res.ok) throw new Error(`GitHub comment failed: ${res.status}`);
      }),
    catch: (err: unknown) => err,
  });
}

function formatNewIssueBody(
  feedback: AgentFeedback,
  context: FeedbackContext,
  agentId: string,
): string {
  const lines: string[] = [
    "## Agent Feedback",
    "",
    `**Category:** ${feedback.category}`,
    `**Severity:** ${feedback.severity}`,
    `**Agent ID:** ${agentId}`,
    `**Version:** ${context.prismVersion}`,
    `**Platform:** ${context.platform}`,
    `**Install method:** ${context.installMethod}`,
    `**Runtime:** ${context.runtime}`,
    "",
    "### Summary",
    feedback.summary,
  ];
  if (feedback.details) {
    lines.push("", "### Details", feedback.details);
  }
  if (feedback.relatedFiles && feedback.relatedFiles.length > 0) {
    lines.push("", "### Related files", ...feedback.relatedFiles.map((f) => `- \`${f}\``));
  }
  lines.push(
    "",
    "---",
    "*This issue was automatically created by a Prism agent. If you're a human, please add the `confirmed` label if this is valid.*",
  );
  return lines.join("\n");
}

function formatCommentBody(
  feedback: AgentFeedback,
  context: FeedbackContext,
  agentId: string,
): string {
  const parts: string[] = [
    `+1 from agent on ${context.platform} (${context.runtime}).`,
    "",
    feedback.summary,
  ];
  if (feedback.details) parts.push("", feedback.details);
  parts.push("", `Agent ID: ${agentId}`);
  return parts.join("\n");
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
    const agentId = detectAgentId();
    const state = { optOut: config.feedbackOptOut || readOptOut() };

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

        const localRow = yield* db.getFeedbackByHash(hash, agentId);
        const local = localRow ? toFeedbackEntry(localRow) : null;
        if (local) {
          const ageMs = Date.now() - local.reportedAt;
          if (ageMs < FEEDBACK_LIMITS.duplicateCooldownMs) {
            logger.info(
              `Skipping duplicate feedback (cooldown ${Math.round(ageMs / 1000)}s): ` +
                `${feedback.summary} → issue #${local.githubIssueNumber}`,
            );

            if (local.githubIssueNumber !== null) {
              return {
                kind: "duplicate" as const,
                issueNumber: local.githubIssueNumber,
                issueUrl: local.githubIssueUrl ?? "",
              };
            }
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
          return { kind: "rate_limited" as const, reason: `Exceeded ${FEEDBACK_LIMITS.perHour} per hour` };
        }
        const rateDayCount = allRecent.filter((f) => f.reportedAt > now - 24 * 60 * 60 * 1000).length;
        if (rateDayCount >= FEEDBACK_LIMITS.perDay) {
          return { kind: "rate_limited" as const, reason: `Exceeded ${FEEDBACK_LIMITS.perDay} per day` };
        }
        if (allRecent.length > 0) {
          const lastSubmission = Math.max(...allRecent.map((f) => f.reportedAt));
          if (now - lastSubmission < FEEDBACK_LIMITS.minIntervalMs) {
            return { kind: "rate_limited" as const, reason: `Minimum interval is ${FEEDBACK_LIMITS.minIntervalMs / 1000}s` };
          }
        }

        if (!config.githubToken) {
          const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const entry: FeedbackEntry = {
            id: localId,
            agentId,
            category: feedback.category,
            severity: feedback.severity,
            summary: feedback.summary,
            details: feedback.details ?? null,
            relatedFiles: feedback.relatedFiles ?? [],
            contextJson: JSON.stringify(feedback.context),
            githubIssueNumber: null,
            githubIssueUrl: null,
            reportedAt: Date.now(),
            hash,
          };
          yield* db.saveFeedback(entry);
          logger.warn(
            "GITHUB_TOKEN unset — feedback stored locally only. " +
              "Set GITHUB_TOKEN to enable GitHub Issues filing.",
          );
          return { kind: "local_only" as const, localId };
        }

        const recentHour = yield* db.getRecentFeedbackForAgent(
          agentId,
          Date.now() - 60 * 60 * 1000,
        );
        if (recentHour.length >= FEEDBACK_LIMITS.perHour) {
          return {
            kind: "rate_limited" as const,
            reason: `Exceeded ${FEEDBACK_LIMITS.perHour} feedback items per hour`,
          };
        }
        const recentDay = yield* db.getRecentFeedbackForAgent(
          agentId,
          Date.now() - 24 * 60 * 60 * 1000,
        );
        if (recentDay.length >= FEEDBACK_LIMITS.perDay) {
          return {
            kind: "rate_limited" as const,
            reason: `Exceeded ${FEEDBACK_LIMITS.perDay} feedback items per day`,
          };
        }
        const lastRow = yield* db.getLastFeedbackForAgent(agentId);
        const last = lastRow ? toFeedbackEntry(lastRow) : null;
        if (last && Date.now() - last.reportedAt < FEEDBACK_LIMITS.minIntervalMs) {
          const wait = Math.round(
            (FEEDBACK_LIMITS.minIntervalMs - (Date.now() - last.reportedAt)) / 1000,
          );
          return {
            kind: "rate_limited" as const,
            reason: `Minimum interval between feedback is ${FEEDBACK_LIMITS.minIntervalMs / 1000}s (wait ${wait}s)`,
          };
        }

        const keywords = extractKeywords(`${feedback.summary} ${feedback.details ?? ""}`);
        const issues = yield* searchGitHubIssues(config.githubToken, config.githubRepo, keywords);

        const feedbackKw = keywords;
        let existing: { number: number; html_url: string } | null = null;
        for (const issue of issues) {
          const issueKw = extractKeywords(`${issue.title} ${issue.body}`);
          if (jaccardSimilarity(feedbackKw, issueKw) >= SIMILARITY_THRESHOLD) {
            existing = { number: issue.number, html_url: issue.html_url };
            break;
          }
        }

        if (existing) {
          yield* commentOnGitHubIssue(
            config.githubToken,
            config.githubRepo,
            existing.number,
            formatCommentBody(feedback, context, agentId),
          );
          const entry: FeedbackEntry = {
            id: `gh-comment-${existing.number}-${Date.now()}`,
            agentId,
            category: feedback.category,
            severity: feedback.severity,
            summary: feedback.summary,
            details: feedback.details ?? null,
            relatedFiles: feedback.relatedFiles ?? [],
            contextJson: JSON.stringify(feedback.context),
            githubIssueNumber: existing.number,
            githubIssueUrl: existing.html_url,
            reportedAt: Date.now(),
            hash,
          };
          yield* db.saveFeedback(entry);
          logger.info(`Added +1 to existing issue #${existing.number} for: ${feedback.summary}`);
          return {
            kind: "duplicate" as const,
            issueNumber: existing.number,
            issueUrl: existing.html_url,
          };
        }

        const issueTitle =
          feedback.summary.length > 256 ? feedback.summary.slice(0, 253) + "..." : feedback.summary;
        const created = yield* createGitHubIssue(
          config.githubToken,
          config.githubRepo,
          issueTitle,
          formatNewIssueBody(feedback, context, agentId),
        );
        const entry: FeedbackEntry = {
          id: `gh-created-${created.number}-${Date.now()}`,
          agentId,
          category: feedback.category,
          severity: feedback.severity,
          summary: feedback.summary,
          details: feedback.details ?? null,
          relatedFiles: feedback.relatedFiles ?? [],
          contextJson: JSON.stringify(feedback.context),
          githubIssueNumber: created.number,
          githubIssueUrl: created.html_url,
          reportedAt: Date.now(),
          hash,
        };
        yield* db.saveFeedback(entry);
        logger.info(`Filed new issue #${created.number} for: ${feedback.summary}`);
        return {
          kind: "created" as const,
          issueNumber: created.number,
          issueUrl: created.html_url,
        };
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
        Effect.sync(() => {
          state.optOut = value;
          writeOptOut(value);
        }),
      getOptOut: () => Effect.sync(() => state.optOut),
    };
  }),
);
