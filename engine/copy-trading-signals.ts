import { Effect, Layer } from "effect";
import { ConfigService } from "./config-service.js";
import { CopySignalService } from "./services.js";
import type { ActionType, AgentDecision } from "./types.js";
import { createLogger } from "./logger.js";
import { retryEffectWithBackoff } from "./adapter-retry.js";

const logger = createLogger("copy-signals");
const MAX_BOOST = 0.05;
const WALLET_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type CopySignalObservation = {
  readonly wallet: string;
  readonly poolAddress: string;
  readonly action: "ENTER" | "HOLD" | "REBALANCE";
  readonly confidence: number;
  readonly observedAt: number;
  readonly signature?: string;
};

export type CopySignalApi = {
  readonly getBoost: (poolAddress: string, now: number) => Effect.Effect<CopySignalResult, never>;
};

export type CopySignalResult = {
  readonly boost: number;
  readonly wallets: ReadonlyArray<string>;
  readonly ignored: number;
};

type CopySignalConfig = {
  readonly enabled: boolean;
  readonly endpoint: string;
  readonly wallets: ReadonlyArray<string>;
  readonly staleMs: number;
  readonly maxBoost: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseCopySignalPayload(raw: unknown): ReadonlyArray<CopySignalObservation> {
  const values = Array.isArray(raw)
    ? raw
    : isObject(raw) && Array.isArray(raw["signals"])
      ? raw["signals"]
      : [];
  const observations: CopySignalObservation[] = [];
  for (const value of values) {
    if (!isObject(value)) continue;
    const wallet = value["wallet"];
    const poolAddress = value["poolAddress"];
    const action = value["action"];
    const confidence = value["confidence"];
    const observedAt = value["observedAt"];
    if (
      typeof wallet !== "string" ||
      !WALLET_PATTERN.test(wallet) ||
      typeof poolAddress !== "string" ||
      poolAddress.length === 0 ||
      (action !== "ENTER" && action !== "HOLD" && action !== "REBALANCE") ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      typeof observedAt !== "number" ||
      !Number.isFinite(observedAt)
    )
      continue;
    observations.push({
      wallet,
      poolAddress,
      action,
      confidence,
      observedAt,
      ...(typeof value["signature"] === "string" ? { signature: value["signature"] } : {}),
    });
  }
  return observations;
}

export function applyCopySignalBoost(
  decision: AgentDecision,
  result: CopySignalResult,
  maxBoost = MAX_BOOST,
): AgentDecision {
  if (decision.action === "EXIT" || result.boost <= 0) return decision;
  const boost = Math.min(Math.max(result.boost, 0), maxBoost);
  return {
    ...decision,
    confidence: Math.min(1, decision.confidence + boost),
    reasoning: `${decision.reasoning} [copy-signal +${boost.toFixed(3)} from ${result.wallets.length} wallet(s)]`,
  };
}

const fetchSignals = (config: CopySignalConfig) =>
  retryEffectWithBackoff(
    Effect.tryPromise({
      try: () =>
        fetch(config.endpoint, { signal: AbortSignal.timeout(10_000) }).then((response) => {
          if (!response.ok) throw new Error(`copy-signal HTTP ${response.status}`);
          return response.json() as Promise<unknown>;
        }),
      catch: (cause) => cause,
    }),
    { maxRetries: 2 },
  );

export const CopySignalLive = Layer.effect(
  CopySignalService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const settings: CopySignalConfig = {
      enabled: config.copySignalsEnabled ?? false,
      endpoint: config.copySignalsEndpoint ?? "",
      wallets: config.copySignalWallets ?? [],
      staleMs: config.copySignalsStaleMs ?? 900_000,
      maxBoost: config.copySignalsMaxBoost ?? MAX_BOOST,
    };
    const getBoost = (poolAddress: string, now: number): Effect.Effect<CopySignalResult, never> => {
      if (!settings.enabled || settings.endpoint.length === 0 || settings.wallets.length === 0) {
        return Effect.succeed({ boost: 0, wallets: [], ignored: 0 });
      }
      return fetchSignals(settings).pipe(
        Effect.map((raw) => {
          const allowed = new Set(settings.wallets);
          const seen = new Set<string>();
          const valid = parseCopySignalPayload(raw).filter((signal) => {
            const key = `${signal.wallet}:${signal.poolAddress}:${signal.action}:${signal.signature ?? signal.observedAt}`;
            const accepted =
              signal.poolAddress === poolAddress &&
              allowed.has(signal.wallet) &&
              now - signal.observedAt >= 0 &&
              now - signal.observedAt <= settings.staleMs &&
              !seen.has(key);
            seen.add(key);
            return accepted;
          });
          const wallets = [...new Set(valid.map((signal) => signal.wallet))];
          return {
            boost: Math.min(settings.maxBoost, wallets.length > 0 ? MAX_BOOST : 0),
            wallets,
            ignored: parseCopySignalPayload(raw).length - valid.length,
          };
        }),
        Effect.catchAll((error) =>
          Effect.sync(() => {
            logger.warn("Copy-signal fetch failed; continuing without boost", {
              error: String(error),
            });
            return { boost: 0, wallets: [], ignored: 0 };
          }),
        ),
      );
    };
    return { getBoost } satisfies CopySignalApi;
  }),
);

export const copySignalActionTypes: ReadonlyArray<ActionType> = ["ENTER", "HOLD", "REBALANCE"];
