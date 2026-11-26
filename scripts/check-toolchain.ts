/**
 * Toolchain compatibility gate.
 *
 * Three dependency clusters in this repo break each other silently when one
 * side is bumped alone, and every failure mode is quiet:
 *
 *  - `@effect/tsgo` type-aware lint needs an Oxlint/tsgolint/TypeScript pin it
 *    publishes support for. Out of band and `effect-tsgo patch` fails; the
 *    `prepare` script warns and installs with type-aware rules off.
 *  - The anti-slop Oxlint plugins inline `@oxlint/plugins` at bundle time. A
 *    plugin upgrade without a bundle rebuild leaves a stale compat shim that
 *    oxlint loads without complaint.
 *  - `@meteora-ag/dlmm` peers exact `@coral-xyz/anchor` and `^1` web3.js. A
 *    "latest" bump of either compiles against a different SDK than the one the
 *    adapter runs.
 *
 * Each check names the requirement and the fix. Exit 1 on any mismatch.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";

interface Manifest {
  readonly version: string;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly packageManager?: string;
}

const root = join(import.meta.dir, "..");

function readJson(relativePath: string): Manifest {
  // SAFETY: package.json files are machine-written by the install tooling and
  // the checks below read only the fields declared on Manifest; a missing
  // field makes the corresponding check fail loudly instead of passing.
  return JSON.parse(readFileSync(join(root, relativePath), "utf8")) as Manifest;
}

function pin(manifest: Manifest, name: string): string {
  const version = manifest.devDependencies[name] ?? manifest.dependencies[name];
  if (version === undefined) throw new Error(`${name} is not a direct dependency`);
  return version;
}

function bare(range: string): string {
  const cleaned = semver.coerce(range);
  if (cleaned === null) throw new Error(`cannot read a version out of "${range}"`);
  return cleaned.version;
}

const failures: Array<string> = [];

function check(name: string, detail: string, ok: boolean): void {
  if (!ok) failures.push(`${name}: ${detail}`);
}

const pkg = readJson("package.json");

// ─── @effect/tsgo ↔ effect ───────────────────────────────────────────────────
const tsgo = readJson("node_modules/@effect/tsgo/package.json");
const tsgoEffectRange = tsgo.devDependencies["effect"];
const effectVersion = bare(pin(pkg, "effect"));
check(
  "@effect/tsgo",
  `tsgo ${tsgo.version} is built against effect ${tsgoEffectRange}, installed effect is ${effectVersion}. ` +
    `Move both pins together: effect and @effect/tsgo ship as a matched pair.`,
  tsgoEffectRange !== undefined && semver.satisfies(effectVersion, tsgoEffectRange),
);

// ─── @effect/tsgo ↔ Typescript / Oxlint / tsgolint ───────────────────────────
function supportedVersions(readme: string, component: string): ReadonlyArray<string> {
  const row = readme
    .split("\n")
    .find((line) => line.startsWith(`| ${component} |`) || line.startsWith(`| \`${component}\` |`));
  if (row === undefined) return [];
  return [...row.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "").filter(Boolean);
}

const tsgoReadme = readFileSync(join(root, "node_modules/@effect/tsgo/README.md"), "utf8");
for (const [component, name] of [
  ["TypeScript", "typescript"],
  ["Oxlint", "oxlint"],
  ["oxlint-tsgolint", "oxlint-tsgolint"],
] as const) {
  const supported = supportedVersions(tsgoReadme, component);
  const installed = pin(pkg, name);
  check(
    `@effect/tsgo ↔ ${name}`,
    `tsgo ${tsgo.version} supports ${component} ${supported.join(", ") || "(table not found)"}; ` +
      `package.json pins ${installed}. Pin the newest supported one — an unsupported ` +
      `pair makes \`effect-tsgo patch\` fail and disables type-aware Effect lint.`,
    supported.includes(installed),
  );
}

// ─── anti-slop bundles inline @oxlint/plugins ────────────────────────────────
const pluginsVersion = readJson("node_modules/@oxlint/plugins/package.json").version;
for (const bundle of [
  "tools/oxlint/anti-slop/index.mjs",
  "tools/oxlint/anti-slop/effect/index.mjs",
]) {
  const head = readFileSync(join(root, bundle), "utf8").split("\n", 1)[0] ?? "";
  const inlined = /@oxlint\+plugins@([\d.]+)/.exec(head)?.[1];
  check(
    bundle,
    `bundle inlines @oxlint/plugins ${inlined ?? "(unknown)"} but ${pluginsVersion} is installed. ` +
      `Rebuild: bun build ${bundle.replace(/index\.mjs$/, "index.ts")} --outfile ${bundle}`,
    inlined === pluginsVersion,
  );
}

// ─── @meteora-ag/dlmm's Solana SDK pins ─────────────────────────────────────
// These are declared as `dependencies` (exact for anchor/borsh, `^1` for
// web3.js). Bun's isolated linker can nest a second copy, which would make the
// adapter and the SDK disagree on classes; pinning the root to the same range
// keeps one copy in every graph.
const dlmm = readJson("node_modules/@meteora-ag/dlmm/package.json");
for (const name of ["@solana/web3.js", "@coral-xyz/anchor"]) {
  const dlmmRange = dlmm.dependencies[name] ?? dlmm.peerDependencies?.[name];
  const installed = bare(pin(pkg, name));
  check(
    `@meteora-ag/dlmm ↔ ${name}`,
    `dlmm ${dlmm.version} requires ${name} ${dlmmRange ?? "(none)"}; package.json pins ${installed}. ` +
      `The DLMM SDK and the adapter are written against that API — do not chase "latest" here.`,
    dlmmRange !== undefined && semver.satisfies(installed, dlmmRange),
  );
}

// ─── Bun runtime ↔ bun-types ↔ Docker base image ─────────────────────────────
const managerVersion = /^bun@(.+)$/.exec(pkg.packageManager ?? "")?.[1];
check(
  "bun-types",
  `bun-types ${pin(pkg, "bun-types")} does not match packageManager bun@${managerVersion ?? "(unset)"}. ` +
    `Bump packageManager, bun-types, the Dockerfile FROM tag and CI BUN_VERSION together.`,
  managerVersion !== undefined && pin(pkg, "bun-types") === managerVersion,
);
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
for (const tag of new Set([...dockerfile.matchAll(/FROM oven\/bun:([\w.-]+)/g)].map((m) => m[1]))) {
  const tagVersion = (tag ?? "").replace(/-slim$/, "");
  check(
    "Dockerfile",
    `Dockerfile runs oven/bun:${tag ?? "(unset)"} but packageManager pins bun@${managerVersion ?? "(unset)"}.`,
    tagVersion === managerVersion,
  );
}

if (failures.length > 0) {
  console.error("toolchain check failed:\n");
  for (const failure of failures) console.error(`  ✗ ${failure}\n`);
  process.exit(1);
}
console.log(
  `toolchain ok: effect ${effectVersion} ↔ tsgo ${tsgo.version}, oxlint ${pin(pkg, "oxlint")}, ` +
    `dlmm peers satisfied, anti-slop bundles current, bun ${managerVersion}`,
);
