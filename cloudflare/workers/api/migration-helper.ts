/**
 * Shared test-schema setup for the API worker tests.
 *
 * The vitest-pool-workers sandbox virtualizes fs (reads fail against the
 * bundle), so the 0015 telemetry schema is inlined here as the single source
 * of truth for both errors.test.ts and installs.test.ts. Keep this in sync
 * with cloudflare/migrations/0015_telemetry_summaries.sql.
 */
const MIGRATION_0015_STATEMENTS = [
  `ALTER TABLE error_logs ADD COLUMN fingerprint TEXT`,
  `ALTER TABLE error_logs ADD COLUMN first_seen_at DATETIME`,
  `ALTER TABLE error_logs ADD COLUMN last_seen_at DATETIME`,
  `ALTER TABLE error_logs ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE error_logs ADD COLUMN last_report_id TEXT`,
];

/** Statement-count summary asserted by the migration-sync test. */
export const MIGRATION_0015_SUMMARY = {
  alterErrorLogsCount: 5,
  hasReceiptsTable: true,
  hasInstallSummaryTable: true,
  hasUserFingerprintIndex: true,
} as const;

/**
 * Applies the 0015 telemetry migration statements to the test database.
 * D1 test databases are shared across test files, so ALTER TABLE statements
 * are tolerated when the column already exists, and error_logs statements are
 * skipped when the table was not created by the calling test file.
 */
export async function applyMigration(db: D1Database, _migrationFile: string): Promise<void> {
  const hasErrorLogs =
    (await db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'error_logs'`)
      .first<{ name: string }>()) !== null;
  for (const statement of MIGRATION_0015_STATEMENTS) {
    if (!hasErrorLogs && statement.includes("error_logs")) continue;
    await db
      .prepare(statement)
      .run()
      .catch((error: unknown) => {
        if (!String(error).toLowerCase().includes("duplicate column")) throw error;
      });
  }
  const remainder = [
    ...(hasErrorLogs
      ? [
          `UPDATE error_logs
           SET first_seen_at = COALESCE(first_seen_at, created_at),
               last_seen_at = COALESCE(last_seen_at, created_at),
               last_report_id = COALESCE(last_report_id, id)
           WHERE first_seen_at IS NULL OR last_seen_at IS NULL OR last_report_id IS NULL`,
          `UPDATE error_logs
           SET fingerprint = COALESCE(fingerprint, 'legacy:' || id)
           WHERE fingerprint IS NULL`,
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_error_logs_user_fingerprint
             ON error_logs(user_id, fingerprint)`,
          `CREATE TABLE IF NOT EXISTS error_report_receipts (
             user_id TEXT NOT NULL,
             report_id TEXT NOT NULL,
             summary_applied INTEGER NOT NULL DEFAULT 0,
             received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
             PRIMARY KEY (user_id, report_id)
           )`,
          `CREATE INDEX IF NOT EXISTS idx_error_report_receipts_received
             ON error_report_receipts(received_at)`,
        ]
      : []),
    `CREATE TABLE IF NOT EXISTS install_event_summary (
       install_id TEXT NOT NULL,
       event TEXT NOT NULL,
       version TEXT,
       channel TEXT,
       platform TEXT,
       user_id TEXT,
       first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       occurrence_count INTEGER NOT NULL DEFAULT 1,
       PRIMARY KEY (install_id, event)
     )`,
    `CREATE INDEX IF NOT EXISTS idx_install_event_summary_last_seen
       ON install_event_summary(last_seen_at)`,
  ];
  for (const statement of remainder) {
    await db.prepare(statement).run();
  }
}
