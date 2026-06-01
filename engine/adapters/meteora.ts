import { Connection, PublicKey, Keypair, Transaction } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { createLogger } from "../logger.js";
import type { BinArray, BinData, PoolState, Position } from "../types.js";
import { config } from "../config.js";
import bs58 from "bs58";
import { BN } from "@coral-xyz/anchor";

const log = createLogger("MeteoraAdapter");

export class MeteoraAdapter {
  private connection: Connection;
  private wallet: Keypair | null = null;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
    if (config.WALLET_PRIVATE_KEY) {
      try {
        this.wallet = Keypair.fromSecretKey(bs58.decode(config.WALLET_PRIVATE_KEY));
        log.info("Wallet loaded", { address: this.wallet.publicKey.toBase58() });
      } catch (err) {
        log.error("Failed to load wallet", { err });
      }
    }
  }

  hasWallet(): boolean {
    return this.wallet !== null;
  }

  getWalletAddress(): string | null {
    return this.wallet?.publicKey.toBase58() ?? null;
  }

  getConnection(): Connection {
    return this.connection;
  }

  getWalletPublicKey(): PublicKey | null {
    return this.wallet?.publicKey ?? null;
  }

  async getWalletBalanceUsd(): Promise<number> {
    if (!this.wallet) return 0;
    
    try {
      const solBal = await this.connection.getBalance(this.wallet.publicKey);
      const solAmount = solBal / 1e9;
      
      // Hardcoded SOL price fallback (update via cron or price feed later)
      const solPrice = 165; // ~$165/SOL
      const solValue = solAmount * solPrice;
      
      // Check USDC
      const usdcMint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: usdcMint }
      );
      
      let usdcValue = 0;
      if (tokenAccounts.value.length > 0 && tokenAccounts.value[0]) {
        const bal = await this.connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
        usdcValue = bal.value.uiAmount ?? 0;
      }
      
      return solValue + usdcValue;
    } catch (err) {
      log.error("Failed to get wallet balance", { err });
      return 0;
    }
  }

  async getPoolState(poolAddress: string): Promise<PoolState> {
    try {
      const pubkey = new PublicKey(poolAddress);
      const dlmm = await DLMM.create(this.connection, pubkey);

      const lbPair = dlmm.lbPair;
      const activeBin = await dlmm.getActiveBin();

      // Fetch token metadata from Helius
      const [tokenXMeta, tokenYMeta] = await Promise.all([
        this.getTokenMeta(lbPair.tokenXMint.toBase58()),
        this.getTokenMeta(lbPair.tokenYMint.toBase58()),
      ]);

      // Fetch pool stats from Helius DAS / Meteora API
      const stats = await this.fetchPoolStats(poolAddress);

      return {
        address: poolAddress,
        tokenX: lbPair.tokenXMint.toBase58(),
        tokenY: lbPair.tokenYMint.toBase58(),
        tokenXSymbol: tokenXMeta.symbol,
        tokenYSymbol: tokenYMeta.symbol,
        tvlUsd: stats.tvlUsd,
        volume24hUsd: stats.volume24hUsd,
        fees24hUsd: stats.fees24hUsd,
        apr: stats.apr,
        activeBinId: activeBin.binId,
        binStep: lbPair.binStep,
        currentPrice: Number(activeBin.price),
        timestamp: Date.now(),
      };
    } catch (err) {
      log.error("Failed to get pool state", { poolAddress, err });
      throw err;
    }
  }

  async getBinArray(poolAddress: string): Promise<BinArray> {
    const pubkey = new PublicKey(poolAddress);
    const dlmm = await DLMM.create(this.connection, pubkey);

    const activeBin = await dlmm.getActiveBin();
    const halfRange = 20;
    const lowerBinId = activeBin.binId - halfRange;
    const upperBinId = activeBin.binId + halfRange;
    const binStep = Number(dlmm.lbPair.binStep);

    // Build synthetic bins — the DLMM SDK's getBinsBetweenLowerAndUpperBound
    // crashes on many mainnet pools due to sparse bin arrays. We only need
    // bin IDs and prices for strategy decisions, not actual reserves.
    const bins: BinData[] = [];
    const basePrice = Number(activeBin.price);
    for (let i = lowerBinId; i <= upperBinId; i++) {
      const price = basePrice * Math.pow(1 + binStep / 10000, i - activeBin.binId);
      bins.push({
        binId: i,
        price,
        reserveX: 0n,
        reserveY: 0n,
        liquiditySupply: 1n,
      });
    }

    return {
      lowerBinId,
      upperBinId,
      bins,
      activeBinId: activeBin.binId,
      binStep,
    };
  }

  async getPositions(poolAddress: string, walletAddress: string): Promise<Position[]> {
    const pubkey = new PublicKey(poolAddress);
    const wallet = new PublicKey(walletAddress);
    const dlmm = await DLMM.create(this.connection, pubkey);

    const { userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet);

    return userPositions.map((p) => {
      const data = p.positionData;
      return {
        id: p.publicKey.toBase58(),
        poolAddress,
        poolName: `${poolAddress.slice(0, 6)}...`,
        lowerBinId: data.lowerBinId,
        upperBinId: data.upperBinId,
        liquidityShares: BigInt(data.totalXAmount.toString()),
        depositedUsd: 0, // requires price feed integration
        currentValueUsd: 0,
        unrealizedPnlUsd: 0,
        feesEarnedUsd: Number(data.feeX.toString()) + Number(data.feeY.toString()),
        openedAt: data.lastUpdatedAt * 1000,
      };
    });
  }

  async simulateRebalance(
    poolAddress: string,
    newLowerBinId: number,
    newUpperBinId: number
  ): Promise<{ estimatedIlUsd: number; estimatedFeesUsd: number; netBenefitUsd: number }> {
    // Simulation using bin price data
    const binArray = await this.getBinArray(poolAddress);
    const activeBin = binArray.bins.find((b) => b.binId === binArray.activeBinId);

    if (!activeBin) {
      return { estimatedIlUsd: 0, estimatedFeesUsd: 0, netBenefitUsd: 0 };
    }

    const rangeWidth = newUpperBinId - newLowerBinId;
    const estimatedFeesUsd = (rangeWidth / 40) * 10; // rough heuristic
    const estimatedIlUsd = rangeWidth > 30 ? rangeWidth * 0.5 : 0;
    const netBenefitUsd = estimatedFeesUsd - estimatedIlUsd;

    return { estimatedIlUsd, estimatedFeesUsd, netBenefitUsd };
  }

  // ─── Live Trading Execution ─────────────────────────────────────────────────

  private async getTokenBalance(mintAddress: string): Promise<bigint> {
    if (!this.wallet) return 0n;
    try {
      const mint = new PublicKey(mintAddress);
      const accounts = await this.connection.getTokenAccountsByOwner(
        this.wallet!.publicKey,
        { mint }
      );
      if (accounts.value.length === 0 || !accounts.value[0]) return 0n;
      const bal = await this.connection.getTokenAccountBalance(accounts.value[0].pubkey);
      return BigInt(bal.value.amount);
    } catch {
      return 0n;
    }
  }

  async enterPosition(
    poolAddress: string,
    lowerBinId: number,
    upperBinId: number,
    positionSizeUsd: number
  ): Promise<{ positionPubKey: string; txSignature: string } | null> {
    if (!this.wallet) {
      log.error("No wallet configured");
      return null;
    }

    try {
      const poolPubkey = new PublicKey(poolAddress);
      const dlmm = await DLMM.create(this.connection, poolPubkey);
      const pool = await this.getPoolState(poolAddress);

      log.info("Entering position", {
        pool: poolAddress,
        range: `${lowerBinId}-${upperBinId}`,
        sizeUsd: positionSizeUsd,
      });

      // Fetch token prices to convert USD to token amounts
      const prices = await this.fetchTokenPrices([pool.tokenX, pool.tokenY]);
      const priceX = prices[pool.tokenX] ?? 0;
      const priceY = prices[pool.tokenY] ?? 0;

      if (!priceX || !priceY) {
        log.error("Could not fetch token prices for pool", { pool: poolAddress });
        return null;
      }

      // 50/50 split by value for Spot strategy
      const halfUsd = positionSizeUsd / 2;
      const tokenXDecimals = await this.getTokenDecimals(pool.tokenX);
      const tokenYDecimals = await this.getTokenDecimals(pool.tokenY);

      let totalXAmount = new BN(Math.floor((halfUsd / priceX) * Math.pow(10, tokenXDecimals)));
      let totalYAmount = new BN(Math.floor((halfUsd / priceY) * Math.pow(10, tokenYDecimals)));

      // Check actual token balances and cap deposit amounts
      const balanceX = await this.getTokenBalance(pool.tokenX);
      const balanceY = await this.getTokenBalance(pool.tokenY);
      
      // For wrapped SOL, also check native SOL balance
      let nativeSolBalance = 0n;
      if (pool.tokenX === 'So11111111111111111111111111111111111111112' || 
          pool.tokenY === 'So11111111111111111111111111111111111111112') {
        nativeSolBalance = BigInt(await this.connection.getBalance(this.wallet.publicKey));
      }

      // Cap X amount
      const maxX = pool.tokenX === 'So11111111111111111111111111111111111111112' 
        ? nativeSolBalance 
        : balanceX;
      if (BigInt(totalXAmount.toString()) > maxX) {
        log.warn("Capping X deposit to available balance", { 
          requested: totalXAmount.toString(), 
          available: maxX.toString() 
        });
        totalXAmount = new BN(maxX.toString());
      }

      // Cap Y amount
      const maxY = pool.tokenY === 'So11111111111111111111111111111111111111112' 
        ? nativeSolBalance 
        : balanceY;
      if (BigInt(totalYAmount.toString()) > maxY) {
        log.warn("Capping Y deposit to available balance", { 
          requested: totalYAmount.toString(), 
          available: maxY.toString() 
        });
        totalYAmount = new BN(maxY.toString());
      }

      // Skip if either side is zero
      if (totalXAmount.eq(new BN(0)) || totalYAmount.eq(new BN(0))) {
        log.error("Insufficient token balance to enter position", {
          pool: poolAddress,
          tokenX: pool.tokenX,
          tokenY: pool.tokenY,
          balanceX: maxX.toString(),
          balanceY: maxY.toString(),
        });
        return null;
      }

      const positionKeypair = new Keypair();
      const strategy = {
        minBinId: lowerBinId,
        maxBinId: upperBinId,
        strategyType: 0, // StrategyType.Spot
      };

      const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
        positionPubKey: positionKeypair.publicKey,
        totalXAmount,
        totalYAmount,
        strategy,
        user: this.wallet.publicKey,
        slippage: 50, // 0.5%
      });

      tx.feePayer = this.wallet.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash()).blockhash;
      tx.sign(this.wallet, positionKeypair);

      const signature = await this.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      await this.connection.confirmTransaction(signature, "confirmed");

      log.info("Position entered successfully", {
        pool: poolAddress,
        position: positionKeypair.publicKey.toBase58(),
        tx: signature,
      });

      return { positionPubKey: positionKeypair.publicKey.toBase58(), txSignature: signature };
    } catch (err) {
      log.error("Failed to enter position", { poolAddress, err });
      return null;
    }
  }

  async exitPosition(
    poolAddress: string,
    positionPubKey: string
  ): Promise<{ txSignature: string } | null> {
    if (!this.wallet) {
      log.error("No wallet configured");
      return null;
    }

    try {
      const poolPubkey = new PublicKey(poolAddress);
      const positionPubkey = new PublicKey(positionPubKey);
      const dlmm = await DLMM.create(this.connection, poolPubkey);

      const position = await dlmm.getPosition(positionPubkey);
      const lowerBinId = position.positionData.lowerBinId;
      const upperBinId = position.positionData.upperBinId;

      log.info("Exiting position", {
        pool: poolAddress,
        position: positionPubKey,
        range: `${lowerBinId}-${upperBinId}`,
      });

      const txs = await dlmm.removeLiquidity({
        user: this.wallet.publicKey,
        position: positionPubkey,
        fromBinId: lowerBinId,
        toBinId: upperBinId,
        bps: new BN(10000), // 100%
        shouldClaimAndClose: true,
      });

      const latestBlockhash = await this.connection.getLatestBlockhash();
      for (const tx of txs) {
        tx.feePayer = this.wallet.publicKey;
        tx.recentBlockhash = latestBlockhash.blockhash;
        tx.sign(this.wallet);

        const signature = await this.connection.sendRawTransaction(tx.serialize(), {
          skipPreflight: false,
          preflightCommitment: "confirmed",
        });

        await this.connection.confirmTransaction(signature, "confirmed");
        log.info("Exit transaction confirmed", { tx: signature });
      }

      return { txSignature: "batch-confirmed" };
    } catch (err) {
      log.error("Failed to exit position", { poolAddress, positionPubKey, err });
      return null;
    }
  }

  async rebalancePosition(
    poolAddress: string,
    positionPubKey: string,
    newLowerBinId: number,
    newUpperBinId: number
  ): Promise<{ newPositionPubKey: string; txSignatures: string[] } | null> {
    if (!this.wallet) {
      log.error("No wallet configured");
      return null;
    }

    try {
      // Step 1: Exit old position
      const exitResult = await this.exitPosition(poolAddress, positionPubKey);
      if (!exitResult) {
        log.error("Rebalance failed: could not exit old position", { poolAddress, positionPubKey });
        return null;
      }

      // Step 2: Get current pool state to determine new position size
      const pool = await this.getPoolState(poolAddress);
      const positionSizeUsd = Math.min(
        config.PAPER_PORTFOLIO_USD * 0.2,
        pool.tvlUsd * 0.01
      );

      // Step 3: Enter new position
      const enterResult = await this.enterPosition(poolAddress, newLowerBinId, newUpperBinId, positionSizeUsd);
      if (!enterResult) {
        log.error("Rebalance failed: could not enter new position", { poolAddress });
        return null;
      }

      return {
        newPositionPubKey: enterResult.positionPubKey,
        txSignatures: [exitResult.txSignature, enterResult.txSignature],
      };
    } catch (err) {
      log.error("Rebalance failed", { poolAddress, positionPubKey, err });
      return null;
    }
  }

  // ─── Jupiter Swap Helper ────────────────────────────────────────────────────

  async swapViaJupiter(
    inputMint: string,
    outputMint: string,
    amount: number, // in input token base units
    slippageBps: number = 50
  ): Promise<{ txSignature: string } | null> {
    if (!this.wallet) {
      log.error("No wallet configured for swap");
      return null;
    }

    try {
      // 1. Get quote
      const quoteRes = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`
      );
      const quote = await quoteRes.json() as { data?: Record<string, any>; error?: string };
      if (!quote || quote.error) {
        log.error("Jupiter quote failed", { quote });
        return null;
      }

      // 2. Get swap transaction
      const swapRes = await fetch("https://quote-api.jup.ag/v6/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse: quote,
          userPublicKey: this.wallet.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        }),
      });
      const swapData = await swapRes.json() as { swapTransaction?: string; error?: string };
      if (!swapData.swapTransaction) {
        log.error("Jupiter swap transaction failed", { swapData });
        return null;
      }

      // 3. Deserialize and sign
      const swapTransactionBuf = Buffer.from(swapData.swapTransaction, "base64");
      const transaction = Transaction.from(swapTransactionBuf);
      transaction.sign(this.wallet);

      const signature = await this.connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: "confirmed",
      });

      await this.connection.confirmTransaction(signature, "confirmed");
      log.info("Jupiter swap confirmed", { inputMint, outputMint, amount, tx: signature });
      return { txSignature: signature };
    } catch (err) {
      log.error("Jupiter swap failed", { inputMint, outputMint, amount, err });
      return null;
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private async getTokenMeta(mint: string): Promise<{ symbol: string; decimals: number }> {
    try {
      const url = `https://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "get-asset",
          method: "getAsset",
          params: { id: mint },
        }),
      });
      const json = (await res.json()) as {
        result?: { content?: { metadata?: { symbol?: string } }; token_info?: { decimals?: number } };
      };
      return {
        symbol: json.result?.content?.metadata?.symbol ?? mint.slice(0, 4),
        decimals: json.result?.token_info?.decimals ?? 6,
      };
    } catch {
      return { symbol: mint.slice(0, 4), decimals: 6 };
    }
  }

  private async getTokenDecimals(mint: string): Promise<number> {
    const meta = await this.getTokenMeta(mint);
    return meta.decimals;
  }

  private async fetchPoolStats(
    poolAddress: string
  ): Promise<{ tvlUsd: number; volume24hUsd: number; fees24hUsd: number; apr: number }> {
    try {
      const pubkey = new PublicKey(poolAddress);
      const dlmm = await DLMM.create(this.connection, pubkey);
      const lbPair = dlmm.lbPair;

      // Get token mints
      const tokenXMint = lbPair.tokenXMint.toBase58();
      const tokenYMint = lbPair.tokenYMint.toBase58();

      // Fetch token decimals from mint accounts
      const [mintXInfo, mintYInfo] = await Promise.all([
        this.connection.getParsedAccountInfo(lbPair.tokenXMint),
        this.connection.getParsedAccountInfo(lbPair.tokenYMint),
      ]);

      const tokenXDecimals = (mintXInfo.value?.data as any)?.parsed?.info?.decimals ?? 9;
      const tokenYDecimals = (mintYInfo.value?.data as any)?.parsed?.info?.decimals ?? 6;

      // Get pool vault token accounts (ATAs owned by the pool)
      const vaultX = await this.connection.getTokenAccountsByOwner(
        pubkey,
        { mint: lbPair.tokenXMint }
      );
      const vaultY = await this.connection.getTokenAccountsByOwner(
        pubkey,
        { mint: lbPair.tokenYMint }
      );

      let reserveX = 0;
      let reserveY = 0;

      if (vaultX.value.length > 0) {
        const firstVault = vaultX.value[0] as { pubkey: PublicKey };
        const balance = await this.connection.getTokenAccountBalance(firstVault.pubkey);
        reserveX = Number(balance.value.amount) / Math.pow(10, tokenXDecimals);
      }
      if (vaultY.value.length > 0) {
        const firstVault = vaultY.value[0] as { pubkey: PublicKey };
        const balance = await this.connection.getTokenAccountBalance(firstVault.pubkey);
        reserveY = Number(balance.value.amount) / Math.pow(10, tokenYDecimals);
      }

      // Fetch token prices from Jupiter
      const prices = await this.fetchTokenPrices([tokenXMint, tokenYMint]);
      const priceX = prices[tokenXMint] || 0;
      const priceY = prices[tokenYMint] || 0;

      const tvlUsd = reserveX * priceX + reserveY * priceY;

      // Estimate 24h metrics from TVL and binStep
      // Higher binStep = more volatile = higher volume and fees
      const binStep = Number(lbPair.binStep);
      const turnoverRate = 0.3 + (binStep / 100) * 0.5; // 0.3 to 0.8 based on volatility
      const estimatedVolume24h = tvlUsd * turnoverRate;
      const feeRate = 0.0025 + (binStep / 10000); // 0.25% to 1.25%
      const fees24hUsd = estimatedVolume24h * feeRate;
      const apr = tvlUsd > 0 ? (fees24hUsd * 365 / tvlUsd) * 100 : 0;

      return {
        tvlUsd,
        volume24hUsd: estimatedVolume24h,
        fees24hUsd,
        apr,
      };
    } catch (err) {
      log.warn("Failed to fetch pool stats from on-chain data", { poolAddress, err: (err as Error).message });
      return { tvlUsd: 0, volume24hUsd: 0, fees24hUsd: 0, apr: 0 };
    }
  }

  private async fetchTokenPrices(mints: string[]): Promise<Record<string, number>> {
    // Fallback price list for common tokens (updated manually or via cron)
    const fallbackPrices: Record<string, number> = {
      "So11111111111111111111111111111111111111112": 165, // SOL
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 1.0, // USDC
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": 1.0, // USDT
      "7i5KKsX2weiTkry7jA4ZwSu2SmtUa4rCCi4t8U9b3bR2": 1.0, // USDY
      "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYk6U5Yf9sW": 1.0, // JLP
      "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": 1.0, // JUP (placeholder)
    };

    const prices: Record<string, number> = {};
    const missingMints: string[] = [];

    for (const mint of mints) {
      if (fallbackPrices[mint]) {
        prices[mint] = fallbackPrices[mint];
      } else {
        missingMints.push(mint);
      }
    }

    if (missingMints.length === 0) return prices;

    // Try Jupiter API first
    try {
      const ids = missingMints.join(",");
      const res = await fetch(`https://price.jup.ag/v6/price?ids=${ids}`);
      if (res.ok) {
        const json = (await res.json()) as { data?: Record<string, { price: number }> };
        for (const mint of missingMints) {
          prices[mint] = json.data?.[mint]?.price ?? 0;
        }
        return prices;
      }
    } catch (err) {
      log.warn("Jupiter price API failed, trying CoinGecko", { err: (err as Error).message });
    }

    // Fallback to CoinGecko free API
    try {
      const ids = missingMints.join(",");
      const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${ids}&vs_currencies=usd`
      );
      if (res.ok) {
        const json = (await res.json()) as Record<string, { usd: number }>;
        for (const mint of missingMints) {
          prices[mint] = json[mint]?.usd ?? 0;
        }
        return prices;
      }
    } catch (err) {
      log.warn("CoinGecko price API failed", { err: (err as Error).message });
    }

    // Last resort: return 0 for unknown tokens
    for (const mint of missingMints) {
      prices[mint] = 0;
    }
    return prices;
  }
}
