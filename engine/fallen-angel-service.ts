import type { GeckoOhlcvSignals } from "./gecko-ohlcv-service.js";
import type { RugCheckReport } from "./rugcheck-service.js";

/**
 * Fallen-angel gate pipeline (Wave 19) — pure decision module.
 *
 * Decides whether a DLMM pool qualifies as a "fallen angel": the underlying
 * token is deeply down from its all-time high (GeckoTerminal OHLCV), calm
 * enough to mean-revert (daily-return stddev within a band), clean enough to
 * trust (RugCheck: no danger-level risks, low top-10 holder concentration,
 * adequate holder base, sane score), and the pool has any TVL above a
 * configurable floor.
 *
 * Deliberately module-functions only (clone of the depeg detector / token-risk
 * overlay): no Effect Context.Tag, no network calls here. The caller fetches
 * signals via `getGeckoPoolOhlcv` / `getRugCheckReport` and passes them in.
 *
 * FAIL-CLOSED for the positive gate: any signal that is MISSING (null report,
 * null score, null holders) makes the candidate fail with an explicit reason —
 * a token whose security or history is unknown is never an "angel". Only the
 * holder-concentration check fails OPEN when topHolders is absent (the API
 * returns null topHolders for majors like USDC/SOL, and concentration is a
 * secondary signal). No fabricated default is ever substituted.
 */

export interface FallenAngelGateConfig {
  readonly minTvlUsd: number;
  readonly minDrawdownPct: number;
  readonly maxDrawdownPct: number;
  readonly volBaselineMin: number;
  readonly volBaselineMax: number;
  /** RugCheck score_normalised MUST be at or below this (higher = riskier). */
  readonly maxRugcheckScore: number;
  readonly minHolders: number;
  readonly maxTop10HolderPct: number;
}

export interface FallenAngelGateInput {
  readonly poolTvlUsd: number;
  /** The token under scrutiny — the NON-stablecoin leg of the pair. */
  readonly assetMint: string;
  readonly ohlcv: GeckoOhlcvSignals | null;
  readonly rugcheck: RugCheckReport | null;
  readonly config: FallenAngelGateConfig;
}

export interface FallenAngelGateResult {
  readonly qualified: boolean;
  /** Empty when qualified; one entry per failed check otherwise. */
  readonly reasons: ReadonlyArray<string>;
}

/** True when a report carries any risk whose level is "danger" (hard reject). */
export function hasDangerRisks(report: RugCheckReport): boolean {
  return report.dangerRiskCount > 0;
}

