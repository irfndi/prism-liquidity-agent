/**
 * @file Transfer-tax (Robinhood rule 4) screening: reject tokens whose mint
 * charges a transfer fee. Shared by the market gate (engine/market-gate.ts)
 * and the launch branch (engine/program.ts) so one definition of "charges a
 * transfer fee" drives both paths.
 */

/** Minimal mint-info shape carrying the transfer-fee flag. The adapter's
 *  getMintAuthorities result (which also carries mint/freeze authority) is
 *  structurally compatible. The flag is `boolean | undefined` because a mint
 *  whose on-chain data has not been fetched yet is NOT a fee token — absence
 *  of evidence fails open, matching the gate's other metadata screens. */
export interface TransferFeeMintInfo {
  readonly transferFeeEnabled: boolean | undefined;
}

/** True when the leg's mint charges a transfer fee (Token-2022 transfer-fee
 *  extension with a non-zero rate or max fee). `mint` is part of the public
 *  contract so callers can attribute/log the offending leg; the check itself
 *  only reads the parsed mint info. */
export function legHasTransferFee(mint: string, mintInfo: TransferFeeMintInfo): boolean {
  return mintInfo.transferFeeEnabled === true;
}

/** Single source of truth for the transfer-fee rejection: returns the
 *  rejection reason when the leg's mint charges a transfer fee and fees are
 *  not explicitly allowed, else null. Used by BOTH the market gate loop (for
 *  the specific reason string) and marketLegPasses (for the boolean gate) so
 *  the rule cannot drift between the two. */
export function transferFeeRejectionReason(
  symbol: string | undefined,
  transferFeeEnabled: boolean | undefined,
  allowTransferFeeTokens: boolean | undefined,
): string | null {
  if (transferFeeEnabled === true && allowTransferFeeTokens !== true) {
    return `leg ${symbol ?? "mint"} charges a transfer fee (allowTransferFeeTokens not enabled)`;
  }
  return null;
}
