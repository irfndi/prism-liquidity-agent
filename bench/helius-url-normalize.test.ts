import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeHeliusUrl } from "../engine/config-service.js";

describe("normalizeHeliusUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns non-Helius URLs unchanged", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://api.mainnet-beta.solana.com",
      "my-key",
    );
    expect(url).toBe("https://api.mainnet-beta.solana.com");
    expect(normalized).toBe(false);
  });

  it("returns empty strings unchanged", () => {
    const { url, normalized } = normalizeHeliusUrl("", "my-key");
    expect(url).toBe("");
    expect(normalized).toBe(false);
  });

  it("replaces api_key= with api-key= in Helius URLs", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://mainnet.helius-rpc.com/?api_key=abc-123",
      "abc-123",
    );
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=abc-123");
    expect(normalized).toBe(true);
  });

  it("replaces all occurrences of api_key=", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://mainnet.helius-rpc.com/?api_key=abc&api_key=def",
      "abc",
    );
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=abc&api-key=def");
    expect(normalized).toBe(true);
  });

  it("leaves correct api-key= URLs unchanged", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://mainnet.helius-rpc.com/?api-key=abc-123",
      "abc-123",
    );
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=abc-123");
    expect(normalized).toBe(false);
  });

  it("appends api-key when Helius URL is missing it entirely", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://mainnet.helius-rpc.com/",
      "my-secret-key",
    );
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=my-secret-key");
    expect(normalized).toBe(true);
  });

  it("appends with & when URL already has query params", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://mainnet.helius-rpc.com/?foo=bar",
      "my-key",
    );
    expect(url).toBe("https://mainnet.helius-rpc.com/?foo=bar&api-key=my-key");
    expect(normalized).toBe(true);
  });

  it("does not append api-key when no key is configured", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://mainnet.helius-rpc.com/",
      "",
    );
    expect(url).toBe("https://mainnet.helius-rpc.com/");
    expect(normalized).toBe(false);
  });

  it("trims whitespace from URLs", () => {
    const { url } = normalizeHeliusUrl(
      "  https://mainnet.helius-rpc.com/?api-key=abc  ",
      "abc",
    );
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=abc");
  });
});
