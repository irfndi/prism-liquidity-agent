/** Transfer-tax (Robinhood rule 4) screen unit tests: the market gate must
 *  reject legs whose mint charges a Token-2022 transfer fee unless the
 *  operator opts in, and the adapter's parsed-mint detection must spot the
 *  transferFeeConfig extension. */
import { describe, it, expect } from "vitest";
import {
  gateAndRankMarketPools,
  marketLegPasses,
  type MarketGateConfig,
} from "../engine/market-gate.js";
import { legHasTransferFee } from "../engine/transfer-fee.js";
import { parsedMintHasTransferFee, type ParsedMintInfo } from "../engine/adapter-service.js";
import { asOwner } from "./helpers.js";
import type { DiscoveredPool } from "../engine/services.js";

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function makePool(overrides: Partial<DiscoveredPool> & { address: string }): DiscoveredPool {
  const { address, ...rest } = overrides;
  return {
    address,
    tvlUsd: 1_000_000,
    volume24hUsd: 500_000,
    fees24hUsd: 1_500,
    apr: 0.55,
    binStep: 20,
    tokenX: SOL,
    tokenY: USDC,
    tokenXSymbol: "SOL",
    tokenYSymbol: "USDC",
    tokenXVerified: true,
    tokenYVerified: true,
    tokenXFreezeDisabled: true,
    tokenYFreezeDisabled: true,
    tokenXHolders: 3_000_000,
    tokenYHolders: 2_000_000,
    ...rest,
  };
}

const config: MarketGateConfig = {
  minTvlUsd: 250_000,
  minFeeApr: 25,
  minVolumeTurnover: 0.02,
  maxVolumeTurnover: 50,
  minHolders: 1000,
  minPoolAgeHours: 0,
  minBinStep: 2,
  maxBinStep: 200,
  stablecoinMints: new Set([USDC]),
};

describe("marketLegPasses transfer-fee screen", () => {
  it("rejects a transfer-fee leg by default (allowTransferFeeTokens absent)", () => {
    expect(
      marketLegPasses(
        {
          isStableOrSol: false,
          verified: true,
          freezeDisabled: true,
          holders: 10_000,
          transferFeeEnabled: true,
        },
        config.minHolders,
      ),
    ).toBe(false);
  });

  it("rejects a transfer-fee leg even when it is a stablecoin (screen overrides the allowlist exemption)", () => {
    expect(
      marketLegPasses(
        {
          isStableOrSol: true,
          verified: true,
          freezeDisabled: true,
          holders: 10_000,
          transferFeeEnabled: true,
        },
        config.minHolders,
      ),
    ).toBe(false);
  });

  it("passes a clean leg (no transfer fee)", () => {
    expect(
      marketLegPasses(
        {
          isStableOrSol: false,
          verified: true,
          freezeDisabled: true,
          holders: 10_000,
        },
        config.minHolders,
      ),
    ).toBe(true);
  });

  it("passes an unknown-fee leg (absent metadata is not a fee)", () => {
    expect(
      marketLegPasses(
        {
          isStableOrSol: false,
          verified: false,
          freezeDisabled: true,
          holders: 10_000,
        },
        config.minHolders,
      ),
    ).toBe(true);
  });

  it("passes a transfer-fee leg when the operator opts in", () => {
    expect(
      marketLegPasses(
        {
          isStableOrSol: false,
          verified: true,
          freezeDisabled: true,
          holders: 10_000,
          transferFeeEnabled: true,
        },
        config.minHolders,
        { allowTransferFeeTokens: true },
      ),
    ).toBe(true);
  });
});

