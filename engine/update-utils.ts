import { Effect } from "effect";
import semver from "semver";
import path from "path";

/** Parse a URL and return its origin; null when malformed. */
function safeUrlOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

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

/** GitHub API request headers; Bearer auth only when a token is configured. */
function buildGithubHeaders(token?: string): FetchHeaders {
  const headers: FetchHeaders = {
    "User-Agent": "prism-liquidity-agent",
    Accept: "application/vnd.github.v3+json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Extract the `rel="next"` URL from a GitHub Link header (null when absent). */
function parseNextLink(linkHeader: string | null): string | null {
  const match = linkHeader ? linkHeader.match(/<([^>]+)>;\s*rel="next"/) : null;
  return match?.[1] ?? null;
}

/** Fail when GitHub rate-limits this client (403 with exhausted quota, or 429).
 *  A 403 without exhausted quota falls through to the generic !ok handling. */
function failOnGithubRateLimit(response: Response): Effect.Effect<void, Error> {
  if (response.status !== 403 && response.status !== 429) {
    return Effect.void;
  }
  const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  if (rateLimitRemaining !== "0" && response.status !== 429) {
    return Effect.void;
  }
  const msg = retryAfter
    ? `GitHub API rate limit exceeded. Retry after ${retryAfter}s.`
    : "GitHub API rate limit exceeded. Try again later.";
  return Effect.fail(new Error(msg));
}

/** Release guard: a GitHub release payload must carry a string tag_name. Malformed shapes fail soft (Effect channel) so the update check fails with a named cause — a throw here would escape as an Effect defect and crash the update check. */
function isGitHubRelease(value: GitHubRelease | null): value is GitHubRelease {
  if (value === null || !("tag_name" in value)) return false;
  return Object.prototype.toString.call(value.tag_name) === "[object String]";
}

/** Fail on malformed GitHub payloads so the update check names the cause; pass through null and valid releases. */
function requireValidRelease(
  candidate: GitHubRelease | null,
  url: string,
): Effect.Effect<GitHubRelease | null, Error> {
  if (candidate !== null && !isGitHubRelease(candidate)) {
    return Effect.fail(new Error(`Unexpected GitHub release shape from ${url}`));
  }
  return Effect.succeed(candidate);
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
  readonly channel: "stable" | "beta" | "dev" | "canary";
  readonly tarballUrl: string;
  readonly sha256Url: string;
  readonly signatureUrl: string;
  readonly publishedAt: string;
  readonly minCliVersion: string;
  readonly bundleUrl: string;
  readonly bundleSha256Url: string;
  readonly commit: string;
}

export interface BundleManifest {
  readonly url: string;
  readonly sha256_url: string;
}

/** The `manifest.json` format the canary pipeline publishes as a GitHub
 *  release asset. (Cloudflare R2 is deprecated for distribution as of
 *  2026-09-23 — account billing; the bucket itself is untouched.) */
export interface ChannelManifest {
  readonly version: string;
  readonly channel: "stable" | "beta" | "dev" | "canary";
  readonly tarball_url: string;
  readonly sha256_url: string;
  readonly signature_url?: string;
  readonly published_at: string;
  readonly min_cli_version: string;
  readonly bundles?: Record<string, BundleManifest>;
  readonly commit?: string;
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

/** Outbound request headers (valid HeadersInit value form). */
/** GitHub API headers: identity + version accept always sent; Bearer auth only when a token is configured. */
type FetchHeaders = {
  "User-Agent": string;
  Accept: string;
  Authorization?: string;
};
/** Rolling GitHub prerelease tag that hosts the canary build and its
 *  `manifest.json` asset — CI publishes assets first and uploads the
 *  manifest LAST, so the manifest's appearance IS the pointer flip. */
export const CANARY_RELEASE_TAG = "canary";

export function fetchGitHubRelease(
  repo: string,
  channel: "stable" | "beta" | "dev" | "canary",
  token?: string,
): Effect.Effect<GitHubRelease | null, Error> {
  return Effect.gen(function* () {
    const url =
      channel === "stable"
        ? `https://api.github.com/repos/${repo}/releases/latest`
        : `https://api.github.com/repos/${repo}/releases`;

    const response = yield* tryNetwork(
      () => fetch(url, { headers: buildGithubHeaders(token) }),
      `Failed to fetch GitHub release from ${url}`,
    );
    yield* failOnGithubRateLimit(response);

    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`GitHub API error: ${response.status} ${response.statusText}`),
      );
    }

    if (channel === "stable") {
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      const release = (yield* tryNetwork(
        () => response.json(),
        "Failed to parse GitHub release JSON",
      )) as GitHubRelease | undefined;
      return yield* requireValidRelease(release ?? null, url);
    }

    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    const firstPageReleases = (yield* tryNetwork(
      () => response.json(),
      "Failed to parse GitHub releases JSON",
    )) as GitHubRelease[];
    const firstPage: GitHubRelease[] = Array.isArray(firstPageReleases)
      ? [...firstPageReleases]
      : [];

    const allReleases = yield* fetchAllReleasePages(
      firstPage,
      parseNextLink(response.headers.get("link")),
      token,
    );
    const filtered = channel === "beta" ? allReleases.filter((r) => r.prerelease) : allReleases;
    return yield* requireValidRelease(filtered[0] ?? null, url);
  });
}

