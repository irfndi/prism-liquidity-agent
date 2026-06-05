import { Effect } from "effect";
import semver from "semver";

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
}

export interface R2Manifest {
  readonly version: string;
  readonly channel: "stable" | "beta" | "dev";
  readonly tarball_url: string;
  readonly sha256_url: string;
  readonly signature_url?: string;
  readonly published_at: string;
  readonly min_cli_version: string;
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

export const R2_PUBLIC_URL = "https://r2.prism-agent.com";
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

    const response = yield* Effect.tryPromise(() =>
      fetch(url, {
        headers: {
          "User-Agent": "prism-liquidity-agent",
          Accept: "application/json",
        },
      }),
    );

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      return yield* Effect.fail(
        new Error(`R2 manifest fetch error: ${response.status} ${response.statusText}`),
      );
    }

    const manifest = (yield* Effect.tryPromise(() => response.json())) as R2Manifest;
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

    const response = yield* Effect.tryPromise(() =>
      fetch(url, { headers }),
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
      const release = (yield* Effect.tryPromise(() => response.json())) as
        | GitHubRelease
        | undefined;
      return release ?? null;
    }

    const firstPageReleases = (yield* Effect.tryPromise(() => response.json())) as GitHubRelease[];

    const allReleases: GitHubRelease[] = Array.isArray(firstPageReleases)
      ? [...firstPageReleases]
      : [];

    const linkHeader = response.headers.get("link");
    const nextMatch = linkHeader ? linkHeader.match(/<([^>]+)>;\s*rel="next"/) : null;
    let pageUrl: string | null = nextMatch?.[1] ?? null;
    let pageCount = 1;
    const maxPages = 3;

    while (pageUrl !== null && pageCount < maxPages) {
      pageCount++;
      const pageHeaders: Record<string, string> = {
        "User-Agent": "prism-liquidity-agent",
        Accept: "application/vnd.github.v3+json",
      };
      if (token) {
        pageHeaders.Authorization = `Bearer ${token}`;
      }
      const pageResponse = yield* Effect.tryPromise(() =>
        fetch(pageUrl!, { headers: pageHeaders }),
      );

      if (!pageResponse.ok) {
        return yield* Effect.fail(
          new Error(`GitHub API error: ${pageResponse.status} ${pageResponse.statusText}`),
        );
      }

      const releases = (yield* Effect.tryPromise(() => pageResponse.json())) as GitHubRelease[];

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

export function githubReleaseToInfo(
  release: GitHubRelease,
  channel: "stable" | "beta" | "dev",
): ReleaseInfo {
  const tarballAsset = release.assets.find(
    (a) => a.name.endsWith(".tar.gz") && !a.name.endsWith(".sha256") && !a.name.endsWith(".asc"),
  );
  const sha256Asset = release.assets.find((a) => a.name.endsWith(".sha256"));
  const sigAsset = release.assets.find((a) => a.name.endsWith(".asc"));

  return {
    version: release.tag_name,
    channel,
    tarballUrl: tarballAsset?.browser_download_url ?? "",
    sha256Url: sha256Asset?.browser_download_url ?? "",
    signatureUrl: sigAsset?.browser_download_url ?? "",
    publishedAt: release.published_at,
    minCliVersion: "1.0.0",
    source: "github",
  };
}

export function r2ManifestToInfo(manifest: R2Manifest): ReleaseInfo {
  return {
    version: manifest.version,
    channel: manifest.channel,
    tarballUrl: manifest.tarball_url,
    sha256Url: manifest.sha256_url,
    signatureUrl: manifest.signature_url ?? "",
    publishedAt: manifest.published_at,
    minCliVersion: manifest.min_cli_version,
    source: "r2",
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

    const ghRelease = yield* fetchGitHubRelease(repo, channel, token);
    if (!ghRelease) {
      return null;
    }
    return githubReleaseToInfo(ghRelease, channel);
  });
}
