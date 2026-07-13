import type { AppConfig } from "./config-service.js";

export function shouldDiscoverPools(
  config: Pick<AppConfig, "enablePoolDiscovery" | "paperTrading">,
): boolean {
  return config.enablePoolDiscovery && config.paperTrading;
}
