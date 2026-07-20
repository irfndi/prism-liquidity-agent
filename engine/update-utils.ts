import { Effect } from "effect";
import semver from "semver";
import path from "path";

export function getVersionAgnosticInstallDir(installDir: string): string {
  const normalized = path.normalize(installDir);
  const name = path.basename(normalized);
  const match = /^(prism(?:-dlmm|-liquidity-agent)?)-v\d+\.\d+\.\d+(?:[-+].+)?$/.exec(name);
  const prefix = match?.[1];
  return prefix ? path.join(path.dirname(normalized), prefix) : normalized;
}

function tryNetwork<T>(promise: () => Promise<T>, description: string): Effect.Effect<T, Error> {
  return Effect.tryPromise({
    try: promise,
    catch: (error) =>
      new Error(`${description}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      }),
  });
}

export function compareVersions(a: string, b: string): number {
  const cleanA = semver.clean(a) || a;
  const cleanB = semver.clean(b) || b;
  return semver.compare(cleanA, cleanB);
}

export function isValidVersion(version: string): boolean {
  const clean = semver.clean(version);
  return clean !== null && semver.valid(clean) !== null;
}

export interface ReleaseInfo {
  readonly version: string;
  readonly channel: "stable" | "beta" | "dev";
  readonly tarballUrl: string;
  readonly sha256Url: string;
  readonly signatureUrl: string;
  readonly publishedAt: string;
  readonly minCliVersion: string;
  readonly source: "r2" | "github";
  readonly bundleUrl: string;
  readonly bundleSha256Url: string;
}

export interface BundleManifest {
  readonly url: string;
  readonly sha256_url: string;
}

export interface R2Manifest {
  readonly version: string;
  readonly channel: "stable" | "beta" | "dev";
  readonly tarball_url: string;
  readonly sha256_url: string;
  readonly signature_url?: string;
  readonly published_at: string;
  readonly min_cli_version: string;
  readonly bundles?: Record<string, BundleManifest>;
}

export interface GitHubRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly body: string;
  readonly published_at: string;
  readonly prerelease: boolean;
  readonly assets: Array<{
    name: string;
    browser_download_url: string;
  }>;
}

export const R2_PUBLIC_URL = "https://pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev";
export const R2_RELEASES_BUCKET = "prism-backups";
export const R2_MANIFEST_PATHS: Record<"stable" | "beta" | "dev", string> = {
  stable: "releases/latest.json",
  beta: "releases/channel/beta.json",
  dev: "releases/channel/dev.json",
};

export function fetchR2Manifest(
  channel: "stable" | "beta" | "dev",
  r2PublicUrl: string = R2_PUBLIC_URL,
): Effect.Effect<R2Manifest | null, Error> {
  return Effect.gen(function* () {
    const path = R2_MANIFEST_PATHS[channel];
    const url = `${r2PublicUrl}/${path}`;

    const response = yield* tryNetwork(
      () =>
        fetch(url, {
          headers: {
            "User-Agent": "prism-liquidity-agent",
            Accept: "application/json",
          },
        }),
      `Failed to fetch R2 manifest from ${url}`,
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      return yield* Effect.fail(
        new Error(`R2 manifest fetch error: ${response.status} ${response.statusText}`),
      );
    }

    const manifest = (yield* tryNetwork(
      () => response.json(),
      "Failed to parse R2 manifest JSON",
    )) as R2Manifest;
    return manifest;
  });
}

export function fetchGitHubRelease(
  repo: string,
  channel: "stable" | "beta" | "dev",
  token?: string,
): Effect.Effect<GitHubRelease | null, Error> {
  return Effect.gen(function* () {
    const url =
      channel === "stable"
        ? `https://api.github.com/repos/${repo}/releases/latest`
        : `https://api.github.com/repos/${repo}/releases`;

    const headers: Record<string, string> = {
      "User-Agent": "prism-liquidity-agent",
      Accept: "application/vnd.github.v3+json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = yield* tryNetwork(
      () => fetch(url, { headers }),
      `Failed to fetch GitHub release from ${url}`,
    );

    if (response.status === 403 || response.status === 429) {
      const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
      const retryAfter = response.headers.get("retry-after");
      if (rateLimitRemaining === "0" || response.status === 429) {
        const msg = retryAfter
          ? `GitHub API rate limit exceeded. Retry after ${retryAfter}s.`
          : "GitHub API rate limit exceeded. Try again later.";
        return yield* Effect.fail(new Error(msg));
      }
    }

    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`GitHub API error: ${response.status} ${response.statusText}`),
      );
    }

    if (channel === "stable") {
      const release = (yield* tryNetwork(
        () => response.json(),
        "Failed to parse GitHub release JSON",
      )) as GitHubRelease | undefined;
      return release ?? null;
    }

    const firstPageReleases = (yield* tryNetwork(
      () => response.json(),
      "Failed to parse GitHub releases JSON",
    )) as GitHubRelease[];

    const allReleases: GitHubRelease[] = Array.isArray(firstPageReleases)
      ? [...firstPageReleases]
      : [];

    const linkHeader = response.headers.get("link");
    const nextMatch = linkHeader ? linkHeader.match(/<([^>]+)>;\s*rel="next"/) : null;
    let pageUrl: string | null = nextMatch?.[1] ?? null;
    let pageCount = 1;
    const maxPages = 3;

    while (pageUrl !== null && pageCount < maxPages) {
      // Never forward credentials to non-GitHub origins (Link header spoofing).
      const pageOrigin = new URL(pageUrl).origin;
      if (pageOrigin !== "https://api.github.com") {
        break;
      }

      pageCount++;
      const pageHeaders: Record<string, string> = {
        "User-Agent": "prism-liquidity-agent",
        Accept: "application/vnd.github.v3+json",
      };
      if (token) {
        pageHeaders.Authorization = `Bearer ${token}`;
      }
      const pageResponse = yield* tryNetwork(
        () => fetch(pageUrl!, { headers: pageHeaders }),
        "Failed to fetch GitHub releases page",
      );

      if (!pageResponse.ok) {
        return yield* Effect.fail(
          new Error(`GitHub API error: ${pageResponse.status} ${pageResponse.statusText}`),
        );
      }

      const releases = (yield* tryNetwork(
        () => pageResponse.json(),
        "Failed to parse GitHub releases page JSON",
      )) as GitHubRelease[];

      if (!Array.isArray(releases) || releases.length === 0) {
        break;
      }

      allReleases.push(...releases);

      const nextLink = pageResponse.headers.get("link");
      const nextPageMatch = nextLink ? nextLink.match(/<([^>]+)>;\s*rel="next"/) : null;
      pageUrl = nextPageMatch?.[1] ?? null;
    }

    if (allReleases.length === 0) {
      return null;
    }

    const filtered = channel === "beta" ? allReleases.filter((r) => r.prerelease) : allReleases;

    if (filtered.length === 0) {
      return null;
    }

    return filtered[0]!;
  });
}

