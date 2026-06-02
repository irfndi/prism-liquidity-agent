import { Effect, Context } from "effect";
import { execSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { pipeline } from "stream/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { getCurrentVersion } from "./version.js";
import { ConfigService } from "./config-service.js";
import {
  compareVersions,
  isValidVersion,
  fetchLatestRelease,
  type ReleaseInfo,
} from "./update-utils.js";
import { createLogger } from "./logger.js";

const logger = createLogger("update-service");

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

      if (!isValidVersion(release.version)) {
        return yield* Effect.fail(
          new Error(`Invalid version format: ${release.version}`),
        );
      }

      if (compareVersions(release.version, current) <= 0) {
        return null;
      }

      return release;
    });

  const applyUpdate = (version: string): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      if (!isValidVersion(version)) {
        return yield* Effect.fail(new Error("Invalid version format"));
      }

      const repo = config.updateGithubRepo;
      const channel = config.updateChannel;
      const release = yield* fetchLatestRelease(repo, channel);

      if (!release || release.version !== version) {
        return yield* Effect.fail(
          new Error(`Version ${version} not found in release channel`),
        );
      }

      if (!release.tarballUrl) {
        return yield* Effect.fail(
          new Error(`No tarball URL for version ${version}`),
        );
      }

      const workDir = join(tmpdir(), `prism-update-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });
      const tarballPath = join(workDir, `prism-v${version}.tar.gz`);

      try {
        logger.info(`Downloading ${release.tarballUrl} → ${tarballPath}`);
        const downloadResponse = yield* Effect.tryPromise(() =>
          fetch(release.tarballUrl),
        );
        if (!downloadResponse.ok) {
          return yield* Effect.fail(
            new Error(
              `Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`,
            ),
          );
        }
        if (!downloadResponse.body) {
          return yield* Effect.fail(new Error("Download response has no body"));
        }
        yield* Effect.tryPromise(() =>
          pipeline(downloadResponse.body!, createWriteStream(tarballPath)),
        );

        if (release.sha256Url) {
          const expectedHash = yield* Effect.tryPromise(() =>
            fetch(release.sha256Url).then((r) => r.text()),
          );
          const expectedHashTrimmed = expectedHash.trim().split(/\s+/)[0] ?? "";
          const fileBuffer = readFileSync(tarballPath);
          const actualHash = createHash("sha256")
            .update(fileBuffer)
            .digest("hex");
          if (actualHash !== expectedHashTrimmed) {
            return yield* Effect.fail(
              new Error(
                `SHA-256 mismatch: expected ${expectedHashTrimmed}, got ${actualHash}`,
              ),
            );
          }
          logger.info("SHA-256 checksum verified");
        }

        yield* Effect.try(() => {
          execSync(`tar -xzf "${tarballPath}" -C "${workDir}"`, {
            stdio: "inherit",
          });
        });

        const extractedDir = join(workDir, "prism-liquidity-agent");
        if (!existsSync(extractedDir)) {
          return yield* Effect.fail(
            new Error("Extracted tarball missing expected directory"),
          );
        }

        yield* Effect.try(() => {
          execSync("bun install", { cwd: extractedDir, stdio: "inherit" });
        });

        yield* Effect.try(() => {
          execSync("cp -r ./* .[!.]* ../../", {
            cwd: extractedDir,
            stdio: "inherit",
          });
        });

        logger.info(`Updated to ${version} from ${release.source}`);
      } finally {
        if (existsSync(workDir)) {
          rmSync(workDir, { recursive: true, force: true });
        }
      }
    });

  const service: UpdateService = {
    checkForUpdates,
    applyUpdate,
    getCurrentVersion,
  };

  return service;
});
