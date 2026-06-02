import { Command } from "commander";
import fs from "fs";
import path from "path";
import os from "os";
import { Keypair } from "@solana/web3.js";

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
      }),
  )
  .addCommand(
    new Command("show")
      .description("Show wallet pubkey")
      .action(() => {
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
      .argument("[keypair]", "Keypair as JSON array")
      .option("--force", "Overwrite existing wallet")
      .action((keypairStr, options) => {
        ensureWalletDir();
        if (fs.existsSync(WALLET_FILE) && !options.force) {
          console.error("Error: Wallet already exists. Use --force to overwrite.");
          process.exit(1);
        }
        let secretKey: number[];
        if (keypairStr) {
          try {
            secretKey = JSON.parse(keypairStr);
          } catch (err) {
            console.error("Error: Invalid keypair JSON format");
            process.exit(1);
          }
        } else {
          console.error("Error: Keypair required");
          process.exit(1);
        }
        const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));
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
      }),
  );
