import { Command } from "commander";
import { execSync } from "child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { pipeline } from "stream/promises";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { getCurrentVersion } from "../engine/version.js";
import {
  compareVersions,
  isValidVersion,
  fetchLatestRelease,
  R2_PUBLIC_URL,
} from "../engine/update-utils.js";
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
      execSync(`tar -xzf "${tarballPath}" -C "${workDir}"`, { stdio: "inherit" });

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
      execSync("bun install", { cwd: extractedDir, stdio: "inherit" });

      // === Pre-apply smoke tests ===
      console.log("Running TypeScript smoke test...");
      try {
        execSync("bunx tsc --noEmit", { cwd: extractedDir, stdio: "inherit" });
      } catch {
        throw new UpdateAbort(`TypeScript smoke test failed — refusing to install ${latest}`);
      }
      console.log("✓ TypeScript smoke test passed");

      console.log("Running test suite smoke test...");
      try {
        execSync("bunx vitest run --reporter=basic", { cwd: extractedDir, stdio: "inherit" });
      } catch {
        throw new UpdateAbort(`Test suite smoke test failed — refusing to install ${latest}`);
      }
      console.log("✓ Test suite smoke test passed");

      // Atomic swap: stage new files alongside the install root, then rename.
      // A direct copy into the live install can leave it half-updated on failure.
      const installRoot = resolveInstallRoot();
      const installName = installRoot.split("/").pop() ?? "prism-liquidity-agent";
      const stagedRoot = join(installRoot, "..", `.prism-update-stage`);
      const backupRoot = join(installRoot, "..", `.prism-update-backup`);
      const currentBackup = join(installRoot, "..", `.prism-prev-${installName}`);

      try {
        if (existsSync(stagedRoot)) {
          rmSync(stagedRoot, { recursive: true, force: true });
        }
        execSync(`cp -R "${extractedDir}/." "${stagedRoot}/"`, { stdio: "inherit" });

        if (existsSync(backupRoot)) {
          rmSync(backupRoot, { recursive: true, force: true });
        }

        execSync(`mv "${installRoot}" "${currentBackup}"`, { stdio: "inherit" });
        try {
          execSync(`mv "${stagedRoot}" "${installRoot}"`, { stdio: "inherit" });
        } catch (swapErr) {
          if (existsSync(currentBackup) && !existsSync(installRoot)) {
            execSync(`mv "${currentBackup}" "${installRoot}"`);
          }
          throw swapErr;
        }
        if (existsSync(currentBackup)) {
          execSync(`mv "${currentBackup}" "${backupRoot}"`, { stdio: "inherit" });
        }

        // Post-apply health check
        console.log("Running post-apply health check...");
        try {
          execSync("bunx tsc --noEmit", { cwd: installRoot, stdio: "inherit", timeout: 30_000 });
        } catch (healthErr) {
          console.error("Post-apply health check failed — rolling back");
          try {
            rmSync(installRoot, { recursive: true, force: true });
            if (existsSync(backupRoot)) {
              execSync(`mv "${backupRoot}" "${installRoot}"`, { stdio: "inherit" });
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
