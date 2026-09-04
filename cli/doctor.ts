import { Command } from "commander";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, statSync } from "fs";
import { gte } from "semver";
import { getCurrentVersion } from "../engine/version.js";
import {
  getPrismConfigDir,
  getPrismDataDir,
  getPrismDbPath,
  getPrismEnvPath,
  getPrismLogsDir,
} from "../engine/paths.js";
import { isSourceInstall } from "../engine/install-method.js";
import { probeVecAvailability, vecRemediationHint, type VecProbeResult } from "../engine/db.js";
import {
  normalizeHeliusUrl,
  maskHeliusUrl,
  ConfigService,
  ConfigLive,
} from "../engine/config-service.js";
import { findDbConfigSpec, parseDbConfigValue } from "../engine/db-config.js";
import { loadKeystoreSecretKeyBase58 } from "../engine/wallet-keystore.js";
import { getApiBaseUrl, prismApiPost, readCredentials } from "./api.js";
import { readTelemetryPreference } from "../engine/telemetry-preference.js";
import { Effect } from "effect";

type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly message: string;
}

export interface DoctorReport {
  readonly ok: boolean;
  readonly version: string;
  readonly checks: ReadonlyArray<DoctorCheck>;
}

interface DoctorOptions {
  fix?: boolean;
  json?: boolean;
}

function check(name: string, status: DoctorStatus, message: string): DoctorCheck {
  return { name, status, message };
}

// Mirror engine/config-service.ts PAPER_TRADING parsing (Effect Config.boolean):
// true/yes/on/1 = paper, false/no/off/0 = live, anything else = default paper.
const PAPER_TRUTHY = ["true", "yes", "on", "1"];
const PAPER_FALSY = ["false", "no", "off", "0"];

function isPaperTrading(): boolean {
  const raw = process.env.PAPER_TRADING?.trim().toLowerCase() ?? "";
  if (PAPER_TRUTHY.includes(raw)) return true;
  if (PAPER_FALSY.includes(raw)) return false;
  return true;
}

interface RpcEnv {
  readonly primary: string;
  readonly helius: string;
  readonly fallback: string;
}

function readRpcEnv(): RpcEnv {
  return {
    primary: process.env.SOLANA_RPC_URL?.trim() ?? "",
    helius: process.env.HELIUS_API_KEY?.trim() ?? "",
    fallback: process.env.SOLANA_RPC_FALLBACK_URL?.trim() ?? "",
  };
}

