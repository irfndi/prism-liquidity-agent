import { describe, it, expect, beforeEach } from "vitest";
import {
  fetchTokenRisks,
  consultTokenRisks,
  clearTokenRiskCache,
  type FetchLike,
  type TokenRiskConfigLike,
} from "../engine/token-risk-service.js";

// All tests inject fetchImpl — NO live network. The Jupiter Tokens V2 contract
// was live-verified in the research wave (notepad R1); these lock the parse +
// cache + fail-open behavior against that fixed shape.

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ENABLED: TokenRiskConfigLike = {
  jupiterTokenRiskEnabled: true,
  jupiterTokenRiskCacheTtlMin: 30,
};

function okFetch(entries: ReadonlyArray<unknown>): FetchLike {
  return async () => new Response(JSON.stringify(entries), { status: 200 });
}

function failFetch(): FetchLike {
  return async () => {
    throw new Error("network down");
  };
}

function headerRecord(init: RequestInit | undefined): object {
  const headers = init?.headers;
  return headers !== null &&
    headers !== undefined &&
    typeof headers === "object" &&
    !Array.isArray(headers) &&
    !(headers instanceof Headers)
    ? headers
    : {};
}

beforeEach(() => {
  clearTokenRiskCache();
});

describe("token-risk-service", () => {
  it("(1) parses a USDC-shaped payload into a fully-populated signal", async () => {
    const entries = [
      {
        address: USDC_MINT,
        symbol: "USDC",
        isVerified: true,
        organicScore: 100,
        organicScoreLabel: "high",
        mintAuthority: "BJE5MintAuthorityAddress111111111111111111",
        freezeAuthority: "7dGbFreezeAuthorityAddress1111111111111111",
        // audit PRESENT but without isSus — must read as NOT suspicious
        // (absence is not the same as a false flag).
        audit: { topHoldersPercentage: 26.84, devBalancePercentage: 2.6e-7 },
      },
    ];
    const result = await fetchTokenRisks([USDC_MINT], { fetchImpl: okFetch(entries) });
    const signal = result.get(USDC_MINT);
    expect(signal).toBeDefined();
    expect(signal!.isSus).toBe(false);
    expect(signal!.freezeAuthorityPresent).toBe(true);
    expect(signal!.mintAuthorityPresent).toBe(true);
    expect(signal!.isVerified).toBe(true);
    expect(signal!.organicScore).toBe(100);
    expect(signal!.organicScoreLabel).toBe("high");
  });

  it("(2) a 200 empty-array response leaves the mint absent from the map", async () => {
    const result = await fetchTokenRisks([USDC_MINT], { fetchImpl: okFetch([]) });
    expect(result.has(USDC_MINT)).toBe(false);
    expect(result.size).toBe(0);
  });

  it("(3) consult never throws on fetch failure — serves stale when cached, else empty", async () => {
    // Seed the cache for one mint via a working fetch.
    await consultTokenRisks([USDC_MINT], ENABLED, {
      fetchImpl: okFetch([{ address: USDC_MINT, isVerified: true }]),
    });
    const unknownMint = "UnknownMint1111111111111111111111111111111";
    // The next consult needs a fresh fetch (unknownMint missing) that throws:
    // the cached mint is served stale, the unknown mint stays absent, no throw.
    const stale = await consultTokenRisks([USDC_MINT, unknownMint], ENABLED, {
      fetchImpl: failFetch(),
    });
    expect(stale.get(USDC_MINT)?.isVerified).toBe(true);
    expect(stale.has(unknownMint)).toBe(false);

    // With no cache at all, failure yields an empty map (still no throw).
    clearTokenRiskCache();
    const empty = await consultTokenRisks([unknownMint], ENABLED, { fetchImpl: failFetch() });
    expect(empty.size).toBe(0);

    // A non-OK (e.g. 429) response is likewise swallowed.
    clearTokenRiskCache();
    const rateLimited = await consultTokenRisks([unknownMint], ENABLED, {
      fetchImpl: async () => new Response("rate limited", { status: 429 }),
    });
    expect(rateLimited.size).toBe(0);
  });

  it("(4) two consults within the TTL perform exactly ONE fetch", async () => {
    let calls = 0;
    const countingFetch: FetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify([{ address: USDC_MINT, isVerified: true }]), {
        status: 200,
      });
    };
    await consultTokenRisks([USDC_MINT], ENABLED, { fetchImpl: countingFetch });
    await consultTokenRisks([USDC_MINT], ENABLED, { fetchImpl: countingFetch });
    expect(calls).toBe(1);
  });

  it("(5) omits x-api-key on an empty key and sends it when configured", async () => {
    let captured: RequestInit | undefined;
    const capturingFetch: FetchLike = async (_url, init) => {
      captured = init;
      return new Response("[]", { status: 200 });
    };

    await fetchTokenRisks([USDC_MINT], { apiKey: "", fetchImpl: capturingFetch });
    expect(headerRecord(captured)).not.toHaveProperty("x-api-key");

    await fetchTokenRisks([USDC_MINT], { apiKey: "test-key", fetchImpl: capturingFetch });
    expect(headerRecord(captured)).toHaveProperty("x-api-key", "test-key");
  });

  it("(6) chunks 150 mints into two requests (100 + 50)", async () => {
    const urls: string[] = [];
    const capturingFetch: FetchLike = async (url) => {
      urls.push(typeof url === "string" ? url : url.toString());
      return new Response("[]", { status: 200 });
    };
    const mints = Array.from({ length: 150 }, (_, i) => `Mint${i}`);
    await fetchTokenRisks(mints, { fetchImpl: capturingFetch });

    expect(urls.length).toBe(2);
    const firstCount = new URL(urls[0]!).searchParams.get("query")?.split(",").length ?? 0;
    const secondCount = new URL(urls[1]!).searchParams.get("query")?.split(",").length ?? 0;
    expect(firstCount).toBe(100);
    expect(secondCount).toBe(50);
  });

  it("(7) a disabled config performs zero fetches and returns an empty map", async () => {
    let calls = 0;
    const countingFetch: FetchLike = async () => {
      calls += 1;
      return new Response("[]", { status: 200 });
    };
    const result = await consultTokenRisks(
      [USDC_MINT],
      { jupiterTokenRiskEnabled: false },
      { fetchImpl: countingFetch },
    );
    expect(calls).toBe(0);
    expect(result.size).toBe(0);
  });
});
