import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import path from "path";
import { Effect, Layer } from "effect";
import { AuditLive } from "../engine/audit-service.js";
import { AuditService } from "../engine/services.js";
import { DbLive } from "../engine/db-service.js";

const tmpDir = path.resolve("bench/tmp-audit");
let testId = 0;

describe("AuditService", () => {
  beforeAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  function auditPath() {
    return path.join(tmpDir, `audit-${testId}.jsonl`);
  }

  function makeLayer() {
    return Layer.provide(AuditLive, DbLive(":memory:"));
  }

  function makeRecord(
    overrides: Partial<{ action: string; confidence: number; timestamp: number }> = {},
  ) {
    return {
      timestamp: overrides.timestamp ?? Date.now(),
      cycleId: "cycle-1",
      poolAddress: "Pool111111111111111111111111111111111111111",
      action: overrides.action ?? "ENTER",
      confidence: overrides.confidence ?? 0.8,
      reasoning: "test",
      riskResult: { approved: true, reason: "ok" },
      executed: true,
      paperTrading: true,
    };
  }

  function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): T {
    return Effect.runSync((Effect.provide as any)(effect, layer));
  }

  it("records a decision", () => {
    testId++;
    const layer = makeLayer();
    const api = run(
      Effect.gen(function* () {
        return yield* AuditService;
      }),
      layer,
    );

    run(api.recordDecision(makeRecord()), layer);

    const recent = run(api.getRecentDecisions(10), layer);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.action).toBe("ENTER");
  });

  it("returns recent decisions in reverse order", () => {
    testId++;
    const layer = makeLayer();
    const api = run(
      Effect.gen(function* () {
        return yield* AuditService;
      }),
      layer,
    );

    run(api.recordDecision(makeRecord({ action: "ENTER", timestamp: 1 })), layer);
    run(api.recordDecision(makeRecord({ action: "HOLD", timestamp: 2 })), layer);

    const recent = run(api.getRecentDecisions(10), layer);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.action).toBe("HOLD");
    expect(recent[1]!.action).toBe("ENTER");
  });

  it("limits results", () => {
    testId++;
    const layer = makeLayer();
    const api = run(
      Effect.gen(function* () {
        return yield* AuditService;
      }),
      layer,
    );

    for (let i = 0; i < 5; i++) {
      run(api.recordDecision(makeRecord()), layer);
    }

    const recent = run(api.getRecentDecisions(2), layer);
    expect(recent).toHaveLength(2);
  });

  it("keeps same-cycle same-millisecond decisions unique", () => {
    testId++;
    const layer = makeLayer();
    const api = run(
      Effect.gen(function* () {
        return yield* AuditService;
      }),
      layer,
    );
    const record = makeRecord({ timestamp: 1234 });

    run(api.recordDecision(record), layer);
    run(api.recordDecision(record), layer);

    expect(run(api.getRecentDecisions(10), layer)).toHaveLength(2);
  });

  it("returns empty array when no records", () => {
    testId++;
    const layer = makeLayer();
    const api = run(
      Effect.gen(function* () {
        return yield* AuditService;
      }),
      layer,
    );

    const recent = run(api.getRecentDecisions(10), layer);
    expect(recent).toHaveLength(0);
  });
});
