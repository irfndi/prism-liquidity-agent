import { pingInstall } from "./api.js";

type PingInstall = typeof pingInstall;

// Telemetry must never block agent startup — degrade to a warning when the
// API is unreachable so offline work keeps running.
export async function reportDevStartTelemetry(
  userId: string,
  ping: PingInstall = pingInstall,
): Promise<void> {
  if (!(await ping("dev_start", { userId }))) {
    console.warn("⚠️  Prism telemetry is unavailable; continuing without telemetry.");
    console.warn("Run 'prism doctor' to diagnose the account and API connection.");
  }
}
