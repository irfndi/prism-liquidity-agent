import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDefillamaCoinCacheForTest,
  fetchDefillamaCoins,
  parseDefillamaCoinData,
  setDefillamaRequestIntervalMsForTest,
  type DefillamaFetchLike,
} from "../engine/defillama-service.js";

const MINT = "So11111111111111111111111111111111111111112";
const NOW_SECONDS = 1_790_000_000;
const NOW_MS = NOW_SECONDS * 1_000;

function response(price: number, confidence = 0.99, timestamp = NOW_SECONDS): Response {
  return new Response(
    JSON.stringify({
      coins: {
        [`solana:${MINT}`]: { price, confidence, timestamp, decimals: 9, symbol: "SOL" },
      },
    }),
    { status: 200 },
  );
}

describe("DefiLlama coin data", () => {
  beforeEach(() => {
    clearDefillamaCoinCacheForTest();
    setDefillamaRequestIntervalMsForTest(0);
  });

  afterEach(() => {
    clearDefillamaCoinCacheForTest();
    setDefillamaRequestIntervalMsForTest(1_000);
  });

  it("keeps fresh high-confidence price plus normalized metadata", () => {
    const parsed = parseDefillamaCoinData(
      {
        coins: {
          [`solana:${MINT}`]: {
            price: 71.5,
            confidence: 0.99,
            timestamp: NOW_SECONDS,
            decimals: 9,
            symbol: "SOL",
          },
        },
      },
      [MINT],
      NOW_MS,
    );
    expect(parsed.get(MINT)).toEqual({
      priceUsd: 71.5,
      decimals: 9,
      symbol: "SOL",
      timestamp: NOW_MS,
      confidence: 0.99,
    });
  });

  it("rejects stale or low-confidence prices but keeps immutable metadata", () => {
    for (const body of [
      {
        coins: {
          [`solana:${MINT}`]: {
            price: 71.5,
            confidence: 0.99,
            timestamp: NOW_SECONDS - 3_600,
            decimals: 9,
            symbol: "SOL",
          },
        },
      },
      {
        coins: {
          [`solana:${MINT}`]: {
            price: 71.5,
            confidence: 0.5,
            timestamp: NOW_SECONDS,
            decimals: 9,
            symbol: "SOL",
          },
        },
      },
    ]) {
      const parsed = parseDefillamaCoinData(body, [MINT], NOW_MS);
      expect(parsed.get(MINT)?.priceUsd).toBeNull();
      expect(parsed.get(MINT)?.decimals).toBe(9);
    }
  });

  it("batches 50 mints and caches the normalized result", async () => {
    const mints = Array.from({ length: 51 }, (_, index) => `Mint${index}`);
    const fetchImpl: DefillamaFetchLike = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            coins: Object.fromEntries(
              mints.map((mint) => [
                `solana:${mint}`,
                { price: 1, confidence: 1, timestamp: NOW_SECONDS, decimals: 6, symbol: mint },
              ]),
            ),
          }),
          { status: 200 },
        ),
      ),
    );
    const first = await fetchDefillamaCoins(mints, { fetchImpl });
    const second = await fetchDefillamaCoins(mints, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(first.size).toBe(51);
    expect(second.size).toBe(51);
  });

  it("coalesces concurrent identical coin lookups", async () => {
    const fetchImpl: DefillamaFetchLike = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return response(71.5);
    });
    const [first, second] = await Promise.all([
      fetchDefillamaCoins([MINT], { fetchImpl }),
      fetchDefillamaCoins([MINT], { fetchImpl }),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first.get(MINT)?.decimals).toBe(9);
    expect(second.get(MINT)?.decimals).toBe(9);
  });

  it("fails open on HTTP errors", async () => {
    const fetchImpl: DefillamaFetchLike = () =>
      Promise.resolve(new Response("no", { status: 429 }));
    const parsed = await fetchDefillamaCoins([MINT], { fetchImpl });
    expect(parsed.size).toBe(0);
  });
});
