import { describe, expect, it, vi } from "vitest";
import {
  BoundedTtlCache,
  PublicProviderBreaker,
  RequestPacer,
} from "../engine/public-data-client.js";

describe("BoundedTtlCache", () => {
  it("deduplicates concurrent identical fetches", async () => {
    const cache = new BoundedTtlCache<number>(10);
    let release: ((value: number) => void) | undefined;
    const fetchValue = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const first = cache.getOrFetch("key", 1_000, fetchValue);
    const second = cache.getOrFetch("key", 1_000, fetchValue);
    expect(fetchValue).toHaveBeenCalledTimes(1);
    release?.(42);
    await expect(first).resolves.toBe(42);
    await expect(second).resolves.toBe(42);
  });

  it("expires values and bounds storage", () => {
    const cache = new BoundedTtlCache<number>(2);
    cache.set("a", 1, 1_000, 0);
    cache.set("b", 2, 1_000, 0);
    cache.set("c", 3, 1_000, 0);
    expect(cache.get("a", 1)).toBeUndefined();
    expect(cache.get("b", 1)).toBe(2);
    expect(cache.get("b", 1_001)).toBeUndefined();
  });
});

describe("PublicProviderBreaker", () => {
  it("opens after consecutive failures and allows one trial after cooldown", () => {
    const breaker = new PublicProviderBreaker(3, 1_000);
    breaker.recordFailure(0);
    breaker.recordFailure(0);
    expect(breaker.canTry(0)).toBe(true);
    breaker.recordFailure(0);
    expect(breaker.canTry(999)).toBe(false);
    expect(breaker.canTry(1_000)).toBe(true);
    breaker.recordSuccess();
    expect(breaker.canTry(1_001)).toBe(true);
  });
});

describe("RequestPacer", () => {
  it("spaces callers by the configured interval", async () => {
    const pacer = new RequestPacer(10);
    const started = Date.now();
    await pacer.wait();
    await pacer.wait();
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
  });
});
