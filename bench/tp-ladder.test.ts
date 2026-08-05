import { describe, it, expect } from "vitest";
import {
  buildTpLadder,
  evaluateTpLadder,
  serializeTpLadder,
  parseTpLadder,
  type TpLadderConfig,
} from "../engine/tp-ladder.js";

const CONFIG: TpLadderConfig = {
  rungs: [0.15, 0.3, 0.5],
  fractions: [0.4, 0.3, 0.3],
  invalidationStopPct: 0.25,
};

describe("buildTpLadder", () => {
  it("builds rungs at entry × (1 + pct) in ascending order", () => {
    const built = buildTpLadder(100, CONFIG)!;
    const targets = built.ladder.rungs.map((r) => r.targetPrice);
    expect(targets[0]).toBeCloseTo(115, 6);
    expect(targets[1]).toBeCloseTo(130, 6);
    expect(targets[2]).toBeCloseTo(150, 6);
    expect(built.ladder.rungs.map((r) => r.fraction)).toEqual([0.4, 0.3, 0.3]);
    expect(built.ladder.totalFraction).toBeCloseTo(1, 6);
    expect(built.invalidationPrice).toBe(75);
  });

  it("renormalizes fractions that sum over 1", () => {
    const over = buildTpLadder(100, { rungs: [0.1], fractions: [1.5], invalidationStopPct: 0.25 })!;
    expect(over.ladder.rungs[0]!.fraction).toBeCloseTo(1, 6);
    expect(over.ladder.totalFraction).toBe(1);
  });

  it("returns null for non-positive entry or empty config", () => {
    expect(buildTpLadder(0, CONFIG)).toBeNull();
    expect(buildTpLadder(-1, CONFIG)).toBeNull();
    expect(buildTpLadder(100, { rungs: [], fractions: [], invalidationStopPct: 0.25 })).toBeNull();
  });
});

describe("evaluateTpLadder", () => {
  const built = buildTpLadder(100, CONFIG)!;

  it("returns none when price is below the first rung and above invalidation", () => {
    expect(evaluateTpLadder(110, built.ladder, built.invalidationPrice).status).toBe("none");
  });

  it("fires invalidation first (capital protection)", () => {
    const r = evaluateTpLadder(70, built.ladder, built.invalidationPrice);
    expect(r.status).toBe("invalidation");
    expect(r.invalidationPrice).toBe(75);
  });

  it("fires the first reached rung when price crosses it", () => {
    const r = evaluateTpLadder(120, built.ladder, built.invalidationPrice);
    expect(r.status).toBe("tp");
    expect(r.rungReached!.targetPrice).toBeCloseTo(115, 6);
    expect(r.scaleOutFraction).toBeCloseTo(0.4, 6);
    expect(r.ladderComplete).toBe(false);
  });

  it("marks ladderComplete when the final rung is the first reached", () => {
    // A fresh position always evaluates the FIRST crossed target (close-and-
    // reopen scales out bottom-up); the ladder is complete only when that first
    // reached rung is also the last one.
    const single = buildTpLadder(100, { rungs: [0.5], fractions: [1], invalidationStopPct: 0.25 })!;
    const r = evaluateTpLadder(160, single.ladder, single.invalidationPrice);
    expect(r.status).toBe("tp");
    expect(r.rungReached!.targetPrice).toBeCloseTo(150, 6);
    expect(r.ladderComplete).toBe(true);
  });

  it("returns none for non-finite or non-positive price", () => {
    expect(evaluateTpLadder(Number.NaN, built.ladder, built.invalidationPrice).status).toBe("none");
    expect(evaluateTpLadder(0, built.ladder, built.invalidationPrice).status).toBe("none");
  });
});

describe("serialize / parse", () => {
  it("round-trips a ladder", () => {
    const built = buildTpLadder(100, CONFIG)!;
    const raw = serializeTpLadder(built.ladder);
    expect(raw).toBeTruthy();
    const parsed = parseTpLadder(raw)!;
    expect(parsed.rungs.length).toBe(3);
    expect(parsed.rungs[0]!.targetPrice).toBeCloseTo(115, 6);
    expect(parsed.rungs[0]!.fraction).toBe(0.4);
  });

  it("returns null for undefined/empty input", () => {
    expect(serializeTpLadder(undefined)).toBeNull();
    expect(parseTpLadder(null)).toBeNull();
    expect(parseTpLadder("")).toBeNull();
    expect(parseTpLadder("{not json")).toBeNull();
    expect(parseTpLadder('{"rungs":[]}')).toBeNull();
  });

  it("drops malformed rungs on parse", () => {
    const parsed = parseTpLadder(
      JSON.stringify({
        rungs: [
          { targetPrice: 115, fraction: 0.4 },
          { targetPrice: -1, fraction: 0.5 },
        ],
      }),
    )!;
    expect(parsed.rungs.length).toBe(1);
    expect(parsed.rungs[0]!.targetPrice).toBeCloseTo(115, 6);
  });
});
