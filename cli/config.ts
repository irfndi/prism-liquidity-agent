import { Command } from "commander";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import { getPrismDbPath } from "../engine/paths.js";
import {
  DB_CONFIG_KEYS,
  dbConfigKey,
  findDbConfigSpec,
  parseDbConfigValue,
} from "../engine/db-config.js";

/**
 * `prism config` — inspect and edit the DB-backed config sidecar.
 *
 * Precedence is env > DB > defaults. These commands read/write the SQLite
 * `metadata` table rows keyed `config.<ENV_KEY>`; a row only takes effect when
 * the corresponding env var is UNSET (env always wins). The engine honours
 * these rows at config load; this CLI is the editing surface.
 *
 * Only keys in the `DB_CONFIG_KEYS` allowlist are settable — secrets, wallet
 * keys, RPC URLs and paths are never stored here.
 */

function buildLayer(): Layer.Layer<DbService, never, never> {
  return DbLive(process.env.SQLITE_DB_PATH ?? getPrismDbPath());
}

function unknownKey(envKey: string): void {
  console.error(`Unknown config key: ${envKey}`);
  console.error(`Known keys: ${DB_CONFIG_KEYS.map((s) => s.envKey).join(", ")}`);
  process.exitCode = 1;
}

const listCommand = new Command("list")
  .description("List DB-backed config overrides and which env vars shadow them")
  .action(() => {
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService;
        const rows: Array<{ key: string; value: string }> = [];
        for (const spec of DB_CONFIG_KEYS) {
          const value = yield* db
            .getMetadata(dbConfigKey(spec.envKey))
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (value !== null) rows.push({ key: spec.envKey, value });
        }
        if (rows.length === 0) {
          console.log("No DB-backed config overrides set.");
          console.log("Known keys (env var wins when set):");
          for (const spec of DB_CONFIG_KEYS) {
            console.log(
              `  ${spec.envKey}${process.env[spec.envKey] !== undefined ? "  (env SHADOWS this key)" : ""}`,
            );
          }
          return;
        }
        console.log("DB-backed config overrides (precedence: env > DB > defaults):");
        for (const { key, value } of rows) {
          const shadowed = process.env[key] !== undefined;
          console.log(`  ${key} = ${value}${shadowed ? "  (SHADOWED by env)" : ""}`);
        }
      }).pipe(Effect.provide(buildLayer())),
    ).catch((err) => {
      console.error(`Failed to list config: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
  });

const getCommand = new Command("get")
  .description("Show the effective value for a config key (env wins over DB)")
  .argument("<KEY>", "env-style key, e.g. MIN_POOL_TVL_USD")
  .action((key: string) => {
    const spec = findDbConfigSpec(key);
    if (!spec) {
      unknownKey(key);
      return;
    }
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService;
        const dbValue = yield* db
          .getMetadata(dbConfigKey(key))
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const envValue = process.env[key];
        if (envValue !== undefined) {
          console.log(`${key}=${envValue}  (from env)`);
        } else if (dbValue !== null) {
          console.log(`${key}=${dbValue}  (from DB)`);
        } else {
          console.log(`${key}=<default>  (not set)`);
        }
      }).pipe(Effect.provide(buildLayer())),
    ).catch((err) => {
      console.error(`Failed to read config: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
  });

const setCommand = new Command("set")
  .description("Set a DB-backed config override (env still wins if the env var is set)")
  .argument("<KEY>", "env-style key, e.g. MIN_POOL_TVL_USD")
  .argument("<VALUE>", "value to persist (boolean: true/false/1/0; number: numeric)")
  .action((key: string, value: string) => {
    const spec = findDbConfigSpec(key);
    if (!spec) {
      unknownKey(key);
      return;
    }
    // Validate + clamp BEFORE writing so a malformed value is never persisted.
    const parsed = parseDbConfigValue(spec, value);
    if (parsed === null) {
      console.error(
        `Invalid value for ${key}: "${value}" (expected ${spec.kind === "boolean" ? "a boolean (true/false/1/0)" : "a finite number"})`,
      );
      process.exitCode = 1;
      return;
    }
    const stored = String(parsed);
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.setMetadata(dbConfigKey(key), stored);
        const shadowed = process.env[key] !== undefined;
        console.log(`Set ${key}=${stored} in DB.`);
        console.log("Note: the running engine loads config at startup — restart it to apply.");
        if (shadowed) {
          console.warn(
            `Note: env var ${key}=${process.env[key]} is set and will win over this DB value.`,
          );
        }
      }).pipe(Effect.provide(buildLayer())),
    ).catch((err) => {
      console.error(`Failed to set config: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
  });

const unsetCommand = new Command("unset")
  .description("Remove a DB-backed config override (defaults / env take over)")
  .argument("<KEY>", "env-style key, e.g. MIN_POOL_TVL_USD")
  .action((key: string) => {
    const spec = findDbConfigSpec(key);
    if (!spec) {
      unknownKey(key);
      return;
    }
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.deleteMetadata(dbConfigKey(key));
        console.log(`Unset ${key}.`);
      }).pipe(Effect.provide(buildLayer())),
    ).catch((err) => {
      console.error(`Failed to unset config: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
  });

export const configCommand = new Command("config")
  .description("Inspect or edit DB-backed config (precedence: env > DB > defaults)")
  .addCommand(listCommand)
  .addCommand(getCommand)
  .addCommand(setCommand)
  .addCommand(unsetCommand);
