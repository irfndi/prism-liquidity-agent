import { Command } from "commander";
import fs from "fs";
import path from "path";
import readline from "readline";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { readCredentials, prismApiPost } from "./api.js";
import { getPrismUserConfigDir } from "../engine/paths.js";
import { getWalletKeystorePath } from "../engine/wallet-keystore.js";

const WALLET_DIR = getPrismUserConfigDir();
const WALLET_FILE = getWalletKeystorePath();

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

// The `prism` wrapper (scripts/prism.sh) `cd`s into the package root before running
// the CLI, so a relative positional path like `./kp.json` must be resolved against the
// caller's original directory (captured as PRISM_CALLER_CWD), not the package root.
// Falls back to cwd for direct `bun cli/index.ts` invocations where no wrapper set it.
function resolveImportPath(candidate: string): string {
  if (path.isAbsolute(candidate)) return candidate;
  const callerCwd = process.env.PRISM_CALLER_CWD;
  return callerCwd ? path.resolve(callerCwd, candidate) : candidate;
}

function guardWalletAbsent(force: boolean): void {
  if (fs.existsSync(WALLET_FILE) && !force) {
    console.error("Error: Wallet already exists. Use --force to overwrite.");
    process.exit(1);
  }
}

function writeWalletFile(keypair: Keypair): string {
  const walletData = {
    pubkey: keypair.publicKey.toBase58(),
    secretKey: Array.from(keypair.secretKey),
  };
  fs.writeFileSync(WALLET_FILE, JSON.stringify(walletData, null, 2), { mode: 0o600 });
  fs.chmodSync(WALLET_FILE, 0o600);
  return walletData.pubkey;
}

function syncWalletToCloud(pubkey: string, command: string): void {
  const creds = readCredentials();
  if (!creds) return;
  void prismApiPost("/v1/wallet", { pubkey }, { apiKey: creds.apiKey }).then((result) => {
    if (!result.ok) {
      console.warn(
        `Warning: Could not sync wallet to cloud. Run 'prism wallet ${command}' again if needed.`,
      );
    }
  });
}

function loadKeypairFile(resolvedPath: string, displayPath: string): number[] {
  try {
    return JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  } catch {
    console.error(`Error: Failed to read or parse keypair file '${displayPath}'`);
    process.exit(1);
  }
}

function parseStdinKeypair(input: string): number[] {
  try {
    return JSON.parse(input);
  } catch {
    console.error("Error: Invalid keypair JSON from stdin");
    process.exit(1);
  }
}

function parseInlineKeypair(keypairStr: string): number[] {
  console.warn(
    "⚠️  SECURITY WARNING: Providing a keypair as a CLI argument exposes it to `ps aux` and shell history. Use --file or --stdin instead.",
  );
  try {
    return JSON.parse(keypairStr);
  } catch {
    console.error(
      "Error: Invalid keypair JSON, and no such keypair file exists. Provide a valid JSON array or an existing file path.",
    );
    process.exit(1);
  }
}

async function readImportSecretKey(
  keypairStr: string | undefined,
  fileOpt: string | undefined,
  stdinOpt: boolean,
): Promise<number[]> {
  if (fileOpt) return loadKeypairFile(resolveImportPath(fileOpt), fileOpt);
  if (stdinOpt) return parseStdinKeypair(await readStdin());
  if (keypairStr && isExistingFile(resolveImportPath(keypairStr))) {
    return loadKeypairFile(resolveImportPath(keypairStr), keypairStr);
  }
  if (keypairStr) return parseInlineKeypair(keypairStr);
  console.error(
    "Error: Keypair required. Provide via --file <path>, --stdin, or as a positional argument (not recommended).",
  );
  process.exit(1);
}

function buildImportKeypair(secretKey: number[]): Keypair {
  try {
    return Keypair.fromSecretKey(Uint8Array.from(secretKey));
  } catch {
    console.error(
      "Error: Invalid keypair. The secret key array may have the wrong length or format.",
    );
    process.exit(1);
  }
}

// Effective-wallet resolution, mirroring the engine (engine/config-service.ts):
// WALLET_PRIVATE_KEY (base58, decoded exactly like engine/adapter-service.ts) takes
// precedence, then the local keystore written by `prism wallet generate|import` — the
// engine loads the same keystore as its fallback, so a generated/imported wallet IS the
// engine's signing wallet. If the env key is present but invalid, returns an error rather
/** Resolves the effective wallet identity without hiding malformed configured keys. */
export function resolveEffectivePubkey(): {
  pubkey: string;
  source: "env" | "keystore";
  error?: string;
} | null {
  const envKey = process.env.WALLET_PRIVATE_KEY?.trim();
  if (envKey) {
    try {
      return {
        pubkey: Keypair.fromSecretKey(bs58.decode(envKey)).publicKey.toBase58(),
        source: "env",
      };
    } catch {
      return {
        pubkey: "",
        source: "env",
        error: "WALLET_PRIVATE_KEY is set but could not be decoded as a base58 private key.",
      };
    }
  }
  if (fs.existsSync(WALLET_FILE)) {
    try {
      // SAFETY: The surrounding runtime boundary establishes the asserted contract before this value is consumed.
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
        guardWalletAbsent(options.force);
        const pubkey = writeWalletFile(Keypair.generate());
        console.log("✓ New wallet created");
        console.log(`  Pubkey: ${pubkey}`);
        console.log(`  Saved to: ${WALLET_FILE}`);
        syncWalletToCloud(pubkey, "generate");
      }),
  )
  .addCommand(
    new Command("show")
      .description(
        "Show the effective wallet pubkey (WALLET_PRIVATE_KEY env, then the local keystore). Both are usable by the engine for signing.",
      )
      .action(() => {
        const effective = resolveEffectivePubkey();
        if (effective?.error) {
          console.error(`Error: ${effective.error}`);
          process.exit(1);
        }
        if (!effective) {
          console.error(
            "Error: No wallet found. Run 'prism wallet generate' first, or set WALLET_PRIVATE_KEY.",
          );
          process.exit(1);
        }
        console.log(effective.pubkey);
        if (effective.source === "env") {
          console.error("(source: WALLET_PRIVATE_KEY environment variable)");
        } else {
          console.error(`(source: keystore ${WALLET_FILE})`);
        }
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
        guardWalletAbsent(options.force);
        // A bare file path passed positionally, e.g. `prism wallet import ./kp.json`
        // (resolved against the caller's directory). A JSON array string is never an
        // existing file, so this detection is unambiguous.
        const secretKey = await readImportSecretKey(keypairStr, options.file, options.stdin);
        const pubkey = writeWalletFile(buildImportKeypair(secretKey));
        console.log("✓ Wallet imported");
        console.log(`  Pubkey: ${pubkey}`);
        syncWalletToCloud(pubkey, "import");
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
