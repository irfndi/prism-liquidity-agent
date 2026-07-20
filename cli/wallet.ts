import { Command } from "commander";
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { readCredentials, prismApiPost } from "./api.js";

const WALLET_DIR = path.join(os.homedir(), ".config", "prism");
const WALLET_FILE = path.join(WALLET_DIR, "wallet.json");

function ensureWalletDir() {
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  }
}

function isExistingFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// Effective-wallet resolution mirroring the engine: WALLET_PRIVATE_KEY (base58, decoded
// exactly like engine/adapter-service.ts) takes precedence over the local keystore.
// Returns null when neither yields a usable key.
function resolveEffectivePubkey(): { pubkey: string; source: "env" | "keystore" } | null {
  const envKey = process.env.WALLET_PRIVATE_KEY?.trim();
  if (envKey) {
    try {
      return {
        pubkey: Keypair.fromSecretKey(bs58.decode(envKey)).publicKey.toBase58(),
        source: "env",
      };
    } catch {
      // Undecodable env key: fall through to the keystore.
    }
  }
  if (fs.existsSync(WALLET_FILE)) {
    try {
      const walletData = JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8")) as { pubkey?: string };
      if (walletData.pubkey) {
        return { pubkey: walletData.pubkey, source: "keystore" };
      }
    } catch {
      return null;
    }
  }
  return null;
}

