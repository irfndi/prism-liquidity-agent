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
import { errorReporter } from "./error-reporter.js";

const logger = createLogger("update-service");

export interface UpdateService {
  readonly checkForUpdates: () => Effect.Effect<ReleaseInfo | null, unknown>;
  readonly applyUpdate: (version: string) => Effect.Effect<void, unknown>;
  readonly getCurrentVersion: () => string;
}

export class UpdateServiceTag extends Context.Tag("UpdateService")<
  UpdateServiceTag,
  UpdateService
>() {}

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
        return yield* Effect.fail(new Error(`Invalid version format: ${release.version}`));
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
        return yield* Effect.fail(new Error(`Version ${version} not found in release channel`));
      }

      if (!release.tarballUrl) {
        return yield* Effect.fail(new Error(`No tarball URL for version ${version}`));
      }

      const workDir = join(tmpdir(), `prism-update-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });
      const tarballPath = join(workDir, `prism-v${version}.tar.gz`);

      try {
        logger.info(`Downloading ${release.tarballUrl} → ${tarballPath}`);
        const downloadResponse = yield* Effect.tryPromise(() => fetch(release.tarballUrl));
        if (!downloadResponse.ok) {
          return yield* Effect.fail(
            new Error(`Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`),
          );
        }
        if (!downloadResponse.body) {
          return yield* Effect.fail(new Error("Download response has no body"));
        }
        yield* Effect.tryPromise(() =>
          pipeline(downloadResponse.body!, createWriteStream(tarballPath)),
        );

        if (!release.sha256Url) {
          return yield* Effect.fail(
            new Error(
              `Release manifest missing sha256Url — refusing to install ${version} without integrity check`,
            ),
          );
        }
        const shaResponse = yield* Effect.tryPromise(() => fetch(release.sha256Url));
        if (!shaResponse.ok) {
          return yield* Effect.fail(
            new Error(
              `Failed to fetch SHA-256 checksum: ${shaResponse.status} ${shaResponse.statusText}`,
            ),
          );
        }
        const expectedHash = yield* Effect.tryPromise(() => shaResponse.text());
        const expectedHashTrimmed = expectedHash.trim().split(/\s+/)[0] ?? "";
        const fileBuffer = readFileSync(tarballPath);
        const actualHash = createHash("sha256").update(fileBuffer).digest("hex");
        if (actualHash !== expectedHashTrimmed) {
          return yield* Effect.fail(
            new Error(`SHA-256 mismatch: expected ${expectedHashTrimmed}, got ${actualHash}`),
          );
        }
        logger.info("SHA-256 checksum verified");

        yield* Effect.try(() => {
          execSync(`tar -xzf "${tarballPath}" -C "${workDir}"`, {
            stdio: "inherit",
          });
        });

        // Tarballs may extract into either workDir or workDir/prism-liquidity-agent.
        // Detect whichever exists and contains the expected files.
        const candidateRoots = [workDir, join(workDir, "prism-liquidity-agent")];
        const extractedDir = candidateRoots.find(
          (p) => existsSync(p) && existsSync(join(p, "package.json")),
        );
        if (!extractedDir) {
          return yield* Effect.fail(
            new Error("Extracted tarball missing package.json — cannot determine install root"),
          );
        }

        yield* Effect.try(() => {
          execSync("bun install --production=false", {
            cwd: extractedDir,
            stdio: "inherit",
          });
        });

        // Pre-apply smoke tests
        yield* Effect.try(() => {
          execSync("bunx tsc --noEmit", { cwd: extractedDir, stdio: "inherit" });
        }).pipe(
          Effect.catchAll(() =>
            Effect.fail(new Error(`TypeScript smoke test failed — refusing to install ${version}`)),
          ),
        );

        yield* Effect.try(() => {
          execSync("bunx vitest run --reporter=basic", { cwd: extractedDir, stdio: "inherit" });
        }).pipe(
          Effect.catchAll(() =>
            Effect.fail(new Error(`Test suite smoke test failed — refusing to install ${version}`)),
          ),
        );

        // Atomic swap: stage new files alongside install root, then rename.
        // This avoids leaving the live install in a half-updated state on failure.
        const installRoot = process.cwd();
        const stagedRoot = join(installRoot, `..`, `.prism-update-stage`);
        const backupRoot = join(installRoot, `..`, `.prism-update-backup`);

        yield* Effect.try(() => {
          // Remove any stale staging directory from a prior failed run.
          if (existsSync(stagedRoot)) {
            rmSync(stagedRoot, { recursive: true, force: true });
          }
          // Copy the new tree into a staging dir beside the install root.
          execSync(`cp -R "${extractedDir}/." "${stagedRoot}/"`, { stdio: "inherit" });

          // Back up the current install so we can roll back on swap failure.
          if (existsSync(backupRoot)) {
            rmSync(backupRoot, { recursive: true, force: true });
          }
          const installName = installRoot.split("/").pop() ?? "prism-liquidity-agent";
          const currentBackup = join(installRoot, `..`, `.prism-prev-${installName}`);

          // Atomic swap with rollback: if any rename fails after the current
          // install has been moved aside, restore the previous install in place.
          try {
            execSync(`mv "${installRoot}" "${currentBackup}"`, { stdio: "inherit" });
            try {
              execSync(`mv "${stagedRoot}" "${installRoot}"`, { stdio: "inherit" });
            } catch (swapErr) {
              // stagedRoot -> installRoot failed; restore the previous install.
              if (existsSync(currentBackup) && !existsSync(installRoot)) {
                execSync(`mv "${currentBackup}" "${installRoot}"`);
              }
              throw swapErr;
            }
            // Keep the previous install as a sibling backup until the user confirms.
            if (existsSync(currentBackup)) {
              execSync(`mv "${currentBackup}" "${backupRoot}"`, { stdio: "inherit" });
            }

            // Post-apply health check
            console.log("Running post-apply health check...");
            try {
              execSync("bunx tsc --noEmit", {
                cwd: installRoot,
                stdio: "inherit",
                timeout: 30_000,
              });
            } catch (healthErr) {
              console.error("Post-apply health check failed — rolling back");
              try {
                rmSync(installRoot, { recursive: true, force: true });
                if (existsSync(backupRoot)) {
                  execSync(`mv "${backupRoot}" "${installRoot}"`, { stdio: "inherit" });
                }
              } catch (rollbackErr) {
                throw new Error(
                  "Update failed: health check did not pass AND rollback failed. " +
                    `Your install at ${installRoot} may be in an inconsistent state. ` +
                    `Previous version is at ${backupRoot}.`,
                );
              }
              const healthMessage =
                healthErr instanceof Error ? healthErr.message : String(healthErr);
              throw new Error(
                `Post-apply health check failed — rolled back to previous version. ` +
                  `Error: ${healthMessage}`,
              );
            }
            console.log("✓ Post-apply health check passed");
          } catch (swapErr) {
            // Best-effort cleanup of any orphaned staging directory.
            if (existsSync(stagedRoot)) {
              try {
                rmSync(stagedRoot, { recursive: true, force: true });
              } catch {
                // ignore cleanup failure; surface the original swap error
              }
            }
            throw swapErr;
          }
        });

        logger.info(
          `Updated to ${version} from ${release.source}. Previous install kept at ${backupRoot} for rollback.`,
        );
      } finally {
        if (existsSync(workDir)) {
          rmSync(workDir, { recursive: true, force: true });
        }
      }
    }).pipe(
      Effect.tapError((err) =>
        Effect.sync(() => {
          const error = err instanceof Error ? err : new Error(String(err));
          errorReporter.report(error, { severity: "critical" });
        }),
      ),
    );

  const service: UpdateService = {
    checkForUpdates,
    applyUpdate,
    getCurrentVersion,
  };

  return service;
});
