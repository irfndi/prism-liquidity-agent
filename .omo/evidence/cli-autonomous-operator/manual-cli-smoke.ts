import { Effect } from "effect";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { join } from "path";
import { writeFileSync } from "fs";
import { DbLive } from "../../../engine/db-service.js";
import { DbService } from "../../../engine/services.js";

const evidenceDir = join(process.cwd(), ".omo/evidence/cli-autonomous-operator");
const dbPath = join(evidenceDir, "manual-smoke.db");
const walletKeypair = Keypair.generate();
const walletAddress = walletKeypair.publicKey.toBase58();
const agentInstanceId = "manual-smoke";

await Effect.runPromise(
  Effect.gen(function* () {
    const db = yield* DbService;
    yield* db.saveTokenCandidate({
      id: "manual-candidate",
      walletAddress,
      agentInstanceId,
      poolAddress: "manual-pool",
      tokenMint: "manual-mint",
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
      id: "manual-operation",
      walletAddress,
      agentInstanceId,
      candidateId: "manual-candidate",
      positionId: null,
      poolAddress: "manual-pool",
      tokenMint: "manual-mint",
      operationType: "entry",
      status: "prepared",
      amountAtomic: "100",
      txSignature: null,
      error: null,
      createdAt: 3_000,
      updatedAt: 3_000,
    });
    yield* db.saveSettlementJob({
      id: "manual-settlement",
      walletAddress,
      agentInstanceId,
      positionId: "manual-position",
      poolAddress: "manual-pool",
      tokenMint: "manual-mint",
      amountAtomic: "99",
      destinationAsset: "SOL",
      status: "retryable",
      attempts: 2,
      nextRetryAt: 4_000,
      txSignature: null,
      expiresAt: 5_000,
      error: "rpc unavailable",
      createdAt: 3_000,
      updatedAt: 3_000,
    });
    yield* db.saveSafetyPause({
      walletAddress,
      agentInstanceId,
      reason: "settlement_overdue",
      triggeredAt: 3_000,
      resolvedAt: null,
    });
  }).pipe(Effect.provide(DbLive(dbPath))),
);

const environment = {
  ...process.env,
  SQLITE_DB_PATH: dbPath,
  AGENT_INSTANCE_ID: agentInstanceId,
  AUTONOMOUS_TOKEN_MODE: "shadow",
  PAPER_TRADING: "true",
  WALLET_PRIVATE_KEY: bs58.encode(walletKeypair.secretKey),
};
const cli = join(process.cwd(), "cli/index.ts");
const decode = (output: Uint8Array) => new TextDecoder().decode(output);
const run = (args: ReadonlyArray<string>) =>
  Bun.spawnSync([process.execPath, cli, ...args], {
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });

const before = run(["status", "--json"]);
const human = run(["status"]);
const resume = run(["resume"]);
const after = run(["status", "--json"]);

writeFileSync(
  join(evidenceDir, "manual-cli-smoke.json"),
  JSON.stringify(
    {
      invocation: ["prism status --json", "prism status", "prism resume", "prism status --json"],
      walletAddress,
      agentInstanceId,
      before: { exitCode: before.exitCode, stdout: decode(before.stdout), stderr: decode(before.stderr) },
      human: { exitCode: human.exitCode, stdout: decode(human.stdout), stderr: decode(human.stderr) },
      resume: { exitCode: resume.exitCode, stdout: decode(resume.stdout), stderr: decode(resume.stderr) },
      after: { exitCode: after.exitCode, stdout: decode(after.stdout), stderr: decode(after.stderr) },
    },
    null,
    2,
  ),
);
