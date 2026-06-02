import { Command } from "commander";
import fs from "fs";
import path from "path";
import os from "os";

const CREDENTIALS_DIR = path.join(os.homedir(), ".config", "prism");
const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "credentials.json");

function ensureCredentialsDir() {
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
}

function generateApiKey(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const maxUnbiased = 256 - (256 % chars.length);
  let result = "sk-prism-";
  for (let i = 0; i < 32; i++) {
    // Rejection sampling: loop until we get an unbiased byte
    let byte: number;
    do {
      const buf = new Uint8Array(1);
      crypto.getRandomValues(buf);
      byte = buf[0];
    } while (byte >= maxUnbiased);
    result += chars.charAt(byte % chars.length);
  }
  return result;
}

export const registerCommand = new Command("register")
  .description("Register with Prism and get an API key")
  .action(async () => {
    ensureCredentialsDir();

    // TODO: Call Cloudflare Worker /v1/register when Issue #16 is implemented
    // For now, generate a local API key
    const apiKey = generateApiKey();
    const userId = `user_${Date.now()}`;

    const credentials = {
      apiKey,
      userId,
      createdAt: new Date().toISOString(),
    };

    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), {
      mode: 0o600,
    });
    fs.chmodSync(CREDENTIALS_FILE, 0o600);

    console.log("✓ Registration successful");
    console.log(`  User ID: ${userId}`);
    console.log(`  API Key: ${apiKey.slice(0, 12)}...`);
    console.log(`  Saved to: ${CREDENTIALS_FILE}`);
    console.log("");
    console.log("Next: run 'prism setup' to configure your trading agent");
  });
