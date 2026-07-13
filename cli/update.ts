import { Command } from "commander";
import {
  createWriteStream,
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { pipeline } from "stream/promises";
import { dirname, join } from "path";
import { tmpdir, homedir } from "os";
import { createHash } from "crypto";
import { getCurrentVersion } from "../engine/version.js";
import { isSourceInstall } from "../engine/install-method.js";
import {
  compareVersions,
  isValidVersion,
  fetchLatestRelease,
  R2_PUBLIC_URL,
  type ReleaseInfo,
  getVersionAgnosticInstallDir,
} from "../engine/update-utils.js";
import { Effect } from "effect";
import { createLogger } from "../engine/logger.js";

if (typeof Bun === "undefined") {
  console.error("The prism update command requires the Bun runtime.");
  process.exit(1);
}

const logger = createLogger("update");

const SMOKE_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 600_000;

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
    const cwdMsg = options?.cwd ? ` in ${options.cwd}` : "";
    throw new UpdateAbort(
      `Command failed: ${name} ${args.join(" ")}${cwdMsg} (exit ${result.exitCode})`,
    );
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
    const cwdMsg = options?.cwd ? ` in ${options.cwd}` : "";
    throw new UpdateAbort(
      `Command failed: ${name} ${args.join(" ")}${cwdMsg} (exit ${result.exitCode})`,
    );
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

async function fetchAndValidateChecksum(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new UpdateAbort(
      `Failed to fetch SHA-256 checksum: ${response.status} ${response.statusText}`,
    );
  }
  const checksumText = (await response.text()).trim();
  if (!checksumText) {
    throw new UpdateAbort("SHA-256 checksum file is empty");
  }
  const [expectedHash] = checksumText.split(/\s+/);
  if (!expectedHash || !/^[a-fA-F0-9]{64}$/.test(expectedHash)) {
    throw new UpdateAbort(`SHA-256 checksum file is malformed: ${checksumText.slice(0, 32)}`);
  }
  return expectedHash;
}

