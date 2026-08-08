import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "cli", "index.ts");

let testDirectory: string | null = null;

afterEach(() => {
  if (testDirectory !== null) {
    rmSync(testDirectory, { recursive: true, force: true });
    testDirectory = null;
  }
});

function createChildEnvironment(
  overrides: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...overrides };
}

function runCli(args: ReadonlyArray<string>, environment: Readonly<Record<string, string>>) {
  return Bun.spawnSync([process.execPath, CLI, ...args], {
    env: createChildEnvironment(environment),
    stdout: "pipe",
    stderr: "pipe",
  });
}

function decode(output: Uint8Array): string {
  return new TextDecoder().decode(output);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeJsonObject(output: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(decode(output));
  if (!isRecord(parsed)) {
    throw new Error("CLI JSON output must be an object");
  }
  return parsed;
}

async function seedAutonomousState(
  dbPath: string,
  walletAddress: string,
  agentInstanceId: string,
  options: { readonly recovered?: boolean; readonly recurring?: boolean } = {},
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* DbService;
      yield* db.saveTokenCandidate({
        id: "candidate-1",
        walletAddress,
        agentInstanceId,
        poolAddress: "pool-1",
        tokenMint: "mint-1",
        state: "eligible",
        healthyScanCount: 6,
        firstSeenAt: 1_000,
        lastSeenAt: 2_000,
        eligibleAt: 2_000,
        enteredAt: null,
        cooldownUntil: null,
        rejectionReason: null,
        createdAt: 1_000,
        updatedAt: 2_000,
      });
      yield* db.saveExecutionOperation({
        id: "operation-1",
        walletAddress,
        agentInstanceId,
        candidateId: "candidate-1",
        positionId: null,
        poolAddress: "pool-1",
        tokenMint: "mint-1",
        operationType: "entry",
        status: "prepared",
        amountAtomic: "100",
        txSignature: null,
        error: null,
        createdAt: 3_000,
        updatedAt: 3_000,
      });
      yield* db.saveSettlementJob({
        id: "settlement-1",
        walletAddress,
        agentInstanceId,
        positionId: "position-1",
        poolAddress: "pool-1",
        tokenMint: "mint-1",
        amountAtomic: "99",
        destinationAsset: "SOL",
        status: "retryable",
        attempts: 2,
        nextRetryAt: 4_000,
        txSignature: null,
        confirmedOutputAtomic: null,
        outputUsd: null,
        executionCostUsd: null,
        finalizedAt: null,
        realizedPnlUsd: null,
        expiresAt: 5_000,
        error: "rpc unavailable",
        createdAt: 3_000,
        updatedAt: 3_000,
      });
      // Issue #166: a terminal settlement with no recovered output is the
      // stranded-token case the sweep re-queues; status must surface it.
      yield* db.saveSettlementJob({
        id: "settlement-2",
        walletAddress,
        agentInstanceId,
        positionId: "position-2",
        poolAddress: "",
        tokenMint: "mint-2",
        amountAtomic: "15413",
        destinationAsset: "SOL",
        status: "terminal",
        attempts: 6,
        nextRetryAt: null,
        txSignature: null,
        confirmedOutputAtomic: null,
        outputUsd: null,
        executionCostUsd: null,
        finalizedAt: null,
        realizedPnlUsd: null,
        expiresAt: 5_000,
        error: "Jupiter quote failed: 429",
        createdAt: 3_000,
        updatedAt: 3_000,
      });
      if (options.recovered) {
        // The orphan sweep sold the stranded mint — the terminal record above
        // is now historical and must not be reported as stranded.
        yield* db.saveSettlementJob({
          id: "settlement-3",
          walletAddress,
          agentInstanceId,
          positionId: "orphan:recovered",
          poolAddress: "",
          tokenMint: "mint-2",
          amountAtomic: "15413",
          destinationAsset: "SOL",
          status: "confirmed",
          attempts: 1,
          nextRetryAt: null,
          txSignature: "recovered-sig",
          confirmedOutputAtomic: "1000000",
          outputUsd: 10,
          executionCostUsd: 0.1,
          finalizedAt: null,
          realizedPnlUsd: null,
          expiresAt: 5_000,
          error: null,
          createdAt: 4_000,
          updatedAt: 4_000,
        });
      }
      if (options.recurring) {
        // A PREVIOUS recovery (confirmed, older than the terminal row) — the
        // terminal record is a NEW stranding and must stay visible.
        yield* db.saveSettlementJob({
          id: "settlement-4",
          walletAddress,
          agentInstanceId,
          positionId: "orphan:previous",
          poolAddress: "",
          tokenMint: "mint-2",
          amountAtomic: "15413",
          destinationAsset: "SOL",
          status: "confirmed",
          attempts: 1,
          nextRetryAt: null,
          txSignature: "previous-sig",
          confirmedOutputAtomic: "1000000",
          outputUsd: 10,
          executionCostUsd: 0.1,
          finalizedAt: null,
          realizedPnlUsd: null,
          expiresAt: 5_000,
          error: null,
          createdAt: 2_000,
          updatedAt: 2_000,
        });
      }
      yield* db.saveSafetyPause({
        walletAddress,
        agentInstanceId,
        reason: "settlement_overdue",
        triggeredAt: 3_000,
        resolvedAt: null,
      });
    }).pipe(Effect.provide(DbLive(dbPath))),
  );
}

