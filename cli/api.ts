import fs from "fs";
import path from "path";
import os from "os";
import { getOrCreateInstallId } from "./install-id.js";
import { getCurrentVersion } from "../engine/version.js";

const DEFAULT_API_URL = "https://prism-api.irfndi.workers.dev";

export function getApiBaseUrl(): string {
  return process.env.PRISM_API_URL ?? DEFAULT_API_URL;
}

export const CREDENTIALS_FILE = path.join(os.homedir(), ".config", "prism", "credentials.json");

export interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

export async function prismApiPost<T = unknown>(
  path: string,
  body: Record<string, unknown>,
  options: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  try {
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Prism API error: ${response.status} ${response.statusText}`,
      };
    }
    const json = (await response.json()) as T;
    return { ok: true, status: response.status, data: json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function prismApiGet<T = unknown>(
  path: string,
  options: { apiKey?: string } = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  try {
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: "GET",
      headers,
    });
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `Prism API error: ${response.status} ${response.statusText}`,
      };
    }
    const json = (await response.json()) as T;
    return { ok: true, status: response.status, data: json };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
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

export function pingInstall(
  event: "install" | "setup" | "dev_start" | "register",
  options: { userId?: string } = {},
): Promise<void> {
  return (async () => {
    try {
      const body: Record<string, string> = {
        installId: getOrCreateInstallId(),
        event,
        version: getCurrentVersion(),
        channel: process.env.UPDATE_CHANNEL ?? "stable",
        platform: process.platform,
      };
      if (options.userId) body.userId = options.userId;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      await prismApiPost("/v1/installs/ping", body, { signal: controller.signal }).finally(() =>
        clearTimeout(timeout),
      );
    } catch {
      return;
    }
  })();
}
