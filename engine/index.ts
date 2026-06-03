import "dotenv/config";
import { Effect } from "effect";
import { program, buildLayer } from "./program.js";
import { ConfigService, ConfigLive } from "./config-service.js";
import { errorReporter } from "./error-reporter.js";
import { getCurrentVersion } from "./version.js";

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
    errorReporter.flushAsync().finally(() => {
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
          errorReporter.flushAsync().finally(() => {
            process.exit(1);
          });
        });
      }),
    ),
  ),
);