describe("autonomous CLI operator surface", () => {
  it("shows current-wallet candidate, operation, settlement, and active pause state in JSON", async () => {
    // Given
    testDirectory = mkdtempSync(join(tmpdir(), "prism-cli-autonomous-status-"));
    const dbPath = join(testDirectory, "prism.db");
    const walletKeypair = Keypair.generate();
    const wallet = walletKeypair.publicKey.toBase58();
    const agentInstanceId = "operator-test";
    await seedAutonomousState(dbPath, wallet, agentInstanceId);

    // When
    const result = runCli(["status", "--json"], {
      SQLITE_DB_PATH: dbPath,
      AGENT_INSTANCE_ID: agentInstanceId,
      WALLET_PRIVATE_KEY: bs58.encode(walletKeypair.secretKey),
    });

    // Then
    expect(result.exitCode).toBe(0);
    const output = decodeJsonObject(result.stdout);
    expect(output["autonomous"]).toMatchObject({
      walletAddress: wallet,
      agentInstanceId,
      candidates: [{ id: "candidate-1", state: "eligible" }],
      operations: [{ id: "operation-1", status: "prepared" }],
      settlements: [
        { id: "settlement-1", status: "retryable" },
        {
          id: "settlement-2",
          status: "terminal",
          tokenMint: "mint-2",
          amountAtomic: "15413",
          confirmedOutputAtomic: null,
          error: "Jupiter quote failed: 429",
        },
      ],
      safetyPause: { active: true, reason: "settlement_overdue" },
    });
  });

  it("flags terminal settlements with unspent balance in text output", async () => {
    // Given
    testDirectory = mkdtempSync(join(tmpdir(), "prism-cli-autonomous-stranded-"));
    const dbPath = join(testDirectory, "prism.db");
    const walletKeypair = Keypair.generate();
    const wallet = walletKeypair.publicKey.toBase58();
    const agentInstanceId = "operator-test";
    await seedAutonomousState(dbPath, wallet, agentInstanceId);

    // When
    const result = runCli(["status"], {
      SQLITE_DB_PATH: dbPath,
      AGENT_INSTANCE_ID: agentInstanceId,
      WALLET_PRIVATE_KEY: bs58.encode(walletKeypair.secretKey),
    });

    // Then (issue #183): the unpriceable terminal is surfaced on the
    // Unpriceable line — it cannot be valued, so it is not counted as
    // Stranded capital and the sweep never re-queues it.
    expect(result.exitCode).toBe(0);
    const text = decode(result.stdout);
    expect(text).toContain("Unpriceable: 1 terminal settlement(s) with no USD price");
    expect(text).toContain("?/mint-2");
    expect(text).not.toContain("Stranded:");
  });

  it("hides terminal settlements whose mint was later recovered by a confirmed settlement", async () => {
    // Given a terminal job for mint-2 plus a confirmed orphan-sweep sale of
    // the same mint (the recovery path from issue #166).
    testDirectory = mkdtempSync(join(tmpdir(), "prism-cli-autonomous-recovered-"));
    const dbPath = join(testDirectory, "prism.db");
    const walletKeypair = Keypair.generate();
    const wallet = walletKeypair.publicKey.toBase58();
    const agentInstanceId = "operator-test";
    await seedAutonomousState(dbPath, wallet, agentInstanceId, { recovered: true });

    // When
    const result = runCli(["status"], {
      SQLITE_DB_PATH: dbPath,
      AGENT_INSTANCE_ID: agentInstanceId,
      WALLET_PRIVATE_KEY: bs58.encode(walletKeypair.secretKey),
    });

    // Then the historical terminal record is not reported as stranded.
    expect(result.exitCode).toBe(0);
    const text = decode(result.stdout);
    expect(text).not.toContain("Stranded:");
  });

  it("still reports a terminal settlement newer than any confirmed recovery", async () => {
    // Given a confirmed sale of mint-2 that PREDATES the terminal row — a
    // recurring stranding (sold once, then stranded again) must stay visible.
    testDirectory = mkdtempSync(join(tmpdir(), "prism-cli-autonomous-recurring-"));
    const dbPath = join(testDirectory, "prism.db");
    const walletKeypair = Keypair.generate();
    const wallet = walletKeypair.publicKey.toBase58();
    const agentInstanceId = "operator-test";
    await seedAutonomousState(dbPath, wallet, agentInstanceId, { recurring: true });

    // When
    const result = runCli(["status"], {
      SQLITE_DB_PATH: dbPath,
      AGENT_INSTANCE_ID: agentInstanceId,
      WALLET_PRIVATE_KEY: bs58.encode(walletKeypair.secretKey),
    });

    // Then the newer terminal record stays visible (issue #183): unpriceable
    // in the test env, so it is surfaced on the Unpriceable line rather than
    // counted as valued Stranded capital.
    expect(result.exitCode).toBe(0);
    const text = decode(result.stdout);
    expect(text).toContain("Unpriceable: 1 terminal settlement(s) with no USD price");
    expect(text).not.toContain("Stranded:");
  });

  it("marks the current wallet's active safety pause resolved without live execution", async () => {
    // Given
    testDirectory = mkdtempSync(join(tmpdir(), "prism-cli-autonomous-resume-"));
    const dbPath = join(testDirectory, "prism.db");
    const walletKeypair = Keypair.generate();
    const wallet = walletKeypair.publicKey.toBase58();
    const agentInstanceId = "operator-test";
    await seedAutonomousState(dbPath, wallet, agentInstanceId);
    const environment = {
      SQLITE_DB_PATH: dbPath,
      AGENT_INSTANCE_ID: agentInstanceId,
      WALLET_PRIVATE_KEY: bs58.encode(walletKeypair.secretKey),
    };

    // When
    const resume = runCli(["resume"], environment);
    const status = runCli(["status", "--json"], environment);

    // Then
    expect(resume.exitCode).toBe(0);
    const output = decodeJsonObject(status.stdout);
    expect(output["autonomous"]).toMatchObject({ safetyPause: { active: false } });
  });
});
