/**
 * E2E: the migration drill from issue #250.
 *
 * Everything here runs against REAL databases written by the REAL schema in
 * `engine/db.ts` — no mocks of the copy path, because the failure this guards
 * against (a restore that silently loses rows) only shows up on a real page set.
 *
 * The drill, end to end:
 *   1. build three profile databases (the live/verify shape: positions, audit,
 *      snapshots, vec memory) and write real rows into each,
 *   2. `createBackup` while a writer is still attached (WAL, not checkpointed),
 *   3. `restoreBackup --verify-only` (the pre-cutover drill) and assert it agrees,
 *   4. `restoreBackup` into a fresh directory (the "new 2 GB host" simulation),
 *   5. assert integrity, schema version, per-table counts and vector memory on
 *      every restored file,
 *   6. tamper with one archive artifact and assert restore REFUSES it,
 *   7. emit a JSON artifact both a human and CI can read back.
 */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBackup,
  discoverProfileDatabases,
  readBackupManifest,
  restoreBackup,
  sha256File,
} from "../engine/backup.js";
import { attachVecExtension, createDatabase } from "../engine/db.js";

const ARTIFACT_PATH = join(process.cwd(), "bench", "tmp-backup-drill.json");

const created: string[] = [];

function scratchDir(label: string): string {
  const dir = join(
    tmpdir(),
    `prism-backup-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Row counts seeded into a profile database. */
interface SeededCounts {
  readonly positions: number;
  readonly audit: number;
}

/** One database in the emitted E2E artifact. */
interface DrillArtifactEntry {
  readonly artifact: string;
  readonly sourcePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly schemaVersion: number | null;
  readonly positions: number;
  readonly vecRows: number;
  readonly integrity: string;
}

/** The repeatable E2E artifact written next to the tests. */
interface DrillArtifact {
  readonly generatedAt: string;
  readonly prismVersion: string;
  readonly sqliteVersion: string;
  readonly databases: readonly DrillArtifactEntry[];
}

/** A profile database with the tables the ledger actually needs to survive. */
function makeProfileDatabase(path: string, poolSeed: number): SeededCounts {
  const db = createDatabase(path);
  try {
    const positions = 5 + poolSeed;
    const audit = 20 + poolSeed;
    for (let i = 0; i < positions; i += 1) {
      db.run(
        `INSERT INTO positions (position_id, pool_address, deposited_usd, current_value_usd,
            timestamp, cumulative_fees_claimed_usd, cumulative_rewards_claimed_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [`pos-${poolSeed}-${i}`, `Pool${poolSeed}${i}`, 20, 21, 1_780_000_000_000 + i, 0.5, 0.1],
      );
      db.run(
        `INSERT INTO position_events (id, pool_address, position_id, event, value_usd, created_at)
         VALUES (?, ?, ?, 'ENTER', ?, ?)`,
        [
          `evt-${poolSeed}-${i}`,
          `Pool${poolSeed}${i}`,
          `pos-${poolSeed}-${i}`,
          20,
          1_780_000_000_000 + i,
        ],
      );
    }
    for (let i = 0; i < audit; i += 1) {
      db.run(
        `INSERT INTO audit (id, timestamp, cycle_id, pool_address, action, executed)
         VALUES (?, ?, ?, ?, 'HOLD', 1)`,
        [`aud-${poolSeed}-${i}`, Date.now() - i, `cycle-${i}`, `Pool${poolSeed}0`],
      );
    }
    // Vector memory rows: the one table that only exists when sqlite-vec loaded.
    db.run(
      `INSERT INTO vec_memory (embedding, content, category, createdAt)
       VALUES (vec_f32(?), ?, 'pattern', ?)`,
      [new Float32Array(384).fill(0.01), `memory row ${poolSeed}`, Date.now()],
    );
    return { positions, audit };
  } finally {
    db.close();
  }
}

