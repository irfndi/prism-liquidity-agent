import { Effect } from "effect";
import type { AppConfig } from "./config-service.js";
import type { DbApi } from "./services.js";
import { fetchLatestRelease, compareVersions, type ReleaseInfo } from "./update-utils.js";
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

/** Named predicate: the check path runs when either auto-update flag is on. */
function isAutoUpdateDisabled(autoUpdate: boolean, forceUpdateEnabled: boolean): boolean {
  return !autoUpdate && !forceUpdateEnabled;
}

/** Resolve the install timestamp, syncing file/db sources and repairing bad values. */
function resolveInstalledAtMs(
  db: DbApi,
  stored: string | null,
  fileTimestamp: number | null,
  now: number,
): Effect.Effect<number, Error> {
  return Effect.gen(function* () {
    let effective = stored;
    if (fileTimestamp !== null) {
      effective = String(fileTimestamp);
      yield* db.setMetadata("versionInstalledAt", effective);
    }
    if (effective === null) {
      const text = String(now);
      yield* db.setMetadata("versionInstalledAt", text);
      return now;
    }
    const ms = Number(effective);
    if (!Number.isFinite(ms) || ms <= 0) {
      log.warn("Invalid versionInstalledAt timestamp, resetting to now", {
        versionInstalledAt: effective,
      });
      const text = String(now);
      yield* db.setMetadata("versionInstalledAt", text);
      return now;
    }
    return ms;
  });
}

/** Type guard: a newer release exists beyond the current version. */
function isNewerReleaseAvailable(
  release: ReleaseInfo | null,
  currentVersion: string,
): release is ReleaseInfo {
  if (release === null) {
    return false;
  }
  return compareVersions(release.version, currentVersion) > 0;
}

/** Log force-update urgency; shuts down past the threshold. Returns true when shutting down. */
function reportForceUpdateStatus(
  daysSinceInstall: number,
  daysUntilForce: number,
  thresholdDays: number,
  version: string,
): Effect.Effect<boolean, never> {
  if (daysUntilForce <= 0) {
    log.error(
      `[FORCE UPDATE] Version ${version} is available and your install ` +
        `is ${daysSinceInstall} days old (threshold: ${thresholdDays} days). ` +
        `Shutting down to enforce update. Run "prism update" to apply.`,
    );
    return Effect.sync(() => {
      process.exit(1);
      return true;
    });
  }
  if (daysUntilForce <= 1) {
    log.warn(
      `[FORCE UPDATE URGENCY] Update to ${version} required within ` +
        `${daysUntilForce} day(s). After that, the agent will shut down.`,
    );
  } else if (daysUntilForce <= 2) {
    log.warn(
      `[FORCE UPDATE] Update to ${version} recommended. ` +
        `${daysUntilForce} day(s) until forced shutdown.`,
    );
  }
  return Effect.succeed(false);
}

export function checkForAutoUpdate(config: AppConfig, db: DbApi): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const now = Date.now();

    const lastCheckRaw = yield* db.getMetadata("lastUpdateCheckAt");
    const lastCheckAt = lastCheckRaw ? Number(lastCheckRaw) : 0;
    if (now - lastCheckAt < config.updateCheckIntervalMs) {
      return;
    }

    if (isAutoUpdateDisabled(config.autoUpdate, config.forceUpdateEnabled)) {
      yield* db.setMetadata("lastUpdateCheckAt", String(now));
      return;
    }

    const storedInstalledAt = yield* db.getMetadata("versionInstalledAt");
    const installedAtMs = yield* resolveInstalledAtMs(
      db,
      storedInstalledAt,
      getVersionInstalledAtFromFile(),
      now,
    );

    const currentVersion = getCurrentVersion();

    const release = yield* fetchLatestRelease(
      config.updateGithubRepo,
      config.updateChannel,
      config.updateR2PublicUrl,
      config.githubToken || undefined,
    );

    if (!isNewerReleaseAvailable(release, currentVersion)) {
      yield* db.setMetadata("lastUpdateCheckAt", String(now));
      return;
    }

    const daysSinceInstall = Math.floor((now - installedAtMs) / MS_PER_DAY);
    const daysUntilForce = config.forceUpdateAfterDays - daysSinceInstall;

    log.info(`New version available: ${release.version} (current: ${currentVersion})`, {
      source: release.source,
    });

    if (config.forceUpdateEnabled) {
      const shuttingDown = yield* reportForceUpdateStatus(
        daysSinceInstall,
        daysUntilForce,
        config.forceUpdateAfterDays,
        release.version,
      );
      if (shuttingDown) {
        return;
      }
    }

    yield* db.setMetadata("lastUpdateCheckAt", String(now));
  }).pipe(
    Effect.catch((err) => {
      log.warn("Auto-update check failed (non-fatal)", { error: String(err) });
      return Effect.void;
    }),
  );
}
