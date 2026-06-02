import "dotenv/config";
import { Effect } from "effect";
import { program, buildLayer } from "./program.js";
import { ConfigService, ConfigLive } from "./config-service.js";

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
        console.error("Fatal error:", err);
        process.exit(1);
      }),
    ),
  ),
);