describe("backup/restore drill (issue #250)", () => {
  it("backs up live WAL databases and restores them onto a clean host with no data loss", async () => {
    const root = scratchDir("drill");
    const configRoot = join(root, "config");
    const liveDir = join(root, "live");
    mkdirSync(configRoot, { recursive: true });
    mkdirSync(liveDir, { recursive: true });

    // Three profiles, mirroring the box: the live engine plus the two paper lanes.
    const profiles = [
      { name: "prism-main", seed: 0 },
      { name: "prism-paper-bin20", seed: 1 },
      { name: "prism-paper-growth", seed: 2 },
    ].map((profile) => {
      const profileDir = join(configRoot, profile.name);
      mkdirSync(profileDir, { recursive: true });
      const dbPath = join(liveDir, `${profile.name}.db`);
      const counts = makeProfileDatabase(dbPath, profile.seed);
      writeFileSync(
        join(profileDir, ".env"),
        `# profile\nSQLITE_DB_PATH=${dbPath}\nPAPER_TRADING=true\n`,
      );
      return { ...profile, profileDir, dbPath, counts };
    });

    // ── 1. discovery reads the profile files, not a hardcoded list ───────────
    const discovered = discoverProfileDatabases(configRoot);
    expect(discovered.map((source) => source.path).sort()).toEqual(
      profiles.map((profile) => profile.dbPath).sort(),
    );

    // ── 2. a writer stays attached while the backup runs ────────────────────
    const liveWriter = new Database(profiles[0]!.dbPath);
    liveWriter.run("PRAGMA journal_mode = WAL");
    liveWriter.run(
      `INSERT INTO audit (id, timestamp, cycle_id, pool_address, action, executed)
       VALUES ('in-flight', ?, 'cycle-live', 'Pool00', 'HOLD', 1)`,
      [Date.now()],
    );

    const archive = await createBackup({
      sources: discovered,
      outDir: join(root, "archive"),
      now: 1_790_000_000_000,
    });
    const diskManifest = readBackupManifest(archive.dir);
    expect(diskManifest.databases).toHaveLength(3);
    expect(diskManifest.manifestVersion).toBe(1);

    // The in-flight row must be in the copy: VACUUM INTO reads inside a
    // transaction, and the transaction had already committed.
    const backedUpMain = diskManifest.databases.find(
      (entry) => entry.sourcePath === profiles[0]!.dbPath,
    );
    expect(backedUpMain?.tableCounts.audit).toBe(profiles[0]!.counts.audit + 1);
    liveWriter.close();

    // Every artifact hash matches the file on disk.
    for (const entry of diskManifest.databases) {
      expect(await sha256File(join(archive.dir, entry.artifact))).toBe(entry.sha256);
    }

    // ── 3. pre-cutover drill: verify-only touches nothing ───────────────────
    const drill = await restoreBackup({
      archiveDir: archive.dir,
      verifiedOnly: true,
      now: 1_790_000_100_000,
    });
    expect(drill.problems).toEqual([]);
    expect(drill.entries).toHaveLength(3);
    for (const entry of drill.entries) {
      expect(entry.integrityCheck).toBe("ok");
      expect(entry.countRegressions).toEqual([]);
      expect(entry.vecAvailable).toBe(true);
      expect(entry.displacedTo).toBeNull();
    }

    // ── 4. restore onto a "fresh host" directory ────────────────────────────
    const newHost = join(root, "new-host");
    const restored = await restoreBackup({
      archiveDir: archive.dir,
      targetDir: newHost,
      now: 1_790_000_200_000,
    });
    expect(restored.problems).toEqual([]);
    expect(restored.entries).toHaveLength(3);

    // ── 5. the restored copy is the same ledger ─────────────────────────────
    const collected: DrillArtifactEntry[] = [];
    for (const entry of diskManifest.databases) {
      const restoredPath = join(newHost, entry.artifact);
      expect(existsSync(restoredPath)).toBe(true);
      const db = new Database(restoredPath, { readonly: true });
      attachVecExtension(db);
      try {
        // SAFETY: both pragmas return a single TEXT row; the SELECT list above
        // is fixed and returns one integer per table.
        // SAFETY: PRAGMA integrity_check returns one row whose single value is
        // the verdict ("ok" or a corruption message).
        const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
        expect(integrity.integrity_check).toBe("ok");
        // SAFETY: MAX(version) returns one integer-or-NULL row.
        const schema = db.query("SELECT MAX(version) AS v FROM _migrations").get() as {
          v: number | null;
        };
        expect(schema.v).toBe(entry.schemaVersion);
        // SAFETY: COUNT(*) returns one integer row per table.
        const positions = db.query("SELECT COUNT(*) AS n FROM positions").get() as { n: number };
        expect(positions.n).toBe(entry.tableCounts.positions);
        // SAFETY: COUNT(*) returns one integer row.
        const vectors = db.query("SELECT COUNT(*) AS n FROM vec_memory").get() as { n: number };
        expect(vectors.n).toBe(1);
        collected.push({
          artifact: entry.artifact,
          sourcePath: entry.sourcePath,
          sha256: entry.sha256,
          bytes: entry.bytes,
          schemaVersion: entry.schemaVersion,
          positions: positions.n,
          vecRows: vectors.n,
          integrity: "ok",
        });
      } finally {
        db.close();
      }
    }
    // The restored live database keeps the in-flight row — nothing was lost
    // between the writer's commit and the archive.
    const liveCopy = new Database(join(newHost, backedUpMain!.artifact), { readonly: true });
    try {
      // SAFETY: COUNT(*) returns one integer row.
      const inFlight = liveCopy
        .query("SELECT COUNT(*) AS n FROM audit WHERE id = 'in-flight'")
        .get() as {
        n: number;
      };
      expect(inFlight.n).toBe(1);
    } finally {
      liveCopy.close();
    }

    const report: DrillArtifact = {
      generatedAt: new Date().toISOString(),
      prismVersion: diskManifest.prismVersion,
      sqliteVersion: diskManifest.sqliteVersion,
      databases: collected,
    };
    writeFileSync(ARTIFACT_PATH, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    expect(report.databases).toHaveLength(3);
  }, 60_000);

  it("refuses a restore whose archive no longer matches the manifest", async () => {
    const root = scratchDir("tamper");
    const liveDir = join(root, "live");
    mkdirSync(liveDir, { recursive: true });
    const dbPath = join(liveDir, "prism.db");
    makeProfileDatabase(dbPath, 0);

    const archive = await createBackup({
      sources: [{ path: dbPath }],
      outDir: join(root, "archive"),
      now: 1_790_000_000_000,
    });
    const manifest = readBackupManifest(archive.dir);
    const artifact = join(archive.dir, manifest.databases[0]!.artifact);

    // Flip a byte in the middle of the copy: still a valid SQLite file, so only
    // the checksum can catch it.
    const bytes = readFileSync(artifact);
    bytes[Math.floor(bytes.length / 2)] = (bytes[Math.floor(bytes.length / 2)] ?? 0) ^ 0xff;
    writeFileSync(artifact, bytes);

    const target = join(root, "restored");
    const report = await restoreBackup({
      archiveDir: archive.dir,
      targetDir: target,
      now: 1_790_000_100_000,
    });
    expect(report.entries).toEqual([]);
    expect(report.problems.length).toBeGreaterThan(0);
    expect(report.problems.join(" ")).toContain("SHA-256 mismatch");
    expect(existsSync(join(target, manifest.databases[0]!.artifact))).toBe(false);
  }, 30_000);

  it("moves an existing database aside instead of overwriting it", async () => {
    const root = scratchDir("displace");
    const liveDir = join(root, "live");
    mkdirSync(liveDir, { recursive: true });
    const dbPath = join(liveDir, "prism.db");
    makeProfileDatabase(dbPath, 3);

    const archive = await createBackup({
      sources: [{ path: dbPath }],
      outDir: join(root, "archive"),
      now: 1_790_000_000_000,
    });
    const manifest = readBackupManifest(archive.dir);
    const artifact = manifest.databases[0]!.artifact;

    const target = join(root, "target");
    mkdirSync(target, { recursive: true });
    // A live database already at the destination, with a WAL beside it.
    const existing = join(target, artifact);
    makeProfileDatabase(existing, 9);
    writeFileSync(`${existing}-wal`, "stale wal bytes");

    // Without --force it refuses.
    const blocked = await restoreBackup({
      archiveDir: archive.dir,
      targetDir: target,
      now: 1_790_000_100_000,
    });
    expect(blocked.entries).toEqual([]);
    expect(blocked.problems.join(" ")).toContain("--force");

    const forced = await restoreBackup({
      archiveDir: archive.dir,
      targetDir: target,
      force: true,
      now: 1_790_000_200_000,
    });
    expect(forced.problems).toEqual([]);
    expect(forced.entries).toHaveLength(1);
    const displaced = forced.entries[0]!.displacedTo;
    expect(displaced).not.toBeNull();
    expect(existsSync(displaced!)).toBe(true);
    // The stale WAL travelled with the displaced file — it must never be
    // replayable onto the restored page set.
    expect(existsSync(`${displaced!}-wal`)).toBe(true);
    expect(existsSync(`${existing}-wal`)).toBe(false);
  }, 30_000);
});
