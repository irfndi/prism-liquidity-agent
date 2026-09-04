import fs from "fs";
import path from "path";
import { getOrCreateInstallId } from "./install-id.js";
import { getCurrentVersion } from "../engine/version.js";
import { getPrismUserConfigDir } from "../engine/paths.js";

const DEFAULT_API_URL = "https://prism-api.irfndi.workers.dev";

export function getApiBaseUrl(): string {
  return process.env.PRISM_API_URL ?? DEFAULT_API_URL;
}

export const CREDENTIALS_FILE = path.join(getPrismUserConfigDir(), "credentials.json");

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export interface PrismCredentials {
  apiKey: string;
  userId: string;
  createdAt: string;
}

/** JSON-serializable request body for the Prism Cloud API. */
export type JsonBody = Readonly<Record<string, string | number | boolean | null>>;

async function readSuccessBody<T>(response: Response): Promise<ApiResponse<T>> {
  // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
  const json = (await response.json()) as T;
  return { ok: true, status: response.status, data: json };
}

function buildPostInit(
  body: JsonBody,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): RequestInit {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  const init: RequestInit = { method: "POST", headers, body: JSON.stringify(body) };
  if (signal) init.signal = signal;
  return init;
}

export async function prismApiPost<T = unknown>(
  path: string,
  body: JsonBody,
  options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}${path}`,
      buildPostInit(body, options.apiKey, options.signal),
    );
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Prism API error: ${response.status} ${response.statusText}`,
      };
    }
    return readSuccessBody<T>(response);
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function prismApiGet<T = unknown>(
  path: string,
  options: { apiKey?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
  try {
    const response = await fetch(`${getApiBaseUrl()}${path}`, { method: "GET", headers });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Prism API error: ${response.status} ${response.statusText}`,
      };
    }
    return readSuccessBody<T>(response);
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export function readCredentials(): {
  apiKey: string;
  userId: string;
  createdAt: string;
} | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function ensureCredentialsValid(apiKey: string): Promise<string | null> {
  const result = await prismApiPost("/v1/login", {}, { apiKey, signal: AbortSignal.timeout(5000) });
  if (result.ok) return null;
  return result.error ? ` ${result.error}` : "";
}

export async function requireRegistered(validate = false): Promise<PrismCredentials> {
  const credentials = readCredentials();
  if (!credentials?.apiKey || !credentials.userId) {
    throw new Error("Prism account required. Run 'prism register' first.");
  }
  if (!validate) return credentials;
  const detail = await ensureCredentialsValid(credentials.apiKey);
  if (detail !== null) {
    throw new Error(
      `Stored Prism credentials are invalid or unavailable. Run 'prism login <key>'.${detail}`,
    );
  }
  return credentials;
}

export function writeCredentials(creds: {
  apiKey: string;
  userId: string;
  createdAt: string;
}): void {
  const dir = path.dirname(CREDENTIALS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), {
    mode: 0o600,
  });
  fs.chmodSync(CREDENTIALS_FILE, 0o600);
}

type InstallPingBody = {
  readonly installId: string;
  readonly event: string;
  readonly version: string;
  readonly channel: string;
  readonly platform: string;
};

interface PingRequestOptions {
  apiKey?: string;
  signal: AbortSignal;
}

function buildPingBody(event: "install" | "setup" | "dev_start" | "register"): InstallPingBody {
  return {
    installId: getOrCreateInstallId(),
    event,
    version: getCurrentVersion(),
    channel: process.env.UPDATE_CHANNEL ?? "stable",
    platform: process.platform,
  };
}

function isPingSkipped(
  event: "install" | "setup" | "dev_start" | "register",
  storedApiKey: string | undefined,
  storedUserId: string | undefined,
  wantedUserId: string | undefined,
): boolean {
  if (event !== "install" && !storedApiKey) return true;
  if (wantedUserId !== undefined && storedUserId !== wantedUserId) return true;
  return false;
}

async function postPing(body: InstallPingBody, apiKey: string | undefined): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const requestOptions: PingRequestOptions = { signal: controller.signal };
  if (apiKey) requestOptions.apiKey = apiKey;
  try {
    const result = await prismApiPost("/v1/installs/ping", body, requestOptions);
    return result.ok;
  } finally {
    clearTimeout(timeout);
  }
}

export function pingInstall(
  event: "install" | "setup" | "dev_start" | "register",
  options: { userId?: string } = {},
): Promise<boolean> {
  return (async () => {
    try {
      const credentials = readCredentials();
      if (isPingSkipped(event, credentials?.apiKey, credentials?.userId, options.userId))
        return false;
      return postPing(buildPingBody(event), credentials?.apiKey);
    } catch {
      return false;
    }
  })();
}