export function getPlatformKey(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${os}-${arch}`;
}

export function githubReleaseToInfo(
  release: GitHubRelease,
  channel: "stable" | "beta" | "dev",
): ReleaseInfo {
  const platformKey = getPlatformKey();
  const tarballAsset = release.assets.find(
    (a) => a.name.endsWith(".tar.gz") && !a.name.endsWith(".sha256") && !a.name.endsWith(".asc"),
  );
  const sha256Asset = tarballAsset
    ? release.assets.find((a) => a.name === `${tarballAsset.name}.sha256`)
    : release.assets.find((a) => a.name.endsWith(".sha256"));
  const sigAsset = release.assets.find((a) => a.name.endsWith(".asc"));
  const bundleAsset = release.assets.find(
    (a) =>
      a.name.startsWith(`prism-v${release.tag_name.replace(/^v/, "")}-${platformKey}`) &&
      a.name.endsWith(".tar.gz") &&
      !a.name.endsWith(".sha256"),
  );
  const bundleSha256Asset = release.assets.find(
    (a) =>
      a.name.startsWith(`prism-v${release.tag_name.replace(/^v/, "")}-${platformKey}`) &&
      a.name.endsWith(".sha256"),
  );

  return {
    version: release.tag_name,
    channel,
    tarballUrl: tarballAsset?.browser_download_url ?? "",
    sha256Url: sha256Asset?.browser_download_url ?? "",
    signatureUrl: sigAsset?.browser_download_url ?? "",
    publishedAt: release.published_at,
    minCliVersion: "1.0.0",
    source: "github",
    bundleUrl: bundleAsset?.browser_download_url ?? "",
    bundleSha256Url: bundleSha256Asset?.browser_download_url ?? "",
  };
}

export function r2ManifestToInfo(manifest: R2Manifest): ReleaseInfo {
  const platformKey = getPlatformKey();
  const bundle = manifest.bundles?.[platformKey];
  return {
    version: manifest.version,
    channel: manifest.channel,
    tarballUrl: manifest.tarball_url,
    sha256Url: manifest.sha256_url,
    signatureUrl: manifest.signature_url ?? "",
    publishedAt: manifest.published_at,
    minCliVersion: manifest.min_cli_version,
    source: "r2",
    bundleUrl: bundle?.url ?? "",
    bundleSha256Url: bundle?.sha256_url ?? "",
  };
}

export function fetchLatestRelease(
  repo: string,
  channel: "stable" | "beta" | "dev",
  r2PublicUrl?: string,
  token?: string,
): Effect.Effect<ReleaseInfo | null, Error> {
  return Effect.gen(function* () {
    const r2Result = yield* Effect.either(fetchR2Manifest(channel, r2PublicUrl));

    if (r2Result._tag === "Right" && r2Result.right) {
      const manifest = r2Result.right;
      if (isValidVersion(manifest.version)) {
        return r2ManifestToInfo(manifest);
      }
    }
    const r2Error = r2Result._tag === "Left" ? r2Result.left : null;

    const ghResult = yield* Effect.either(fetchGitHubRelease(repo, channel, token));
    if (ghResult._tag === "Right") {
      if (ghResult.right) {
        return githubReleaseToInfo(ghResult.right, channel);
      }
      return null;
    }

    const ghError = ghResult.left;
    if (r2Error) {
      return yield* Effect.fail(
        new Error(`Update check failed. R2: ${r2Error.message}; GitHub: ${ghError.message}`),
      );
    }
    return yield* Effect.fail(new Error(`Update check failed: ${ghError.message}`));
  });
}