/** Follow GitHub's Link-header pagination up to 3 pages total, collecting
 *  releases. Fails on any non-ok page; stops on an empty/invalid page or a
 *  next-URL pointing outside api.github.com (Link-header spoofing guard). */
function fetchAllReleasePages(
  firstPage: ReadonlyArray<GitHubRelease>,
  nextLink: string | null,
  token?: string,
): Effect.Effect<GitHubRelease[], Error> {
  return Effect.gen(function* () {
    const allReleases: GitHubRelease[] = [...firstPage];
    const maxPages = 3;
    let pageCount = 1;
    let pageUrl = nextLink;

    while (pageUrl !== null && pageCount < maxPages) {
      // Never forward credentials to non-GitHub origins (Link header spoofing).
      const pageOrigin = safeUrlOrigin(pageUrl);
      if (pageOrigin === null || pageOrigin !== "https://api.github.com") {
        break;
      }
      pageCount++;
      const pageResponse = yield* tryNetwork(
        () => fetch(pageUrl!, { headers: buildGithubHeaders(token) }),
        "Failed to fetch GitHub releases page",
      );
      if (!pageResponse.ok) {
        return yield* Effect.fail(
          new Error(`GitHub API error: ${pageResponse.status} ${pageResponse.statusText}`),
        );
      }

      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
      const releases = (yield* tryNetwork(
        () => pageResponse.json(),
        "Failed to parse GitHub releases page JSON",
      )) as GitHubRelease[];

      if (!Array.isArray(releases) || releases.length === 0) {
        break;
      }
      allReleases.push(...releases);
      pageUrl = parseNextLink(pageResponse.headers.get("link"));
    }

    return allReleases;
  });
}

