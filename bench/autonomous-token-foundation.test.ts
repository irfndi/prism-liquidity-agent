import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { ConfigLive, ConfigService } from "../engine/config-service.js";
import { createDatabase } from "../engine/db.js";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";
import type {
  ExecutionOperationRecord,
  SafetyPauseRecord,
  SettlementJobRecord,
  TokenCandidateRecord,
} from "../engine/types.js";

async function loadConfig() {
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        return yield* ConfigService;
      }),
      ConfigLive,
      { local: true },
    ),
  );
}

async function useDb<T, E>(dbPath: string, effect: Effect.Effect<T, E, DbService>): Promise<T> {
  return Effect.runPromise(Effect.provide(effect, DbLive(dbPath)));
}

describe("autonomous token configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses legacy-preserving defaults when autonomous mode is unset", async () => {
    // Given
    vi.stubEnv("AUTONOMOUS_TOKEN_MODE", undefined);

    // When
    const config = await loadConfig();

    // Then
    expect({
      mode: config.autonomousTokenMode,
      settlementAsset: config.settlementAsset,
      candidateMinHealthyScans: config.candidateMinHealthyScans,
      candidateMinObservationMs: config.candidateMinObservationMs,
      candidateScanLimit: config.candidateScanLimit,
      candidateMinPoolAgeMs: config.candidateMinPoolAgeMs,
      maxMarketDataAgeMs: config.maxMarketDataAgeMs,
      maxSwapSlippageBps: config.maxSwapSlippageBps,
      maxSwapPriceImpactBps: config.maxSwapPriceImpactBps,
      settlementDustUsd: config.settlementDustUsd,
      settlementMaxPendingMs: config.settlementMaxPendingMs,
      maxDailyDrawdownPct: config.maxDailyDrawdownPct,
      maxConsecutiveExecutionFailures: config.maxConsecutiveExecutionFailures,
      agentInstanceId: config.agentInstanceId,
    }).toEqual({
      mode: "off",
      settlementAsset: "SOL",
      candidateMinHealthyScans: 6,
      candidateMinObservationMs: 3_600_000,
      candidateScanLimit: 20,
      candidateMinPoolAgeMs: 86_400_000,
      maxMarketDataAgeMs: 300_000,
      maxSwapSlippageBps: 50,
      maxSwapPriceImpactBps: 100,
      settlementDustUsd: 0.1,
      settlementMaxPendingMs: 3_600_000,
      maxDailyDrawdownPct: 5,
      maxConsecutiveExecutionFailures: 3,
      agentInstanceId: "primary",
    });
  });

  it.each(["off", "shadow", "canary", "live"] as const)(
    "accepts AUTONOMOUS_TOKEN_MODE=%s",
    async (mode) => {
      // Given
      vi.stubEnv("AUTONOMOUS_TOKEN_MODE", mode);

      // When
      const config = await loadConfig();

      // Then
      expect(config.autonomousTokenMode).toBe(mode);
    },
  );

  it("rejects an unknown autonomous mode at the config boundary", async () => {
    // Given
    vi.stubEnv("AUTONOMOUS_TOKEN_MODE", "enabled");

    // When / Then
    await expect(loadConfig()).rejects.toThrow("AUTONOMOUS_TOKEN_MODE");
  });

  it.each(["", "   "])("rejects blank AGENT_INSTANCE_ID=%j", async (agentInstanceId) => {
    // Given
    vi.stubEnv("AGENT_INSTANCE_ID", agentInstanceId);

    // When / Then
    await expect(loadConfig()).rejects.toThrow("AGENT_INSTANCE_ID");
  });
});

