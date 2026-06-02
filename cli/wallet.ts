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
      .action(() => {
        ensureWalletDir();
        const keypair = Keypair.generate();
        const walletData = {
          pubkey: keypair.publicKey.toBase58(),
          secretKey: Array.from(keypair.secretKey),
        };
        fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), {
          mode: 0o600,
        });
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
        const walletData = JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8"));
        console.log(walletData.pubkey);
      }),
  )
  .addCommand(
    new Command("import")
      .description("Import an existing keypair")
      .argument("[keypair]", "Keypair as JSON array")
      .action((keypairStr) => {
        ensureWalletDir();
        let secretKey: number[];
        if (keypairStr) {
          secretKey = JSON.parse(keypairStr);
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
        console.log("✓ Wallet imported");
        console.log(`  Pubkey: ${walletData.pubkey}`);
      }),
  );
