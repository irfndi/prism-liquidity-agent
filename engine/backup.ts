/**
 * SQLite backup / restore with a verifiable manifest.
 *
 * Why this exists (issue #250): the agent's ledger is the only durable record
 * of what it did with money. Moving hosts without a restore that PROVES the
 * copy is complete is how a ledger quietly loses months of history.
 *
 * Design:
 * - **Online copy, not a file copy.** `VACUUM INTO` produces a transactionally
 *   consistent single-file copy of a live WAL database without stopping the
 *   writer and without the memory cost of `sqlite3_serialize` (which loads the
 *   whole database into RAM — 5.4 GB of databases on a 2 GB host is exactly the
 *   case that must not do that).
 * - **A manifest that can be checked.** Every artifact carries its byte size,
 *   SHA-256, schema version, per-table row counts and the result of
 *   `PRAGMA quick_check`. Restore re-verifies all of it and refuses to write a
 *   database that does not match.
 * - **Restore never destroys silently.** The target is written to a temp file,
 *   integrity-checked, then renamed; an existing database is moved aside to
 *   `<path>.pre-restore-<timestamp>` rather than deleted.
 *
 * Plain module: no Effect services, no clock reads (callers pass `now`).
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Schema } from "effect";
import { attachVecExtension } from "./db.js";
import { getCurrentVersion } from "./version.js";

export const BACKUP_MANIFEST_VERSION = 1;
export const MANIFEST_FILE = "manifest.json";
export const CHECKSUMS_FILE = "SHA256SUMS";

export type SqliteCheck = "ok" | "failed";

/** Per-table row counts, measured on one database. */
export interface TableCounts {
  readonly [table: string]: number;
}

/** Key/value pairs from a profile `.env` (values only, unquoted). */
export interface ProfileEnv {
  readonly [key: string]: string;
}

export interface BackupSource {
  /** Path the live engine writes. Absolute. */
  readonly path: string;
  /** Profile directory this path was resolved from, when auto-discovered. */
  readonly profileDir?: string;
}

export interface DatabaseBackupEntry {
  readonly sourcePath: string;
  readonly profileDir: string | null;
  /** Filename inside the archive directory. */
  readonly artifact: string;
  readonly bytes: number;
  readonly sha256: string;
  /** Highest applied migration (`_migrations`), null when the table is absent. */
  readonly schemaVersion: number | null;
  /** Row count per user table, measured on the source database. */
  readonly tableCounts: TableCounts;
  readonly quickCheck: SqliteCheck;
  readonly sqliteVersion: string;
}

export interface BackupManifest {
  readonly manifestVersion: number;
  readonly createdAt: string;
  readonly prismVersion: string;
  readonly sqliteVersion: string;
  readonly platform: string;
  readonly databases: readonly DatabaseBackupEntry[];
}

export interface BackupResult {
  readonly dir: string;
  readonly manifestPath: string;
  readonly manifest: BackupManifest;
}

export interface RestoreReportEntry {
  readonly artifact: string;
  readonly targetPath: string;
  /** Path the previous database was moved to, null when nothing was there. */
  readonly displacedTo: string | null;
  readonly integrityCheck: SqliteCheck;
  readonly vecAvailable: boolean;
  /** Tables whose restored count is below the manifest baseline. */
  readonly countRegressions: readonly string[];
  readonly bytes: number;
}

export interface RestoreReport {
  readonly archiveDir: string;
  readonly verifiedOnly: boolean;
  readonly entries: readonly RestoreReportEntry[];
  readonly problems: readonly string[];
}

/**
 * `_migrations` is bookkeeping, `sqlite_*` is SQLite's own, and `vec_memory_*`
 * are vec0's internal shadow tables: they are an implementation detail of the
 * extension, not a contract, so counting them would put noise in the manifest
 * and couple it to sqlite-vec's internals.
 */
const INTERNAL_TABLE_PREFIXES = ["sqlite_", "_migrations", "vec_memory_"];

