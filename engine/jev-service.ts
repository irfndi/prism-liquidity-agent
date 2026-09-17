/**
 * Jev judgment service (TypeSafe System One) — shadow/advisory only.
 *
 * Four narrow judgments, one per existing heuristic gate. Every judgment has
 * a deterministic fallback that the engine keeps using; Jev output is logged
 * alongside the fallback for calibration and NEVER drives ENTER/EXIT.
 *
 * - depositPick (Choice spot|curve|bidask) ↔ recommendStrategy
 * - toxicFlow (Noul) ↔ checkVolumeAuthenticity / fee-rate outlier
 * - recoveryHold (Noul) ↔ shouldHoldForRecovery
 * - regimeStress (Noul) ↔ regime-gate assessHerding/herdingBlocksEntry
 *
 * Pure module (like market-gate.ts / token-risk-service.ts): no Effect
 * Context.Tag, injectable fetchImpl, fail-open (unknown/error → caller keeps
 * its deterministic verdict). Key resolution: canonical TYPESAFE_API_KEY,
 * legacy TYPESAFEAI_API alias.
 */

import type { JsonValue } from "./services.js";
import type { FetchLike } from "./token-risk-service.js";
import type { EntryStrategySpec } from "./types.js";
import { jevFetch } from "./jev-gate.js";

export const JEV_SYSTEMONE_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_DEFAULT_TIMEOUT_MS = 10_000;

export interface JevPoolState {
  readonly poolAddress: string;
  readonly tokenXSymbol: string;
  readonly tokenYSymbol: string;
  readonly tvlUsd: number;
  readonly volume24hUsd: number;
  readonly fees24hUsd: number;
  readonly statsSource: string | undefined;
  readonly volumeAuthenticityKnown: boolean;
  readonly feeIlRatioKnown: boolean;
  readonly binUtilizationKnown: boolean;
  readonly feeIlRatio: number;
  readonly volumeAuthenticity: number;
  readonly binUtilization: number;
  readonly volatilityStddev: number;
  readonly netDriftBins: number | null;
  readonly activeBinId: number;
  readonly binStep: number;
}

/** The deposit-distribution Choice answer: distribution + confidence. */
export interface DepositChoice {
  readonly distribution: EntryStrategySpec | null;
  readonly confidence: number | null;
}

export interface JevJudgments {
  readonly depositPick: EntryStrategySpec | null;
  readonly depositConfidence: number | null;
  readonly toxicFlowNoul: number | null;
  readonly recoveryHoldNoul: number | null;
  readonly regimeStressNoul: number | null;
  /** True when the call succeeded and judgments are usable for logging. */
  readonly ok: boolean;
  /** Short failure class for logs: disabled|error|timeout|rate_limited|invalid. */
  readonly failure: string | null;
}

export interface JevConfigLike {
  readonly jevEnabled?: boolean | undefined;
  readonly jevApiKey?: string | undefined;
  readonly jevBaseUrl?: string | undefined;
  readonly jevModel?: string | undefined;
  readonly jevTimeoutMs?: number | undefined;
}

/** Resolved endpoint triple: URL + model + per-attempt timeout. */
export interface JevEndpoint {
  readonly url: string;
  readonly model: string;
  readonly timeoutMs: number;
}

export const JEV_DISABLED: JevJudgments = {
  depositPick: null,
  depositConfidence: null,
  toxicFlowNoul: null,
  recoveryHoldNoul: null,
  regimeStressNoul: null,
  ok: false,
  failure: "disabled",
};

/** Minimal env surface for key resolution (process.env satisfies this). */
export interface JevEnv {
  readonly TYPESAFE_API_KEY?: string | undefined;
  readonly TYPESAFEAI_API?: string | undefined;
  readonly [key: string]: string | undefined;
}

/** Resolve the API key: canonical TYPESAFE_API_KEY, legacy TYPESAFEAI_API alias. */
export function resolveJevApiKey(env: JevEnv = process.env): string {
  const canonical = (env.TYPESAFE_API_KEY ?? "").trim();
  if (canonical) return canonical;
  return (env.TYPESAFEAI_API ?? "").trim();
}

interface UnknownRecord {
  readonly [key: string]: JsonValue;
}

function isObject<T>(value: T): value is UnknownRecord & T {
  return value !== null && value instanceof Object && !(value instanceof Function);
}

function isStringLike<T>(value: T): value is string & T {
  return Object.prototype.toString.call(value) === "[object String]";
}

