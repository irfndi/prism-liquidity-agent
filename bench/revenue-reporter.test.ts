import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect, Layer } from "effect";
import { AdapterService } from "../engine/services.js";
import type { AdapterApi } from "../engine/services.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function run<T>(effect: Effect.Effect<T, unknown, unknown>, layer: unknown): Promise<T> {
  return Effect.runPromise((Effect.provide as any)(effect, layer));
}

const FEE_WALLET_API_URL = "https://prism-api.irfndi.workers.dev";

type FeeCollectionEvent = {
  poolAddress: string;
  positionPubkey?: string;
  feeX: number;
  feeY: number;
  platformFeeX: number;
  platformFeeY: number;
  tier: string;
  txSignature: string;
  feeTransferTxSignature?: string;
};

/**
 * Build a test AdapterService layer that replicates the reportFeeCollection
 * behavior from adapter-service.ts:875-890.
 *
 * The real implementation:
 *   1. Always fires an async fetch to POST /v1/revenue/log (hardcoded URL)
 *   2. Logs warning on failure (does not throw)
 */
function makeTestAdapterLayer() {
  const mockAdapter: AdapterApi = {
    hasWallet: () => false,
    getWalletAddress: () => null,
    getWalletBalanceUsd: () => Effect.succeed(0),
    getNativeSolBalance: () => Effect.succeed(0n),
    getTokenBalance: () => Effect.succeed(0n),
    getTokenPrices: () => Effect.succeed({}),
    getTokenDecimals: () => Effect.succeed(6),
    swapUSDCForToken: () => Effect.fail("not implemented"),
    getPoolState: () => Effect.fail("not implemented"),
    getBinArray: () => Effect.fail("not implemented"),
    getPositions: () => Effect.succeed([]),
    getAllWalletPositions: () => Effect.succeed([]),
    simulateRebalance: () => Effect.fail("not implemented"),
    enterPosition: () => Effect.fail("not implemented"),
    exitPosition: () => Effect.fail("not implemented"),
    rebalancePosition: () => Effect.fail("not implemented"),
    claimFees: () => Effect.fail("not implemented"),
    discoverPools: () => Effect.succeed([]),

    reportFeeCollection(event: FeeCollectionEvent) {
      return Effect.tryPromise(() =>
        fetch(`${FEE_WALLET_API_URL}/v1/revenue/log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...event, installId: "test-install-id" }),
        }),
      ).pipe(
        Effect.tap((res) =>
          res.ok
            ? Effect.void
            : Effect.sync(() => console.warn("Revenue report failed:", res.status)),
        ),
        Effect.catchAll((err) =>
          Effect.sync(() => console.warn("Revenue report failed:", String(err))),
        ),
        Effect.asVoid,
      );
    },

    swapUSDCForSOL: () => Effect.void,
  };

  return Layer.succeed(AdapterService, mockAdapter);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("reportFeeCollection", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  const sampleEvent: FeeCollectionEvent = {
    poolAddress: "PoolAddr111111111111111111111111111111111111",
    positionPubkey: "PosKey111111111111111111111111111111111111111",
    feeX: 1.5,
    feeY: 2.3,
    platformFeeX: 0.15,
    platformFeeY: 0.23,
    tier: "standard",
    txSignature: "Sig11111111111111111111111111111111111111111111",
  };

  it("sends the correct payload to the API", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const layer = makeTestAdapterLayer();

    await run(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        yield* adapter.reportFeeCollection(sampleEvent);
      }),
      layer,
    );

    // reportFeeCollection is fire-and-forget (void), so flush the microtask queue
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${FEE_WALLET_API_URL}/v1/revenue/log`);
    expect(options.method).toBe("POST");
    expect(options.headers).toEqual({ "Content-Type": "application/json" });

    const body = JSON.parse(options.body as string);
    expect(body.poolAddress).toBe(sampleEvent.poolAddress);
    expect(body.positionPubkey).toBe(sampleEvent.positionPubkey);
    expect(body.feeX).toBe(1.5);
    expect(body.feeY).toBe(2.3);
    expect(body.platformFeeX).toBe(0.15);
    expect(body.platformFeeY).toBe(0.23);
    expect(body.tier).toBe("standard");
    expect(body.txSignature).toBe(sampleEvent.txSignature);
    expect(body.installId).toBe("test-install-id");
  });

  it("handles API errors gracefully (no throw)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network timeout"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const layer = makeTestAdapterLayer();

    // Should not throw
    await expect(
      run(
        Effect.gen(function* () {
          const adapter = yield* AdapterService;
          yield* adapter.reportFeeCollection(sampleEvent);
        }),
        layer,
      ),
    ).resolves.toBeUndefined();

    // Flush microtasks so the async fetch completes
    await vi.advanceTimersByTimeAsync(0);

    // The fetch was attempted but failed — no throw, just a console.warn
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
