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

export interface GitHubRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly body: string;
  readonly published_at: string;
  readonly prerelease: boolean;
}

export function fetchLatestRelease(
  repo: string,
  channel: "stable" | "beta" | "dev",
): Effect.Effect<GitHubRelease | null | undefined, Error> {
  return Effect.gen(function* () {
    const url =
      channel === "stable"
        ? `https://api.github.com/repos/${repo}/releases/latest`
        : `https://api.github.com/repos/${repo}/releases`;

    const response = yield* Effect.tryPromise(() =>
      fetch(url, {
        headers: {
          "User-Agent": "prism-liquidity-agent",
          Accept: "application/vnd.github.v3+json",
        },
      }),
    );

    if (response.status === 403 || response.status === 429) {
      const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
      const retryAfter = response.headers.get("retry-after");
      if (rateLimitRemaining === "0") {
        const msg = retryAfter
          ? `GitHub API rate limit exceeded. Retry after ${retryAfter}s.`
          : "GitHub API rate limit exceeded. Try again later.";
        return yield* Effect.fail(new Error(msg));
      }
      if (response.status === 429) {
        const msg = retryAfter
          ? `GitHub API secondary rate limit. Retry after ${retryAfter}s.`
          : "GitHub API secondary rate limit. Try again later.";
        return yield* Effect.fail(new Error(msg));
      }
    }

    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`GitHub API error: ${response.status} ${response.statusText}`),
      );
    }

    if (channel === "stable") {
      const release = (yield* Effect.tryPromise(() =>
        response.json(),
      )) as GitHubRelease | undefined;
      return release ?? null;
    }

    const allReleases: GitHubRelease[] = [];
    let pageUrl: string | null = url;
    let pageCount = 0;
    const maxPages = 3;

    while (pageUrl !== null && pageCount < maxPages) {
      pageCount++;
      const pageResponse = yield* Effect.tryPromise(() =>
        fetch(pageUrl!, {
          headers: {
            "User-Agent": "prism-liquidity-agent",
            Accept: "application/vnd.github.v3+json",
          },
        }),
      );

      if (!pageResponse.ok) {
        return yield* Effect.fail(
          new Error(`GitHub API error: ${pageResponse.status} ${pageResponse.statusText}`),
        );
      }

      const releases = (yield* Effect.tryPromise(() =>
        pageResponse.json(),
      )) as GitHubRelease[];

      if (!Array.isArray(releases) || releases.length === 0) {
        break;
      }

      allReleases.push(...releases);

      const linkHeader = pageResponse.headers.get("link");
      if (linkHeader) {
        const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        pageUrl = nextMatch?.[1] ?? null;
      } else {
        pageUrl = null;
      }
    }

    if (allReleases.length === 0) {
      return null;
    }

    const filtered =
      channel === "beta"
        ? allReleases.filter((r) => r.prerelease)
        : allReleases;

    if (filtered.length === 0) {
      return null;
    }

    return filtered[0]!;
  });
}
