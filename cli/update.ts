import { Command } from "commander";
import { execFileSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { pipeline } from "stream/promises";
import { dirname, join, resolve } from "path";
import { tmpdir, homedir } from "os";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { getCurrentVersion } from "../engine/version.js";
import {
  compareVersions,
  isValidVersion,
  fetchLatestRelease,
  R2_PUBLIC_URL,
} from "../engine/update-utils.js";
import semver from "semver";
import { Effect } from "effect";
import { createLogger } from "../engine/logger.js";

const logger = createLogger("update");

class UpdateAbort extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "UpdateAbort";
  }
}

/**
 * Resolve a command to an absolute path using Bun.which. Passing absolute
 * paths to execFileSync avoids ENOENT surprises when the target environment
 * has a restricted PATH or when Bun's internal fallback tries to spawn a
 * shell that does not exist (e.g. `/bin/sh` in minimal containers).
 */
function resolveBin(name: string): string {
  const resolved = Bun.which(name);
  if (!resolved) {
    const hint =
      name === "bun" || name === "bunx"
        ? "Ensure Bun is installed and on your PATH."
        : "Ensure it is installed and on your PATH.";
    throw new UpdateAbort(`${name} not found in PATH. ${hint}`);
  }
  return resolved;
}

// Walk up from this CLI's location to the Prism install root. Required so
// that `prism update` is safe to run from any directory — using process.cwd()
// would let the swap clobber an unrelated working dir.
function resolveInstallRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = resolve(here);
  for (let i = 0; i < 10; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
          name?: string;
        };
        if (pkg.name === "prism-liquidity-agent" || pkg.name === "prism") {
          return dir;
        }
      } catch {
        // fall through to keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(here);
}

