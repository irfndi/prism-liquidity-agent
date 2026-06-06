import { Effect, Layer } from "effect";
import { ReferralService, type ReferralApi } from "./services.js";

export const REFERRAL_MILESTONES = [
  { count: 5, bonus: 25 },
  { count: 10, bonus: 50 },
];

export function generateReferralCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export function checkMilestone(
  referralCount: number,
): { count: number; bonus: number } | null {
  for (let i = REFERRAL_MILESTONES.length - 1; i >= 0; i--) {
    const milestone = REFERRAL_MILESTONES[i];
    if (milestone && referralCount >= milestone.count) {
      return milestone;
    }
  }
  return null;
}

const generateCodeImpl = (userId: string): Effect.Effect<string, Error> =>
  Effect.sync(() => {
    const code = generateReferralCode();
    console.info("Generated referral code", { userId, code });
    return code;
  });

const validateCodeImpl = (
  code: string,
): Effect.Effect<{ valid: boolean; referrerId?: string }, Error> =>
  Effect.succeed(
    code.length === 8
      ? { valid: true, referrerId: "dummy_referrer" }
      : { valid: false },
  );

const applyReferralImpl = (
  code: string,
  refereeId: string,
): Effect.Effect<void, Error> =>
  Effect.sync(() => {
    console.info("Applied referral", { code, refereeId });
  });

const getReferralCountImpl = (_userId: string): Effect.Effect<number, Error> =>
  Effect.succeed(0);

const getUserCreditsImpl = (_userId: string): Effect.Effect<number, Error> =>
  Effect.succeed(0);

const addCreditsImpl = (
  userId: string,
  amount: number,
  reason: string,
): Effect.Effect<void, Error> =>
  Effect.sync(() => {
    console.info("Added credits", { userId, amount, reason });
  });

const deductCreditsImpl = (
  userId: string,
  amount: number,
  reason: string,
): Effect.Effect<void, Error> =>
  Effect.sync(() => {
    console.info("Deducted credits", { userId, amount, reason });
  });

export const ReferralLive = Layer.succeed(ReferralService, {
  generateCode: generateCodeImpl,
  validateCode: validateCodeImpl,
  applyReferral: applyReferralImpl,
  getReferralCount: getReferralCountImpl,
  getUserCredits: getUserCreditsImpl,
  addCredits: addCreditsImpl,
  deductCredits: deductCreditsImpl,
} satisfies ReferralApi);