/** A count that could not be measured (vec0 unavailable) is recorded as -1. */
export const COUNT_UNKNOWN = -1;

function isUserTable(name: string): boolean {
  return !INTERNAL_TABLE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** SHA-256 of a file without loading it into memory (archives are multi-GB). */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolvePromise());
  });
  return hash.digest("hex");
}

function tableNames(db: Database): string[] {
  // SAFETY: sqlite_master always returns a TEXT `name` column.
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name).filter(isUserTable);
}

/**
 * `vec_memory` is a vec0 VIRTUAL table: counting it without the extension
 * loaded fails with "no such module: vec0", which would abort the whole backup.
 * Counted when the extension is available, recorded as unavailable otherwise so
 * the manifest stays honest instead of dropping the table silently.
 */
const VEC_TABLE = "vec_memory";

function readTableCounts(db: Database, tables: readonly string[]): TableCounts {
  const counts: Record<string, number> = {};
  for (const table of tables) {
    // Table names come from sqlite_master, never user input; still quoted so an
    // odd name cannot break the statement.
    try {
      // SAFETY: COUNT(*) always returns exactly one integer row.
      const row = db.query(`SELECT COUNT(*) AS n FROM "${table.replaceAll('"', '""')}"`).get() as {
        n: number;
      };
      counts[table] = Number(row.n);
    } catch (error) {
      // Only the virtual table may be unreadable; anything else is a real bug.
      if (table !== VEC_TABLE) throw error;
      counts[table] = COUNT_UNKNOWN;
    }
  }
  return counts;
}

