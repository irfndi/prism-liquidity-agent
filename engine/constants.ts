export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// 0.02 SOL reserved for fees and non-System-program costs.
export const GAS_RESERVE_LAMPORTS = 20_000_000n;

// Additional SOL reserved for DLMM position account rent, WSOL wrapping, and
// other direct System Program debits incurred during live entry. This buffer
// is acquired when auto-swapping USDC into the SOL leg so enterPosition's
// transaction-balance check does not fail after the swap.
export const SOL_ENTRY_TRANSACTION_BUFFER_LAMPORTS = 50_000_000n;
