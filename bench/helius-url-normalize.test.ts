import { describe, it, expect, vi, afterEach } from "vitest";
import { normalizeHeliusUrl } from "../engine/config-service.js";

describe("normalizeHeliusUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns non-Helius URLs unchanged", () => {
    const { url, normalized } = normalizeHeliusUrl("https://api.mainnet-beta.solana.com", "my-key");
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
    const { url, normalized } = normalizeHeliusUrl("https://mainnet.helius-rpc.com/", "");
    expect(url).toBe("https://mainnet.helius-rpc.com/");
    expect(normalized).toBe(false);
  });

  it("trims whitespace from URLs", () => {
    const { url } = normalizeHeliusUrl("  https://mainnet.helius-rpc.com/?api-key=abc  ", "abc");
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=abc");
  });

  it("replaces empty api-key= value with the configured key", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://mainnet.helius-rpc.com/?api-key=",
      "my-real-key",
    );
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=my-real-key");
    expect(normalized).toBe(true);
  });

  it("replaces empty api-key= when followed by other params", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://mainnet.helius-rpc.com/?api-key=&foo=bar",
      "my-real-key",
    );
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=my-real-key&foo=bar");
    expect(normalized).toBe(true);
  });

  it("does not modify empty api-key= when no key is configured", () => {
    const { url, normalized } = normalizeHeliusUrl("https://mainnet.helius-rpc.com/?api-key=", "");
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=");
    expect(normalized).toBe(false);
  });

  it("rejects attacker domains containing helius-rpc.com as substring", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://helius-rpc.com.attacker.example/",
      "my-secret-key",
    );
    expect(url).toBe("https://helius-rpc.com.attacker.example/");
    expect(normalized).toBe(false);
  });

  it("rejects URLs with helius-rpc.com in the path, not the hostname", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "https://evil.com/helius-rpc.com/proxy",
      "my-secret-key",
    );
    expect(url).toBe("https://evil.com/helius-rpc.com/proxy");
    expect(normalized).toBe(false);
  });

  it("accepts subdomains of helius-rpc.com", () => {
    const { url, normalized } = normalizeHeliusUrl("https://mainnet.helius-rpc.com/", "my-key");
    expect(url).toBe("https://mainnet.helius-rpc.com/?api-key=my-key");
    expect(normalized).toBe(true);
  });

  it("handles invalid URLs gracefully", () => {
    const { url, normalized } = normalizeHeliusUrl("not-a-url", "my-key");
    expect(url).toBe("not-a-url");
    expect(normalized).toBe(false);
  });

  it("refuses to append credentials to http:// Helius URLs", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "http://mainnet.helius-rpc.com/",
      "my-secret-key",
    );
    expect(url).toBe("http://mainnet.helius-rpc.com/");
    expect(normalized).toBe(false);
  });

  it("still normalizes api_key= to api-key= on http:// URLs without appending the key", () => {
    const { url, normalized } = normalizeHeliusUrl(
      "http://mainnet.helius-rpc.com/?api_key=existing",
      "my-secret-key",
    );
    expect(url).toBe("http://mainnet.helius-rpc.com/?api_key=existing");
    expect(normalized).toBe(false);
  });
});
