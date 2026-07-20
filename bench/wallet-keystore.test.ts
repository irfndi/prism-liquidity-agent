import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { loadKeystoreSecretKeyBase58, getWalletKeystorePath } from "../engine/wallet-keystore.js";
import { ConfigService, ConfigLive } from "../engine/config-service.js";
import type { AppConfig } from "../engine/config-service.js";

async function loadConfig(): Promise<AppConfig> {
  return Effect.runPromise(ConfigService.pipe(Effect.provide(ConfigLive)));
}

function writeKeystore(keypair: Keypair): void {
  fs.writeFileSync(
    getWalletKeystorePath(),
    JSON.stringify({
      pubkey: keypair.publicKey.toBase58(),
      secretKey: Array.from(keypair.secretKey),
    }),
  );
}

describe("wallet-keystore", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-ks-"));
    process.env.PRISM_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.PRISM_CONFIG_DIR;
    delete process.env.WALLET_PRIVATE_KEY;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("loadKeystoreSecretKeyBase58", () => {
    it("loads the keystore secret key as base58", () => {
      const keypair = Keypair.generate();
      writeKeystore(keypair);
      expect(loadKeystoreSecretKeyBase58()).toBe(bs58.encode(keypair.secretKey));
    });

    it("returns null when no keystore exists", () => {
      expect(loadKeystoreSecretKeyBase58()).toBeNull();
    });

    it("returns null for a malformed keystore", () => {
      fs.writeFileSync(getWalletKeystorePath(), "{ this is not json");
      expect(loadKeystoreSecretKeyBase58()).toBeNull();
    });
  });

  describe("engine config wallet resolution", () => {
    it("falls back to the keystore when WALLET_PRIVATE_KEY is unset", async () => {
      const keypair = Keypair.generate();
      writeKeystore(keypair);
      delete process.env.WALLET_PRIVATE_KEY;

      const config = await loadConfig();
      expect(config.walletPrivateKey).toBe(bs58.encode(keypair.secretKey));
    });

    it("prefers WALLET_PRIVATE_KEY over the keystore", async () => {
      writeKeystore(Keypair.generate());
      const envKeypair = Keypair.generate();
      const envKey = bs58.encode(envKeypair.secretKey);
      process.env.WALLET_PRIVATE_KEY = envKey;

      const config = await loadConfig();
      expect(config.walletPrivateKey).toBe(envKey);
    });

    it("is empty when neither env nor keystore is present", async () => {
      delete process.env.WALLET_PRIVATE_KEY;
      const config = await loadConfig();
      expect(config.walletPrivateKey).toBe("");
    });
  });
});