function readSchemaVersion(db: Database): number | null {
  try {
    // SAFETY: MAX(version) returns a single integer-or-NULL row.
    const row = db.query("SELECT MAX(version) AS v FROM _migrations").get() as {
      v: number | null;
    } | null;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

function runCheck(db: Database, pragma: "quick_check" | "integrity_check"): SqliteCheck {
  try {
    // SAFETY: both pragmas return rows keyed by their own `*_check` column.
    const rows = db.query(`PRAGMA ${pragma}`).all() as Array<Record<string, string>>;
    const messages = rows.map((row) => Object.values(row)[0] ?? "");
    return messages.length === 1 && messages[0] === "ok" ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

function readSqliteVersion(): string {
  const probe = new Database(":memory:");
  try {
    // SAFETY: sqlite_version() returns a single TEXT row.
    const row = probe.query("SELECT sqlite_version() AS v").get() as { v: string };
    return row.v;
  } finally {
    probe.close();
  }
}

/** Artifact name: stable, collision-free, and obviously tied to the source. */
function artifactName(sourcePath: string, used: Set<string>): string {
  const stem = basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, "_");
  if (!used.has(stem)) {
    used.add(stem);
    return stem;
  }
  let index = 2;
  while (used.has(`${index}-${stem}`)) index += 1;
  const name = `${index}-${stem}`;
  used.add(name);
  return name;
}

/**
 * Copy one live database into `outDir` and describe it.
 *
 * The copy is made with `VACUUM INTO`, which runs inside a single read
 * transaction: a writer that commits mid-copy either lands in the copy or does
 * not, never half of it.
 */
async function backupOne(
  source: BackupSource,
  outDir: string,
  used: Set<string>,
): Promise<DatabaseBackupEntry> {
  const sourcePath = resolve(source.path);
  if (!existsSync(sourcePath)) {
    throw new Error(`database not found: ${sourcePath}`);
  }
  const artifact = artifactName(sourcePath, used);
  const destination = join(outDir, artifact);
  // VACUUM INTO fails when the destination exists; a re-run must be clean.
  rmSync(destination, { force: true });

  const db = new Database(sourcePath);
  try {
    // vec0 virtual tables cannot be counted without the extension; the source is
    // live so the copy is what matters, but the manifest counts must be real.
    attachVecExtension(db);
    // A source that cannot pass quick_check is not worth archiving: silently
    // shipping a corrupt file is worse than failing the backup.
    const quickCheck = runCheck(db, "quick_check");
    if (quickCheck !== "ok") {
      throw new Error(
        `source database failed PRAGMA quick_check and will not be archived: ${sourcePath}`,
      );
    }
    const schemaVersion = readSchemaVersion(db);
    const counts = readTableCounts(db, tableNames(db));
    db.run("VACUUM INTO ?", [destination]);
    return {
      sourcePath,
      profileDir: source.profileDir === undefined ? null : resolve(source.profileDir),
      artifact,
      bytes: statSync(destination).size,
      sha256: await sha256File(destination),
      schemaVersion,
      tableCounts: counts,
      quickCheck,
      sqliteVersion: readSqliteVersion(),
    };
  } finally {
    db.close();
  }
}

/** `KEY=value` lines of a profile `.env`, values unquoted. */
export function parseProfileEnv(contents: string): ProfileEnv {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Databases named by the `prism-*` profile env files under `configRoot`.
 *
 * Profile files are a convenience, NOT ground truth: a stale profile can name a
 * database its process does not hold. The manifest records both the profile dir
 * and the resolved absolute path so the operator can compare them against
 * `/proc/<pid>/fd` before trusting a restore.
 */
export function discoverProfileDatabases(configRoot: string): BackupSource[] {
  if (!existsSync(configRoot)) return [];
  const sources: BackupSource[] = [];
  for (const entry of readdirSync(configRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("prism-")) continue;
    const profileDir = join(configRoot, entry.name);
    const envPath = join(profileDir, ".env");
    if (!existsSync(envPath)) continue;
    const declared = parseProfileEnv(readFileSync(envPath, "utf8")).SQLITE_DB_PATH;
    if (declared === undefined || declared.length === 0) continue;
    sources.push({ path: resolve(profileDir, declared), profileDir });
  }
  return sources;
}

/**
 * Archive every source into `outDir` and write the manifest + checksums.
 * Sources are de-duplicated by resolved path so two profiles sharing one
 * database do not archive it twice.
 */
export async function createBackup(input: {
  readonly sources: readonly BackupSource[];
  readonly outDir: string;
  readonly now: number;
}): Promise<BackupResult> {
  if (input.sources.length === 0) {
    throw new Error("no databases to back up (pass --db or --profile)");
  }
  const dir = resolve(input.outDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const unique = new Map<string, BackupSource>();
  for (const source of input.sources) {
    const key = resolve(source.path);
    if (!unique.has(key)) unique.set(key, source);
  }

  const used = new Set<string>();
  const databases: DatabaseBackupEntry[] = [];
  for (const source of unique.values()) {
    databases.push(await backupOne(source, dir, used));
  }

  const manifest: BackupManifest = {
    manifestVersion: BACKUP_MANIFEST_VERSION,
    createdAt: new Date(input.now).toISOString(),
    prismVersion: getCurrentVersion(),
    sqliteVersion: readSqliteVersion(),
    platform: `${process.platform}-${process.arch}`,
    databases,
  };
  const manifestPath = join(dir, MANIFEST_FILE);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(
    join(dir, CHECKSUMS_FILE),
    `${databases.map((entry) => `${entry.sha256}  ${entry.artifact}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  return { dir, manifestPath, manifest };
}

/** Wire format of `manifest.json`; decoded at the I/O boundary, then trusted. */
const ManifestSchema = Schema.Struct({
  manifestVersion: Schema.Number,
  createdAt: Schema.String,
  prismVersion: Schema.String,
  sqliteVersion: Schema.String,
  platform: Schema.String,
  databases: Schema.NonEmptyArray(
    Schema.Struct({
      sourcePath: Schema.String,
      profileDir: Schema.NullOr(Schema.String),
      artifact: Schema.String,
      bytes: Schema.Number,
      sha256: Schema.String,
      schemaVersion: Schema.NullOr(Schema.Number),
      tableCounts: Schema.Record(Schema.String, Schema.Number),
      quickCheck: Schema.Literals(["ok", "failed"]),
      sqliteVersion: Schema.String,
    }),
  ),
});
const ManifestFromJson = Schema.fromJsonString(ManifestSchema);

/** Read and decode `manifest.json` from an archive directory. */
export function readBackupManifest(archiveDir: string): BackupManifest {
  const manifestPath = join(resolve(archiveDir), MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new Error(`not a Prism backup archive (no ${MANIFEST_FILE}): ${resolve(archiveDir)}`);
  }
  const decoded = Schema.decodeUnknownSync(ManifestFromJson)(readFileSync(manifestPath, "utf8"));
  if (decoded.manifestVersion !== BACKUP_MANIFEST_VERSION) {
    throw new Error(
      `unsupported manifest version ${decoded.manifestVersion} (this build reads ${BACKUP_MANIFEST_VERSION})`,
    );
  }
  return decoded;
}

interface InspectedArtifact {
  readonly integrityCheck: SqliteCheck;
  readonly vecAvailable: boolean;
  readonly tableCounts: TableCounts;
}

/**
 * Open a database read-only and measure it. `vecAvailable` is advisory: a
 * missing extension on the inspecting host must not fail a restore whose data
 * is intact, but the operator needs to know before starting a profile.
 */
function inspectDatabase(path: string): InspectedArtifact {
  const db = new Database(path, { readonly: true });
  attachVecExtension(db);
  try {
    const integrityCheck = runCheck(db, "integrity_check");
    const tableCounts = readTableCounts(db, tableNames(db));
    let vecAvailable = false;
    try {
      db.query("SELECT 1 FROM vec_memory LIMIT 1").get();
      vecAvailable = true;
    } catch {
      vecAvailable = false;
    }
    return { integrityCheck, vecAvailable, tableCounts };
  } finally {
    db.close();
  }
}

/** Tables present in the manifest but missing or shorter in the restore. */
function countRegressions(expected: TableCounts, actual: TableCounts): string[] {
  const regressions: string[] = [];
  for (const [table, expectedCount] of Object.entries(expected)) {
    // An unmeasurable baseline (vec0 absent at backup time) is not a regression.
    if (expectedCount < 0) continue;
    const actualCount = actual[table];
    if (actualCount === undefined || actualCount < expectedCount) {
      regressions.push(table);
    }
  }
  return regressions.sort();
}

/** Result of inspecting (or installing) one artifact. */
interface ArtifactOutcome {
  readonly entry: RestoreReportEntry | null;
  readonly problems: readonly string[];
}

/** Verified-only inspection of one artifact: no writes, returns what it found. */
function verifyArtifact(database: DatabaseBackupEntry, artifactPath: string): ArtifactOutcome {
  const inspected = inspectDatabase(artifactPath);
  const regressions = countRegressions(database.tableCounts, inspected.tableCounts);
  const problems: string[] = [];
  if (inspected.integrityCheck !== "ok") {
    problems.push(`${database.artifact}: PRAGMA integrity_check failed`);
  }
  if (regressions.length > 0) {
    problems.push(`${database.artifact}: row counts below baseline in ${regressions.join(", ")}`);
  }
  return {
    entry: {
      artifact: database.artifact,
      targetPath: database.sourcePath,
      displacedTo: null,
      integrityCheck: inspected.integrityCheck,
      vecAvailable: inspected.vecAvailable,
      countRegressions: regressions,
      bytes: database.bytes,
    },
    problems,
  };
}

/** Move an existing database (and its WAL pair) aside, never delete it. */
function displaceExisting(targetPath: string, now: number): string | null {
  if (!existsSync(targetPath)) return null;
  const displacedTo = `${targetPath}.pre-restore-${now}`;
  renameSync(targetPath, displacedTo);
  // The old -wal/-shm belong to the displaced file. Leaving them beside the
  // restored one would replay the old WAL onto a new page set — silent
  // corruption.
  for (const suffix of ["-wal", "-shm"]) {
    if (existsSync(`${targetPath}${suffix}`)) {
      renameSync(`${targetPath}${suffix}`, `${displacedTo}${suffix}`);
    }
  }
  return displacedTo;
}

/** Write one artifact to its target after re-verifying the staged copy. */
function installArtifact(
  database: DatabaseBackupEntry,
  artifactPath: string,
  targetPath: string,
  now: number,
): ArtifactOutcome {
  const problems: string[] = [];
  mkdirSync(dirname(targetPath), { recursive: true });
  const staging = `${targetPath}.restoring-${now}`;
  rmSync(staging, { force: true });
  copyFileSync(artifactPath, staging);

  const inspected = inspectDatabase(staging);
  const regressions = countRegressions(database.tableCounts, inspected.tableCounts);
  if (inspected.integrityCheck !== "ok") {
    problems.push(`${targetPath}: staged copy failed PRAGMA integrity_check — not installed`);
  }
  if (regressions.length > 0) {
    problems.push(
      `${targetPath}: staged copy is below the manifest baseline in ${regressions.join(", ")} — not installed`,
    );
  }
  if (problems.length > 0) {
    // Never let a bad copy take the live path.
    rmSync(staging, { force: true });
    return { entry: null, problems };
  }

  const displacedTo = displaceExisting(targetPath, now);
  renameSync(staging, targetPath);
  return {
    entry: {
      artifact: database.artifact,
      targetPath,
      displacedTo,
      integrityCheck: inspected.integrityCheck,
      vecAvailable: inspected.vecAvailable,
      countRegressions: regressions,
      bytes: database.bytes,
    },
    problems,
  };
}

/** Hash + size check before anything is opened or written. */
async function verifyArchiveArtifact(
  database: DatabaseBackupEntry,
  artifactPath: string,
): Promise<readonly string[]> {
  if (!existsSync(artifactPath)) {
    return [`${database.artifact}: artifact missing from the archive`];
  }
  const bytes = statSync(artifactPath).size;
  if (bytes !== database.bytes) {
    return [`${database.artifact}: size ${bytes} does not match the manifest (${database.bytes})`];
  }
  const digest = await sha256File(artifactPath);
  if (digest !== database.sha256) {
    return [`${database.artifact}: SHA-256 mismatch — refusing to restore a corrupt copy`];
  }
  return [];
}

/**
 * Restore an archive.
 *
 * `verifiedOnly` checks hashes, integrity and row counts without writing
 * anything — the drill that must pass before a cutover. Otherwise each database
 * is written to a temp file, re-verified, and atomically renamed into place; an
 * existing file is moved aside, never deleted.
 */
export async function restoreBackup(input: {
  readonly archiveDir: string;
  readonly targetDir?: string;
  readonly force?: boolean;
  readonly verifiedOnly?: boolean;
  readonly now: number;
}): Promise<RestoreReport> {
  const archiveDir = resolve(input.archiveDir);
  const manifest = readBackupManifest(archiveDir);
  const problems: string[] = [];
  const entries: RestoreReportEntry[] = [];
  const verifiedOnly = input.verifiedOnly === true;

  for (const database of manifest.databases) {
    const artifactPath = join(archiveDir, database.artifact);
    const archiveProblems = await verifyArchiveArtifact(database, artifactPath);
    if (archiveProblems.length > 0) {
      problems.push(...archiveProblems);
      continue;
    }

    const targetPath =
      input.targetDir === undefined
        ? database.sourcePath
        : join(resolve(input.targetDir), database.artifact);

    if (verifiedOnly) {
      const outcome = verifyArtifact(database, artifactPath);
      problems.push(...outcome.problems);
      if (outcome.entry !== null) entries.push({ ...outcome.entry, targetPath });
      continue;
    }

    if (existsSync(targetPath) && input.force !== true) {
      problems.push(`${targetPath}: exists — pass --force (or --target-dir) to overwrite`);
      continue;
    }

    const outcome = installArtifact(database, artifactPath, targetPath, input.now);
    problems.push(...outcome.problems);
    if (outcome.entry !== null) entries.push(outcome.entry);
  }

  return { archiveDir, verifiedOnly, entries, problems };
}