export const walletCommand = new Command("wallet")
  .description("Manage Solana wallet")
  .addCommand(
    new Command("generate")
      .description("Generate a new Solana keypair")
      .option("--force", "Overwrite existing wallet")
      .action((options) => {
        ensureWalletDir();
        if (fs.existsSync(WALLET_FILE) && !options.force) {
          console.error("Error: Wallet already exists. Use --force to overwrite.");
          process.exit(1);
        }
        const keypair = Keypair.generate();
        const walletData = {
          pubkey: keypair.publicKey.toBase58(),
          secretKey: Array.from(keypair.secretKey),
        };
        fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
          mode: 0o600,
        });
        fs.chmodSync(WALLET_FILE, 0o600);
        console.log("✓ New wallet created");
        console.log(`  Pubkey: ${walletData.pubkey}`);
        console.log(`  Saved to: ${WALLET_FILE}`);

        const creds = readCredentials();
        if (creds) {
          prismApiPost("/v1/wallet", { pubkey: walletData.pubkey }, { apiKey: creds.apiKey }).then(
            (result) => {
              if (!result.ok) {
                console.warn(
                  "Warning: Could not sync wallet to cloud. Run 'prism wallet generate' again if needed.",
                );
              }
            },
          );
        }
      }),
  )
  .addCommand(
    new Command("show")
      .description("Show the effective wallet pubkey (WALLET_PRIVATE_KEY env, then local keystore)")
      .action(() => {
        const effective = resolveEffectivePubkey();
        if (!effective) {
          if (process.env.WALLET_PRIVATE_KEY?.trim()) {
            console.error(
              "Error: WALLET_PRIVATE_KEY is set but could not be decoded, and no keystore wallet exists.",
            );
          } else {
            console.error(
              "Error: No wallet found. Run 'prism wallet generate' first, or set WALLET_PRIVATE_KEY.",
            );
          }
          process.exit(1);
        }
        console.log(effective.pubkey);
        console.error(
          effective.source === "env"
            ? "(source: WALLET_PRIVATE_KEY environment variable)"
            : `(source: keystore ${WALLET_FILE})`,
        );
      }),
  )
  .addCommand(
    new Command("import")
      .description("Import an existing keypair")
      .argument(
        "[keypair]",
        "Keypair as a JSON array, OR a path to a keypair JSON file (file paths are auto-detected)",
      )
      .option("--force", "Overwrite existing wallet")
      .option("--file <path>", "Read keypair JSON from file (recommended; secure)")
      .option("--stdin", "Read keypair from stdin (recommended; secure, piped input)")
      .addHelpText(
        "after",
        `
Examples:
  $ prism wallet import --file /path/to/keypair.json   # read from file (recommended)
  $ prism wallet import /path/to/keypair.json          # file path auto-detected
  $ cat keypair.json | prism wallet import --stdin      # read from stdin (recommended)
  $ prism wallet import '[1,2,3,...]'                   # inline JSON (visible to ps/history; not recommended)
`,
      )
      .action(async (keypairStr, options) => {
        ensureWalletDir();
        if (fs.existsSync(WALLET_FILE) && !options.force) {
          console.error("Error: Wallet already exists. Use --force to overwrite.");
          process.exit(1);
        }

        let secretKey: number[];

        if (options.file) {
          try {
            const fileContent = fs.readFileSync(options.file, "utf-8");
            secretKey = JSON.parse(fileContent);
          } catch (err) {
            console.error(`Error: Failed to read or parse keypair file '${options.file}'`);
            process.exit(1);
          }
        } else if (options.stdin) {
          const input = await readStdin();
          try {
            secretKey = JSON.parse(input);
          } catch (err) {
            console.error("Error: Invalid keypair JSON from stdin");
            process.exit(1);
          }
        } else if (keypairStr) {
          if (isExistingFile(keypairStr)) {
            // A bare file path passed positionally, e.g. `prism wallet import ./kp.json`.
            // A JSON array string is never an existing file, so this is unambiguous.
            try {
              const fileContent = fs.readFileSync(keypairStr, "utf-8");
              secretKey = JSON.parse(fileContent);
            } catch {
              console.error(`Error: Failed to read or parse keypair file '${keypairStr}'`);
              process.exit(1);
            }
          } else {
            console.warn(
              "⚠️  SECURITY WARNING: Providing a keypair as a CLI argument exposes it to `ps aux` and shell history. Use --file or --stdin instead.",
            );
            try {
              secretKey = JSON.parse(keypairStr);
            } catch {
              console.error(
                "Error: Invalid keypair JSON, and no such keypair file exists. Provide a valid JSON array or an existing file path.",
              );
              process.exit(1);
            }
          }
        } else {
          console.error(
            "Error: Keypair required. Provide via --file <path>, --stdin, or as a positional argument (not recommended).",
          );
          process.exit(1);
        }

        let keypair: Keypair;
        try {
          keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
        } catch (err) {
          console.error(
            "Error: Invalid keypair. The secret key array may have the wrong length or format.",
          );
          process.exit(1);
        }
        const walletData = {
          pubkey: keypair.publicKey.toBase58(),
          secretKey: Array.from(keypair.secretKey),
        };
        fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
          mode: 0o600,
        });
        fs.chmodSync(WALLET_FILE, 0o600);
        console.log("✓ Wallet imported");
        console.log(`  Pubkey: ${walletData.pubkey}`);

        const creds = readCredentials();
        if (creds) {
          prismApiPost("/v1/wallet", { pubkey: walletData.pubkey }, { apiKey: creds.apiKey }).then(
            (result) => {
              if (!result.ok) {
                console.warn(
                  "Warning: Could not sync wallet to cloud. Run 'prism wallet import' again if needed.",
                );
              }
            },
          );
        }
      }),
  );

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      try {
        Bun.spawnSync(["stty", "-echo"], { stdin: "inherit", stdout: "inherit" });
      } catch {
        /* non-POSIX shell */
      }
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: false,
      });
      rl.on("close", () => {
        try {
          Bun.spawnSync(["stty", "echo"], { stdin: "inherit", stdout: "inherit" });
        } catch {
          /* restore best-effort */
        }
      });
      rl.question("Paste keypair JSON and press Enter (input hidden): ", (answer) => {
        rl.close();
        process.stdout.write("\n");
        resolve(answer.trim());
      });
    } else {
      let data = "";
      process.stdin.setEncoding("utf-8");
      process.stdin.on("data", (chunk) => {
        data += chunk;
      });
      process.stdin.on("end", () => {
        resolve(data.trim());
      });
      process.stdin.on("error", (err) => {
        reject(err);
      });
      process.stdin.resume();
    }
  });
}
