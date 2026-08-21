import "./load-env.js";
import fs from "fs";
import path from "path";
import { Effect } from "effect";
import { program, buildLayer } from "./program.js";
import { ConfigService, ConfigLive } from "./config-service.js";
import { createLogger } from "./logger.js";
import { errorReporter } from "./error-reporter.js";
import { getCurrentVersion } from "./version.js";
import {
  getPrismConfigDir,
  getPrismDataDir,
  getPrismDbPath,
  getPrismEnvPath,
  getPrismLogsDir,
} from "./paths.js";

function redirectStdoutStderrToFile(): void {
  const logsDir = getPrismLogsDir();
  fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logsDir, "engine.log");
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const originalStdoutWrite = process.stdout.write.bind(process.stdout) as (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (error?: Error | null) => void,
  ) => boolean;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const originalStderrWrite = process.stderr.write.bind(process.stderr) as (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (error?: Error | null) => void,
  ) => boolean;
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const streamWrite = stream.write.bind(stream) as (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (error?: Error | null) => void,
  ) => boolean;

  let streamBroken = false;

  stream.on("error", (err) => {
    if (streamBroken) return;
    streamBroken = true;
    // Restore original writers so a broken stream doesn't keep swallowing output.
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    process.stderr.write = originalStderrWrite as typeof process.stderr.write;
    process.stderr.write(`[run-engine] log stream error: ${err.message}\n`);
  });

  function safeStreamWrite(
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (error?: Error | null) => void,
  ): void {
    if (streamBroken) return;
    Effect.runSync(
      Effect.try({
        try: () => streamWrite(chunk, encoding, cb),
        catch: () => undefined,
      }),
    );
  }

  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  process.stdout.write = function (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (error?: Error | null) => void,
  ): boolean {
    safeStreamWrite(chunk, encoding, cb);
    return originalStdoutWrite(chunk, encoding, cb);
  } as typeof process.stdout.write;

  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  process.stderr.write = function (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding,
    cb?: (error?: Error | null) => void,
  ): boolean {
    safeStreamWrite(chunk, encoding, cb);
    return originalStderrWrite(chunk, encoding, cb);
  } as typeof process.stdout.write;
}

redirectStdoutStderrToFile();

function ensureError(cause: unknown): Error {
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  if ((cause as object) instanceof Error) {
    // SAFETY: This branch normalizes the caught cause to the Error contract before propagation.
    return cause as Error;
  }
  return new Error(String(cause));
}

export function runEngine(): Promise<void> {
  errorReporter.setAppVersion(getCurrentVersion());

  const logger = createLogger("run-engine");
  logger.info(`Prism engine starting — version ${getCurrentVersion()}`);
  logger.info(
    `Resolved paths: installDir=${process.env.PRISM_INSTALL_DIR ?? "(not set)"} configDir=${getPrismConfigDir()} dataDir=${getPrismDataDir()} envPath=${getPrismEnvPath()} dbPath=${getPrismDbPath()} logsDir=${getPrismLogsDir()}`,
  );

  process.on("uncaughtException", (err) => {
    errorReporter.report(ensureError(err), { severity: "critical" });
    console.error("Uncaught exception:", err);
    setImmediate(() =>
      Effect.runFork(
        errorReporter.flushEffect(2_000).pipe(Effect.ensuring(Effect.sync(() => process.exit(1)))),
      ),
    );
  });

  const config = Effect.runSync(
    Effect.gen(function* () {
      return yield* ConfigService;
    }).pipe(Effect.provide(ConfigLive)),
  );

  return Effect.runPromise(
    program.pipe(
      Effect.provide(buildLayer(config)),
      Effect.catch((err) =>
        Effect.sync(() => {
          errorReporter.report(ensureError(err), { severity: "critical" });
          console.error("Fatal error:", err);
          setImmediate(() =>
            Effect.runFork(
              errorReporter
                .flushEffect(2_000)
                .pipe(Effect.ensuring(Effect.sync(() => process.exit(1)))),
            ),
          );
        }),
      ),
    ),
  );
}
