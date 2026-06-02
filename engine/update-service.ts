import { Effect, Context } from "effect";
import { execSync, spawnSync } from "child_process";
import { getCurrentVersion } from "./version.js";
import { ConfigService } from "./config-service.js";
import { compareVersions, isValidVersion, fetchLatestRelease } from "./update-utils.js";

export interface ReleaseInfo {
  readonly version: string;
  readonly channel: "stable" | "beta" | "dev";
  readonly releaseUrl: string;
  readonly releaseNotes: string;
  readonly publishedAt: string;
}

export interface UpdateService {
  readonly checkForUpdates: () => Effect.Effect<ReleaseInfo | null, unknown>;
  readonly applyUpdate: (version: string) => Effect.Effect<void, unknown>;
  readonly getCurrentVersion: () => string;
}

export class UpdateServiceTag extends Context.Tag("UpdateService")
  <UpdateServiceTag, UpdateService>() {}

export const UpdateServiceLive = Effect.gen(function* () {
  const config = yield* ConfigService;

  const checkForUpdates = (): Effect.Effect<ReleaseInfo | null, unknown> =>
    Effect.gen(function* () {
      const current = getCurrentVersion();
      const repo = config.updateGithubRepo;
      const channel = config.updateChannel;

      const release = yield* fetchLatestRelease(repo, channel);

      if (!release) {
        return null;
      }

      const latest = release.tag_name;
      if (!isValidVersion(latest)) {
        return yield* Effect.fail(new Error("Invalid version format from GitHub API"));
      }

      if (compareVersions(latest, current) <= 0) {
        return null;
      }

      return {
        version: latest,
        channel: release.prerelease ? "beta" : "stable",
        releaseUrl: release.html_url,
        releaseNotes: release.body,
        publishedAt: release.published_at,
      };
    });

  const applyUpdate = (version: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (!isValidVersion(version)) {
        return yield* Effect.fail(new Error("Invalid version format"));
      }

      // Check for local modifications
      if (!config.updateAllowDirty) {
        const status = yield* Effect.try(() =>
          execSync("git status --porcelain", { encoding: "utf-8" }),
        );
        if (status.trim()) {
          return yield* Effect.fail(
            new Error("Local modifications detected. Commit or stash before updating."),
          );
        }
      }

      // Fetch and checkout using spawnSync to avoid shell interpolation
      yield* Effect.try(() => {
        execSync("git fetch origin", { stdio: "inherit" });
        const result = spawnSync("git", ["checkout", version], { stdio: "inherit" });
        if (result.status !== 0) {
          throw new Error(`git checkout ${version} failed`);
        }
        execSync("bun install", { stdio: "inherit" });
      });

      yield* Effect.log(`Updated to ${version}`);
    });

  const service: UpdateService = {
    checkForUpdates,
    applyUpdate,
    getCurrentVersion,
  };

  return service;
});
