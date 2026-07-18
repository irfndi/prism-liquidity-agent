import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect, Layer } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DbLive } from "../engine/db-service.js";
import { AlertLive } from "../engine/alert-service.js";
import { AlertService, DbService } from "../engine/services.js";
import { ConfigService } from "../engine/config-service.js";
import { defaultAppConfig, mockFetch } from "./helpers.js";
import type { AppConfig } from "../engine/config-service.js";

const POOL = "Pool1111111111111111111111111111111111111";
const TEST_API_KEY = "sk-prism-alert-test-key";

function makeConfigLayer(overrides: Partial<AppConfig> = {}) {
  return Layer.succeed(
    ConfigService,
    defaultAppConfig({
      alertsEnabled: true,
      alertCooldownMinutes: 120,
      alertFeeMilestoneUsd: 10,
      ...overrides,
    }),
  );
}

function makeAlertLayer(dbPath: string, overrides: Partial<AppConfig> = {}) {
  const dbLayer = DbLive(dbPath);
  const deps = Layer.merge(dbLayer, makeConfigLayer(overrides));
  return Layer.provide(AlertLive, deps);
}

interface CapturedPost {
  url: string;
  body: Record<string, unknown>;
  authorization: string | null;
}

function capturePosts(status = 200): { posts: CapturedPost[]; restore: () => void } {
  const posts: CapturedPost[] = [];
  const restore = mockFetch((url: unknown, init: { body?: string; headers?: unknown } = {}) => {
    const headers = new Headers(init.headers as Record<string, string> | undefined);
    posts.push({
      url: String(url),
      body: JSON.parse(init.body ?? "{}") as Record<string, unknown>,
      authorization: headers.get("Authorization"),
    });
    return Promise.resolve(new Response(JSON.stringify({ id: "x", delivered: false }), { status }));
  });
  return { posts, restore };
}

