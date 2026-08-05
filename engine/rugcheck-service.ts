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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Parse a raw RugCheck report payload. Returns null when the payload is not a
 * usable report object. Individual fields degrade to null / empty lists — the
 * caller's gate decides which absences are fail-closed vs fail-open.
 */
export function parseRugCheckReport(raw: unknown): RugCheckReport | null {
  if (!isObject(raw)) return null;
  const mint = typeof raw["mint"] === "string" ? raw["mint"] : "";
  if (mint.length === 0) return null;

  const token = isObject(raw["token"]) ? (raw["token"] as Record<string, unknown>) : null;
  const tokenMeta = isObject(raw["tokenMeta"])
    ? (raw["tokenMeta"] as Record<string, unknown>)
    : null;

  const risks: RugCheckRisk[] = [];
  if (Array.isArray(raw["risks"])) {
    for (const risk of raw["risks"]) {
      if (!isObject(risk)) continue;
      risks.push({
        name: typeof risk["name"] === "string" ? risk["name"] : "unknown risk",
        value: typeof risk["value"] === "string" ? risk["value"] : null,
        description: typeof risk["description"] === "string" ? risk["description"] : null,
        level: typeof risk["level"] === "string" ? risk["level"] : null,
      });
    }
  }

  const rawTopHolders = raw["topHolders"];
  const topHolders: RugCheckTopHolder[] = [];
  if (Array.isArray(rawTopHolders)) {
    for (const holder of rawTopHolders) {
      if (!isObject(holder)) continue;
      const address = typeof holder["address"] === "string" ? holder["address"] : "";
      if (address.length === 0) continue;
      const pct = readFiniteNumber(holder["pct"]);
      if (pct === null) continue;
      topHolders.push({
        address,
        owner: typeof holder["owner"] === "string" ? holder["owner"] : null,
        pct,
        insider: typeof holder["insider"] === "boolean" ? holder["insider"] : null,
      });
    }
  }
  const top10HolderPct =
    topHolders.length > 0 ? topHolders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0) : null;

  return {
    mint,
    scoreNormalised: readFiniteNumber(raw["score_normalised"]),
    rugged: raw["rugged"] === true,
    mintAuthority:
      token !== null &&
      typeof token["mintAuthority"] === "string" &&
      token["mintAuthority"].length > 0
        ? token["mintAuthority"]
        : null,
    freezeAuthority:
      token !== null &&
      typeof token["freezeAuthority"] === "string" &&
      token["freezeAuthority"].length > 0
        ? token["freezeAuthority"]
        : null,
    tokenMetaMutable:
      tokenMeta !== null && typeof tokenMeta["mutable"] === "boolean" ? tokenMeta["mutable"] : null,
    totalHolders: readFiniteNumber(raw["totalHolders"]),
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
