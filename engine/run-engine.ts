import "./load-env.js";
import fs from "fs";
import path from "path";
import { Effect } from "effect";
import { program, buildLayer } from "./program.js";
import { ConfigService, ConfigLive } from "./config-service.js";
import { errorReporter } from "./error-reporter.js";
import { getCurrentVersion } from "./version.js";
import { getPrismConfigDir, getPrismDataDir, getPrismDbPath, getPrismEnvPath, getPrismLogsDir } from "./paths.js";

function redirectStdoutStderrToFile(): void {
  const logsDir = getPrismLogsDir();
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logsDir, "engine.log");
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  const originalStdoutWrite = process.stdout.write.bind(process.stdout) as (
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => boolean;
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as (
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => boolean;
  const streamWrite = stream.write.bind(stream) as (
    chunk: unknown,
    encoding?: unknown,
    cb?: unknown,
  ) => boolean;

  let streamBroken = false;

  stream.on("error", (err) => {
    if (streamBroken) return;
    streamBroken = true;
    // Restore original writers so a broken stream doesn't keep swallowing output.
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
    process.stderr.write(`[run-engine] log stream error: ${err.message}\n`);
  });

  function safeStreamWrite(chunk: unknown, encoding?: unknown, cb?: unknown): void {
    if (streamBroken) return;
    try {
      streamWrite(chunk, encoding, cb);
    } catch {
      // If the log stream write fails, continue so the original stdout/stderr
      // write below still emits the message.
    }
  }

  process.stdout.write = function (chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    safeStreamWrite(chunk, encoding, cb);
    return originalStdoutWrite(chunk, encoding, cb);
  } as typeof process.stdout.write;

  process.stderr.write = function (chunk: unknown, encoding?: unknown, cb?: unknown): boolean {
    safeStreamWrite(chunk, encoding, cb);
    return originalStderrWrite(chunk, encoding, cb);
  } as typeof process.stderr.write;
}

redirectStdoutStderrToFile();

function ensureError(cause: unknown): Error {
  if ((cause as object) instanceof Error) {
    return cause as Error;
  }
  return new Error(String(cause));
}

export function runEngine(): Promise<void> {
  errorReporter.setAppVersion(getCurrentVersion());

  console.info(`Prism engine starting — version ${getCurrentVersion()}`);
  console.info(`Resolved paths: installDir=${process.env.PRISM_INSTALL_DIR ?? "(not set)"} configDir=${getPrismConfigDir()} dataDir=${getPrismDataDir()} envPath=${getPrismEnvPath()} dbPath=${getPrismDbPath()} logsDir=${getPrismLogsDir()}`);

  process.on("uncaughtException", (err) => {
    errorReporter.report(ensureError(err), { severity: "critical" });
    console.error("Uncaught exception:", err);
    setImmediate(() => {
      errorReporter.flushAsync(2_000).finally(() => {
        process.exit(1);
      });
    });
  });

  const config = Effect.runSync(
    Effect.gen(function* () {
      return yield* ConfigService;
    }).pipe(Effect.provide(ConfigLive)),
  );

  return Effect.runPromise(
    program.pipe(
      Effect.provide(buildLayer(config)),
      Effect.catchAll((err) =>
        Effect.sync(() => {
          errorReporter.report(ensureError(err), { severity: "critical" });
          console.error("Fatal error:", err);
          setImmediate(() => {
            errorReporter.flushAsync(2_000).finally(() => {
              process.exit(1);
            });
          });
        }),
      ),
    ),
  );
}
