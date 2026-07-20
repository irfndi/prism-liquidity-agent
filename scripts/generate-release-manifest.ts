import fs from "fs";
import path from "path";

const version = process.env.VERSION ?? "";
const channel = (process.env.CHANNEL ?? "stable") as "stable" | "beta" | "dev" | "canary";
const r2Base = process.env.R2_BASE_URL ?? "https://pub-2f55c98709e74d1d900b89ec20f8f1fc.r2.dev";
const keyPrefix = process.env.R2_KEY_PREFIX ?? `releases/v${version}`;
const commit = process.env.COMMIT;
const outFile = process.env.OUT_FILE ?? "manifest.json";
const requireAllBundles = (process.env.REQUIRE_ALL_BUNDLES ?? "true") === "true";

if (!version) {
  console.error("VERSION env is required");
  process.exit(1);
}

if (!["stable", "beta", "dev", "canary"].includes(channel)) {
  console.error(`Invalid channel: ${channel}`);
  process.exit(1);
}

const cwd = process.cwd();
const files = fs.readdirSync(cwd).filter((f) => {
  return f.startsWith(`prism-v${version}-`) && f.endsWith(".tar.gz") && !f.endsWith(".sha256");
});

const expectedPlatforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const bundles: Record<string, { url: string; sha256_url: string }> = {};

for (const file of files) {
  const escaped = version.replace(/\./g, "\\.");
  const match = new RegExp(`^prism-v${escaped}-(.+)\\.tar\\.gz$`).exec(file);
  if (!match) continue;
  const platformKey = match[1]!;
  const sha256File = `${file}.sha256`;
  if (!fs.existsSync(path.join(cwd, sha256File))) {
    console.warn(`Missing checksum for ${file}, skipping`);
    continue;
  }
  const url = `${r2Base}/${keyPrefix}/${file}`;
  bundles[platformKey] = { url, sha256_url: `${url}.sha256` };
}

if (requireAllBundles) {
  const missing = expectedPlatforms.filter((p) => !bundles[p]);
  if (missing.length > 0) {
    console.error(`Missing bundles for platforms: ${missing.join(", ")}`);
    process.exit(1);
  }
}

if (Object.keys(bundles).length === 0) {
  console.warn("No bundles found; manifest will have no per-platform bundles.");
}

const tarballUrl = `${r2Base}/${keyPrefix}/prism-v${version}.tar.gz`;
const signatureUrl = `${tarballUrl}.asc`;

const manifest: Record<string, unknown> = {
  version,
  channel,
  ...(commit ? { commit } : {}),
  tarball_url: tarballUrl,
  sha256_url: `${tarballUrl}.sha256`,
  signature_url: signatureUrl,
  published_at: new Date().toISOString(),
  min_cli_version: "1.0.0",
  bundles,
};

fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${outFile} with bundles: ${Object.keys(bundles).join(", ") || "none"}`);
