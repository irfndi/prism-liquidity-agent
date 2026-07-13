import { describe, expect, it } from "vitest";
import { shouldDiscoverPools } from "../engine/pool-policy.js";

describe("shouldDiscoverPools", () => {
  it("allows opt-in discovery in paper trading", () => {
    expect(shouldDiscoverPools({ enablePoolDiscovery: true, paperTrading: true })).toBe(true);
  });

  it("blocks discovery in live trading even when legacy config enables it", () => {
    expect(shouldDiscoverPools({ enablePoolDiscovery: true, paperTrading: false })).toBe(false);
  });

  it("blocks discovery when it is not enabled", () => {
    expect(shouldDiscoverPools({ enablePoolDiscovery: false, paperTrading: true })).toBe(false);
  });
});
