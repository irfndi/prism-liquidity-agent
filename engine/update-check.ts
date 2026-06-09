import { Effect } from "effect";
import type { AppConfig } from "./config-service.js";
import type { DbApi } from "./services.js";
import { fetchLatestRelease, compareVersions } from "./update-utils.js";
import { getCurrentVersion } from "./version.js";
import { createLogger } from "./logger.js";
import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const log = createLogger("update-check");

const MS_PER_DAY = 86_400_000;

function getVersionInstalledAtFromFile(): number | null {
  try {
    const filePath = join(homedir(), ".config", "prism", "version-installed-at");
    const content = readFileSync(filePath, "utf-8").trim();
    const ts = Number(content);
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  } catch {
    return null;
  }
}

export function checkForAutoUpdate(
  config: AppConfig,
  db: DbApi,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const now = Date.now();

    const lastCheckRaw = yield* db.getMetadata("lastUpdateCheckAt");
    const lastCheckAt = lastCheckRaw ? Number(lastCheckRaw) : 0;
    if (now - lastCheckAt < config.updateCheckIntervalMs) {
      return;
    }

    if (!config.autoUpdate && !config.forceUpdateEnabled) {
      yield* db.setMetadata("lastUpdateCheckAt", String(now));
      return;
    }

    let versionInstalledAt = yield* db.getMetadata("versionInstalledAt");
    const fileTimestamp = getVersionInstalledAtFromFile();
    if (fileTimestamp !== null) {
      const fileTimestampString = String(fileTimestamp);
      versionInstalledAt = fileTimestampString;
      yield* db.setMetadata("versionInstalledAt", fileTimestampString);
    }
    if (versionInstalledAt === null) {
      versionInstalledAt = String(now);
      yield* db.setMetadata("versionInstalledAt", versionInstalledAt);
    }

    let installedAtMs = Number(versionInstalledAt);
    if (!Number.isFinite(installedAtMs) || installedAtMs <= 0) {
      log.warn("Invalid versionInstalledAt timestamp, resetting to now", { versionInstalledAt });
      versionInstalledAt = String(now);
      yield* db.setMetadata("versionInstalledAt", versionInstalledAt);
      installedAtMs = now;
    }

    const currentVersion = getCurrentVersion();

    const release = yield* fetchLatestRelease(
      config.updateGithubRepo,
      config.updateChannel,
      config.updateR2PublicUrl,
      config.githubToken || undefined,
    );

    if (release === null) {
      yield* db.setMetadata("lastUpdateCheckAt", String(now));
      return;
    }

    const cmp = compareVersions(release.version, currentVersion);
    if (cmp <= 0) {
      yield* db.setMetadata("lastUpdateCheckAt", String(now));
      return;
    }

    const daysSinceInstall = Math.floor((now - installedAtMs) / MS_PER_DAY);
    const daysUntilForce = config.forceUpdateAfterDays - daysSinceInstall;

    log.info(
      `New version available: ${release.version} (current: ${currentVersion})`,
      { source: release.source },
    );

    if (config.forceUpdateEnabled && daysUntilForce <= 0) {
      log.error(
        `[FORCE UPDATE] Version ${release.version} is available and your install ` +
          `is ${daysSinceInstall} days old (threshold: ${config.forceUpdateAfterDays} days). ` +
          `Shutting down to enforce update. Run "prism update" to apply.`,
      );
      yield* Effect.sync(() => {
        process.exit(1);
      });
    } else if (config.forceUpdateEnabled && daysUntilForce <= 1) {
      log.warn(
        `[FORCE UPDATE URGENCY] Update to ${release.version} required within ` +
          `${daysUntilForce} day(s). After that, the agent will shut down.`,
      );
    } else if (config.forceUpdateEnabled && daysUntilForce <= 2) {
      log.warn(
        `[FORCE UPDATE] Update to ${release.version} recommended. ` +
          `${daysUntilForce} day(s) until forced shutdown.`,
      );
    }

    yield* db.setMetadata("lastUpdateCheckAt", String(now));
  }).pipe(Effect.catchAll((err) => {
    log.warn("Auto-update check failed (non-fatal)", { error: String(err) });
    return Effect.void;
  }));
}
