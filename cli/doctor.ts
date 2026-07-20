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
import { normalizeHeliusUrl, maskHeliusUrl } from "../engine/config-service.js";
import { loadKeystoreSecretKeyBase58 } from "../engine/wallet-keystore.js";
import { getApiBaseUrl, prismApiPost, readCredentials } from "./api.js";

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
  if (typeof Bun === "undefined") {
    return check(
      "runtime",
      "fail",
      `Bun runtime not detected (running under Node ${process.version})`,
    );
  }
  return gte(Bun.version, "1.4.0-canary.1")
    ? check("runtime", "pass", `Bun ${Bun.version}`)
    : check("runtime", "fail", `Bun ${Bun.version} is below 1.4.0-canary.1`);
}

function checkRpc(): DoctorCheck {
  const primary = process.env.SOLANA_RPC_URL?.trim() ?? "";
  const helius = process.env.HELIUS_API_KEY?.trim() ?? "";
  const fallback = process.env.SOLANA_RPC_FALLBACK_URL?.trim() ?? "";
  const paperTrading = process.env.PAPER_TRADING !== "false";
  const effectivePrimary = primary || (helius ? "helius" : "");
  if (!effectivePrimary) {
    return check("rpc", "fail", "No SOLANA_RPC_URL or HELIUS_API_KEY configured");
  }
  if (primary === "https://api.mainnet-beta.solana.com") {
    return check(
      "rpc",
      paperTrading ? "warn" : "fail",
      "Public Solana RPC is configured; use a paid/private provider for live trading",
    );
  }
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

async function probeRpcEndpoint(
  url: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "prism-doctor", method: "getHealth" }),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, error: `HTTP ${res.status} — API key rejected` };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    let json: { result?: unknown; error?: { message?: string } };
    try {
      json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    } catch (parseErr) {
      return {
        ok: false,
        status: res.status,
        error: maskHeliusUrl(
          `Invalid JSON response: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        ),
      };
    }
    if (json.error) {
      return {
        ok: false,
        status: res.status,
        error: maskHeliusUrl(json.error.message ?? "RPC error"),
      };
    }
    if (json.result !== "ok") {
      return {
        ok: false,
        status: res.status,
        error: `getHealth returned unexpected result: ${JSON.stringify(json.result ?? null)}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: maskHeliusUrl(err instanceof Error ? err.message : String(err)),
    };
  }
}

async function checkRpcConnectivity(): Promise<DoctorCheck> {
  const primary = process.env.SOLANA_RPC_URL?.trim() ?? "";
  const helius = process.env.HELIUS_API_KEY?.trim() ?? "";
  const fallback = process.env.SOLANA_RPC_FALLBACK_URL?.trim() ?? "";

  const effectivePrimary =
    primary || (helius ? `https://mainnet.helius-rpc.com/?api-key=${helius}` : "");

  if (!effectivePrimary) {
    return check("rpc-connectivity", "warn", "No RPC endpoint configured; skipping live probe");
  }

  const normalizedPrimary = normalizeHeliusUrl(effectivePrimary, helius).url;
  const primaryResult = await probeRpcEndpoint(normalizedPrimary);
  if (!primaryResult.ok) {
    return check("rpc-connectivity", "fail", `Primary RPC unreachable: ${primaryResult.error}`);
  }

  if (fallback) {
    const normalizedFallback = normalizeHeliusUrl(fallback, helius).url;
    const fallbackResult = await probeRpcEndpoint(normalizedFallback);
    if (!fallbackResult.ok) {
      return check(
        "rpc-connectivity",
        "warn",
        `Primary RPC reachable but fallback failed: ${fallbackResult.error}`,
      );
    }
    return check("rpc-connectivity", "pass", "Primary and fallback RPC endpoints reachable");
  }

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
  if (process.env.PAPER_TRADING !== "false") {
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

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const fix = options.fix === true;
  const sourceInstall = isSourceInstall(getPrismConfigDir());
  const checks: DoctorCheck[] = [checkRuntime()];
  checks.push(checkDirectory("config", getPrismConfigDir(), fix && !sourceInstall));
  checks.push(checkDirectory("data", getPrismDataDir(), fix && !sourceInstall));
  checks.push(checkDirectory("logs", getPrismLogsDir(), fix && !sourceInstall));

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
  checks.push(checkRpc());
  const [rpcConnectivity, heliusApiKey] = await Promise.all([
    checkRpcConnectivity(),
    checkHeliusApiKey(),
  ]);
  checks.push(rpcConnectivity);
  checks.push(heliusApiKey);
  checks.push(checkPriceProviders());
  checks.push(checkWallet());
  checks.push(await checkRegistration());
  checks.push(
    process.env.PRISM_ERROR_REPORTING === "false"
      ? check("error telemetry", "warn", "Disabled by PRISM_ERROR_REPORTING=false")
      : check("error telemetry", "pass", "Enabled for registered agents or explicit opt-in"),
  );

  return {
    ok: checks.every((item) => item.status !== "fail"),
    version: getCurrentVersion(),
    checks,
  };
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
      console.log(`Prism doctor ${report.version}`);
      for (const item of report.checks) {
        console.log(
          `${item.status === "pass" ? "PASS" : item.status === "warn" ? "WARN" : "FAIL"} ${item.name}: ${item.message}`,
        );
      }
      console.log(report.ok ? "Doctor passed." : "Doctor found blocking issues.");
    }
    if (!report.ok) process.exitCode = 1;
  });