function checkDirectory(name: string, directory: string, fix: boolean): DoctorCheck {
  try {
    if (!existsSync(directory)) {
      if (!fix) return check(name, "fail", `${directory} is missing; run prism doctor --fix`);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    if (fix) chmodSync(directory, 0o700);
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return check(name, "pass", `${directory} is present and writable`);
  } catch {
    return check(name, "fail", `${directory} is not writable`);
  }
}

function checkFileAccess(name: string, filePath: string): DoctorCheck {
  try {
    if (!existsSync(filePath)) return check(name, "fail", `${filePath} is missing`);
    const stats = statSync(filePath);
    if (!stats.isFile()) return check(name, "fail", `${filePath} is not a regular file`);
    accessSync(filePath, constants.R_OK);
    return check(name, "pass", `${filePath} is readable`);
  } catch {
    return check(name, "fail", `${filePath} is not readable`);
  }
}

async function checkRegistration(): Promise<DoctorCheck> {
  const credentials = readCredentials();
  if (!credentials?.apiKey || !credentials.userId) {
    return check("registration", "fail", "No credentials found; run prism register");
  }
  const result = await prismApiPost(
    "/v1/login",
    {},
    {
      apiKey: credentials.apiKey,
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!result.ok) {
    return check(
      "registration",
      "fail",
      `Stored credentials could not be validated against ${getApiBaseUrl()}`,
    );
  }
  return check("registration", "pass", `Registered user ${credentials.userId}`);
}

function checkRuntime(): DoctorCheck {
  if (!globalThis.Bun) {
    return check(
      "runtime",
      "fail",
      `Bun runtime not detected (running under Node ${process.version})`,
    );
  }
  return gte(Bun.version, "1.4.0")
    ? check("runtime", "pass", `Bun ${Bun.version}`)
    : check("runtime", "fail", `Bun ${Bun.version} is below 1.4.0`);
}

function checkRpcPair(
  primary: string,
  fallback: string,
  helius: string,
  paperTrading: boolean,
): DoctorCheck {
  if (
    fallback &&
    normalizeHeliusUrl(fallback, helius).url === normalizeHeliusUrl(primary, helius).url
  ) {
    return check("rpc", "fail", "SOLANA_RPC_FALLBACK_URL duplicates SOLANA_RPC_URL");
  }
  if (!fallback && !paperTrading) {
    return check("rpc", "warn", "No fallback RPC configured for live trading");
  }
  return check(
    "rpc",
    "pass",
    fallback ? "Primary and fallback RPC providers configured" : "Primary RPC configured",
  );
}

function checkRpc(): DoctorCheck {
  const { primary, helius, fallback } = readRpcEnv();
  const paperTrading = isPaperTrading();
  if (!primary && !helius) {
    return check("rpc", "fail", "No SOLANA_RPC_URL or HELIUS_API_KEY configured");
  }
  if (primary === "https://api.mainnet-beta.solana.com") {
    return check(
      "rpc",
      paperTrading ? "warn" : "fail",
      "Public Solana RPC is configured; use a paid/private provider for live trading",
    );
  }
  return checkRpcPair(primary, fallback, helius, paperTrading);
}

async function readHealthPayload(
  res: Response,
  status: number,
): Promise<{ ok: boolean; status: number; error?: string }> {
  let json: { result?: unknown; error?: { message?: string } };
  try {
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  } catch (parseErr) {
    return {
      ok: false,
      status,
      error: maskHeliusUrl(
        `Invalid JSON response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      ),
    };
  }
  if (json.error) {
    return { ok: false, status, error: maskHeliusUrl(json.error.message ?? "RPC error") };
  }
  if (json.result !== "ok") {
    return {
      ok: false,
      status,
      error: `getHealth returned unexpected result: ${JSON.stringify(json.result ?? null)}`,
    };
  }
  return { ok: true, status };
}

async function probeRpcEndpoint(
  url: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "prism-doctor", method: "getHealth" }),
      signal: AbortSignal.timeout(8_000),
      // The API key rides in the URL query string; never follow a redirect
      // that would forward it to another host.
      redirect: "error",
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: `HTTP ${res.status} — API key rejected` };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    return readHealthPayload(res, res.status);
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: maskHeliusUrl(err instanceof Error ? err.message : String(err)),
    };
  }
}

async function checkFallbackConnectivity(fallback: string, helius: string): Promise<DoctorCheck> {
  const fallbackResult = await probeRpcEndpoint(normalizeHeliusUrl(fallback, helius).url);
  if (!fallbackResult.ok) {
    return check(
      "rpc-connectivity",
      "warn",
      `Primary RPC reachable but fallback failed: ${fallbackResult.error}`,
    );
  }
  return check("rpc-connectivity", "pass", "Primary and fallback RPC endpoints reachable");
}

async function checkRpcConnectivity(): Promise<DoctorCheck> {
  const { primary, helius, fallback } = readRpcEnv();

  const effectivePrimary =
    primary || (helius ? `https://mainnet.helius-rpc.com/?api-key=${helius}` : "");

  if (!effectivePrimary) {
    return check("rpc-connectivity", "warn", "No RPC endpoint configured; skipping live probe");
  }

  const primaryResult = await probeRpcEndpoint(normalizeHeliusUrl(effectivePrimary, helius).url);
  if (!primaryResult.ok) {
    return check("rpc-connectivity", "fail", `Primary RPC unreachable: ${primaryResult.error}`);
  }

  if (fallback) return checkFallbackConnectivity(fallback, helius);
  return check("rpc-connectivity", "pass", "Primary RPC endpoint reachable");
}

async function checkHeliusApiKey(): Promise<DoctorCheck> {
  const heliusKey = process.env.HELIUS_API_KEY?.trim() ?? "";
  if (!heliusKey) {
    return check("helius-api-key", "warn", "HELIUS_API_KEY not set; DAS price lookups disabled");
  }

  const url = `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  const result = await probeRpcEndpoint(url);
  if (!result.ok) {
    return check("helius-api-key", "fail", `HELIUS_API_KEY rejected by Helius: ${result.error}`);
  }

  return check("helius-api-key", "pass", "Helius API key valid");
}

function checkWallet(): DoctorCheck {
  if (isPaperTrading()) {
    return check("wallet", "pass", "Paper trading is enabled; no private key required");
  }
  // Live trading signs with WALLET_PRIVATE_KEY, falling back to the local keystore the
  // engine also loads (see engine/config-service.ts), so either makes it usable.
  if (process.env.WALLET_PRIVATE_KEY?.trim()) {
    return check("wallet", "pass", "Live trading wallet key is configured (WALLET_PRIVATE_KEY)");
  }
  if (loadKeystoreSecretKeyBase58() != null) {
    return check("wallet", "pass", "Live trading wallet key is configured (local keystore)");
  }
  return check(
    "wallet",
    "fail",
    "Live trading requires WALLET_PRIVATE_KEY or a generated wallet (prism wallet generate)",
  );
}

export function checkMemory(probe: () => VecProbeResult = probeVecAvailability): DoctorCheck {
  const result = probe();
  if (result.available) {
    return check(
      "memory",
      "pass",
      `sqlite-vec vector memory is available (loaded via ${result.source ?? "unknown"})`,
    );
  }
  const detail = result.error ? ` Last error: ${result.error}.` : "";
  return check(
    "memory",
    "fail",
    `sqlite-vec vector memory is unavailable; the engine will run with memory recall/recording silently disabled. ${vecRemediationHint()}${detail}`,
  );
}

export function checkNativeBindings(): DoctorCheck {
  return check(
    "native-bindings",
    "warn",
    "`bigint: Failed to load bindings` at startup is a harmless warning from bigint-buffer (a @solana/web3.js dependency) using its pure-JS fallback; computation results are identical and no action is needed.",
  );
}

function checkPriceProviders(): DoctorCheck {
  const configured = [process.env.JUPITER_API_KEY, process.env.COINGECKO_API_KEY].filter((value) =>
    value?.trim(),
  ).length;
  return check(
    "prices",
    "pass",
    configured > 0
      ? `Price chain active with ${configured} optional provider key${configured === 1 ? "" : "s"}`
      : "Price chain active with public provider fallbacks",
  );
}

function resolveMarketScanFlag(
  spec: Parameters<typeof parseDbConfigValue>[0] | undefined,
  envRaw: string | undefined,
  marketScanEnabled: boolean | undefined,
): boolean {
  if (spec === undefined) return false;
  if (envRaw !== undefined) return parseDbConfigValue(spec, envRaw) === true;
  return marketScanEnabled === true;
}

export /**
 * Validate that the FULL config actually loads (env + .env + DB sidecar
 * overrides, with every numeric clamp and structured warning), not just that
 * the .env file exists. This catches broken values that would otherwise only
 * surface at engine startup.
 */
async function checkConfig(): Promise<DoctorCheck> {
  try {
    const config = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* ConfigService;
        }),
        ConfigLive,
      ),
    );
    // MARKET_SCAN_* is forward-declared config that lands on AppConfig with
    // the market-scan feature branch; this base does not declare it. Report
    // the effective toggle with the engine's env > DB > default precedence:
    // the env var (dotenv already loaded at CLI start) first, then the
    // DB-sidecar override ConfigLive applied onto the loaded config.
    const spec = findDbConfigSpec("MARKET_SCAN_ENABLED");
    const envRaw = process.env.MARKET_SCAN_ENABLED;
    // The market-scan toggle is forward-declared config on the base AppConfig;
    // read it through a named view of the effective value rather than a
    // widened dictionary lookup.
    // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
    const configView = config as { readonly marketScanEnabled?: boolean };
    const marketScan = resolveMarketScanFlag(spec, envRaw, configView.marketScanEnabled);
    return check(
      "config",
      "pass",
      `Config loaded (scan=${config.scanIntervalMs}ms, maxPositions=${config.maxOpenPositions}, marketScan=${marketScan})`,
    );
  } catch (error) {
    return check("config", "fail", `Config failed to load: ${String(error)}`);
  }
}

function collectLocalChecks(fix: boolean, sourceInstall: boolean): DoctorCheck[] {
  const repair = fix && !sourceInstall;
  const checks: DoctorCheck[] = [checkRuntime()];
  checks.push(checkDirectory("config", getPrismConfigDir(), repair));
  checks.push(checkDirectory("data", getPrismDataDir(), repair));
  checks.push(checkDirectory("logs", getPrismLogsDir(), repair));

  const envPath = getPrismEnvPath();
  checks.push(
    existsSync(envPath)
      ? checkFileAccess("environment", envPath)
      : check("environment", "fail", `${envPath} is missing; run prism setup`),
  );
  checks.push(
    existsSync(getPrismDbPath())
      ? checkFileAccess("database", getPrismDbPath())
      : check("database", "warn", `${getPrismDbPath()} will be created on first run`),
  );
  checks.push(checkMemory());
  checks.push(checkNativeBindings());
  checks.push(checkRpc());
  return checks;
}

function checkTelemetry(): DoctorCheck {
  const telemetryEnabled =
    process.env.PRISM_ERROR_REPORTING !== "false" && readTelemetryPreference().enabled;
  if (!telemetryEnabled) {
    return check("error telemetry", "warn", "Disabled by explicit local or environment opt-out");
  }
  if (readCredentials() === null) {
    return check(
      "error telemetry",
      "warn",
      "Enabled but not registered — error reports are queued until an API key is available",
    );
  }
  return check("error telemetry", "pass", "Enabled by default for registered agents");
}

async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const fix = options.fix === true;
  const checks = collectLocalChecks(fix, isSourceInstall(getPrismConfigDir()));
  const [rpcConnectivity, heliusApiKey] = await Promise.all([
    checkRpcConnectivity(),
    checkHeliusApiKey(),
  ]);
  checks.push(rpcConnectivity, heliusApiKey);
  checks.push(checkPriceProviders());
  checks.push(checkWallet());
  checks.push(await checkConfig());
  checks.push(await checkRegistration());
  checks.push(checkTelemetry());

  return {
    ok: checks.every((item) => item.status !== "fail"),
    version: getCurrentVersion(),
    checks,
  };
}

function formatCheckLine(item: DoctorCheck): string {
  const label = item.status === "pass" ? "PASS" : item.status === "warn" ? "WARN" : "FAIL";
  return `${label} ${item.name}: ${item.message}`;
}

function printHumanReport(report: DoctorReport): void {
  console.log(`Prism doctor ${report.version}`);
  for (const item of report.checks) console.log(formatCheckLine(item));
  console.log(report.ok ? "Doctor passed." : "Doctor found blocking issues.");
}

export const doctorCommand = new Command("doctor")
  .description("Validate Prism installation, registration, providers, and local state")
  .option("--fix", "Create missing Prism directories and repair permissions")
  .option("--json", "Print machine-readable JSON")
  .action(async (options: DoctorOptions) => {
    const report = await runDoctor(options);
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printHumanReport(report);
    }
    if (!report.ok) process.exitCode = 1;
  });
