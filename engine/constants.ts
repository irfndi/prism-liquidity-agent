export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// 0.02 SOL reserved for fees and non-System-program costs.
export const GAS_RESERVE_LAMPORTS = 20_000_000n;

// Additional SOL reserved for DLMM position account rent, WSOL wrapping, and
// other direct System Program debits incurred during live entry. This buffer
// is acquired when auto-swapping USDC into the SOL leg so enterPosition's
// transaction-balance check does not fail after the swap.
export const SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS = 50_000_000n;

// Fallback / floor amount of USDC the live-entry gas top-up swaps for SOL.
// `program.ts` computes a price-aware top-up sized to the entry reserve and
// uses this only as a minimum (and as the value when the SOL price is unknown),
// so a flat $2 no longer blocks entry when the wallet has plenty of USDC.
export const GAS_TOP_UP_USDC = 2;

// Pure gas + non-position System Program fee floor (0.03 SOL), used as the
// "gas" component when decomposing the entry reserve in insufficient-SOL error
// messages. The live ENTER gate and the automatic top-up trigger both use
// MIN_SOL_FOR_ENTRY_LAMPORTS (0.18 SOL); this constant is not a threshold for
// either of those paths — see SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS.
export const MIN_SOL_FOR_GAS_LAMPORTS = 30_000_000n;

// Minimum native SOL for a live ENTER including position rent-exempt reserve,
// bin-array initialization, ATA creation, and priority fee buffer. The audit
// measured a live entry needing on the order of ~0.18 SOL; the reserve is set
// to a round 180,000,000 lamports (0.18 SOL) so the transaction simulation
// succeeds. The error message reports available, needed, and reserve components.
export const MIN_SOL_FOR_ENTRY_LAMPORTS = 180_000_000n;

// Native SOL threshold below which `swapUSDCForSOL` performs a top-up. Aliased
// to the live-entry reserve so the top-up trigger and the entry gate cannot
// drift: any wallet below the entry reserve gets topped up before the gate
// rejects it for insufficient SOL.
export const SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS = MIN_SOL_FOR_ENTRY_LAMPORTS;
