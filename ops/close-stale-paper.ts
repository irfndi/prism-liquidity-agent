#!/usr/bin/env bun
/**
 * Close stale/frozen paper positions so the agent can enter fresh positions.
 *
 * Paper rows have no on-chain public key, so `prism close` refuses them. This
 * settles the ledger directly: sets `closed_at` + `realized_pnl_usd` via the
 * engine's own `DbService.closePosition`, which `getClosedPositions` (portfolio
 * history) reads back.
 *
 * Usage:
 *   bun ops/close-stale-paper.ts <positionId> [positionId ...]
 *
 * The engine must be STOPPED while this runs so its in-memory `trackedPositions`
 * Map (loaded at startup) does not re-persist the rows as open.
 */
import { Effect, Layer } from "effect";
import { DbLive } from "../engine/db-service.js";
import { DbService, type DbApi } from "../engine/services.js";
import { getPrismDbPath } from "../engine/paths.js";

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("Usage: bun ops/close-stale-paper.ts <positionId> [positionId ...]");
  process.exit(1);
}

const dbLayer: Layer.Layer<DbService, Error, never> = DbLive(getPrismDbPath());

const run = Effect.gen(function* () {
  const db: DbApi = yield* DbService;
  const active = yield* db.getAllPositions();
  const activeIds = new Set(active.map((p) => p.positionId));

  for (const id of ids) {
    if (!activeIds.has(id)) {
      console.log(`skip ${id} — not an active position`);
      continue;
    }
    const pos = active.find((p) => p.positionId === id)!;
    // Paper close with no withdrawal: realized PnL is 0 (deposited == current
    // for the frozen rows being cleaned; if the ledger disagrees we still
    // realize exactly 0 rather than inventing a mark).
    yield* db.closePosition(id, 0);
    console.log(
      `closed ${id} (${pos.tokenXSymbol}/${pos.tokenYSymbol}, pool ${pos.poolAddress}) realizedPnl=0`,
    );
  }

  const remaining = yield* db.getAllPositions();
  console.log(`\nActive positions remaining: ${remaining.length}`);
  for (const p of remaining) {
    console.log(`  ${p.positionId}  ${p.tokenXSymbol}/${p.tokenYSymbol}`);
  }
});

await Effect.runPromise(Effect.provide(run, dbLayer));