async function downloadAndVerify(
  url: string,
  sha256Url: string | undefined,
  bundlePath: string,
  source: "r2" | "github",
): Promise<void> {
  console.log(`Downloading from ${source === "r2" ? "R2" : "GitHub"}...`);
  await downloadFile(url, bundlePath);
  console.log(`✓ Downloaded to ${bundlePath}`);

  if (!sha256Url) {
    throw new UpdateAbort(
      "Release manifest missing SHA-256 URL — refusing to install without integrity check",
    );
  }

  console.log("Verifying SHA-256 checksum...");
  const expectedHash = await fetchAndValidateChecksum(sha256Url);
  verifyChecksum(bundlePath, expectedHash);
  console.log("✓ SHA-256 checksum verified");
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

function resolveInstallRoot(): string {
  try {
    const wrapperBin = resolveWrapperBin();
    const realPath = realpathSync(wrapperBin);
    const candidate = dirname(dirname(realPath));
    if (isSourceInstall(candidate)) {
      logger.debug(`Detected source install via wrapper: ${candidate}`);
      return candidate;
    }
  } catch {}

  try {
    const main = typeof Bun !== "undefined" ? Bun.main : (process.argv[1] ?? "");
    if (main) {
      const mainReal = realpathSync(main);
      const mainCandidate = dirname(dirname(mainReal));
      if (isSourceInstall(mainCandidate)) {
        logger.debug(`Detected source install via entry script: ${mainCandidate}`);
        return mainCandidate;
      }
    }
  } catch {}

  const installDir = resolveInstallDir();
  logger.debug(`Falling back to bundle install dir: ${installDir}`);
  return installDir;
}

function isWrapperSymlink(wrapperBin: string): boolean {
  try {
    return lstatSync(wrapperBin).isSymbolicLink();
  } catch {
    return false;
  }
}

function rewriteWrapperSymlink(wrapperBin: string, sourceDir: string): void {
  let tempLink: string | undefined;
  try {
    if (!lstatSync(wrapperBin).isSymbolicLink()) return;
    const target = join(sourceDir, "cli", "index.ts");
    tempLink = `${wrapperBin}.tmp-${Date.now()}`;
    symlinkSync(target, tempLink);
    renameSync(tempLink, wrapperBin);
  } catch (error) {
    const target = join(sourceDir, "cli", "index.ts");
    logger.warn(`Failed to rewrite source wrapper symlink at "${wrapperBin}" to "${target}"`, {
      error: error instanceof Error ? error.message : String(error),
    });
    if (tempLink) {
      try {
        rmSync(tempLink, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

function rewriteBundleWrapperSymlink(wrapperBin: string, installDir: string): boolean {
  let tempLink: string | undefined;
  try {
    if (!lstatSync(wrapperBin).isSymbolicLink()) return true;
    const target = join(installDir, "dist", "cli", "index.mjs");
    tempLink = `${wrapperBin}.tmp-${Date.now()}`;
    symlinkSync(target, tempLink);
    renameSync(tempLink, wrapperBin);
    return true;
  } catch (error) {
    const target = join(installDir, "dist", "cli", "index.mjs");
    logger.warn(`Failed to rewrite bundle wrapper symlink at "${wrapperBin}" to "${target}"`, {
      error: error instanceof Error ? error.message : String(error),
    });
    if (tempLink) {
      try {
        rmSync(tempLink, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    return false;
  }
}

function rewriteBundleWrapper(wrapperBin: string, installDir: string): void {
  if (isWrapperSymlink(wrapperBin)) {
    if (!rewriteBundleWrapperSymlink(wrapperBin, installDir)) {
      throw new UpdateAbort(`Failed to rewrite bundle wrapper symlink at "${wrapperBin}"`);
    }
    return;
  }

  let temporary: string | undefined;
  try {
    const existing = readFileSync(wrapperBin, "utf8");
    if (!existing.includes("Auto-generated by Prism installer")) return;
    const extension = process.platform === "darwin" ? "dylib" : "so";
    const content = `#!/usr/bin/env bash
# Auto-generated by Prism installer. Runs the compiled bundle.
export PRISM_INSTALL_DIR="${installDir}"
export PRISM_VEC0_PATH="${installDir}/lib/vec0.${extension}"
exec bun "${installDir}/dist/cli/index.mjs" "$@"
`;
    temporary = `${wrapperBin}.tmp-${Date.now()}`;
    writeFileSync(temporary, content, { mode: 0o755 });
    renameSync(temporary, wrapperBin);
    temporary = undefined;
  } catch (error) {
    logger.warn(`Failed to rewrite bundle wrapper at "${wrapperBin}"`, {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new UpdateAbort(`Failed to rewrite bundle wrapper at "${wrapperBin}"`);
  } finally {
    if (temporary && existsSync(temporary)) {
      try {
        rmSync(temporary, { force: true });
      } catch (cleanupError) {
        logger.debug("Failed to remove temporary bundle wrapper", {
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    }
  }
}

function migrateVersionedInstallDir(installDir: string): string {
  const canonicalDir = getVersionAgnosticInstallDir(installDir);
  if (canonicalDir === installDir || !existsSync(installDir) || existsSync(canonicalDir)) {
    return installDir;
  }
  try {
    renameSync(installDir, canonicalDir);
    logger.info(`Migrated versioned install directory to ${canonicalDir}`);
    return canonicalDir;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "EEXIST" || code === "ENOTEMPTY") {
      logger.info(`Versioned install migration raced with another update; using ${canonicalDir}`);
      return canonicalDir;
    }
    if (code === "EXDEV") {
      try {
        cpSync(installDir, canonicalDir, { recursive: true });
        rmSync(installDir, { recursive: true, force: true });
        logger.info(`Copied versioned install directory to ${canonicalDir}`);
        return canonicalDir;
      } catch (copyError) {
        logger.warn(`Failed to copy versioned install directory to ${canonicalDir}`, {
          error: copyError instanceof Error ? copyError.message : String(copyError),
        });
        return installDir;
      }
    }
    logger.warn(`Failed to migrate versioned install directory to ${canonicalDir}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return installDir;
  }
}

function findSourceRoot(extractedDir: string): string {
  const candidates = [
    extractedDir,
    join(extractedDir, "prism"),
    join(extractedDir, "prism-liquidity-agent"),
  ];
  for (const dir of candidates) {
    if (
      existsSync(join(dir, "package.json")) &&
      existsSync(join(dir, "engine")) &&
      existsSync(join(dir, "cli", "index.ts"))
    ) {
      return dir;
    }
  }
  throw new UpdateAbort("Extracted source tarball does not contain a valid Prism source tree");
}

function preserveUserData(sourceDir: string, destDir: string): void {
  const items = [".env", "prism.db", "prism.db-wal", "prism.db-shm", "logs"];
  for (const item of items) {
    const src = join(sourceDir, item);
    const dest = join(destDir, item);
    if (existsSync(src)) {
      cpSync(src, dest, { recursive: true });
    }
  }
}

function migrateBundleStateToUserDirs(installDir: string): void {
  const configDir = process.env.PRISM_CONFIG_DIR ?? join(homedir(), ".config", "prism");
  const dataDir = process.env.PRISM_DATA_DIR ?? join(homedir(), ".local", "share", "prism");

  const legacyEnv = join(installDir, ".env");
  const configEnv = join(configDir, ".env");
  if (existsSync(legacyEnv) && !existsSync(configEnv)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    cpSync(legacyEnv, configEnv);
    chmodSync(configEnv, 0o600);
  }

  for (const item of ["prism.db", "prism.db-wal", "prism.db-shm", "logs"]) {
    const legacyPath = join(installDir, item);
    const dataPath = join(dataDir, item);
    if (!existsSync(legacyPath) || existsSync(dataPath)) continue;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    cpSync(legacyPath, dataPath, { recursive: true });
  }
}

async function updateFromSource(
  release: ReleaseInfo,
  currentDir: string,
  workDir: string,
  skipSmokeTest: boolean,
): Promise<void> {
  console.log("Source install detected; updating from source tarball...");

  if (!release.tarballUrl) {
    throw new UpdateAbort(
      `No source tarball URL available for version ${release.version}. ` +
        `Please reinstall with the latest install script.`,
    );
  }

  const bundleName = `prism-v${release.version}.tar.gz`;
  const bundlePath = join(workDir, bundleName);

  await downloadAndVerify(release.tarballUrl, release.sha256Url, bundlePath, release.source);

  console.log("Extracting source tarball...");
  const extractedDir = join(workDir, "extracted");
  extractTarball(bundlePath, extractedDir);
  const sourceRoot = findSourceRoot(extractedDir);

  console.log("Preserving user data (.env, prism.db, logs)...");
  preserveUserData(currentDir, sourceRoot);

  console.log("Installing dependencies in new source tree...");
  runCommand("bun", ["install"], { cwd: sourceRoot, timeout: BUILD_TIMEOUT_MS });

  console.log("Building new source tree...");
  runCommand("bun", ["run", "build"], { cwd: sourceRoot, timeout: BUILD_TIMEOUT_MS });

  const wrapperBin = resolveWrapperBin();
  const isSymlink = isWrapperSymlink(wrapperBin);
  const backupDir = atomicReplaceInstall(currentDir, sourceRoot);

  try {
    rewriteWrapperSymlink(wrapperBin, currentDir);
    smokeTest(wrapperBin, skipSmokeTest);
  } catch (smokeErr) {
    console.error("Smoke test failed — rolling back");
    if (existsSync(currentDir)) {
      rmSync(currentDir, { recursive: true, force: true });
    }
    if (existsSync(backupDir)) {
      renameSync(backupDir, currentDir);
    }
    if (isSymlink && existsSync(wrapperBin)) {
      rewriteWrapperSymlink(wrapperBin, currentDir);
    }
    throw new UpdateAbort(
      `Smoke test failed — rolled back to previous version. ` +
        `Error: ${smokeErr instanceof Error ? smokeErr.message : String(smokeErr)}`,
    );
  }

  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true });
  }
}

async function updateFromBundle(
  release: ReleaseInfo,
  workDir: string,
  skipSmokeTest: boolean,
): Promise<void> {
  if (!release.bundleUrl) {
    throw new UpdateAbort(
      `No bundle URL available for version ${release.version}. ` +
        `Please reinstall with the latest install script.`,
    );
  }

  const bundleName = `prism-v${release.version}.tar.gz`;
  const bundlePath = join(workDir, bundleName);

  await downloadAndVerify(release.bundleUrl, release.bundleSha256Url, bundlePath, release.source);

  console.log("Extracting bundle...");
  const extractedDir = join(workDir, "extracted");
  extractTarball(bundlePath, extractedDir);
  const bundleRoot = findBundleRoot(extractedDir);

  const previousInstallDir = resolveInstallDir();
  const installDir = migrateVersionedInstallDir(previousInstallDir);
  migrateBundleStateToUserDirs(installDir);
  preserveUserData(installDir, bundleRoot);

  console.log("Installing bundle...");
  const backupDir = atomicReplaceInstall(installDir, bundleRoot);

  const wrapperBin = resolveWrapperBin();
  try {
    rewriteBundleWrapper(wrapperBin, installDir);
    smokeTest(wrapperBin, skipSmokeTest);
  } catch (smokeErr) {
    console.error("Smoke test failed — rolling back");
    if (existsSync(installDir)) {
      rmSync(installDir, { recursive: true, force: true });
    }
    if (existsSync(backupDir)) {
      renameSync(backupDir, installDir);
    }
    if (
      installDir !== previousInstallDir &&
      existsSync(installDir) &&
      !existsSync(previousInstallDir)
    ) {
      try {
        renameSync(installDir, previousInstallDir);
      } catch (restoreDirErr) {
        logger.error("Failed to restore the previous install directory after rollback", {
          error: restoreDirErr instanceof Error ? restoreDirErr.message : String(restoreDirErr),
        });
      }
    }
    try {
      rewriteBundleWrapper(wrapperBin, previousInstallDir);
    } catch (restoreErr) {
      logger.error("Failed to restore the previous bundle wrapper after rollback", {
        error: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
      });
    }
    throw new UpdateAbort(
      `Smoke test failed — rolled back to previous version. ` +
        `Error: ${smokeErr instanceof Error ? smokeErr.message : String(smokeErr)}`,
    );
  }

  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true });
  }
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
      const channelValue = String(options.channel);
      if (channelValue !== "stable" && channelValue !== "beta" && channelValue !== "dev") {
        throw new UpdateAbort(
          `Invalid release channel '${channelValue}'. Use stable, beta, or dev.`,
        );
      }
      const channel = channelValue;
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

      workDir = join(tmpdir(), `prism-update-${Date.now()}`);
      mkdirSync(workDir, { recursive: true });

      const installRoot = resolveInstallRoot();
      const fromSource = isSourceInstall(installRoot);
      if (fromSource) {
        await updateFromSource(release, installRoot, workDir, options.skipSmokeTest as boolean);
      } else {
        await updateFromBundle(release, workDir, options.skipSmokeTest as boolean);
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
