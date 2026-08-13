/**
 * Privacy-first telemetry preference module.
 *
 * - Defaults to enabled unless explicitly opted out via env/config.
 * - Reads the local preference flag from the Prism config directory.
 * - Never blocks the engine: missing file or malformed JSON falls back to enabled.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getPrismUserConfigDir } from "./paths.js";

const TELEMETRY_PREFERENCE_FILE = "telemetry-preference.json";

export interface TelemetryPreference {
  readonly enabled: boolean;
  readonly updatedAt: string;
}

export interface TelemetryPreferenceWrite {
  readonly ok: boolean;
  readonly error?: string;
}

export function getTelemetryPreferencePath(): string {
  return join(getPrismUserConfigDir(), TELEMETRY_PREFERENCE_FILE);
}

export function readTelemetryPreference(): TelemetryPreference {
  try {
    const path = getTelemetryPreferencePath();
    if (!existsSync(path)) {
      return { enabled: true, updatedAt: new Date().toISOString() };
    }
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TelemetryPreference>;
    if (Object.prototype.toString.call(parsed.enabled) !== "[object Boolean]") {
      return { enabled: true, updatedAt: new Date().toISOString() };
    }
    return {
      enabled: parsed.enabled as boolean,
      updatedAt:
        Object.prototype.toString.call(parsed.updatedAt) === "[object String]"
          ? (parsed.updatedAt as string)
          : new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[telemetry] Failed to read preference; defaulting to enabled: ${message}`);
    return { enabled: true, updatedAt: new Date().toISOString() };
  }
}

export function writeTelemetryPreference(enabled: boolean): TelemetryPreferenceWrite {
  const path = getTelemetryPreferencePath();
  const dir = dirname(path);
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const data: TelemetryPreference = {
      enabled,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    const result: TelemetryPreferenceWrite = { ok: true };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[telemetry] Failed to write preference file: ${message}`);
    const result: TelemetryPreferenceWrite = { ok: false, error: message };
    return result;
  }
}
