import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, "..", "cli", "index.ts");

function runWalletShow(env: Record<string, string>) {
  return Bun.spawnSync([process.execPath, CLI, "wallet", "show"], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function decode(buffer: Uint8Array): string {
  return new TextDecoder().decode(buffer);
}

// Write a keystore wallet in an isolated HOME so the engine-equivalent resolution can be
// exercised without touching the developer's real ~/.config/prism.
function makeIsolatedKeystore(): { home: string; keystorePubkey: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "prism-wallet-test-"));
  const walletDir = path.join(home, ".config", "prism");
  fs.mkdirSync(walletDir, { recursive: true });
  const keypair = Keypair.generate();
  fs.writeFileSync(
    path.join(walletDir, "wallet.json"),
    JSON.stringify({
      pubkey: keypair.publicKey.toBase58(),
      secretKey: Array.from(keypair.secretKey),
    }),
    { mode: 0o600 },
  );
  return { home, keystorePubkey: keypair.publicKey.toBase58() };
}

describe("wallet show (effective wallet resolution)", () => {
  it("errors on a set-but-invalid WALLET_PRIVATE_KEY instead of silently showing the keystore", () => {
    const { home, keystorePubkey } = makeIsolatedKeystore();
    try {
      const result = runWalletShow({ HOME: home, WALLET_PRIVATE_KEY: "not-a-valid-base58-key!!!" });
      const stdout = decode(result.stdout);
      const stderr = decode(result.stderr);

      // The engine resolves the wallet to null when the env key is invalid; `wallet show`
      // must match that rather than report the (different) keystore pubkey.
      expect(result.exitCode).not.toBe(0);
      expect(stderr).toContain("could not be decoded");
      expect(stdout).not.toContain(keystorePubkey);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers a valid WALLET_PRIVATE_KEY over the keystore", () => {
    const { home, keystorePubkey } = makeIsolatedKeystore();
    try {
      const envKeypair = Keypair.generate();
      const result = runWalletShow({
        HOME: home,
        WALLET_PRIVATE_KEY: bs58.encode(envKeypair.secretKey),
      });
      const stdout = decode(result.stdout);

      expect(result.exitCode).toBe(0);
      expect(stdout).toContain(envKeypair.publicKey.toBase58());
      expect(stdout).not.toContain(keystorePubkey);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("shows the keystore pubkey when no env key is set", () => {
    const { home, keystorePubkey } = makeIsolatedKeystore();
    try {
      const { WALLET_PRIVATE_KEY: _walletKey, ...envBase } = process.env as Record<
        string,
        string | undefined
      >;
      const env = { ...envBase, HOME: home } as Record<string, string>;
      const result = Bun.spawnSync([process.execPath, CLI, "wallet", "show"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(decode(result.stdout)).toContain(keystorePubkey);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
