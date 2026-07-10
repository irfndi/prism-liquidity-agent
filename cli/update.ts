import { Command } from "commander";
import {
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { pipeline } from "stream/promises";
import { dirname, join } from "path";
import { tmpdir, homedir } from "os";
import { createHash } from "crypto";
import { getCurrentVersion } from "../engine/version.js";
import {
  compareVersions,
  isValidVersion,
  fetchLatestRelease,
  R2_PUBLIC_URL,
} from "../engine/update-utils.js";
import { Effect } from "effect";
import { createLogger } from "../engine/logger.js";

if (typeof Bun === "undefined") {
  console.error("The prism update command requires the Bun runtime.");
  process.exit(1);
}

const logger = createLogger("update");

const SMOKE_TIMEOUT_MS = 60_000;

class UpdateAbort extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "UpdateAbort";
  }
}

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

function resolveInstallDir(): string {
  return process.env.PRISM_INSTALL_DIR ?? join(homedir(), ".prism");
}

function resolveWrapperBin(): string {
  const fromEnv = process.env.PRISM_WRAPPER_BIN;
  if (fromEnv) return fromEnv;
  const fromPath = Bun.which("prism");
  if (fromPath) return fromPath;
  return join(homedir(), ".local", "bin", "prism");
}

function runCommand(
  name: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): void {
  const bin = resolveBin(name);
  const result = Bun.spawnSync([bin, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    ...(options?.timeout ? { timeout: options.timeout } : {}),
  });
  if (!result.success) {
    throw new UpdateAbort(`Command failed: ${name} ${args.join(" ")} (exit ${result.exitCode})`);
  }
}

function runCommandOutput(
  name: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
): string {
  const bin = resolveBin(name);
  const result = Bun.spawnSync([bin, ...args], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
    ...(options?.cwd ? { cwd: options.cwd } : {}),
    ...(options?.timeout ? { timeout: options.timeout } : {}),
  });
  if (!result.success) {
    throw new UpdateAbort(`Command failed: ${name} ${args.join(" ")} (exit ${result.exitCode})`);
  }
  return result.stdout.toString().trim();
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) {
    throw new UpdateAbort(`Download failed: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new UpdateAbort("Download response has no body");
  }
  await pipeline(response.body, createWriteStream(dest));
}

function verifyChecksum(bundlePath: string, expectedHash: string): void {
  const fileBuffer = readFileSync(bundlePath);
  const actualHash = createHash("sha256").update(fileBuffer).digest("hex");
  if (actualHash !== expectedHash) {
    throw new UpdateAbort(`SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
}

function extractTarball(tarballPath: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  runCommand("tar", ["-xzf", tarballPath, "-C", destDir]);
}

function findBundleRoot(extractedDir: string): string {
  // The bundle tarball contains `dist/` and `lib/` at its root. Some tar
  // tools add a single top-level prefix; tolerate that.
  const candidates = [
    extractedDir,
    join(extractedDir, "prism"),
    join(extractedDir, "prism-liquidity-agent"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "dist", "cli", "index.mjs"))) {
      return dir;
    }
  }
  throw new UpdateAbort(
    "Extracted bundle does not contain dist/cli/index.mjs — cannot determine install root",
  );
}

function atomicReplaceInstall(installDir: string, newDir: string): string {
  const parent = dirname(installDir);
  const backupDir = join(parent, `.prism-update-backup-${Date.now()}`);
  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true });
  }
  if (existsSync(installDir)) {
    renameSync(installDir, backupDir);
  }
  try {
    cpSync(newDir, installDir, { recursive: true });
  } catch (err) {
    if (existsSync(installDir)) {
      rmSync(installDir, { recursive: true, force: true });
    }
    if (existsSync(backupDir)) {
      renameSync(backupDir, installDir);
    }
    throw err;
  }
  return backupDir;
}

function smokeTest(wrapperBin: string, skipSmokeTest: boolean): void {
  if (skipSmokeTest) {
    console.log("⚠ Skipping smoke test (--skip-smoke-test)");
    return;
  }
  console.log("Running smoke test...");
  const versionOutput = runCommandOutput(wrapperBin, ["--version"], {
    timeout: SMOKE_TIMEOUT_MS,
  });
  console.log(`  version: ${versionOutput}`);
  runCommand(wrapperBin, ["--help"], { timeout: SMOKE_TIMEOUT_MS });
  console.log("✓ Smoke test passed");
}

export const updateCommand = new Command("update")
  .description("Check for and apply updates")
  .option("--check-only", "Only check for updates, don't apply")
  .option("--channel <channel>", "Release channel (stable, beta, dev)", "stable")
  .option("--r2-url <url>", "R2 public URL for release bundles", R2_PUBLIC_URL)
  .option("--skip-smoke-test", "Skip post-install smoke test")
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
      if (release.bundleUrl) {
        console.log(`Download: ${release.bundleUrl}`);
      }

      if (options.checkOnly) {
        return;
      }

      if (!release.bundleUrl) {
        throw new UpdateAbort(
          `No bundle URL available for version ${latest}. ` +
            `Please reinstall with the latest install script.`,
        );
      }

      workDir = join(tmpdir(), `prism-update-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });
      const bundleName = `prism-v${latest}.tar.gz`;
      const bundlePath = join(workDir, bundleName);

      console.log(`Downloading from ${release.source === "r2" ? "R2" : "GitHub"}...`);
      await downloadFile(release.bundleUrl, bundlePath);
      console.log(`✓ Downloaded to ${bundlePath}`);

      if (!release.bundleSha256Url) {
        throw new UpdateAbort(
          `Release manifest missing bundleSha256Url — refusing to install ${latest} without integrity check`,
        );
      }
      console.log("Verifying SHA-256 checksum...");
      const expectedHashResponse = await fetch(release.bundleSha256Url, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!expectedHashResponse.ok) {
        throw new UpdateAbort(
          `Failed to fetch SHA-256 checksum: ${expectedHashResponse.status} ${expectedHashResponse.statusText}`,
        );
      }
      const expectedHash = (await expectedHashResponse.text()).trim().split(/\s+/)[0] ?? "";
      verifyChecksum(bundlePath, expectedHash);
      console.log("✓ SHA-256 checksum verified");

      console.log("Extracting bundle...");
      const extractedDir = join(workDir, "extracted");
      extractTarball(bundlePath, extractedDir);
      const bundleRoot = findBundleRoot(extractedDir);

      console.log("Installing bundle...");
      const installDir = resolveInstallDir();
      const backupDir = atomicReplaceInstall(installDir, bundleRoot);

      const wrapperBin = resolveWrapperBin();
      try {
        smokeTest(wrapperBin, options.skipSmokeTest as boolean);
      } catch (smokeErr) {
        console.error("Smoke test failed — rolling back");
        if (existsSync(installDir)) {
          rmSync(installDir, { recursive: true, force: true });
        }
        if (existsSync(backupDir)) {
          renameSync(backupDir, installDir);
        }
        throw new UpdateAbort(
          `Smoke test failed — rolled back to previous version. ` +
            `Error: ${smokeErr instanceof Error ? smokeErr.message : String(smokeErr)}`,
        );
      }

      if (existsSync(backupDir)) {
        rmSync(backupDir, { recursive: true, force: true });
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
