import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseGoPlusEntry,
  goPlusHardRiskReasons,
  consultGoPlusTokenSecurity,
  clearGoPlusCache,
  goPlusConfigured,
  type GoPlusConfigLike,
  type GoPlusFetchLike,
} from "../engine/goplus-token-security.js";

// All tests inject fetchImpl — NO live network. The GoPlus auth + Solana
// token_security contract was live-verified against docs.gopluslabs.io; these
// lock the parse + cache + fail-open behavior against that fixed shape.

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const CONFIG: GoPlusConfigLike = {
  goPlusApiKey: "app-key",
  goPlusApiSecret: "app-secret",
  goPlusTokenRiskEnabled: true,
  goPlusTokenRiskCacheTtlMin: 30,
};

/** Routes a POST /api/v1/token (access token) and GET .../token_security by URL. */
function goPlusFetch<T>(securityResult: T): GoPlusFetchLike {
  return async (input) => {
    // SAFETY: The value is intentionally opaque at this boundary and is validated by the enclosing parser or schema before domain use.
    const url = String(input as unknown);
    if (url.includes("/api/v1/token")) {
      return new Response(
        JSON.stringify({ result: { access_token: "test-token", expires_in: 3600 } }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ result: securityResult }), { status: 200 });
  };
}

function failFetch(): GoPlusFetchLike {
  return async () => {
    throw new Error("network down");
  };
}

beforeEach(() => {
  clearGoPlusCache();
});

