import { Effect } from "effect";

export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const av = aa[i] || 0;
    const bv = bb[i] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export function isValidVersion(version: string): boolean {
  return /^v?[\d.]+$/.test(version);
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
    // For stable channel, /releases/latest works and never returns prereleases
    // For beta/dev, we need to fetch all releases and find the first matching one
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

    if (response.status === 403) {
      const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
      if (rateLimitRemaining === "0") {
        return yield* Effect.fail(
          new Error("GitHub API rate limit exceeded. Try again later."),
        );
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

    // For beta/dev: fetch all releases, filter by prerelease status
    const releases = (yield* Effect.tryPromise(() =>
      response.json(),
    )) as GitHubRelease[];

    if (!Array.isArray(releases) || releases.length === 0) {
      return null;
    }

    // beta = prerelease, dev = all releases (including stable)
    const filtered =
      channel === "beta"
        ? releases.filter((r) => r.prerelease)
        : releases; // dev channel gets everything

    if (filtered.length === 0) {
      return null;
    }

    return filtered[0]; // Most recent
  });
}
