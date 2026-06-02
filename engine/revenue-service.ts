import { Effect, Context, Layer } from "effect";

// Tier definitions
export interface TierConfig {
  readonly name: string;
  readonly maxFreeSol: number; // Max profit before fees kick in
  readonly managementFeeRate: number; // Annual rate (e.g., 0.02 = 2%)
  readonly performanceFeeRate: number; // Of profits above high watermark
  readonly earlyRedemptionFeeRate: number; // Exit before lockup
  readonly lockupDays: number;
  readonly monthlyFeeSol: number; // Fixed monthly fee
}

export const TIERS: Record<string, TierConfig> = {
  free: {
    name: "free",
    maxFreeSol: 1.0,
    managementFeeRate: 0,
    performanceFeeRate: 0,
    earlyRedemptionFeeRate: 0,
    lockupDays: 0,
    monthlyFeeSol: 0,
  },
  pro: {
    name: "pro",
    maxFreeSol: 10.0,
    managementFeeRate: 0.02, // 2% annually
    performanceFeeRate: 0.1, // 10% of profits
    earlyRedemptionFeeRate: 0.05, // 5%
    lockupDays: 30,
    monthlyFeeSol: 0.5,
  },
  fund: {
    name: "fund",
    maxFreeSol: Number.MAX_SAFE_INTEGER,
    managementFeeRate: 0.02, // 2% annually
    performanceFeeRate: 0.2, // 20% of profits
    earlyRedemptionFeeRate: 0.1, // 10%
    lockupDays: 90,
    monthlyFeeSol: 2.0,
  },
};

// Revenue tracking state
export interface RevenueState {
  readonly userId: string;
  readonly tier: string;
  readonly highWatermark: number; // Highest NAV seen
  readonly totalFeesPaid: number;
  readonly lastFeeCalculation: string; // ISO date
  readonly lockupEndDate?: string;
}

// Fee calculation result
export interface FeeCalculation {
  readonly managementFee: number;
  readonly performanceFee: number;
  readonly totalFee: number;
  readonly newHighWatermark: number;
}

export class RevenueService extends Context.Tag("RevenueService")<
  RevenueService,
  {
    readonly calculateFees: (
      state: RevenueState,
      currentNav: number,
      daysHeld: number,
    ) => Effect.Effect<FeeCalculation, Error>;
    readonly checkSubscription: (
      userId: string,
    ) => Effect.Effect<
      { active: boolean; tier: string; expiresAt?: string },
      Error
    >;
    readonly recordFeePayment: (
      userId: string,
      amount: number,
      txSignature: string,
    ) => Effect.Effect<void, Error>;
  }
>() {}

// Implementation
const calculateFeesImpl = (
  state: RevenueState,
  currentNav: number,
  daysHeld: number,
): Effect.Effect<FeeCalculation, Error> =>
  Effect.gen(function* () {
    const tier = TIERS[state.tier];
    if (!tier) {
      return yield* Effect.fail(new Error(`Unknown tier: ${state.tier}`));
    }

    // Management fee: AUM * rate * (days / 365)
    const managementFee =
      currentNav * tier.managementFeeRate * (daysHeld / 365);

    // Performance fee: only on profits above high watermark
    const profitAboveHW = Math.max(0, currentNav - state.highWatermark);
    const performanceFee = profitAboveHW * tier.performanceFeeRate;

    // New high watermark
    const newHighWatermark = Math.max(state.highWatermark, currentNav);

    return {
      managementFee,
      performanceFee,
      totalFee: managementFee + performanceFee,
      newHighWatermark,
    };
  });

const checkSubscriptionImpl = (
  _userId: string,
): Effect.Effect<
  { active: boolean; tier: string; expiresAt?: string },
  Error
> =>
  // TODO: Query D1 via Cloudflare Worker when Issue #16 is merged
  Effect.succeed({ active: true, tier: "free" });

const recordFeePaymentImpl = (
  _userId: string,
  _amount: number,
  _txSignature: string,
): Effect.Effect<void, Error> =>
  // TODO: Record to D1 when Issue #16 is merged
  Effect.void;

export const RevenueLive = Layer.succeed(RevenueService, {
  calculateFees: calculateFeesImpl,
  checkSubscription: checkSubscriptionImpl,
  recordFeePayment: recordFeePaymentImpl,
});
