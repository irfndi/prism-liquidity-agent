import { createLogger } from "./logger.js";

/**
 * RugCheck token-report fetcher for fallen-angel mode (Wave 19).
 *
 * Supplies the SECURITY gate of the fallen-angel pipeline: a distressed token
 * is only worth a mean-reversion play when its token contract is clean. RugCheck
 * (api.rugcheck.xyz) publishes a free, keyless token report aggregating
 * on-chain contract facts (authorities, LP locks, holder concentration, known
 * risk patterns).
 *
 * Module-function design (clone of `gecko-terminal-service.ts` /
 * `token-risk-service.ts`): plain exported functions with an injectable
 * `fetchImpl`, NOT an Effect Context.Tag, so adding it does not ripple through
 * the test layers. All network failure paths return null (fail-open) — a
 * missing report means "security unknown", which the caller treats as "not a
 * fallen angel" (fail-closed for the positive gate).
 *
 * LIVE-VERIFIED contract (2026-08-05, checked across 4 tokens):
 *   GET {base}/tokens/{mint}/report  (keyless)
 *   → {
 *       "score": 15218,               # absolute score — NOT comparable across tokens
 *       "score_normalised": 56,       # 0..100 RISK index — HIGHER = RISKIER
 *         (SOL≈1, BONK≈7, dangerous LP-unlocked token ≈56, mint-authority-enabled ≈71)
 *       "rugged": bool,
 *       "token": { "mintAuthority": addr|null, "freezeAuthority": addr|null, ... },
 *       "tokenMeta": { "name","symbol","uri","mutable": bool, ... },
 *       "totalHolders": number|null,
 *       "topHolders": [ { "address","owner","pct","amount","decimals","uiAmount",
 *                          "insider": bool|null } | null ] | null,
 *       "risks": [ { "name","value","description","score","level": "danger"|"warn" } ],
 *       "totalLPProviders","totalStableLiquidity", ...
 *     }
 *   Unknown/absent token → 404/{"detail": ...}; 429 → rate limited.
 *
 * NOTE on score directions: `score` is an absolute, not-normalised number that
 * varies wildly by token class (1 for SOL/USDC, 15218 for a risky meme) — it
 * MUST NOT be used as a threshold. `score_normalised` is the 0..100 risk index.
 * The primary hard gate is `risks[].level === "danger"` (mint authority still
 * enabled, LP unlocked, etc.); `score_normalised` is a secondary floor.
 */

const logger = createLogger("rugcheck");

const DEFAULT_BASE_URL = "https://api.rugcheck.xyz/v1";
const REQUEST_TIMEOUT_MS = 10_000;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RugCheckRisk {
  readonly name: string;
  readonly value: string | null;
  readonly description: string | null;
  /** "danger" | "warn" | unknown level strings are preserved verbatim. */
  readonly level: string | null;
}

export interface RugCheckTopHolder {
  readonly address: string;
  readonly owner: string | null;
  /** Holder share of supply, 0..100 (percent). */
  readonly pct: number;
  readonly insider: boolean | null;
}

/** Parsed + normalised RugCheck report for one mint. */
export interface RugCheckReport {
  readonly mint: string;
  /** 0..100 risk index from score_normalised; null when absent. HIGHER = RISKIER. */
  readonly scoreNormalised: number | null;
  readonly rugged: boolean;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
  readonly tokenMetaMutable: boolean | null;
  readonly totalHolders: number | null;
  readonly topHolders: ReadonlyArray<RugCheckTopHolder>;
  readonly risks: ReadonlyArray<RugCheckRisk>;
  /** Sum of top-10 holder pct (0..100); null when topHolders is absent. */
  readonly top10HolderPct: number | null;
  /** Number of risks with level "danger" (0 = none). */
  readonly dangerRiskCount: number;
}

interface RawTokenFields {
  readonly mintAuthority: unknown;
  readonly freezeAuthority: unknown;
}

interface RawTokenMetaFields {
  readonly mutable: unknown;
}

interface RawRisk {
  readonly name: unknown;
  readonly value: unknown;
  readonly description: unknown;
  readonly level: unknown;
}

interface RawHolder {
  readonly address: unknown;
  readonly owner: unknown;
  readonly pct: unknown;
  readonly insider: unknown;
}

interface RawRugCheckReport {
  readonly mint: unknown;
  readonly score_normalised: unknown;
  readonly rugged: unknown;
  readonly token: unknown;
  readonly tokenMeta: unknown;
  readonly totalHolders: unknown;
  readonly topHolders: unknown;
  readonly risks: unknown;
}