describe("goplus-token-security", () => {
  it("(1) parses hard-risk flags and trusted status from a payload", () => {
    const parsed = parseGoPlusEntry(USDC_MINT, {
      none_transferable: "1",
      closable: { status: "1" },
      balance_mutable_authority: { status: "1" },
      freezable: { status: "0" },
      mintable: { status: "1" },
      transfer_hook: ["hooked"],
      trusted_token: 0,
    });
    expect(parsed).not.toBeNull();
    const signal = parsed!.signal;
    expect(signal.noneTransferable).toBe(true);
    expect(signal.closable).toBe(true);
    expect(signal.balanceMutable).toBe(true);
    expect(signal.freezable).toBe(false);
    expect(signal.mintable).toBe(true);
    expect(signal.hasTransferHook).toBe(true);
    expect(signal.trusted).toBe(false);
  });

  it("(2) a non-object entry parses to null (never throws)", () => {
    expect(parseGoPlusEntry(USDC_MINT, "not-an-object")).toBeNull();
    expect(parseGoPlusEntry(USDC_MINT, null)).toBeNull();
  });

  it("(3) hard-risk reasons cover only the three unambiguous findings", () => {
    expect(
      goPlusHardRiskReasons({
        noneTransferable: true,
        closable: true,
        balanceMutable: true,
        freezable: false,
        mintable: false,
        hasTransferHook: false,
        trusted: null,
      }),
    ).toEqual([
      "non-transferable (honeypot risk)",
      "closable program (assets can be eliminated)",
      "mutable balance authority",
    ]);
    expect(
      goPlusHardRiskReasons({
        noneTransferable: false,
        closable: false,
        balanceMutable: false,
        freezable: true,
        mintable: true,
        hasTransferHook: true,
        trusted: false,
      }),
    ).toEqual([]);
  });

  it("(4) configured requires BOTH key and secret", () => {
    expect(goPlusConfigured(CONFIG)).toBe(true);
    expect(goPlusConfigured({ ...CONFIG, goPlusApiKey: "" })).toBe(false);
    expect(goPlusConfigured({ ...CONFIG, goPlusApiSecret: "" })).toBe(false);
    expect(goPlusConfigured({ goPlusTokenRiskEnabled: true })).toBe(false);
  });

  it("(5) consult resolves signals and signs + authorizes the two requests", async () => {
    const requests: Array<{ url: string; method: string; init: RequestInit | undefined }> = [];
    const capturingFetch: GoPlusFetchLike = async (input, init) => {
      // SAFETY: The value is intentionally opaque at this boundary and is validated by the enclosing parser or schema before domain use.
      const url = String(input as unknown);
      requests.push({ url, method: init?.method ?? "GET", init });
      if (url.includes("/api/v1/token")) {
        return new Response(
          JSON.stringify({ result: { access_token: "Bearer tok", expires_in: 3600 } }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ result: { [USDC_MINT]: { none_transferable: "1" } } }), {
        status: 200,
      });
    };

    const result = await consultGoPlusTokenSecurity([USDC_MINT], CONFIG, {
      fetchImpl: capturingFetch,
    });

    expect(result.get(USDC_MINT)?.noneTransferable).toBe(true);

    // First request is the signed access-token POST.
    const authReq = requests[0]!;
    expect(authReq.method).toBe("POST");
    expect(authReq.url).toContain("/api/v1/token");
    // SAFETY: The preceding branch or fixture establishes the asserted primitive type before this operation.
    const authBody = JSON.parse(authReq.init?.body as string) as {
      app_key: string;
      sign: string;
      time: number;
    };
    expect(authBody.app_key).toBe("app-key");
    expect(authBody.time).toBeGreaterThan(0);
    expect(authBody.sign).toMatch(/^[0-9a-f]{40}$/); // sha1 hex

    // Second request sends the access token VERBATIM — GoPlus already includes
    // the "Bearer " scheme in the token, so it must not be prepended twice.
    const secReq = requests[1]!;
    expect(secReq.url).toContain("/api/v1/solana/token_security");
    expect(secReq.url).toContain(encodeURIComponent(USDC_MINT));
    expect(headerRecord(secReq.init)).toHaveProperty("authorization", "Bearer tok");
  });

  it("(6) consult never throws on fetch failure and serves stale cache", async () => {
    await consultGoPlusTokenSecurity([USDC_MINT], CONFIG, {
      fetchImpl: goPlusFetch({ [USDC_MINT]: { none_transferable: "1" } }),
    });
    const unknownMint = "UnknownMint1111111111111111111111111111111";
    const stale = await consultGoPlusTokenSecurity([USDC_MINT, unknownMint], CONFIG, {
      fetchImpl: failFetch(),
    });
    expect(stale.get(USDC_MINT)?.noneTransferable).toBe(true);
    expect(stale.has(unknownMint)).toBe(false);

    clearGoPlusCache();
    const empty = await consultGoPlusTokenSecurity([unknownMint], CONFIG, {
      fetchImpl: failFetch(),
    });
    expect(empty.size).toBe(0);
  });

  it("(7) disabled config and unset keys perform zero fetches", async () => {
    let calls = 0;
    const countingFetch: GoPlusFetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify({ result: {} }), { status: 200 });
    };

    const disabled = await consultGoPlusTokenSecurity(
      [USDC_MINT],
      {
        ...CONFIG,
        goPlusTokenRiskEnabled: false,
      },
      { fetchImpl: countingFetch },
    );
    expect(disabled.size).toBe(0);

    const noSecret = await consultGoPlusTokenSecurity(
      [USDC_MINT],
      {
        ...CONFIG,
        goPlusApiSecret: "",
      },
      { fetchImpl: countingFetch },
    );
    expect(noSecret.size).toBe(0);

    expect(calls).toBe(0);
  });

  it("(8) two consults within the TTL perform one access-token + one security round", async () => {
    let tokenCalls = 0;
    let securityCalls = 0;
    const countingFetch: GoPlusFetchLike = async (input) => {
      // SAFETY: The value is intentionally opaque at this boundary and is validated by the enclosing parser or schema before domain use.
      const url = String(input as unknown);
      if (url.includes("/api/v1/token")) {
        tokenCalls += 1;
        return new Response(JSON.stringify({ result: { access_token: "tok", expires_in: 3600 } }), {
          status: 200,
        });
      }
      securityCalls += 1;
      return new Response(JSON.stringify({ result: { [USDC_MINT]: { none_transferable: "1" } } }), {
        status: 200,
      });
    };

    await consultGoPlusTokenSecurity([USDC_MINT], CONFIG, { fetchImpl: countingFetch });
    await consultGoPlusTokenSecurity([USDC_MINT], CONFIG, { fetchImpl: countingFetch });

    expect(tokenCalls).toBe(1);
    expect(securityCalls).toBe(1);
  });

  it("(9) the cached access token is reused before expiry and re-fetched after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      const mintA = USDC_MINT;
      const mintB = "MintB1111111111111111111111111111111111111";
      const mintC = "MintC1111111111111111111111111111111111111";
      let tokenCalls = 0;
      let securityCalls = 0;
      const countingFetch: GoPlusFetchLike = async (input) => {
        // SAFETY: The value is intentionally opaque at this boundary and is validated by the enclosing parser or schema before domain use.
        const url = String(input as unknown);
        if (url.includes("/api/v1/token")) {
          tokenCalls += 1;
          return new Response(
            JSON.stringify({ result: { access_token: "tok", expires_in: 3600 } }),
            { status: 200 },
          );
        }
        securityCalls += 1;
        return new Response(JSON.stringify({ result: { [mintA]: {}, [mintB]: {}, [mintC]: {} } }), {
          status: 200,
        });
      };

      await consultGoPlusTokenSecurity([mintA], CONFIG, { fetchImpl: countingFetch });
      expect(tokenCalls).toBe(1);
      expect(securityCalls).toBe(1);

      // A NEW mint before token expiry reuses the cached access token.
      await consultGoPlusTokenSecurity([mintB], CONFIG, { fetchImpl: countingFetch });
      expect(tokenCalls).toBe(1);
      expect(securityCalls).toBe(2);

      // Past the access-token expiry, a NEW mint forces a fresh token fetch.
      vi.setSystemTime(t0 + 3600 * 1000);
      await consultGoPlusTokenSecurity([mintC], CONFIG, { fetchImpl: countingFetch });
      expect(tokenCalls).toBe(2);
      expect(securityCalls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

function headerRecord(init: RequestInit | undefined): object {
  const headers = init?.headers;
  return headers !== null &&
    headers !== undefined &&
    !Array.isArray(headers) &&
    !(headers instanceof Headers)
    ? headers
    : {};
}
