import { Command } from "commander";
import { Effect, Layer } from "effect";
import { ConfigService, ConfigLive } from "../engine/config-service.js";
import { DbLive } from "../engine/db-service.js";
import { FeedbackLive } from "../engine/feedback-service.js";
import {
  FeedbackService,
  type AgentFeedback,
  type FeedbackCategory,
  type FeedbackResult,
  type FeedbackSeverity,
} from "../engine/services.js";
import { createLogger } from "../engine/logger.js";
import { getPrismDbPath } from "../engine/paths.js";
import { requireRegistered } from "./api.js";

const logger = createLogger("feedback-cli");

const VALID_CATEGORIES: ReadonlyArray<FeedbackCategory> = [
  "friction",
  "suggestion",
  "observation",
  "praise",
];
const VALID_SEVERITIES: ReadonlyArray<FeedbackSeverity> = ["low", "medium", "high"];

function parseCategory(raw: string | undefined, fallback: FeedbackCategory): FeedbackCategory {
  const value = raw ?? fallback;
  if (!VALID_CATEGORIES.includes(value as FeedbackCategory)) {
    throw new Error(`Invalid category '${value}'. Valid: ${VALID_CATEGORIES.join(", ")}`);
  }
  return value as FeedbackCategory;
}

function parseSeverity(raw: string | undefined, fallback: FeedbackSeverity): FeedbackSeverity {
  const value = raw ?? fallback;
  if (!VALID_SEVERITIES.includes(value as FeedbackSeverity)) {
    throw new Error(`Invalid severity '${value}'. Valid: ${VALID_SEVERITIES.join(", ")}`);
  }
  return value as FeedbackSeverity;
}

function buildProgram(): Layer.Layer<FeedbackService | ConfigService, never, never> {
  return Layer.merge(
    Layer.provide(
      FeedbackLive,
      Layer.merge(ConfigLive, DbLive(process.env.SQLITE_DB_PATH ?? getPrismDbPath())),
    ),
    ConfigLive,
  );
}

function formatResult(result: FeedbackResult): string {
  switch (result.kind) {
    case "rate_limited":
      return `⚠ Rate limited: ${result.reason}`;
    case "opt_out":
      return "ℹ Feedback is disabled. Run 'prism feedback enable' to re-enable.";
    case "local_only":
      return `✓ Cloud unavailable; feedback stored locally (id: ${result.localId}).`;
    case "cloud":
      return result.duplicate
        ? `✓ Feedback already exists in Prism cloud (id: ${result.id}).`
        : `✓ Feedback submitted to Prism cloud (id: ${result.id}).`;
    case "error":
      return `✗ Failed to submit feedback: ${result.error}`;
    default:
      return `✗ Unknown feedback result: ${String((result as { kind: string }).kind)}`;
  }
}

function printResult(result: FeedbackResult): void {
  console.log(formatResult(result));
  if (result.kind === "error") process.exitCode = 1;
}

interface SubmitOptions {
  summary: string;
  category: string | undefined;
  severity: string | undefined;
  details: string | undefined;
  file: string | string[] | undefined;
}

function buildFeedback(opts: SubmitOptions): AgentFeedback {
  const relatedFiles: string[] = Array.isArray(opts.file)
    ? opts.file
    : opts.file
      ? [opts.file]
      : [];
  const feedback: AgentFeedback = {
    category: parseCategory(opts.category, "friction"),
    severity: parseSeverity(opts.severity, "medium"),
    summary: opts.summary,
  };
  if (opts.details) {
    Object.assign(feedback, { details: opts.details });
  }
  if (relatedFiles.length > 0) {
    Object.assign(feedback, { relatedFiles });
  }
  return feedback;
}

async function runSubmit(feedback: AgentFeedback): Promise<FeedbackResult> {
  try {
    await requireRegistered(true);
  } catch (err) {
    return {
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const program = buildProgram();
  return Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* FeedbackService;
      return yield* service.submit(feedback);
    }).pipe(Effect.provide(program)),
  ).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Feedback submission crashed: ${message}`);
    return { kind: "error" as const, error: message } satisfies FeedbackResult;
  });
}

export const feedbackCommand = new Command("feedback")
  .description("Submit or manage agent feedback (friction, suggestions, observations, praise)")
  .argument("[summary]", "One-line summary when no subcommand is used")
  .addHelpText(
    "after",
    `\nExamples:
  $ prism feedback "The install process requires manual Bun install" --category friction
  $ prism feedback "Add --yes flag to skip setup prompts" --category suggestion
  $ prism feedback "Scan cycle is 30s on first run" --category observation
  $ prism feedback status
  $ prism feedback list
  $ prism feedback disable

