import fs from "fs";
import path from "path";
import bs58 from "bs58";
import { getPrismUserConfigDir } from "./paths.js";

/**
 * Path to the non-custodial local keystore written by `prism wallet generate|import`.
 * Lives in the user config dir (respects PRISM_CONFIG_DIR, never the source tree) so the
 * CLI that writes it and the engine that reads it always agree on the same file.
 */
export function getWalletKeystorePath(): string {
  return path.join(getPrismUserConfigDir(), "wallet.json");
}

/**
 * Load the keystore's secret key as a base58 string (the format config.walletPrivateKey
 * expects). Returns null when the keystore is absent, unreadable, or malformed — the
 * engine treats that as "no keystore key" and the caller falls back accordingly.
 */
export function loadKeystoreSecretKeyBase58(): string | null {
  try {
    const keystorePath = getWalletKeystorePath();
    if (!fs.existsSync(keystorePath)) return null;
    const data = JSON.parse(fs.readFileSync(keystorePath, "utf-8")) as { secretKey?: unknown };
    if (!Array.isArray(data.secretKey) || data.secretKey.length === 0) return null;
    return bs58.encode(Uint8Array.from(data.secretKey as number[]));
  } catch {
    return null;
  }
}