function isNumberLike<T>(value: T): value is number & T {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function depositFromChoice<T>(choice: T): EntryStrategySpec | null {
  if (!isStringLike(choice)) return null;
  if (choice === "spot") return "spot";
  if (choice === "curve") return "curve";
  if (choice === "bidask") return "bidask";
  return null;
}

function readFiniteOrNull<T>(value: T): number | null {
  if (!isNumberLike(value)) return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function readDepositChoice<T>(answer: T): DepositChoice {
  if (!isObject(answer)) return { distribution: null, confidence: null };
  const choice = "choice" in answer ? answer.choice : null;
  const confidence = "confidence" in answer ? answer.confidence : null;
  return { distribution: depositFromChoice(choice), confidence: readFiniteOrNull(confidence) };
}

function readNoulAnswer<T>(answer: T): number | null {
  if (!isObject(answer)) return null;
  const raw = "noul" in answer ? answer.noul : null;
  const n = readFiniteOrNull(raw);
  if (n === null || n < 0 || n > 1) return null;
  return n;
}

function jevEndpointFor(config: JevConfigLike): JevEndpoint {
  const url = (config.jevBaseUrl ?? "").trim() || JEV_SYSTEMONE_URL;
  const model = (config.jevModel ?? "").trim() || JEV_DEFAULT_MODEL;
  return { url, model, timeoutMs: config.jevTimeoutMs ?? JEV_DEFAULT_TIMEOUT_MS };
}

function buildJevBody(pool: JevPoolState, model: string) {
  return {
    state: {
      pool: {
        address: pool.poolAddress,
        pair: `${pool.tokenXSymbol}/${pool.tokenYSymbol}`,
        tvlUsd: pool.tvlUsd,
        volume24hUsd: pool.volume24hUsd,
        fees24hUsd: pool.fees24hUsd,
        statsSource: pool.statsSource ?? "unknown",
        measured: {
          volumeAuthenticityKnown: pool.volumeAuthenticityKnown,
          feeIlRatioKnown: pool.feeIlRatioKnown,
          binUtilizationKnown: pool.binUtilizationKnown,
        },
      },
      heuristic: {
        feeIlRatio: pool.feeIlRatio,
        volumeAuthenticity: pool.volumeAuthenticity,
        binUtilization: pool.binUtilization,
        volatilityStddevBins: pool.volatilityStddev,
        netDriftBins: pool.netDriftBins,
      },
      chain: { activeBinId: pool.activeBinId, binStep: pool.binStep },
    },
    model,
    questions: {
      deposit_pick: {
        type: "choice",
        instructions: "Which DLMM deposit distribution best fits this pool regime?",
        criteria: {
          spot: "Uniform distribution; high-volatility chop or no clear trend",
          curve: "Concentrated around the active bin; calm/mean-reverting",
          bidask: "Edge-weighted; dominant directional trend",
        },
      },
      toxic_flow: {
        type: "noul",
        instructions:
          "Is current volume toxic directional flow LPs should avoid (rather than organic fee-rich trading)?",
      },
      recovery_hold: {
        type: "noul",
        instructions:
          "If out of range, is near-term mean reversion back into range likely enough to hold rather than rebalance?",
      },
      regime_stress: {
        type: "noul",
        instructions:
          "Is this pool in systemic stress (manipulation, drain, spike shape) where new capital should pause?",
      },
    },
  };
}

async function postJevRequest(
  fetchImpl: FetchLike,
  url: string,
  apiKey: string,
  bodyText: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      signal: controller.signal,
      body: bodyText,
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseJevAnswers(answers: UnknownRecord): JevJudgments {
  const depositAnswer = "deposit_pick" in answers ? answers.deposit_pick : null;
  const deposit = readDepositChoice(depositAnswer);
  return {
    depositPick: deposit.distribution,
    depositConfidence: deposit.confidence,
    toxicFlowNoul: readNoulAnswer("toxic_flow" in answers ? answers.toxic_flow : null),
    recoveryHoldNoul: readNoulAnswer("recovery_hold" in answers ? answers.recovery_hold : null),
    regimeStressNoul: readNoulAnswer("regime_stress" in answers ? answers.regime_stress : null),
    ok: true,
    failure: null,
  };
}

function failureForStatus(response: Response): JevJudgments | null {
  if (response.status === 429) return { ...JEV_DISABLED, ok: false, failure: "rate_limited" };
  if (!response.ok) return { ...JEV_DISABLED, ok: false, failure: "error" };
  return null;
}

function parseJevBody<T>(body: T): JevJudgments {
  if (!isObject(body)) return { ...JEV_DISABLED, ok: false, failure: "invalid" };
  const answers = "answers" in body ? body.answers : null;
  if (!isObject(answers)) return { ...JEV_DISABLED, ok: false, failure: "invalid" };
  return parseJevAnswers(answers);
}

/**
 * One batched systemOne call for the four shadow judgments. NEVER throws:
 * any transport/parse failure returns ok:false so the caller keeps its
 * deterministic verdict. 429/529 are fail-open (no retry loop — the scan
 * cycle must never stall on an advisory call).
 */
export async function consultJevJudgments(
  pool: JevPoolState,
  config: JevConfigLike,
  options: { readonly fetchImpl?: FetchLike } = {},
): Promise<JevJudgments> {
  if (config.jevEnabled === false) return JEV_DISABLED;
  // Explicit empty key = disabled (Bun auto-loads .env into process.env, so
  // falling back to ambient env here would make an explicit "" non-hermetic).
  // Only resolve ambient env when the caller did not provide a key at all.
  const apiKey = config.jevApiKey === undefined ? resolveJevApiKey() : config.jevApiKey.trim();
  if (!apiKey) return JEV_DISABLED;
  const endpoint = jevEndpointFor(config);
  const bodyText = JSON.stringify(buildJevBody(pool, endpoint.model));
  // Injected fakes (tests, offline replay) bypass the process-wide gate;
  // live traffic paces through jevFetch.
  const fetchImpl = options.fetchImpl ?? jevFetch;
  try {
    const response = await postJevRequest(
      fetchImpl,
      endpoint.url,
      apiKey,
      bodyText,
      endpoint.timeoutMs,
    );
    const failed = failureForStatus(response);
    if (failed !== null) return failed;
    return parseJevBody(await response.json());
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return { ...JEV_DISABLED, ok: false, failure: timedOut ? "timeout" : "error" };
  }
}