describe("gateAndRankMarketPools transfer-fee screen", () => {
  it("rejects a pool with a fee-charging leg and records a clear reason", () => {
    const result = gateAndRankMarketPools(
      [makePool({ address: "feeleg", tokenXTransferFeeEnabled: true })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.address).toBe("feeleg");
    expect(result.rejected[0]!.reason).toContain("transfer fee");
  });

  it("admits a fee-charging pool when allowTransferFeeTokens is set", () => {
    const result = gateAndRankMarketPools(
      [makePool({ address: "feeleg", tokenXTransferFeeEnabled: true })],
      { ...config, allowTransferFeeTokens: true },
    );
    expect(result.ranked).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("admits a clean pool (no fee flags)", () => {
    const result = gateAndRankMarketPools([makePool({ address: "clean" })], config);
    expect(result.ranked).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects a pool whose Y leg charges a transfer fee", () => {
    // The token-Y screen is a separate block with its own field read and its
    // own reject string — a wrong field reference would pass an X-only suite.
    const result = gateAndRankMarketPools(
      [makePool({ address: "feelegy", tokenYTransferFeeEnabled: true })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("transfer fee");
  });

  it("rejects a pool whose X leg charges a transfer fee via the shared reason helper", () => {
    const result = gateAndRankMarketPools(
      [makePool({ address: "feelegx", tokenXTransferFeeEnabled: true })],
      config,
    );
    expect(result.ranked).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("charges a transfer fee");
  });
});

describe("legHasTransferFee", () => {
  it("reports true only for a known fee flag", () => {
    expect(legHasTransferFee("mintX", { transferFeeEnabled: true })).toBe(true);
    expect(legHasTransferFee("mintX", { transferFeeEnabled: false })).toBe(false);
    expect(legHasTransferFee("mintX", { transferFeeEnabled: undefined })).toBe(false);
  });
});

describe("parsedMintHasTransferFee (adapter mint parse)", () => {
  const baseMint: ParsedMintInfo = {};

  it("detects a non-zero basis-point rate on the newer fee", () => {
    expect(
      parsedMintHasTransferFee({
        ...baseMint,
        extensions: [
          {
            extension: "transferFeeConfig",
            state: {
              olderTransferFee: { transferFeeBasisPoints: 0, maximumFee: "0" },
              newerTransferFee: { transferFeeBasisPoints: 100, maximumFee: "1000000" },
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("detects a non-zero max fee even at zero basis points", () => {
    expect(
      parsedMintHasTransferFee({
        ...baseMint,
        extensions: [
          {
            extension: "transferFeeConfig",
            state: {
              olderTransferFee: { transferFeeBasisPoints: 0, maximumFee: "0" },
              newerTransferFee: { transferFeeBasisPoints: 0, maximumFee: "500000" },
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("detects a non-zero fee on the older fee (transition window)", () => {
    expect(
      parsedMintHasTransferFee({
        ...baseMint,
        extensions: [
          {
            extension: "transferFeeConfig",
            state: {
              olderTransferFee: { transferFeeBasisPoints: 250, maximumFee: "250000" },
              newerTransferFee: { transferFeeBasisPoints: 0, maximumFee: "0" },
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("ignores a transferFeeConfig with zero rate and zero max fee", () => {
    expect(
      parsedMintHasTransferFee({
        ...baseMint,
        extensions: [
          {
            extension: "transferFeeConfig",
            state: {
              olderTransferFee: { transferFeeBasisPoints: 0, maximumFee: "0" },
              newerTransferFee: { transferFeeBasisPoints: 0, maximumFee: "0" },
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it("returns false for a plain mint or unrelated extensions", () => {
    expect(parsedMintHasTransferFee(baseMint)).toBe(false);
    // The guard branch: no parsed data / non-object input / non-array
    // extensions all fail open — this is the fail-open path the screen
    // depends on when getParsedAccountInfo returns nothing.
    expect(parsedMintHasTransferFee(undefined)).toBe(false);
    expect(parsedMintHasTransferFee(null)).toBe(false);
    expect(parsedMintHasTransferFee(asOwner<ParsedMintInfo>({ ...baseMint, extensions: {} }))).toBe(
      false,
    );
    expect(
      parsedMintHasTransferFee(
        asOwner<ParsedMintInfo>({
          ...baseMint,
          extensions: [{ extension: "transferHook", state: { programId: "hook" } }],
        }),
      ),
    ).toBe(false);
  });

  it("detects the fee from an older parser that flattens the fields", () => {
    expect(
      parsedMintHasTransferFee({
        ...baseMint,
        extensions: [
          {
            extension: "transferFeeConfig",
            state: { transferFeeBasisPoints: 50, maximumFee: "0" },
          },
        ],
      }),
    ).toBe(true);
  });
});
