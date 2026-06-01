import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as bs58 from "bs58";

const HELIUS_RPC = process.env.HELIUS_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=1f666b14-e8af-4883-96f0-e3c0aadecc2f";
const conn = new Connection(HELIUS_RPC, "confirmed");
const wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function swap() {
  const solBal = await conn.getBalance(wallet.publicKey);
  const solAmount = solBal / 1e9;
  console.log(`SOL: ${solAmount.toFixed(6)}`);

  // Swap half of SOL (leave some for gas)
  const swapSol = Math.floor((solAmount - 0.03) / 2 * 1e9); // Leave 0.03 SOL gas, swap half of rest
  if (swapSol < 0.01 * 1e9) {
    console.log("Not enough SOL to swap");
    return;
  }

  console.log(`Swapping ${(swapSol / 1e9).toFixed(6)} SOL to USDC...`);

  // Jupiter quote
  const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=${swapSol}&slippageBps=100`;
  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) throw new Error(`Quote failed: ${quoteRes.status}`);
  const quote = await quoteRes.json();

  console.log(`Expected USDC out: ${quote.outAmount / 1e6}`);

  // Jupiter swap
  const swapBody = {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
  };
  const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapBody),
  });
  if (!swapRes.ok) throw new Error(`Swap failed: ${swapRes.status}`);
  const swapData = await swapRes.json();

  // Deserialize and sign
  const txBuffer = Buffer.from(swapData.swapTransaction, "base64");
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
  const newSolAmount = newSol / 1e9;
  console.log(`New SOL: ${newSolAmount.toFixed(6)}`);

  const usdcAcc = await conn.getTokenAccountsByOwner(wallet.publicKey, { mint: new PublicKey(USDC_MINT) });
  if (usdcAcc.value.length > 0) {
    const bal = await conn.getTokenAccountBalance(usdcAcc.value[0].pubkey);
    console.log(`New USDC: ${bal.value.uiAmount}`);
  }
}

swap().catch(console.error);
