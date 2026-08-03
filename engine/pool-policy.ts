import type { AppConfig } from "./config-service.js";

export function shouldDiscoverPools(
  config: Pick<AppConfig, "enablePoolDiscovery" | "paperTrading"> &
    Partial<Pick<AppConfig, "autonomousTokenMode">>,
): boolean {
  return (
    (config.autonomousTokenMode !== undefined && config.autonomousTokenMode !== "off") ||
    (config.enablePoolDiscovery && config.paperTrading)
  );
}