function isNonNullObject<T>(value: T): boolean {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

function readString<T>(value: T): string | null {
  return Object.prototype.toString.call(value) === "[object String]" ? (value as string) : null;
}

function readBoolean<T>(value: T): boolean | null {
  return Object.prototype.toString.call(value) === "[object Boolean]" ? (value as boolean) : null;
}

function readFiniteNumber<T>(value: T): number | null {
  if (Object.prototype.toString.call(value) === "[object Number]") {
    const num = value as number;
    return Number.isFinite(num) ? num : null;
  }
  if (
    Object.prototype.toString.call(value) === "[object String]" &&
    (value as string).trim().length > 0
  ) {
    const num = Number(value as string);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * Parse a raw RugCheck report payload. Returns null when the payload is not a
 * usable report object. Individual fields degrade to null / empty lists — the
 * caller's gate decides which absences are fail-closed vs fail-open.
 */
export function parseRugCheckReport<T>(raw: T): RugCheckReport | null {
  if (!isNonNullObject(raw)) return null;
  const report = raw as RawRugCheckReport;
  const mint = readString(report.mint);
  if (mint === null || mint.length === 0) return null;

  const token = isNonNullObject(report.token) ? (report.token as RawTokenFields) : null;
  const tokenMeta = isNonNullObject(report.tokenMeta)
    ? (report.tokenMeta as RawTokenMetaFields)
    : null;

  const mintAuthority = readString(token?.mintAuthority);
  const freezeAuthority = readString(token?.freezeAuthority);
  const tokenMetaMutable = readBoolean(tokenMeta?.mutable);

  const risks: RugCheckRisk[] = [];
  if (Array.isArray(report.risks)) {
    for (const risk of report.risks) {
      if (!isNonNullObject(risk)) continue;
      const r = risk as RawRisk;
      risks.push({
        name: readString(r.name) ?? "unknown risk",
        value: readString(r.value),
        description: readString(r.description),
        level: readString(r.level),
      });
    }
  }

  const topHolders: RugCheckTopHolder[] = [];
  if (Array.isArray(report.topHolders)) {
    for (const holder of report.topHolders) {
      if (!isNonNullObject(holder)) continue;
      const h = holder as RawHolder;
      const address = readString(h.address);
      if (address === null || address.length === 0) continue;
      const pct = readFiniteNumber(h.pct);
      if (pct === null) continue;
      topHolders.push({
        address,
        owner: readString(h.owner),
        pct,
        insider: readBoolean(h.insider),
      });
    }
  }
  const top10HolderPct =
    topHolders.length > 0 ? topHolders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0) : null;

  return {
    mint,
    scoreNormalised: readFiniteNumber(report.score_normalised),
    rugged: report.rugged === true,
    mintAuthority: mintAuthority !== null && mintAuthority.length > 0 ? mintAuthority : null,
    freezeAuthority:
      freezeAuthority !== null && freezeAuthority.length > 0 ? freezeAuthority : null,
    tokenMetaMutable,
    totalHolders: readFiniteNumber(report.totalHolders),
    topHolders,
    risks,
    top10HolderPct,
    dangerRiskCount: risks.filter((r) => r.level === "danger").length,
  };
}

/**
 * Fetch a RugCheck report for a mint. NEVER throws and NEVER crashes the scan:
 * 404/429/5xx, timeout, fetch failure, or parse failure all return null so the
 * caller treats the security as unknown (fail-closed for the positive gate).
 * Logs ONE warning per failing fetch.
 */
export async function getRugCheckReport(
  mint: string,
  options: {
    readonly baseUrl?: string;
    readonly timeoutMs?: number;
    readonly fetchImpl?: FetchLike;
  } = {},
): Promise<RugCheckReport | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const base = (options.baseUrl ?? process.env.RUGCHECK_API_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const effectiveBase = base.length > 0 ? base : DEFAULT_BASE_URL;
  const url = `${effectiveBase}/tokens/${mint}/report`;

  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      logger.warn("RugCheck report unavailable — security unknown", {
        mint,
        status: res.status,
      });
      return null;
    }
    const body: unknown = await res.json();
    const parsed = parseRugCheckReport(body);
    if (parsed === null) {
      logger.warn("RugCheck returned an unparseable report", { mint });
      return null;
    }
    return parsed;
  } catch (err) {
    logger.warn("RugCheck fetch failed — security unknown", {
      mint,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
