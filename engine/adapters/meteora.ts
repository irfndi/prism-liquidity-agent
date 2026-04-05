import { Connection, PublicKey } from "@solana/web3.js";
import DLMM from "@meteora-ag/dlmm";
import { createLogger } from "../logger.js";
import type { BinArray, BinData, PoolState, Position } from "../types.js";
import { config } from "../config.js";

const log = createLogger("MeteoraAdapter");

export class MeteoraAdapter {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
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
    // ±20 bins: wide enough to cover typical rebalance targets without fetching the
    // entire bin array. The DLMM SDK fetches bin arrays in account chunks — requesting
    // too wide a range crosses multiple on-chain accounts and multiplies RPC calls.
    const halfRange = 20; // ±20 bins around active
    const lowerBinId = activeBin.binId - halfRange;
    const upperBinId = activeBin.binId + halfRange;

    const binArrays = await dlmm.getBinsBetweenLowerAndUpperBound(
      lowerBinId,
      upperBinId,
      activeBin
    );

    const bins: BinData[] = binArrays.bins.map((b) => ({
      binId: b.binId,
      price: Number(b.price),
      reserveX: BigInt(b.xAmount.toString()),
      reserveY: BigInt(b.yAmount.toString()),
      liquiditySupply: BigInt(b.supply.toString()),
    }));

    return {
      lowerBinId,
      upperBinId,
      bins,
      activeBinId: activeBin.binId,
      binStep: dlmm.lbPair.binStep,
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

  private async fetchPoolStats(
    poolAddress: string
  ): Promise<{ tvlUsd: number; volume24hUsd: number; fees24hUsd: number; apr: number }> {
    try {
      const res = await fetch(
        `https://dlmm-api.meteora.ag/pair/${poolAddress}`
      );
      const json = (await res.json()) as {
        liquidity?: number;
        trade_volume_24h?: number;
        fees_24h?: number;
        apr?: number;
      };
      return {
        tvlUsd: Number(json.liquidity ?? 0),
        volume24hUsd: Number(json.trade_volume_24h ?? 0),
        fees24hUsd: Number(json.fees_24h ?? 0),
        apr: Number(json.apr ?? 0),
      };
    } catch {
      return { tvlUsd: 0, volume24hUsd: 0, fees24hUsd: 0, apr: 0 };
    }
  }
}

