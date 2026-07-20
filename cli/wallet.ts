import { Command } from "commander";
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import { Keypair } from "@solana/web3.js";
import { readCredentials, prismApiPost } from "./api.js";

const WALLET_DIR = path.join(os.homedir(), ".config", "prism");
const WALLET_FILE = path.join(WALLET_DIR, "wallet.json");

function ensureWalletDir() {
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
  }
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
    new Command("show").description("Show wallet pubkey").action(() => {
      if (!fs.existsSync(WALLET_FILE)) {
        console.error("Error: No wallet found. Run 'prism wallet generate' first.");
        process.exit(1);
      }
      let walletData: { pubkey: string };
      try {
        walletData = JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8"));
      } catch (err) {
        console.error("Error: Failed to parse wallet file. It may be corrupted.");
        process.exit(1);
      }
      console.log(walletData.pubkey);
    }),
  )
  .addCommand(
    new Command("import")
      .description("Import an existing keypair")
      .argument("[keypair]", "Keypair as JSON array (not recommended — visible in shell history)")
      .option("--force", "Overwrite existing wallet")
      .option("--file <path>", "Read keypair JSON from file (secure)")
      .option("--stdin", "Read keypair from stdin (secure, piped input)")
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
          console.warn(
            "⚠️  SECURITY WARNING: Providing a keypair as a CLI argument exposes it to `ps aux` and shell history. Use --file or --stdin instead.",
          );
          try {
            secretKey = JSON.parse(keypairStr);
          } catch (err) {
            console.error("Error: Invalid keypair JSON format");
            process.exit(1);
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