export function evaluateFallenAngelGate(input: FallenAngelGateInput): FallenAngelGateResult {
  const reasons: string[] = [];

  if (!Number.isFinite(input.poolTvlUsd) || input.poolTvlUsd < input.config.minTvlUsd) {
    reasons.push(
      `TVL $${Number.isFinite(input.poolTvlUsd) ? input.poolTvlUsd.toFixed(0) : "unknown"} below fallen-angel floor $${input.config.minTvlUsd.toFixed(0)}`,
    );
  }

  // ── Security gate (RugCheck) — fail-closed on missing data ────────────────
  const report = input.rugcheck;
  if (report === null) {
    reasons.push("RugCheck report unavailable — security unknown");
  } else {
    if (report.rugged) {
      reasons.push("RugCheck flags token as rugged");
    }
    if (hasDangerRisks(report)) {
      const dangerNames = report.risks
        .filter((r) => r.level === "danger")
        .map((r) => r.name)
        .join(", ");
      reasons.push(`RugCheck danger risks present: ${dangerNames}`);
    }
    if (report.scoreNormalised === null) {
      reasons.push("RugCheck score unknown — fail closed");
    } else if (report.scoreNormalised > input.config.maxRugcheckScore) {
      reasons.push(
        `RugCheck risk score ${report.scoreNormalised} exceeds max ${input.config.maxRugcheckScore}`,
      );
    }
    if (report.mintAuthority !== null) {
      reasons.push("Token mint authority is still enabled");
    }
    if (report.freezeAuthority !== null) {
      reasons.push("Token freeze authority is still enabled");
    }
    if (report.totalHolders === null) {
      reasons.push("RugCheck holder count unknown — fail closed");
    } else if (report.totalHolders < input.config.minHolders) {
      reasons.push(`Holder count ${report.totalHolders} below minimum ${input.config.minHolders}`);
    }
    // Holder concentration fails OPEN (API returns null topHolders for majors).
    // top10HolderPct is a percent (0..100); config.maxTop10HolderPct is a fraction
    // (0..1) — normalize to fractions before comparing.
    if (
      report.top10HolderPct !== null &&
      report.top10HolderPct / 100 > input.config.maxTop10HolderPct
    ) {
      reasons.push(
        `Top-10 holder concentration ${report.top10HolderPct.toFixed(1)}% exceeds max ${(input.config.maxTop10HolderPct * 100).toFixed(0)}%`,
      );
    }
  }

  // ── History gate (GeckoTerminal OHLCV) — fail-closed on missing data ──────
  const ohlcv = input.ohlcv;
  if (ohlcv === null) {
    reasons.push("OHLCV history unavailable — drawdown unknown");
  } else {
    if (ohlcv.barCount < 2) {
      reasons.push(`OHLCV window too shallow (${ohlcv.barCount} bar(s))`);
    }
    if (ohlcv.drawdownFromAth < input.config.minDrawdownPct) {
      reasons.push(
        `Drawdown from ATH ${(ohlcv.drawdownFromAth * 100).toFixed(1)}% below minimum ${(input.config.minDrawdownPct * 100).toFixed(0)}%`,
      );
    }
    if (ohlcv.drawdownFromAth > input.config.maxDrawdownPct) {
      reasons.push(
        `Drawdown from ATH ${(ohlcv.drawdownFromAth * 100).toFixed(1)}% exceeds maximum ${(input.config.maxDrawdownPct * 100).toFixed(0)}% (dead token)`,
      );
    }
    if (ohlcv.dailyReturnStddev < input.config.volBaselineMin) {
      reasons.push(
        `Daily-return stddev ${ohlcv.dailyReturnStddev.toFixed(4)} below volatility floor ${input.config.volBaselineMin}`,
      );
    }
    if (ohlcv.dailyReturnStddev > input.config.volBaselineMax) {
      reasons.push(
        `Daily-return stddev ${ohlcv.dailyReturnStddev.toFixed(4)} above volatility ceiling ${input.config.volBaselineMax} (lunatic token)`,
      );
    }
  }

  return { qualified: reasons.length === 0, reasons };
}

/**
 * Pick the asset leg of a pool pair: the mint that is NOT a stablecoin and
 * NOT SOL (the base settlement asset). When both legs are stablecoins there is
 * no obvious asset — return null and let the caller fail closed. When the
 * allowlist is empty (undefined) there is no notion of a stable leg, so the
 * pair is unclassifiable — return null (fail closed) rather than guessing.
 * SOL is always excluded: it is the settlement/quote leg, never the
 * fallen-angel asset (RugCheck reports for SOL carry no useful signal).
 */
export function identifyAssetMint(
  tokenX: string,
  tokenY: string,
  stablecoinMints: ReadonlySet<string> | undefined,
  solMint: string,
): string | null {
  if (stablecoinMints === undefined || stablecoinMints.size === 0) return null;
  const xIsStable = stablecoinMints.has(tokenX) || tokenX === solMint;
  const yIsStable = stablecoinMints.has(tokenY) || tokenY === solMint;
  if (!xIsStable && yIsStable) return tokenX;
  if (xIsStable && !yIsStable) return tokenY;
  if (xIsStable && yIsStable) return null;
  // Neither leg is stable/SOL — prefer the first (tokenX) as the asset.
  return tokenX;
}