Environment:
  PRISM_API_URL             Cloud feedback endpoint override
  PRISM_FEEDBACK_OPT_OUT    Set to 'true' to disable automatic feedback

Feedback requires a registered Prism account. Submissions are stored in the
Prism Cloud D1 feedback store, with local storage used only during an outage.`,
  );

feedbackCommand
  .command("submit")
  .description("Submit a piece of feedback (default action if no subcommand given)")
  .argument("<summary>", "One-line summary of the feedback")
  .option("-c, --category <category>", "friction | suggestion | observation | praise", "friction")
  .option("-s, --severity <severity>", "low | medium | high", "medium")
  .option("-d, --details <details>", "Full description of the feedback")
  .option(
    "-f, --file <file>",
    "Related file path (can be repeated)",
    (value: string, prev: string[]) => {
      return prev ? [...prev, value] : [value];
    },
  )
  .action(async (summary: string, opts: SubmitOptions) => {
    const result = await runSubmit(buildFeedback({ ...opts, summary }));
    printResult(result);
  });

feedbackCommand
  .command("status")
  .description("Show this agent's feedback history and rate-limit state")
  .action(async () => {
    try {
      await requireRegistered(true);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const program = buildProgram();
    await Effect.runPromise(
      Effect.gen(function* () {
        const feedback = yield* FeedbackService;
        const optOut = yield* feedback.getOptOut();
        const recent = yield* feedback.list();
        console.log(`Agent feedback status:`);
        console.log(`  Opt-out:       ${optOut ? "yes" : "no"}`);
        console.log(`  Total reports: ${recent.length}`);
        if (recent.length > 0) {
          console.log("");
          console.log("Recent feedback:");
          for (const r of recent.slice(-10)) {
            const ts = new Date(r.reportedAt).toISOString();
            console.log(`  [${ts}] ${r.category}/${r.severity} ${r.id}`);
            console.log(`    ${r.summary}`);
          }
        }
      }).pipe(Effect.provide(program)),
    );
  });

feedbackCommand
  .command("list")
  .description("Alias for 'status'")
  .action(async () => {
    try {
      await requireRegistered(true);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const program = buildProgram();
    await Effect.runPromise(
      Effect.gen(function* () {
        const feedback = yield* FeedbackService;
        const all = yield* feedback.list();
        if (all.length === 0) {
          console.log("No feedback submitted yet from this agent.");
          return;
        }
        for (const r of all) {
          const ts = new Date(r.reportedAt).toISOString();
          console.log(`[${ts}] ${r.category} ${r.id}  ${r.summary}`);
        }
      }).pipe(Effect.provide(program)),
    );
  });

feedbackCommand
  .command("disable")
  .description("Disable automatic feedback for this agent")
  .action(async () => {
    const program = buildProgram();
    await Effect.runPromise(
      Effect.gen(function* () {
        const feedback = yield* FeedbackService;
        yield* feedback.setOptOut(true);
        console.log("✓ Feedback disabled. Run 'prism feedback enable' to re-enable.");
      }).pipe(Effect.provide(program)),
    );
  });

feedbackCommand
  .command("enable")
  .description("Re-enable automatic feedback for this agent")
  .action(async () => {
    const program = buildProgram();
    await Effect.runPromise(
      Effect.gen(function* () {
        const feedback = yield* FeedbackService;
        yield* feedback.setOptOut(false);
        console.log("✓ Feedback enabled.");
      }).pipe(Effect.provide(program)),
    );
  });

// Default action: if `prism feedback "summary"` is run, behave like `submit`.
feedbackCommand.action(async (summary: string, opts: SubmitOptions) => {
  if (typeof summary !== "string") {
    feedbackCommand.help();
    return;
  }
  const result = await runSubmit(buildFeedback({ ...opts, summary }));
  printResult(result);
});