describe("migration v20 autonomous token durability", () => {
  let testDir: string | null = null;

  afterEach(() => {
    if (testDir !== null) rmSync(testDir, { recursive: true, force: true });
  });

  it("creates all autonomous lifecycle tables and remains idempotent on restart", () => {
    // Given
    testDir = mkdtempSync(join(tmpdir(), "prism-autonomous-foundation-"));
    const dbPath = join(testDir, "prism.db");

    // When
    createDatabase(dbPath).close();
    const reopened = createDatabase(dbPath);

    // Then
    const tables = reopened
      .query(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'token_candidates',
           'execution_operations',
           'settlement_jobs',
           'wallet_safety_pauses'
         )
         ORDER BY name`,
      )
      .all()
      .map((row) => String((row as { readonly name: unknown }).name));
    const migrationCount = reopened
      .query("SELECT COUNT(*) AS count FROM _migrations WHERE version = 20")
      .get() as { readonly count: number };
    expect(tables).toEqual([
      "execution_operations",
      "settlement_jobs",
      "token_candidates",
      "wallet_safety_pauses",
    ]);
    expect(migrationCount.count).toBe(1);
    reopened.close();
  });

  it("upgrades a v19 database to v20 without losing existing data", () => {
    // Given
    testDir = mkdtempSync(join(tmpdir(), "prism-autonomous-v19-upgrade-"));
    const dbPath = join(testDir, "prism.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO _migrations (version, name, applied_at)
      VALUES (19, 'pool_snapshots_stats_source', 1);
      CREATE TABLE legacy_marker (value TEXT NOT NULL);
      INSERT INTO legacy_marker (value) VALUES ('preserved');
    `);
    legacy.close();

    // When
    const upgraded = createDatabase(dbPath);

    // Then
    const migrationCount = upgraded
      .query("SELECT COUNT(*) AS count FROM _migrations WHERE version = 20")
      .get() as { readonly count: number };
    const tableCount = upgraded
      .query(
        `SELECT COUNT(*) AS count FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'token_candidates',
           'execution_operations',
           'settlement_jobs',
           'wallet_safety_pauses'
         )`,
      )
      .get() as { readonly count: number };
    const marker = upgraded.query("SELECT value FROM legacy_marker").get() as {
      readonly value: string;
    };
    expect({
      migrationCount: migrationCount.count,
      tableCount: tableCount.count,
      marker: marker.value,
    }).toEqual({ migrationCount: 1, tableCount: 4, marker: "preserved" });
    upgraded.close();
  });

  it("rejects an unknown candidate state in durable storage", () => {
    // Given
    const db = createDatabase(":memory:");

    // When / Then
    expect(() =>
      db.exec(
        `INSERT INTO token_candidates (
          id, wallet_address, agent_instance_id, pool_address, token_mint, state,
          healthy_scan_count, first_seen_at, last_seen_at, eligible_at, entered_at,
          cooldown_until, rejection_reason, created_at, updated_at
        ) VALUES (
          'candidate-1', 'wallet', 'primary', 'pool', 'mint', 'unknown',
          0, 1, 1, NULL, NULL, NULL, NULL, 1, 1
        )`,
      ),
    ).toThrow();
    db.close();
  });

  it("rejects unknown execution and settlement statuses in durable storage", () => {
    // Given
    const db = createDatabase(":memory:");

    // When / Then
    expect(() =>
      db.exec(
        `INSERT INTO execution_operations (
          id, wallet_address, agent_instance_id, candidate_id, position_id,
          pool_address, token_mint, operation_type, status, amount_atomic,
          tx_signature, error, created_at, updated_at
        ) VALUES (
          'operation-1', 'wallet', 'primary', NULL, NULL, 'pool', 'mint',
          'entry', 'unknown', NULL, NULL, NULL, 1, 1
        )`,
      ),
    ).toThrow();
    expect(() =>
      db.exec(
        `INSERT INTO settlement_jobs (
          id, wallet_address, agent_instance_id, position_id, pool_address,
          token_mint, amount_atomic, destination_asset, status, attempts,
          next_retry_at, tx_signature, expires_at, error, created_at, updated_at
        ) VALUES (
          'settlement-1', 'wallet', 'primary', 'position', 'pool', 'mint',
          '100', 'SOL', 'unknown', 0, NULL, NULL, 100, NULL, 1, 1
        )`,
      ),
    ).toThrow();
    db.close();
  });
});

describe("DbService autonomous token records", () => {
  let testDir: string | null = null;

  afterEach(() => {
    if (testDir !== null) rmSync(testDir, { recursive: true, force: true });
  });

  it("round-trips candidate, operation, settlement, and safety-pause records", async () => {
    // Given
    testDir = mkdtempSync(join(tmpdir(), "prism-autonomous-records-"));
    const dbPath = join(testDir, "prism.db");
    const candidate: TokenCandidateRecord = {
      id: "candidate-1",
      walletAddress: "wallet-1",
      agentInstanceId: "primary",
      poolAddress: "pool-1",
      tokenMint: "mint-1",
      state: "observing",
      healthyScanCount: 4,
      firstSeenAt: 100,
      lastSeenAt: 200,
      eligibleAt: null,
      enteredAt: null,
      cooldownUntil: null,
      rejectionReason: null,
      createdAt: 100,
      updatedAt: 200,
    };
    const operation: ExecutionOperationRecord = {
      id: "operation-1",
      walletAddress: "wallet-1",
      agentInstanceId: "primary",
      candidateId: candidate.id,
      positionId: null,
      poolAddress: candidate.poolAddress,
      tokenMint: candidate.tokenMint,
      operationType: "entry",
      status: "prepared",
      amountAtomic: "2500000",
      txSignature: null,
      error: null,
      createdAt: 210,
      updatedAt: 220,
    };
    const settlement: SettlementJobRecord = {
      id: "settlement-1",
      walletAddress: "wallet-1",
      agentInstanceId: "primary",
      positionId: "position-1",
      poolAddress: "pool-1",
      tokenMint: "mint-1",
      amountAtomic: "1250000",
      destinationAsset: "SOL",
      status: "retryable",
      attempts: 1,
      nextRetryAt: 300,
      txSignature: null,
      confirmedOutputAtomic: null,
      outputUsd: null,
      executionCostUsd: null,
      finalizedAt: null,
      realizedPnlUsd: null,
      expiresAt: 3_600_000,
      error: "rpc timeout",
      createdAt: 230,
      updatedAt: 240,
    };
    const pause: SafetyPauseRecord = {
      walletAddress: "wallet-1",
      agentInstanceId: "primary",
      reason: "daily drawdown",
      triggeredAt: 250,
      resolvedAt: null,
    };

    // When
    const records = await useDb(
      dbPath,
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveTokenCandidate(candidate);
        yield* db.saveExecutionOperation(operation);
        yield* db.saveSettlementJob(settlement);
        yield* db.saveSafetyPause(pause);
        return {
          candidate: yield* db.getTokenCandidate(candidate.id),
          operation: yield* db.getExecutionOperation(operation.id),
          settlement: yield* db.getSettlementJob(settlement.id),
          pause: yield* db.getSafetyPause(pause.walletAddress, pause.agentInstanceId),
        };
      }),
    );

    // Then
    expect(records).toEqual({ candidate, operation, settlement, pause });
  });
});
