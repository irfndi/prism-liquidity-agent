/** Held-pool survival: a pool dropped from every ranked set must still be
 * scanned while a position is open on it (field bug 2026-09: 228h/183h
 * survivors left the market top-K, rebuildPoolsToScan wiped them, and no exit
 * — timebox, max-age, fee-il, starvation — could ever fire). */
import { describe, expect, it } from "vitest";
import {
  buildActiveScanSet,
  mergePoolSet,
  snapshotPriceDrift,
  MIN_FEE_WINDOW_SPAN_MS,
} from "../engine/scan-set.js";

describe("buildActiveScanSet held-pool survival", () => {
  const baseApproved: Array<string> = [];
  const base = {
    approvedPoolAddresses: baseApproved,
    marketScanPools: new Set<string>(),
    autonomousCandidatePools: new Set<string>(),
    fallenAngelCandidatePools: new Set<string>(),
    launchScanPools: new Set<string>(),
  };
  it("keeps a held pool dropped from every ranked set", () => {
    const active = buildActiveScanSet({ ...base, heldPoolAddresses: new Set(["HeldPool111"]) });
    expect(active).toContain("HeldPool111");
  });
  it("dedupes a held pool already in the market set", () => {
    const active = buildActiveScanSet({
      ...base,
      marketScanPools: new Set(["SharedPool111"]),
      heldPoolAddresses: new Set(["SharedPool111"]),
    });
    expect(active.filter((p) => p === "SharedPool111")).toHaveLength(1);
  });
  it("merges every ranked set plus held pools", () => {
    const active = buildActiveScanSet({
      approvedPoolAddresses: ["WatchPool111"],
      marketScanPools: new Set(["MarketPool111"]),
      autonomousCandidatePools: new Set(["CandidatePool111"]),
      fallenAngelCandidatePools: new Set(["AngelPool111"]),
      launchScanPools: new Set(["LaunchPool111"]),
      heldPoolAddresses: new Set(["HeldPool111"]),
    });
    for (const pool of [
      "WatchPool111",
      "MarketPool111",
      "CandidatePool111",
      "AngelPool111",
      "LaunchPool111",
      "HeldPool111",
    ]) {
      expect(active).toContain(pool);
    }
  });
  it("mergePoolSet never duplicates", () => {
    const target = ["A"];
    mergePoolSet(target, new Set(["A", "B"]));
    expect(target).toEqual(["A", "B"]);
  });
});

describe("snapshotPriceDrift fee-window anchor", () => {
  const anchor = (price: number, timestamp: number) => ({ currentPrice: price, timestamp });
  it("uses the oldest in-window snapshot so 24h fees compare against 24h drift", () => {
    const drift = snapshotPriceDrift(
      [anchor(100, 1_000), anchor(101, 2_000), anchor(102, 3_000 + MIN_FEE_WINDOW_SPAN_MS)],
      anchor(102, 3_000 + MIN_FEE_WINDOW_SPAN_MS),
    );
    expect(drift?.previousPrice).toBe(100);
    expect(drift?.previousTimestamp).toBe(1_000);
  });
  it("returns undefined on cold start (no history → binStep proxy)", () => {
    expect(snapshotPriceDrift([], undefined)).toBeUndefined();
  });
  it("returns undefined when the window is younger than the span floor (jitter guard)", () => {
    const drift = snapshotPriceDrift([anchor(100, 1_000)], anchor(101, 2_000));
    expect(drift).toBeUndefined();
  });
});
