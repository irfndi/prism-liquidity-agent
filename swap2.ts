import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as bs58 from "bs58";
import { createJupiterApiClient } from "@jup-ag/api";

const HELIUS_RPC = process.env.HELIUS_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=1f666b14-e8af-4883-96f0-e3c0aadecc2f";
const conn = new Connection(HELIUS_RPC, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));

const jupiter = createJupiterApiClient({ basePath: "https://api.jup.ag" });

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function swap() {
  const solBal = await conn.getBalance(wallet.publicKey);
  const solAmount = solBal / 1e9;
  console.log(`SOL: ${solAmount.toFixed(6)}`);

  // Swap half of SOL (leave 0.03 for gas)
  const swapSol = Math.floor((solAmount - 0.03) / 2 * 1e9);
  if (swapSol < 0.01 * 1e9) {
    console.log("Not enough SOL to swap");
    return;
  }

  console.log(`Swapping ${(swapSol / 1e9).toFixed(6)} SOL to USDC...`);

  try {
    // Get quote
    const quote = await jupiter.quoteGet({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: swapSol,
      slippageBps: 100,
      onlyDirectRoutes: false,
    });

    console.log(`Expected USDC out: ${(Number(quote.outAmount) / 1e6).toFixed(2)}`);

    // Get swap transaction
    const swapResult = await jupiter.swapPost({
      swapRequest: {
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      },
    });

    // Deserialize and sign
    const txBuffer = Buffer.from(swapResult.swapTransaction, "base64");
    const tx = require("@solana/web3.js").VersionedTransaction.deserialize(txBuffer);
    tx.sign([wallet]);

    const sig = await conn.sendTransaction(tx, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    console.log(`Swap tx: ${sig}`);

    await conn.confirmTransaction(sig, "confirmed");
    console.log("Swap confirmed!");

    // Check new balances
    const newSol = await conn.getBalance(wallet.publicKey);
    console.log(`New SOL: ${(newSol / 1e9).toFixed(6)}`);

    const usdcAcc = await conn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(USDC_MINT) });
    if (usdcAcc.value.length > 0) {
      const bal = await conn.getTokenAccountBalance(usdcAcc.value[0].pubkey);
      console.log(`New USDC: ${bal.value.uiAmount}`);
    }
  } catch (err: any) {
    console.error("Swap failed:", err.message || err);
    if (err.response) {
      console.error("API response:", await err.response.text().catch(() => "unknown"));
    }
  }
}

swap();
