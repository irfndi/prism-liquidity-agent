import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { Effect } from "effect";
import { BlacklistLive } from "../engine/blacklist-service.js";
import { BlacklistService } from "../engine/services.js";

const tmpDir = path.resolve("bench/tmp");
const deployerPath = path.join(tmpDir, "deployer-blacklist.json");
const tokenPath = path.join(tmpDir, "token-blacklist.json");

describe("BlacklistService", () => {
  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(deployerPath, JSON.stringify(["bad_deployer_1", "bad_deployer_2"]));
    fs.writeFileSync(tokenPath, JSON.stringify(["bad_token_1", "bad_token_2"]));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function getLayer() {
    return BlacklistLive({ deployerBlacklistPath: deployerPath, tokenBlacklistPath: tokenPath });
  }

  describe("isDeployerBlacklisted", () => {
    it("returns true for blacklisted deployer", () => {
      const api = Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          getLayer(),
        ),
      );
      expect(api.isDeployerBlacklisted("bad_deployer_1")).toBe(true);
      expect(api.isDeployerBlacklisted("bad_deployer_2")).toBe(true);
    });

    it("returns false for non-blacklisted deployer", () => {
      const api = Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          getLayer(),
        ),
      );
      expect(api.isDeployerBlacklisted("good_deployer")).toBe(false);
    });

    it("returns false when file does not exist", () => {
      fs.rmSync(deployerPath);
      const api = Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          getLayer(),
        ),
      );
      expect(api.isDeployerBlacklisted("any")).toBe(false);
    });
  });

  describe("isTokenBlacklisted", () => {
    it("returns true for blacklisted token", () => {
      const api = Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          getLayer(),
        ),
      );
      expect(api.isTokenBlacklisted("bad_token_1")).toBe(true);
    });

    it("returns false for non-blacklisted token", () => {
      const api = Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          getLayer(),
        ),
      );
      expect(api.isTokenBlacklisted("good_token")).toBe(false);
    });
  });

  describe("checkPool", () => {
    it("passes for clean pool", () => {
      const api = Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          getLayer(),
        ),
      );
      const result = Effect.runSync(
        Effect.result(api.checkPool("pool1", "good_token", "also_good")),
      );
      expect(result._tag).toBe("Success");
    });

    it("fails when token X is blacklisted", () => {
      const api = Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          getLayer(),
        ),
      );
      const result = Effect.runSync(
        Effect.result(api.checkPool("pool1", "bad_token_1", "good_token")),
      );
      expect(result._tag).toBe("Failure");
    });

    it("fails when token Y is blacklisted", () => {
      const api = Effect.runSync(
        Effect.provide(
          Effect.gen(function* () {
            return yield* BlacklistService;
          }),
          getLayer(),
        ),
      );
      const result = Effect.runSync(
        Effect.result(api.checkPool("pool1", "good_token", "bad_token_2")),
      );
      expect(result._tag).toBe("Failure");
    });
  });
});