describe("AlertService", () => {
  let tmpDir: string;
  let dbPath: string;
  let savedConfigDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "prism-alert-test-"));
    dbPath = join(tmpDir, "test.db");
    // The service resolves the API key via PRISM_CONFIG_DIR/credentials.json.
    savedConfigDir = process.env.PRISM_CONFIG_DIR;
    process.env.PRISM_CONFIG_DIR = tmpDir;
    writeFileSync(join(tmpDir, "credentials.json"), JSON.stringify({ apiKey: TEST_API_KEY }), {
      mode: 0o600,
    });
  });

  afterEach(() => {
    if (savedConfigDir === undefined) {
      delete process.env.PRISM_CONFIG_DIR;
    } else {
      process.env.PRISM_CONFIG_DIR = savedConfigDir;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("posts an alert to the API with the alert payload", async () => {
    const { posts, restore } = capturePosts();
    try {
      const layer = makeAlertLayer(dbPath);
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.sendAlert({
            type: "position_out_of_range",
            severity: "critical",
            message: "Position out of range on SOL/USDC",
            poolAddress: POOL,
            data: { activeBinId: 5050 },
          });
        }).pipe(Effect.provide(layer)),
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]!.url).toContain("/v1/alerts");
      expect(posts[0]!.authorization).toBe(`Bearer ${TEST_API_KEY}`);
      expect(posts[0]!.body.type).toBe("position_out_of_range");
      expect(posts[0]!.body.severity).toBe("critical");
      expect(posts[0]!.body.message).toBe("Position out of range on SOL/USDC");
      expect(posts[0]!.body.poolAddress).toBe(POOL);
    } finally {
      restore();
    }
  });

  it("suppresses a repeated alert of the same type+pool within the cooldown", async () => {
    const { posts, restore } = capturePosts();
    try {
      const layer = makeAlertLayer(dbPath, { alertCooldownMinutes: 120 });
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          const alert = {
            type: "range_warning" as const,
            severity: "warning" as const,
            message: "Range 80% consumed",
            poolAddress: POOL,
          };
          yield* alerts.sendAlert(alert);
          yield* alerts.sendAlert(alert);
        }).pipe(Effect.provide(layer)),
      );
      expect(posts).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("tracks cooldowns independently per pool", async () => {
    const { posts, restore } = capturePosts();
    try {
      const layer = makeAlertLayer(dbPath);
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.sendAlert({
            type: "range_warning",
            severity: "warning",
            message: "Range 80% consumed on pool A",
            poolAddress: "PoolA111111111111111111111111111111111111",
          });
          yield* alerts.sendAlert({
            type: "range_warning",
            severity: "warning",
            message: "Range 80% consumed on pool B",
            poolAddress: "PoolB111111111111111111111111111111111111",
          });
        }).pipe(Effect.provide(layer)),
      );
      expect(posts).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it("persists cooldowns across service rebuilds (restart does not reset them)", async () => {
    const { posts, restore } = capturePosts();
    try {
      const alert = {
        type: "exit_executed" as const,
        severity: "critical" as const,
        message: "EXIT executed",
        poolAddress: POOL,
      };
      // First "process": send the alert.
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.sendAlert(alert);
        }).pipe(Effect.provide(makeAlertLayer(dbPath))),
      );
      // Second "process": rebuilt layer over the same SQLite file — the
      // cooldown row must still be there.
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.sendAlert(alert);
        }).pipe(Effect.provide(makeAlertLayer(dbPath))),
      );
      expect(posts).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("fails open when the POST throws (scan cycle never blocked)", async () => {
    const restore = mockFetch(() => Promise.reject(new Error("network down")));
    try {
      const layer = makeAlertLayer(dbPath);
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.sendAlert({
            type: "risk_rejection",
            severity: "warning",
            message: "Risk gate rejected ENTER",
            poolAddress: POOL,
          });
        }).pipe(Effect.provide(layer)),
      );
      // Reaching here without a throw is the assertion.
    } finally {
      restore();
    }
  });

  it("fails open when the POST returns a non-2xx status", async () => {
    const { posts, restore } = capturePosts(500);
    try {
      const layer = makeAlertLayer(dbPath);
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.sendAlert({
            type: "risk_rejection",
            severity: "warning",
            message: "Risk gate rejected ENTER",
            poolAddress: POOL,
          });
        }).pipe(Effect.provide(layer)),
      );
      expect(posts).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("sends nothing when ALERTS_ENABLED is false", async () => {
    const { posts, restore } = capturePosts();
    try {
      const layer = makeAlertLayer(dbPath, { alertsEnabled: false });
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.sendAlert({
            type: "exit_executed",
            severity: "critical",
            message: "EXIT executed",
            poolAddress: POOL,
          });
          yield* alerts.recordFeeClaim(POOL, 25);
        }).pipe(Effect.provide(layer)),
      );
      expect(posts).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("emits fee_milestone only when cumulative fees cross the threshold", async () => {
    const { posts, restore } = capturePosts();
    try {
      const layer = makeAlertLayer(dbPath, { alertFeeMilestoneUsd: 10 });
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.recordFeeClaim(POOL, 4);
          yield* alerts.recordFeeClaim(POOL, 5);
          // 9 total — still below the $10 milestone.
          expect(posts).toHaveLength(0);
          yield* alerts.recordFeeClaim(POOL, 2);
          // 11 total — crossed $10.
          expect(posts).toHaveLength(1);
          expect(posts[0]!.body.type).toBe("fee_milestone");
          expect(posts[0]!.body.severity).toBe("info");
          yield* alerts.recordFeeClaim(POOL, 1);
          // 12 total — next milestone is $20, no new alert.
          expect(posts).toHaveLength(1);
        }).pipe(Effect.provide(layer)),
      );
    } finally {
      restore();
    }
  });

  it("persists fee milestone state across service rebuilds", async () => {
    const { posts, restore } = capturePosts();
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.recordFeeClaim(POOL, 8);
        }).pipe(Effect.provide(makeAlertLayer(dbPath))),
      );
      // Rebuilt layer: the running total must survive, so $3 more crosses $10.
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.recordFeeClaim(POOL, 3);
        }).pipe(Effect.provide(makeAlertLayer(dbPath))),
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]!.body.type).toBe("fee_milestone");
    } finally {
      restore();
    }
  });

  it("skips silently when no credentials are registered", async () => {
    rmSync(join(tmpDir, "credentials.json"), { force: true });
    const { posts, restore } = capturePosts();
    try {
      const layer = makeAlertLayer(dbPath);
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.sendAlert({
            type: "exit_executed",
            severity: "critical",
            message: "EXIT executed",
            poolAddress: POOL,
          });
        }).pipe(Effect.provide(layer)),
      );
      expect(posts).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it("ignores non-positive fee amounts", async () => {
    const { posts, restore } = capturePosts();
    try {
      const layer = makeAlertLayer(dbPath);
      await Effect.runPromise(
        Effect.gen(function* () {
          const alerts = yield* AlertService;
          yield* alerts.recordFeeClaim(POOL, 0);
          yield* alerts.recordFeeClaim(POOL, -5);
          yield* alerts.recordFeeClaim(POOL, Number.NaN);
        }).pipe(Effect.provide(layer)),
      );
      expect(posts).toHaveLength(0);
    } finally {
      restore();
    }
  });
});