export function getPlatformKey(): string {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${os}-${arch}`;
}

/** Release-asset lookup helpers for githubReleaseToInfo (positional args per repo rule). */
type ReleaseAsset = GitHubRelease["assets"][number];

/** Download URL of a release asset, empty when the asset is absent (5 call sites). */
function assetUrl(asset: ReleaseAsset | undefined): string {
  return asset?.browser_download_url ?? "";
}

function findTarballAsset(assets: GitHubRelease["assets"]): ReleaseAsset | undefined {
  // Source tarball only: platform bundles also end in `.tar.gz` and sort
  // BEFORE it (`-` < `.`), so a bare suffix match can hand a bundle to the
  // source-install path. The platform triple is the discriminator.
  return assets.find(
    (a) =>
      a.name.endsWith(".tar.gz") &&
      !a.name.endsWith(".sha256") &&
      !a.name.endsWith(".asc") &&
      !/(linux|darwin|windows)-(x64|arm64)/.test(a.name),
  );
}

function findSha256Asset(
  assets: GitHubRelease["assets"],
  tarballAsset: ReleaseAsset | undefined,
): ReleaseAsset | undefined {
  const tarballName = tarballAsset?.name;
  if (tarballName !== undefined) {
    const expected = `${tarballName}.sha256`;
    return assets.find((a) => a.name === expected);
  }
  // Same platform-bundle exclusion as findTarballAsset: never pair a source
  // tarball request with a platform bundle's checksum.
  return assets.find(
    (a) => a.name.endsWith(".sha256") && !/(linux|darwin|windows)-(x64|arm64)/.test(a.name),
  );
}

export function githubReleaseToInfo(
  release: GitHubRelease,
  channel: "stable" | "beta" | "dev" | "canary",
): ReleaseInfo {
  const platformKey = getPlatformKey();
  const bundleVersion = release.tag_name.replace(/^v/, "");
  const tarballAsset = findTarballAsset(release.assets);
  const sha256Asset = findSha256Asset(release.assets, tarballAsset);
  const sigAsset = release.assets.find((a) => a.name.endsWith(".asc"));
  const bundleAsset = findBundleAsset(release.assets, bundleVersion, platformKey);
  const bundleSha256Asset = findBundleSha256Asset(release.assets, bundleVersion, platformKey);

  return {
    version: release.tag_name,
    channel,
    tarballUrl: assetUrl(tarballAsset),
    sha256Url: assetUrl(sha256Asset),
    signatureUrl: assetUrl(sigAsset),
    publishedAt: release.published_at,
    minCliVersion: "1.0.0",
    bundleUrl: assetUrl(bundleAsset),
    bundleSha256Url: assetUrl(bundleSha256Asset),
    commit: "",
  };
}

function findBundleAsset(
  assets: GitHubRelease["assets"],
  bundleVersion: string,
  platformKey: string,
): ReleaseAsset | undefined {
  return assets.find(
    (a) =>
      a.name.startsWith(`prism-v${bundleVersion}-${platformKey}`) &&
      a.name.endsWith(".tar.gz") &&
      !a.name.endsWith(".sha256"),
  );
}

function findBundleSha256Asset(
  assets: GitHubRelease["assets"],
  bundleVersion: string,
  platformKey: string,
): ReleaseAsset | undefined {
  return assets.find(
    (a) =>
      a.name.startsWith(`prism-v${bundleVersion}-${platformKey}`) && a.name.endsWith(".sha256"),
  );
}

export function channelManifestToInfo(manifest: ChannelManifest): ReleaseInfo {
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
    bundleUrl: bundle?.url ?? "",
    bundleSha256Url: bundle?.sha256_url ?? "",
    commit: manifest.commit ?? "",
  };
}

/** Canary lookup: valid `manifest.json` on the rolling GitHub prerelease →
 *  ReleaseInfo, absent/invalid → null. Fetch failures propagate. */
export function fetchCanaryManifest(repo: string): Effect.Effect<ReleaseInfo | null, Error> {
  return Effect.gen(function* () {
    const url = `https://github.com/${repo}/releases/download/${CANARY_RELEASE_TAG}/manifest.json`;
    const response = yield* tryNetwork(
      () =>
        fetch(url, {
          headers: {
            "User-Agent": "prism-liquidity-agent",
            Accept: "application/json",
          },
        }),
      `Failed to fetch canary manifest from ${url}`,
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`Canary manifest fetch error: ${response.status} ${response.statusText}`),
      );
    }
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    const manifest = (yield* tryNetwork(
      () => response.json(),
      "Failed to parse canary manifest JSON",
    )) as ChannelManifest;
    if (!isValidVersion(manifest.version)) return null;
    return channelManifestToInfo(manifest);
  });
}

export function fetchLatestRelease(
  repo: string,
  channel: "stable" | "beta" | "dev" | "canary",
  token?: string,
): Effect.Effect<ReleaseInfo | null, Error> {
  return Effect.gen(function* () {
    // Canary ships as the rolling GitHub prerelease + manifest.json asset.
    // Falling through to "newest release" GitHub semantics would install the
    // wrong artifact (canary versions are prerelease builds of main), so the
    // manifest IS the contract — fail with a clear, actionable message.
    if (channel === "canary") {
      const canaryResult = yield* Effect.result(fetchCanaryManifest(repo));
      if (canaryResult._tag === "Success" && canaryResult.success) return canaryResult.success;
      const detail =
        canaryResult._tag === "Failure"
          ? `: ${canaryResult.failure.message}`
          : " (no valid canary manifest found)";
      return yield* Effect.fail(
        new Error(
          `Canary builds are served from the rolling GitHub prerelease \`${CANARY_RELEASE_TAG}\` (manifest.json asset). ` +
            `Failed to resolve a canary build${detail}. ` +
            `Check that the canary pipeline has published a build.`,
        ),
      );
    }

    const ghResult = yield* Effect.result(fetchGitHubRelease(repo, channel, token));
    if (ghResult._tag === "Success") {
      if (ghResult.success) return githubReleaseToInfo(ghResult.success, channel);
      return null;
    }
    return yield* Effect.fail(new Error(`Update check failed: ${ghResult.failure.message}`));
  });
}