export const updateCommand = new Command("update")
  .description("Check for and apply updates")
  .option("--check-only", "Only check for updates, don't apply")
  .option("--channel <channel>", "Release channel (stable, beta, dev)", "stable")
  .option("--r2-url <url>", "R2 public URL for release tarballs", R2_PUBLIC_URL)
  .option("--skip-smoke-test", "Skip pre-install smoke tests (lint + test suite)")
  .action(async (options) => {
    const current = getCurrentVersion();
    console.log(`Current version: ${current}`);

    let workDir: string | null = null;
    try {
      const repo = "irfndi/prism-liquidity-agent";
      const channel = options.channel as "stable" | "beta" | "dev";
      const r2Url = options.r2Url as string;

      const release = await Effect.runPromise(fetchLatestRelease(repo, channel, r2Url));

      if (!release) {
        console.log("✓ Already up to date");
        return;
      }

      const latest = release.version;

      if (!isValidVersion(latest)) {
        throw new UpdateAbort(`Invalid version format: ${latest}`);
      }

      if (compareVersions(latest, current) <= 0) {
        console.log("✓ Already up to date");
        return;
      }

      console.log(`Update available: ${current} → ${latest}`);
      console.log(`Source: ${release.source === "r2" ? "Cloudflare R2" : "GitHub Releases"}`);
      if (release.tarballUrl) {
        console.log(`Download: ${release.tarballUrl}`);
      }

      if (options.checkOnly) {
        return;
      }

      if (!release.tarballUrl) {
        throw new UpdateAbort(`No tarball URL available for version ${latest}`);
      }

      workDir = join(tmpdir(), `prism-update-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });
      const tarballName = `prism-v${latest}.tar.gz`;
      const tarballPath = join(workDir, tarballName);

      console.log(`Downloading from ${release.source === "r2" ? "R2" : "GitHub"}...`);
      const downloadResponse = await fetch(release.tarballUrl);
      if (!downloadResponse.ok) {
        throw new UpdateAbort(
          `Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`,
        );
      }
      if (!downloadResponse.body) {
        throw new UpdateAbort("Download response has no body");
      }
      await pipeline(downloadResponse.body, createWriteStream(tarballPath));
      console.log(`✓ Downloaded to ${tarballPath}`);

      if (!release.sha256Url) {
        throw new UpdateAbort(
          `Release manifest missing sha256Url — refusing to install ${latest} without integrity check`,
        );
      }
      console.log("Verifying SHA-256 checksum...");
      const expectedHashResponse = await fetch(release.sha256Url);
      if (!expectedHashResponse.ok) {
        throw new UpdateAbort(
          `Failed to fetch SHA-256 checksum: ${expectedHashResponse.status} ${expectedHashResponse.statusText}`,
        );
      }
      const expectedHash = (await expectedHashResponse.text()).trim().split(/\s+/)[0] ?? "";
      const fileBuffer = readFileSync(tarballPath);
      const actualHash = createHash("sha256").update(fileBuffer).digest("hex");
      if (actualHash !== expectedHash) {
        throw new UpdateAbort(`SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`);
      }
      console.log("✓ SHA-256 checksum verified");

      console.log("Extracting tarball...");
      execFileSync(resolveBin("tar"), ["-xzf", tarballPath, "-C", workDir], { stdio: "inherit" });

      // R2 tarballs extract at top level; legacy ones had a subdir.
      const candidateRoots = [workDir, join(workDir, "prism-liquidity-agent")];
      const extractedDir = candidateRoots.find(
        (p) => existsSync(p) && existsSync(join(p, "package.json")),
      );
      if (!extractedDir) {
        throw new UpdateAbort(
          "Extracted tarball missing package.json — cannot determine install root",
        );
      }

      console.log("Installing dependencies...");

      // Guard against running on Bun < 1.4 which cannot parse lockfileVersion 2
      const bunVersion = typeof Bun !== "undefined" ? Bun.version : "0.0.0";
      const cleanBunVersion = semver.clean(bunVersion) || bunVersion;
      if (!semver.gte(cleanBunVersion, "1.4.0")) {
        throw new UpdateAbort(
          `Prism requires Bun >= 1.4.0 to install dependencies. ` +
            `Current Bun version is ${bunVersion}. Please upgrade Bun and retry.`,
        );
      }

      execFileSync(resolveBin("bun"), ["install"], { cwd: extractedDir, stdio: "inherit" });

      // === Pre-apply smoke tests ===
      const skipSmokeTest = options.skipSmokeTest as boolean;

      if (skipSmokeTest) {
        console.log("⚠ Skipping smoke tests (--skip-smoke-test)");
      } else {
        console.log("Running TypeScript smoke test...");
        try {
          execFileSync(resolveBin("bunx"), ["tsc", "--noEmit"], {
            cwd: extractedDir,
            stdio: "inherit",
          });
          console.log("✓ TypeScript smoke test passed");
        } catch {
          console.error("⚠ TypeScript smoke test failed — continuing anyway");
          console.error("  Use --skip-smoke-test to bypass this check");
        }

        console.log("Running test suite smoke test...");
        try {
          execFileSync(resolveBin("bunx"), ["--bun", "vitest", "run"], {
            cwd: extractedDir,
            stdio: "inherit",
          });
          console.log("✓ Test suite smoke test passed");
        } catch {
          console.error("⚠ Test suite smoke test failed — continuing anyway");
          console.error("  Use --skip-smoke-test to bypass this check");
        }
      }

      // Atomic swap: stage new files alongside the install root, then rename.
      // A direct copy into the live install can leave it half-updated on failure.
      const installRoot = resolveInstallRoot();
      const installName = installRoot.split("/").pop() ?? "prism-liquidity-agent";
      const stagedRoot = join(installRoot, "..", `.prism-update-stage`);
      const backupRoot = join(installRoot, "..", `.prism-update-backup`);
      const currentBackup = join(installRoot, "..", `.prism-prev-${installName}`);

      const userFilesToPreserve = [".env", "prism.db", "logs"];

      try {
        if (existsSync(stagedRoot)) {
          rmSync(stagedRoot, { recursive: true, force: true });
        }
        execFileSync(resolveBin("cp"), ["-R", `${extractedDir}/.`, `${stagedRoot}/`], {
          stdio: "inherit",
        });

        for (const file of userFilesToPreserve) {
          const source = join(installRoot, file);
          const dest = join(stagedRoot, file);
          if (existsSync(source)) {
            if (existsSync(dest)) {
              rmSync(dest, { recursive: true, force: true });
            }
            execFileSync(resolveBin("cp"), ["-R", source, dest], { stdio: "inherit" });
          }
        }

        if (existsSync(backupRoot)) {
          rmSync(backupRoot, { recursive: true, force: true });
        }

        execFileSync(resolveBin("mv"), [installRoot, currentBackup], { stdio: "inherit" });
        try {
          execFileSync(resolveBin("mv"), [stagedRoot, installRoot], { stdio: "inherit" });
        } catch (swapErr) {
          if (existsSync(currentBackup) && !existsSync(installRoot)) {
            execFileSync(resolveBin("mv"), [currentBackup, installRoot], { stdio: "inherit" });
          }
          throw swapErr;
        }
        if (existsSync(currentBackup)) {
          execFileSync(resolveBin("mv"), [currentBackup, backupRoot], { stdio: "inherit" });
        }

        // Post-apply health check
        console.log("Running post-apply health check...");
        try {
          execFileSync(resolveBin("bunx"), ["tsc", "--noEmit"], {
            cwd: installRoot,
            stdio: "inherit",
            timeout: 30_000,
          });
        } catch (healthErr) {
          console.error("Post-apply health check failed — rolling back");
          try {
            rmSync(installRoot, { recursive: true, force: true });
            if (existsSync(backupRoot)) {
              execFileSync(resolveBin("mv"), [backupRoot, installRoot], { stdio: "inherit" });
            }
          } catch (rollbackErr) {
            throw new UpdateAbort(
              "Update failed: health check did not pass AND rollback failed. " +
                `Your install at ${installRoot} may be in an inconsistent state. ` +
                `Previous version is at ${backupRoot}.`,
            );
          }
          throw new UpdateAbort(
            `Post-apply health check failed — rolled back to previous version. ` +
              `Error: ${healthErr instanceof Error ? healthErr.message : String(healthErr)}`,
          );
        }
        console.log("✓ Post-apply health check passed");
      } catch (swapErr) {
        if (existsSync(stagedRoot)) {
          try {
            rmSync(stagedRoot, { recursive: true, force: true });
          } catch {
            // ignore cleanup failure
          }
        }
        throw swapErr;
      }

      logger.info(`Updated to ${latest} from ${release.source}`);
      console.log(`✓ Updated to ${latest}`);

      // Reset version install timestamp for force-update tracking
      try {
        const prismDir = join(homedir(), ".config", "prism");
        if (!existsSync(prismDir)) mkdirSync(prismDir, { recursive: true, mode: 0o700 });
        const timestampFile = join(prismDir, "version-installed-at");
        writeFileSync(timestampFile, String(Date.now()), { mode: 0o600 });
      } catch {
        // non-fatal: timestamp reset failure doesn't block update
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const exitCode = err instanceof UpdateAbort ? err.exitCode : 1;
      if (err instanceof UpdateAbort) {
        console.error("Error:", message);
      } else {
        logger.error("Update failed", { error: message });
        console.error("Error:", message);
      }
      process.exit(exitCode);
    } finally {
      // Always clean up the work directory, regardless of how we exit.
      if (workDir && existsSync(workDir)) {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });
