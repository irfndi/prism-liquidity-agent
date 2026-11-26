import { describe, expect, it } from "vitest";
import { Database } from "bun:sqlite";
import {
  RENT_BASIS_EPOCH_MS,
  applyRentBackfill,
  auditRow,
  auditRows,
  deriveRealizedUsd,
  readClosedPositions,
  type AuditRow,
} from "../engine/pnl-audit.js";

const BEFORE_FIX = RENT_BASIS_EPOCH_MS - 86_400_000;
const AFTER_FIX = RENT_BASIS_EPOCH_MS + 86_400_000;

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    positionId: "p1",
    closedAt: AFTER_FIX,
    positionPubKey: "LivePubkey111",
    depositedUsd: 19.88,
    realizedPnlUsd: 3.0,
    entryOverheadUsd: 3.0,
    withdrawnUsd: 22.88,
    modeledCostsUsd: 0,
    feesUsd: 0,
    rewardsUsd: 0,
    ...overrides,
  };
}

describe("deriveRealizedUsd", () => {
  it("re-derives the ledger identity", () => {
    expect(deriveRealizedUsd(row())).toBeCloseTo(3.0, 9);
  });

  it("is null when the cost basis is unknown", () => {
    expect(deriveRealizedUsd(row({ depositedUsd: null }))).toBeNull();
    expect(deriveRealizedUsd(row({ withdrawnUsd: null }))).toBeNull();
  });
});

describe("auditRow", () => {
  it("passes a close whose withdrawal is net of the measured overhead", () => {
    // gross 22.88 = deposit 19.88 + rent 3.00, net 19.88 -> realized 0.
    const finding = auditRow(
      row({ withdrawnUsd: 19.88, realizedPnlUsd: 0, entryOverheadUsd: 3.0 }),
    );
    expect(finding.status).toBe("ok");
  });

  it("flags the exact 2026-11 regression shape as rent-unaccounted", () => {
    // Post-fix close with NO measured overhead and a rent-inflated gain.
    const finding = auditRow(
      row({ closedAt: AFTER_FIX, entryOverheadUsd: null, realizedPnlUsd: 3.0 }),
    );
    expect(finding.status).toBe("rent-unaccounted");
  });

  it("does not flag a pre-fix close for missing overhead (it was measured symmetrically)", () => {
    const finding = auditRow(
      row({ closedAt: BEFORE_FIX, entryOverheadUsd: null, realizedPnlUsd: 0, withdrawnUsd: 19.88 }),
    );
    expect(finding.status).toBe("ok");
  });

  it("flags arithmetic that no longer closes", () => {
    const finding = auditRow(row({ realizedPnlUsd: 5, withdrawnUsd: 22.88 }));
    expect(finding.status).toBe("drift");
    expect(finding.driftUsd).toBeCloseTo(2.0, 9);
  });

  it("treats an unpriced close as n/a, never as drift", () => {
    const finding = auditRow(row({ realizedPnlUsd: null, withdrawnUsd: null }));
    expect(finding.status).toBe("unpriced");
    expect(finding.driftUsd).toBeNull();
  });

  it("tolerates sub-cent rounding", () => {
    const finding = auditRow(row({ realizedPnlUsd: 3.01 }));
    expect(finding.status).toBe("ok");
  });
});

describe("auditRows", () => {
  it("separates reported from adjusted PnL for rent-unaccounted rows", () => {
    const audit = auditRows([
      row({ positionId: "phantom", entryOverheadUsd: null, realizedPnlUsd: 3.0 }),
      row({ positionId: "honest", withdrawnUsd: 19.88, realizedPnlUsd: 0 }),
    ]);
    expect(audit.counts["rent-unaccounted"]).toBe(1);
    expect(audit.reportedUsd).toBeCloseTo(3.0, 9);
    expect(audit.adjustedUsd).toBeCloseTo(0, 9);
    expect(audit.rentBackfill).toEqual(["phantom"]);
  });
});

describe("persistence", () => {
  function makeDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE positions (
        position_id TEXT PRIMARY KEY, closed_at INTEGER, position_pubkey TEXT,
        deposited_usd REAL, realized_pnl_usd REAL, entry_overhead_usd REAL,
        cumulative_fees_claimed_usd REAL, cumulative_rewards_claimed_usd REAL
      );
      CREATE TABLE position_events (
        id TEXT PRIMARY KEY, pool_address TEXT, position_id TEXT, event TEXT,
        value_usd REAL, metadata TEXT, created_at INTEGER
      );
    `);
    return db;
  }

  it("reads closed positions with their EXIT leg", () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO positions VALUES ('p1', ${AFTER_FIX}, 'pub', 19.88, 3.0, 3.0, 0.0, 0.0);
      INSERT INTO position_events VALUES ('e1', 'pool', 'p1', 'EXIT', 22.88, '{"modeledCostsUsd":0}', 1);
    `);
    const rows = readClosedPositions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.withdrawnUsd).toBeCloseTo(22.88, 9);
    expect(rows[0]?.entryOverheadUsd).toBeCloseTo(3.0, 9);
    db.close();
  });

  it("voids a rent-unaccounted row to NULL and tags the EXIT, idempotently", () => {
    const db = makeDb();
    db.exec(`
      INSERT INTO positions VALUES ('p1', ${AFTER_FIX}, 'pub', 19.88, 3.0, NULL, 0.0, 0.0);
      INSERT INTO position_events VALUES ('e1', 'pool', 'p1', 'EXIT', 22.88, '{"modeledCostsUsd":0}', 1);
    `);
    const audit = auditRows(readClosedPositions(db));
    expect(applyRentBackfill(db, audit.rentBackfill)).toBe(1);
    const after = readClosedPositions(db);
    expect(after[0]?.realizedPnlUsd).toBeNull();
    // SAFETY: 'e1' was inserted above with a metadata JSON object, so the
    // single projected column is a non-null TEXT value.
    const meta = db.query("SELECT metadata FROM position_events WHERE id = 'e1'").get() as {
      metadata: string;
    };
    expect(meta.metadata).toContain("rentUnaccounted");
    // Second run plans nothing.
    expect(auditRows(readClosedPositions(db)).rentBackfill).toHaveLength(0);
    db.close();
  });
});
