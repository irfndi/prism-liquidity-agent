import { describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService } from "../engine/services.js";

function run<T, R>(
  effect: Effect.Effect<T, unknown, R>,
  layer: Layer.Layer<R, unknown, unknown>,
): T {
  return Effect.runSync(Effect.provide(effect, layer) as Effect.Effect<T, unknown, never>);
}

function makeFeeClaim(
  overrides: Partial<{
    id: string;
    poolAddress: string;
    positionPubkey: string;
    feeX: number;
    feeY: number;
    platformFeeX: number;
    platformFeeY: number;
    netFeeX: number;
    netFeeY: number;
    txSignature: string | null;
    feeTransferTxSignature: string | null;
    reportedToApi: boolean;
    createdAt: number;
  }> = {},
): {
  id: string;
  poolAddress: string;
  positionPubkey: string;
  feeX: number;
  feeY: number;
  platformFeeX: number;
  platformFeeY: number;
  netFeeX: number;
  netFeeY: number;
  txSignature: string | null;
  feeTransferTxSignature: string | null;
  reportedToApi: boolean;
  createdAt: number;
} {
  return {
    id: overrides.id ?? randomUUID(),
    poolAddress: overrides.poolAddress ?? "PoolA111111111111111111111111111111111111111",
    positionPubkey: overrides.positionPubkey ?? "PosA1111111111111111111111111111111111111111",
    feeX: overrides.feeX ?? 0.5,
    feeY: overrides.feeY ?? 1.25,
    platformFeeX: overrides.platformFeeX ?? 0.05,
    platformFeeY: overrides.platformFeeY ?? 0.125,
    netFeeX: overrides.netFeeX ?? 0.45,
    netFeeY: overrides.netFeeY ?? 1.125,
    txSignature: overrides.txSignature === undefined ? "txSig1" : overrides.txSignature,
    feeTransferTxSignature:
      overrides.feeTransferTxSignature === undefined
        ? "feeTxSig1"
        : overrides.feeTransferTxSignature,
    reportedToApi: overrides.reportedToApi ?? false,
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

describe("DbService — fee_claims", () => {
  it("saveFeeClaim persists a claim and getUnreportedFeeClaims returns it", () => {
    const layer = DbLive(":memory:");
    const claim = makeFeeClaim();

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveFeeClaim(claim);
        return yield* db.getUnreportedFeeClaims();
      }),
      layer,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(claim.id);
    expect(result[0]!.poolAddress).toBe(claim.poolAddress);
    expect(result[0]!.feeX).toBe(claim.feeX);
  });

  it("getUnreportedFeeClaims returns only claims with reported_to_api = 0", () => {
    const layer = DbLive(":memory:");
    const a = makeFeeClaim({ createdAt: 1000 });
    const b = makeFeeClaim({ createdAt: 2000 });
    const c = makeFeeClaim({ createdAt: 3000 });

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveFeeClaim(a);
        yield* db.saveFeeClaim(b);
        yield* db.saveFeeClaim(c);
        yield* db.markFeeClaimReported(b.id);
        return yield* db.getUnreportedFeeClaims();
      }),
      layer,
    );

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).not.toContain(b.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(c.id);
  });

  it("markFeeClaimReported removes a claim from the unreported set", () => {
    const layer = DbLive(":memory:");
    const claim = makeFeeClaim();

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveFeeClaim(claim);
        yield* db.markFeeClaimReported(claim.id);
        return yield* db.getUnreportedFeeClaims();
      }),
      layer,
    );

    expect(result).toEqual([]);
  });

  it("getUnreportedFeeClaims returns camelCase fields with the exact set documented by DbApi", () => {
    const layer = DbLive(":memory:");
    const claim = makeFeeClaim({
      poolAddress: "PoolCamel1111111111111111111111111111111111",
      positionPubkey: "PosCamel1111111111111111111111111111111111",
      feeX: 1.5,
      feeY: 2.75,
      platformFeeX: 0.15,
      platformFeeY: 0.275,
      netFeeX: 9.99,
      netFeeY: 8.88,
      txSignature: "claimTx111",
      feeTransferTxSignature: "transferTx111",
      reportedToApi: false,
      createdAt: 1700000000000,
    });

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveFeeClaim(claim);
        return yield* db.getUnreportedFeeClaims();
      }),
      layer,
    );

    expect(result).toHaveLength(1);
    const row = result[0]!;

    expect(row.id).toBe(claim.id);
    expect(row.poolAddress).toBe("PoolCamel1111111111111111111111111111111111");
    expect(row.positionPubkey).toBe("PosCamel1111111111111111111111111111111111");
    expect(row.feeX).toBe(1.5);
    expect(row.feeY).toBe(2.75);
    expect(row.platformFeeX).toBe(0.15);
    expect(row.platformFeeY).toBe(0.275);
    expect(row.txSignature).toBe("claimTx111");
    expect(row.feeTransferTxSignature).toBe("transferTx111");
    expect(row.createdAt).toBe(1700000000000);

    const keys = Object.keys(row).sort();
    expect(keys).toEqual([
      "createdAt",
      "feeTransferTxSignature",
      "feeX",
      "feeY",
      "id",
      "platformFeeX",
      "platformFeeY",
      "poolAddress",
      "positionPubkey",
      "txSignature",
    ]);
  });

  it("getUnreportedFeeClaims orders results by created_at ASC", () => {
    const layer = DbLive(":memory:");

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        const first = makeFeeClaim({ createdAt: 1000 });
        const second = makeFeeClaim({ createdAt: 2000 });
        const third = makeFeeClaim({ createdAt: 3000 });
        yield* db.saveFeeClaim(third);
        yield* db.saveFeeClaim(first);
        yield* db.saveFeeClaim(second);
        return yield* db.getUnreportedFeeClaims();
      }),
      layer,
    );

    expect(result).toHaveLength(3);
    expect(result[0]!.createdAt).toBe(1000);
    expect(result[1]!.createdAt).toBe(2000);
    expect(result[2]!.createdAt).toBe(3000);
  });

  it("markFeeClaimReported on a non-existent id is a silent no-op", () => {
    const layer = DbLive(":memory:");
    const claim = makeFeeClaim();

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveFeeClaim(claim);
        yield* db.markFeeClaimReported("nonexistent-id");
        return yield* db.getUnreportedFeeClaims();
      }),
      layer,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(claim.id);
  });

  it("saveFeeClaim with reportedToApi=true stores reported_to_api=1 and is filtered out of the unreported set", () => {
    const layer = DbLive(":memory:");

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveFeeClaim(makeFeeClaim({ reportedToApi: true }));
        yield* db.saveFeeClaim(makeFeeClaim({ reportedToApi: false }));
        return yield* db.getUnreportedFeeClaims();
      }),
      layer,
    );

    expect(result).toHaveLength(1);
  });

  it("saveFeeClaim accepts null tx signatures and round-trips them", () => {
    const layer = DbLive(":memory:");

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        yield* db.saveFeeClaim(makeFeeClaim({ txSignature: null, feeTransferTxSignature: null }));
        return yield* db.getUnreportedFeeClaims();
      }),
      layer,
    );

    expect(result).toHaveLength(1);
    expect(result[0]!.txSignature).toBeNull();
    expect(result[0]!.feeTransferTxSignature).toBeNull();
  });

  it("getUnreportedFeeClaims returns an empty array when no claims exist", () => {
    const layer = DbLive(":memory:");

    const result = run(
      Effect.gen(function* () {
        const db = yield* DbService;
        return yield* db.getUnreportedFeeClaims();
      }),
      layer,
    );

    expect(result).toEqual([]);
  });
});
