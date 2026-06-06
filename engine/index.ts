import "dotenv/config";
import { Effect } from "effect";
import { program, buildLayer } from "./program.js";
import { ConfigService, ConfigLive } from "./config-service.js";
import { errorReporter } from "./error-reporter.js";
import { getCurrentVersion } from "./version.js";

// Guard: Prevent direct execution of engine/index.ts
// Users must use 'prism dev' (CLI) instead
const isDirectExecution = process.argv[1]?.endsWith('engine/index.ts') ||
                          process.argv[1]?.endsWith('engine/index.js');

if (isDirectExecution && process.env.PRISM_ALLOW_DIRECT !== 'true') {
  console.error('Error: Direct execution of engine/index.ts is not allowed.');
  console.error('Please use "prism dev" instead.');
  console.error('');
  console.error('If you need to run the engine directly for development, set:');
  console.error('  PRISM_ALLOW_DIRECT=true bun engine/index.ts');
  process.exit(1);
}

errorReporter.setAppVersion(getCurrentVersion());

function ensureError(cause: unknown): Error {
  if ((cause as object) instanceof Error) {
    return cause as Error;
  }
  return new Error(String(cause));
}

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

Effect.runPromise(
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
