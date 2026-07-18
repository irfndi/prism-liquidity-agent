import { Effect, Layer } from "effect";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { ConfigService } from "./config-service.js";
import { AlertService, DbService, type AlertApi, type EngineAlert } from "./services.js";
import { createLogger } from "./logger.js";
import { getPrismUserConfigDir } from "./paths.js";

const log = createLogger("alert-service");

const DEFAULT_API_BASE_URL = "https://prism-api.irfndi.workers.dev";
const ALERT_POST_TIMEOUT_MS = 5_000;

// Cooldowns and the fee-milestone accumulator live in the SQLite metadata
// table so an engine restart does not reset throttling state.
const COOLDOWN_KEY_PREFIX = "alert_cooldown:";
const FEE_TOTAL_KEY = "alert_fee_total_usd";
const FEE_NEXT_MILESTONE_KEY = "alert_fee_next_milestone_usd";

function readPrismApiKey(): string | null {
  try {
    const credentialsFile = join(getPrismUserConfigDir(), "credentials.json");
    if (!existsSync(credentialsFile)) return null;
    const value: unknown = JSON.parse(readFileSync(credentialsFile, "utf-8"));
    if (typeof value !== "object" || value === null || !("apiKey" in value)) return null;
    const key = (value as { apiKey: unknown }).apiKey;
    return typeof key === "string" && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

function readInstallId(): string | null {
  try {
    const installIdFile = join(getPrismUserConfigDir(), "install-id");
    if (!existsSync(installIdFile)) return null;
    const value = readFileSync(installIdFile, "utf-8").trim();
    return value.length >= 8 && value.length <= 128 ? value : null;
  } catch {
    return null;
  }
}

function cooldownKey(alert: EngineAlert): string {
  return `${COOLDOWN_KEY_PREFIX}${alert.type}:${alert.poolAddress ?? "global"}`;
}

function parseNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function postAlert(
  apiKey: string,
  installId: string | null,
  alert: EngineAlert,
): Effect.Effect<void, never> {
  const baseUrl = process.env.PRISM_API_URL ?? DEFAULT_API_BASE_URL;
  return Effect.tryPromise(() =>
    fetch(`${baseUrl}/v1/alerts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(installId ? { "X-Install-Id": installId } : {}),
      },
      body: JSON.stringify({
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        ...(alert.poolAddress !== undefined ? { poolAddress: alert.poolAddress } : {}),
        ...(alert.data !== undefined ? { data: alert.data } : {}),
      }),
      signal: AbortSignal.timeout(ALERT_POST_TIMEOUT_MS),
    }),
  ).pipe(
    Effect.tap((response) =>
      response.ok
        ? Effect.void
        : Effect.sync(() =>
            log.warn("Alert POST rejected by API", {
              status: response.status,
              type: alert.type,
            }),
          ),
    ),
    Effect.catchAll((error) =>
      // Fail-open is the core contract: an alert delivery failure must never
      // block or fail a scan cycle.
      Effect.sync(() =>
        log.warn("Alert delivery failed (continuing)", {
          type: alert.type,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
    Effect.asVoid,
  );
}

export const AlertLive: Layer.Layer<AlertService, never, DbService | ConfigService> = Layer.effect(
  AlertService,
  Effect.gen(function* () {
    const db = yield* DbService;
    const config = yield* ConfigService;
    const cooldownMs = config.alertCooldownMinutes * 60_000;

    const sendAlert: AlertApi["sendAlert"] = (alert) =>
      Effect.gen(function* () {
        if (!config.alertsEnabled) return;
        const key = cooldownKey(alert);
        const now = Date.now();
        const lastRaw = yield* db
          .getMetadata(key)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        const lastSent = parseNumber(lastRaw);
        if (lastSent !== null && now - lastSent < cooldownMs) return;

        // Mark the attempt before POSTing: a flaky API must not retrigger the
        // same alert on every scan cycle (throttle beats delivery here).
        yield* db.setMetadata(key, String(now)).pipe(Effect.catchAll(() => Effect.void));

        const apiKey = readPrismApiKey();
        if (!apiKey) {
          // Unregistered install: alerts have nowhere to go. Not an error.
          log.debug("Skipping alert — no Prism credentials registered", { type: alert.type });
          return;
        }
        yield* postAlert(apiKey, readInstallId(), alert);
      });

    const recordFeeClaim: AlertApi["recordFeeClaim"] = (poolAddress, feeUsd) =>
      Effect.gen(function* () {
        if (!config.alertsEnabled) return;
        if (!Number.isFinite(feeUsd) || feeUsd <= 0) return;

        const totalRaw = yield* db
          .getMetadata(FEE_TOTAL_KEY)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        const total = (parseNumber(totalRaw) ?? 0) + feeUsd;
        yield* db
          .setMetadata(FEE_TOTAL_KEY, String(total))
          .pipe(Effect.catchAll(() => Effect.void));

        const nextRaw = yield* db
          .getMetadata(FEE_NEXT_MILESTONE_KEY)
          .pipe(Effect.catchAll(() => Effect.succeed(null)));
        const nextMilestone = parseNumber(nextRaw) ?? config.alertFeeMilestoneUsd;
        if (total < nextMilestone) return;

        let following = nextMilestone;
        while (following <= total) {
          following += config.alertFeeMilestoneUsd;
        }
        yield* db
          .setMetadata(FEE_NEXT_MILESTONE_KEY, String(following))
          .pipe(Effect.catchAll(() => Effect.void));

        yield* sendAlert({
          type: "fee_milestone",
          severity: "info",
          message: `Cumulative fees claimed crossed $${nextMilestone.toFixed(2)} (total $${total.toFixed(2)})`,
          poolAddress,
          data: { totalFeesUsd: total, milestoneUsd: nextMilestone },
        });
      });

    return { sendAlert, recordFeeClaim };
  }),
);
