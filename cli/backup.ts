import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createBackup,
  discoverProfileDatabases,
  readBackupManifest,
  restoreBackup,
  type BackupSource,
  type RestoreReport,
} from "../engine/backup.js";
import { getPrismConfigDir, getPrismDbPath } from "../engine/paths.js";

interface SourceOptions {
  readonly db?: string;
  readonly profile?: string;
}

function collectSources(options: SourceOptions): BackupSource[] {
  const sources: BackupSource[] = [];
  if (options.db !== undefined && options.db.length > 0) {
    sources.push({ path: options.db });
  }
  if (options.profile !== undefined && options.profile.length > 0) {
    // `--profile` names either a directory or a bare profile name under
    // ~/.config (so `--profile prism-paper-bin20` finds its `.env`).
    const named = options.profile;
    const directory = named.includes("/") ? named : join(homedir(), ".config", named);
    sources.push(
      ...discoverProfileDatabases(join(directory, "..")).filter((source) =>
        (source.profileDir ?? "").endsWith(named.replace(/\/$/, "")),
      ),
    );
  }
  if (sources.length === 0) {
    // Default: the active database, plus every profile under ~/.config/prism-*.
    sources.push({ path: getPrismDbPath() });
    sources.push(...discoverProfileDatabases(join(homedir(), ".config")));
  }
  return sources;
}

function printBackup(result: Awaited<ReturnType<typeof createBackup>>): void {
  console.log(`Archive: ${result.dir}`);
  console.log(
    `Prism ${result.manifest.prismVersion} · SQLite ${result.manifest.sqliteVersion} · ${result.manifest.platform}`,
  );
  for (const entry of result.manifest.databases) {
    const rows = Object.entries(entry.tableCounts)
      .map(([table, count]) => `${table}=${count}`)
      .join(" ");
    console.log(
      `  ${entry.artifact}  ${(entry.bytes / 1024 / 1024).toFixed(1)} MB  schema=${entry.schemaVersion ?? "n/a"}  ${entry.sha256.slice(0, 16)}…`,
    );
    console.log(`    from ${entry.sourcePath}`);
    console.log(`    rows ${rows}`);
  }
  console.log(`\nVerify this archive with: prism restore ${result.dir} --verify-only`);
}

function printRestore(report: RestoreReport): void {
  const verdict = report.problems.length === 0 ? "OK" : "FAILED";
  console.log(`${report.verifiedOnly ? "Verified" : "Restored"} ${report.archiveDir} — ${verdict}`);
  for (const entry of report.entries) {
    console.log(`  ${entry.artifact}`);
    console.log(`    target       ${entry.targetPath}`);
    if (entry.displacedTo !== null) console.log(`    displaced to ${entry.displacedTo}`);
    console.log(`    integrity    ${entry.integrityCheck}`);
    console.log(`    sqlite-vec   ${entry.vecAvailable ? "available" : "NOT AVAILABLE"}`);
    if (entry.countRegressions.length > 0) {
      console.log(`    short tables ${entry.countRegressions.join(", ")}`);
    }
  }
  for (const problem of report.problems) console.log(`  problem: ${problem}`);
  if (report.problems.length > 0) {
    console.log(
      "\nNothing was installed for the failed entries above. The live databases are unchanged.",
    );
  }
}

export const backupCommand = new Command("backup")
  .description(
    "Archive the live SQLite databases with a verifiable manifest (read-only on the sources)",
  )
  .option(
    "-d, --db <path>",
    "Database to back up (repeatable via multiple flags is not supported; use --profile)",
  )
  .option(
    "-p, --profile <dir>",
    "Profile directory (or ~/.config/prism-* name) whose .env names the database",
  )
  .option("-o, --out <dir>", "Archive directory (default: ./prism-backup-<timestamp>)")
  .option("-j, --json", "Print the manifest as JSON")
  .action(async (options: SourceOptions & { readonly out?: string; readonly json?: boolean }) => {
    const now = Date.now();
    const outDir = options.out ?? join(process.cwd(), `prism-backup-${now}`);
    try {
      const result = await createBackup({ sources: collectSources(options), outDir, now });
      if (options.json === true) {
        console.log(JSON.stringify(result.manifest, null, 2));
      } else {
        printBackup(result);
      }
    } catch (error) {
      console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  });

export const restoreCommand = new Command("restore")
  .description("Verify and restore a Prism backup archive")
  .argument("<archive>", "Archive directory produced by `prism backup`")
  .option(
    "-t, --target-dir <dir>",
    "Restore into this directory instead of the recorded source paths",
  )
  .option(
    "-f, --force",
    "Overwrite existing databases (the old file is moved aside, never deleted)",
  )
  .option("--verify-only", "Check hashes, integrity and row counts without writing anything")
  .option("-j, --json", "Print the report as JSON")
  .action(
    async (
      archive: string,
      options: {
        readonly targetDir?: string;
        readonly force?: boolean;
        readonly verifyOnly?: boolean;
        readonly json?: boolean;
      },
    ) => {
      try {
        // A manifest-only read first: a wrong directory fails with a clear
        // message instead of a partial restore.
        readBackupManifest(archive);
        const report = await restoreBackup({
          archiveDir: archive,
          now: Date.now(),
          ...(options.targetDir !== undefined && { targetDir: options.targetDir }),
          ...(options.force === true && { force: true }),
          ...(options.verifyOnly === true && { verifiedOnly: true }),
        });
        if (options.json === true) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          printRestore(report);
        }
        if (report.problems.length > 0) process.exitCode = 1;
      } catch (error) {
        console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    },
  );

/** Shared by the CLI description string so the config dir shows up in help. */
export const backupDefaultConfigDir = getPrismConfigDir();
