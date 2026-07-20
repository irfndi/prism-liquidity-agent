import { describe, it, expect } from "vitest";
import {
  compareVersions,
  isValidVersion,
  githubReleaseToInfo,
  r2ManifestToInfo,
  getPlatformKey,
  R2_MANIFEST_PATHS,
} from "../engine/update-utils.js";

describe("update-utils", () => {
  describe("compareVersions", () => {
    it("returns 0 for equal versions", () => {
      expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
      expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    });

    it("returns negative when a < b", () => {
      expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
      expect(compareVersions("1.2.3", "1.3.0")).toBeLessThan(0);
      expect(compareVersions("1.2.3", "2.0.0")).toBeLessThan(0);
    });

    it("returns positive when a > b", () => {
      expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
      expect(compareVersions("1.3.0", "1.2.3")).toBeGreaterThan(0);
      expect(compareVersions("2.0.0", "1.2.3")).toBeGreaterThan(0);
    });

    it("throws on invalid versions (semver strictness)", () => {
      expect(() => compareVersions("not-a-version", "1.2.3")).toThrow();
      expect(() => compareVersions("1.2.3", "not-a-version")).toThrow();
    });

    it("orders canary versions by timestamp and against stable", () => {
      expect(
        compareVersions("0.0.32-canary.20260721T000001", "0.0.32-canary.20260720T000000"),
      ).toBeGreaterThan(0);
      expect(compareVersions("0.0.32-canary.20260720T000000", "0.0.31")).toBeGreaterThan(0);
      expect(compareVersions("0.0.32", "0.0.32-canary.20260720T000000")).toBeGreaterThan(0);
    });
  });

  describe("isValidVersion", () => {
    it("accepts valid semver strings", () => {
      expect(isValidVersion("1.2.3")).toBe(true);
      expect(isValidVersion("v1.2.3")).toBe(true);
      expect(isValidVersion("0.0.1")).toBe(true);
      expect(isValidVersion("10.20.30")).toBe(true);
    });

    it("rejects invalid version strings", () => {
      expect(isValidVersion("not-a-version")).toBe(false);
      expect(isValidVersion("")).toBe(false);
      expect(isValidVersion("1.2")).toBe(false);
      expect(isValidVersion("1")).toBe(false);
      expect(isValidVersion("1.2.3.4")).toBe(false);
    });

    it("accepts canary prerelease versions", () => {
      expect(isValidVersion("0.0.32-canary.20260720T000000")).toBe(true);
    });
  });

  describe("R2_MANIFEST_PATHS", () => {
    it("exposes the canary channel manifest path", () => {
      expect(R2_MANIFEST_PATHS.canary).toBe("releases/channel/canary.json");
    });
  });

  describe("githubReleaseToInfo", () => {
    it("maps GitHub release to ReleaseInfo correctly", () => {
      const release = {
        tag_name: "v1.2.3",
        html_url: "https://github.com/irfndi/prism-liquidity-agent/releases/tag/v1.2.3",
        body: "Release notes",
        published_at: "2024-01-01T00:00:00Z",
        prerelease: false,
        assets: [
          {
            name: "prism-v1.2.3.tar.gz",
            browser_download_url: "https://example.com/prism-v1.2.3.tar.gz",
          },
          {
            name: "prism-v1.2.3.tar.gz.sha256",
            browser_download_url: "https://example.com/prism-v1.2.3.tar.gz.sha256",
          },
          {
            name: "prism-v1.2.3.tar.gz.asc",
            browser_download_url: "https://example.com/prism-v1.2.3.tar.gz.asc",
          },
        ],
      };

      const info = githubReleaseToInfo(release, "stable");
      expect(info.version).toBe("v1.2.3");
      expect(info.channel).toBe("stable");
      expect(info.tarballUrl).toBe("https://example.com/prism-v1.2.3.tar.gz");
      expect(info.sha256Url).toBe("https://example.com/prism-v1.2.3.tar.gz.sha256");
      expect(info.signatureUrl).toBe("https://example.com/prism-v1.2.3.tar.gz.asc");
      expect(info.source).toBe("github");
    });

    it("handles missing assets gracefully", () => {
      const release = {
        tag_name: "v1.0.0",
        html_url: "https://example.com",
        body: "",
        published_at: "2024-01-01T00:00:00Z",
        prerelease: false,
        assets: [],
      };

      const info = githubReleaseToInfo(release, "beta");
      expect(info.tarballUrl).toBe("");
      expect(info.sha256Url).toBe("");
      expect(info.signatureUrl).toBe("");
      expect(info.channel).toBe("beta");
    });

    it("selects platform-specific bundle asset even when .sha256 appears first", () => {
      const platformKey = getPlatformKey();
      const release = {
        tag_name: "v1.2.3",
        html_url: "https://github.com/irfndi/prism-liquidity-agent/releases/tag/v1.2.3",
        body: "Release notes",
        published_at: "2024-01-01T00:00:00Z",
        prerelease: false,
        assets: [
          {
            name: "prism-v1.2.3.tar.gz",
            browser_download_url: "https://example.com/prism-v1.2.3.tar.gz",
          },
          {
            name: "prism-v1.2.3.tar.gz.sha256",
            browser_download_url: "https://example.com/prism-v1.2.3.tar.gz.sha256",
          },
          {
            name: `prism-v1.2.3-${platformKey}.tar.gz.sha256`,
            browser_download_url: `https://example.com/prism-v1.2.3-${platformKey}.tar.gz.sha256`,
          },
          {
            name: `prism-v1.2.3-${platformKey}.tar.gz`,
            browser_download_url: `https://example.com/prism-v1.2.3-${platformKey}.tar.gz`,
          },
        ],
      };

      const info = githubReleaseToInfo(release, "stable");
      expect(info.bundleUrl).toBe(`https://example.com/prism-v1.2.3-${platformKey}.tar.gz`);
      expect(info.bundleSha256Url).toBe(
        `https://example.com/prism-v1.2.3-${platformKey}.tar.gz.sha256`,
      );
      expect(info.tarballUrl).toBe("https://example.com/prism-v1.2.3.tar.gz");
      expect(info.sha256Url).toBe("https://example.com/prism-v1.2.3.tar.gz.sha256");
      expect(info.signatureUrl).toBe("");
    });
  });

  describe("r2ManifestToInfo", () => {
    it("maps R2 manifest to ReleaseInfo correctly", () => {
      const platformKey = getPlatformKey();
      const manifest = {
        version: "1.2.3",
        channel: "stable" as const,
        tarball_url: "https://r2.example.com/prism-v1.2.3.tar.gz",
        sha256_url: "https://r2.example.com/prism-v1.2.3.tar.gz.sha256",
        signature_url: "https://r2.example.com/prism-v1.2.3.tar.gz.asc",
        published_at: "2024-01-01T00:00:00Z",
        min_cli_version: "1.0.0",
        bundles: {
          [platformKey]: {
            url: "https://r2.example.com/prism-v1.2.3-darwin-arm64.tar.gz",
            sha256_url: "https://r2.example.com/prism-v1.2.3-darwin-arm64.tar.gz.sha256",
          },
        },
      };

      const info = r2ManifestToInfo(manifest);
      const bundle = manifest.bundles[platformKey]!;
      expect(info.version).toBe("1.2.3");
      expect(info.channel).toBe("stable");
      expect(info.tarballUrl).toBe("https://r2.example.com/prism-v1.2.3.tar.gz");
      expect(info.sha256Url).toBe("https://r2.example.com/prism-v1.2.3.tar.gz.sha256");
      expect(info.signatureUrl).toBe("https://r2.example.com/prism-v1.2.3.tar.gz.asc");
      expect(info.source).toBe("r2");
      expect(info.minCliVersion).toBe("1.0.0");
      expect(info.bundleUrl).toBe(bundle.url);
      expect(info.bundleSha256Url).toBe(bundle.sha256_url);
    });

    it("handles missing optional signature_url", () => {
      const platformKey = getPlatformKey();
      const manifest = {
        version: "1.0.0",
        channel: "dev" as const,
        tarball_url: "https://r2.example.com/prism-v1.0.0.tar.gz",
        sha256_url: "https://r2.example.com/prism-v1.0.0.tar.gz.sha256",
        published_at: "2024-01-01T00:00:00Z",
        min_cli_version: "1.0.0",
        bundles: {
          [platformKey]: {
            url: "https://r2.example.com/prism-v1.0.0-darwin-arm64.tar.gz",
            sha256_url: "https://r2.example.com/prism-v1.0.0-darwin-arm64.tar.gz.sha256",
          },
        },
      };

      const info = r2ManifestToInfo(manifest);
      const bundle = manifest.bundles[platformKey]!;
      expect(info.signatureUrl).toBe("");
      expect(info.channel).toBe("dev");
      expect(info.bundleUrl).toBe(bundle.url);
    });

    it("maps a canary manifest commit onto ReleaseInfo.commit", () => {
      const manifest = {
        version: "0.0.32-canary.20260720T000000",
        channel: "canary" as const,
        tarball_url: "https://r2.example.com/prism-canary.tar.gz",
        sha256_url: "https://r2.example.com/prism-canary.tar.gz.sha256",
        published_at: "2026-07-20T00:00:00Z",
        min_cli_version: "1.0.0",
        commit: "abcdef0123456789abcdef0123456789abcdef01",
      };

      const info = r2ManifestToInfo(manifest);
      expect(info.channel).toBe("canary");
      expect(info.commit).toBe("abcdef0123456789abcdef0123456789abcdef01");
    });

    it("yields an empty commit when the manifest omits it", () => {
      const manifest = {
        version: "1.0.0",
        channel: "stable" as const,
        tarball_url: "https://r2.example.com/prism-v1.0.0.tar.gz",
        sha256_url: "https://r2.example.com/prism-v1.0.0.tar.gz.sha256",
        published_at: "2024-01-01T00:00:00Z",
        min_cli_version: "1.0.0",
      };

      const info = r2ManifestToInfo(manifest);
      expect(info.commit).toBe("");
    });
  });
});
