/** Merge-preserving .env writer tests: `prism setup` must never wipe user config. */
import { describe, it, expect } from "vitest";
import { mergeEnvContent, envValues, parseEnvLines } from "../cli/env-merge.js";

const MANAGED = `# RPC providers
HELIUS_API_KEY=new-key
SOLANA_RPC_URL=https://new-rpc

# Trading mode
PAPER_TRADING=false
SCAN_INTERVAL_MS=600000
WATCHLIST_POOLS=`;

describe("mergeEnvContent", () => {
  it("preserves unknown user keys and comments verbatim", () => {
    const existing = `# my custom header
HELIUS_API_KEY=old-key
WATCHLIST_POOLS=pool1,pool2
MARKET_SCAN_ENABLED=true
AGENTIC_MODE=true
# a trailing comment`;
    const merged = mergeEnvContent(existing, MANAGED);
    expect(merged).toContain("# my custom header");
    expect(merged).toContain("HELIUS_API_KEY=new-key");
    expect(merged).toContain("WATCHLIST_POOLS=pool1,pool2");
    expect(merged).toContain("MARKET_SCAN_ENABLED=true");
    expect(merged).toContain("AGENTIC_MODE=true");
    expect(merged).toContain("# a trailing comment");
    expect(merged).not.toContain("HELIUS_API_KEY=old-key");
  });

  it("appends managed keys that are absent from the existing file", () => {
    const merged = mergeEnvContent("ONLY_CUSTOM=1\n", MANAGED);
    const values = envValues(merged);
    expect(values.get("HELIUS_API_KEY")).toBe("new-key");
    expect(values.get("ONLY_CUSTOM")).toBe("1");
    expect(merged).toContain("Managed by `prism setup`");
  });

  it("never wipes a non-empty user value with an empty wizard default", () => {
    // MANAGED has WATCHLIST_POOLS= (empty) — the user's pools must survive.
    const existing = `WATCHLIST_POOLS=poolA,poolB
MARKET_SCAN_ENABLED=true
`;
    const merged = mergeEnvContent(existing, MANAGED);
    expect(envValues(merged).get("WATCHLIST_POOLS")).toBe("poolA,poolB");
    // ...but a managed key WITH a fresh value replaces the old one.
    expect(envValues(merged).get("HELIUS_API_KEY")).toBe("new-key");
    expect(envValues(merged).get("PAPER_TRADING")).toBe("false");
  });

  it("honors an intentional clear when the existing value is also empty", () => {
    const existing = "WATCHLIST_POOLS=\n";
    const merged = mergeEnvContent(existing, MANAGED);
    expect(envValues(merged).get("WATCHLIST_POOLS")).toBe("");
  });

  it("parses keys, values, comments and blanks", () => {
    const lines = parseEnvLines("# c\nA=1\n\n B = 2 \nnot-a-key");
    expect(lines).toHaveLength(5);
    expect(lines[0]!.key).toBeNull();
    expect(lines[1]!.key).toBe("A");
    expect(lines[2]!.key).toBeNull();
    expect(lines[3]!.key).toBe("B");
    expect(lines[3]!.value).toBe("2");
    expect(lines[4]!.key).toBeNull();
  });
});
