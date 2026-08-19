import { describe, expect, it } from "vitest";
import { findPoolPnlKillSwitchTrips } from "../engine/pool-pnl-kill-switch.js";

const config = { minClosedPositions: 3, thresholdUsd: -15 };

describe("pool PnL kill switch", () => {
  it("trips only when the latest N known closes net below the threshold", () => {
    const trips = findPoolPnlKillSwitchTrips(
      [
        { positionId: "a3", poolAddress: "A", realizedPnlUsd: -8 },
        { positionId: "a2", poolAddress: "A", realizedPnlUsd: -5 },
        { positionId: "a1", poolAddress: "A", realizedPnlUsd: -3 },
        { positionId: "old", poolAddress: "A", realizedPnlUsd: -100 },
        { positionId: "b3", poolAddress: "B", realizedPnlUsd: 10 },
        { positionId: "b2", poolAddress: "B", realizedPnlUsd: -10 },
        { positionId: "b1", poolAddress: "B", realizedPnlUsd: -10 },
      ],
      config,
    );

    expect(trips).toEqual([
      {
        poolAddress: "A",
        positionIds: ["a3", "a2", "a1"],
        realizedPnlUsd: -16,
      },
    ]);
  });

  it("requires N known realized closes and ignores unknown values", () => {
    expect(
      findPoolPnlKillSwitchTrips(
        [
          { positionId: "a3", poolAddress: "A", realizedPnlUsd: -8 },
          { positionId: "a2", poolAddress: "A", realizedPnlUsd: null },
          { positionId: "a1", poolAddress: "A", realizedPnlUsd: -8 },
        ],
        config,
      ),
    ).toEqual([]);
  });

  it("uses only the trailing window, not older losses", () => {
    expect(
      findPoolPnlKillSwitchTrips(
        [
          { positionId: "a3", poolAddress: "A", realizedPnlUsd: 5 },
          { positionId: "a2", poolAddress: "A", realizedPnlUsd: 5 },
          { positionId: "a1", poolAddress: "A", realizedPnlUsd: 5 },
          { positionId: "old", poolAddress: "A", realizedPnlUsd: -100 },
        ],
        config,
      ),
    ).toEqual([]);
  });
});
