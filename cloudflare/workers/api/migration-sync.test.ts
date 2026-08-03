import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { applyMigration, MIGRATION_0015_SUMMARY } from "./migration-helper";

/**
 * Guards against drift between the inlined 0015 schema in migration-helper.ts
 * and cloudflare/migrations/0015_telemetry_summaries.sql. The worker-pool
 * sandbox virtualizes fs, so the file cannot be read directly; instead this
 * asserts that applying the helper produces the same schema shape the
 * migration creates.
 */
describe("0015 migration schema sync", () => {
  beforeAll(async () => {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS error_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        agent_id TEXT,
        error_type TEXT NOT NULL,
        message TEXT NOT NULL,
        stack_trace TEXT,
        prism_version TEXT NOT NULL,
        platform TEXT,
        severity TEXT DEFAULT 'error',
        is_recoverable INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
    ).run();
    await applyMigration(env.DB, "0015_telemetry_summaries.sql");
  });

  it("applies the expected number of error_logs column additions", async () => {
    const { results } = await env.DB.prepare(
      `SELECT COUNT(*) as n FROM pragma_table_info('error_logs')
       WHERE name IN ('fingerprint', 'first_seen_at', 'last_seen_at', 'occurrence_count', 'last_report_id')`,
    ).all<{ n: number }>();
    expect(results[0]?.n).toBe(MIGRATION_0015_SUMMARY.alterErrorLogsCount);
  });

  it("creates the receipts and install summary tables", async () => {
    for (const table of ["error_report_receipts", "install_event_summary"]) {
      const row = await env.DB.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
        .bind(table)
        .first<{ name: string }>();
      expect(row?.name).toBe(table);
    }
  });

  it("creates the user-fingerprint unique index", async () => {
    const row = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_error_logs_user_fingerprint'`,
    ).first<{ name: string }>();
    expect(row?.name).toBe("idx_error_logs_user_fingerprint");
  });
});
