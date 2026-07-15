export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// 0.02 SOL reserved for fees and non-System-program costs.
export const GAS_RESERVE_LAMPORTS = 20_000_000n;

// Additional SOL reserved for DLMM position account rent, WSOL wrapping, and
// other direct System Program debits incurred during live entry. This buffer
// is acquired when auto-swapping USDC into the SOL leg so enterPosition's
// transaction-balance check does not fail after the swap.
export const SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS = 50_000_000n;

// Amount of USDC the live-entry gas top-up swaps for SOL when the wallet's
// native balance is below the threshold. Must be kept in sync with the value
// passed to `adapter.swapUSDCForSOL` in `program.ts`.
export const GAS_TOP_UP_USDC = 2;

// Minimum native SOL the live entry gate requires before it will submit an
// ENTER transaction (0.03 SOL). This is also the threshold used for the gas
// top-up and the post-swap SOL recheck so all three gates stay aligned.
export const MIN_SOL_FOR_GAS_LAMPORTS = 30_000_000n;

// Native SOL threshold below which `swapUSDCForSOL` performs a gas top-up.
// Kept in sync with the live entry gate to avoid reserving a top-up that the
// gate would reject anyway.
export const SOL_GAS_TOP_UP_THRESHOLD_LAMPORTS = MIN_SOL_FOR_GAS_LAMPORTS;
