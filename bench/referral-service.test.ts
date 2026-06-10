import { describe, it, expect } from "vitest";
import {
  generateReferralCode,
  checkMilestone,
  REFERRAL_MILESTONES,
} from "../engine/referral-service.js";

describe("referral-service", () => {
  describe("generateReferralCode", () => {
    it("generates an 8-character code", () => {
      const code = generateReferralCode();
      expect(code).toHaveLength(8);
    });

    it("uses only allowed characters", () => {
      const code = generateReferralCode();
      const allowedChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      for (const char of code) {
        expect(allowedChars).toContain(char);
      }
    });

    it("generates different codes on multiple calls", () => {
      const codes = new Set<string>();
      for (let i = 0; i < 10; i++) {
        codes.add(generateReferralCode());
      }
      // Very unlikely to get duplicates in 10 calls with 32^8 possibilities
      expect(codes.size).toBeGreaterThanOrEqual(9);
    });
  });

  describe("checkMilestone", () => {
    it("returns null when below all milestones", () => {
      expect(checkMilestone(0)).toBeNull();
      expect(checkMilestone(1)).toBeNull();
      expect(checkMilestone(4)).toBeNull();
    });

    it("returns the correct milestone at exactly 5 referrals", () => {
      const milestone = checkMilestone(5);
      expect(milestone).not.toBeNull();
      expect(milestone!.count).toBe(5);
      expect(milestone!.bonus).toBe(25);
    });

    it("returns the correct milestone at exactly 10 referrals", () => {
      const milestone = checkMilestone(10);
      expect(milestone).not.toBeNull();
      expect(milestone!.count).toBe(10);
      expect(milestone!.bonus).toBe(50);
    });

    it("returns the highest applicable milestone", () => {
      const milestone = checkMilestone(15);
      expect(milestone).not.toBeNull();
      expect(milestone!.count).toBe(10);
      expect(milestone!.bonus).toBe(50);
    });

    it("returns 5-referral milestone for counts between 5 and 9", () => {
      for (let i = 5; i <= 9; i++) {
        const milestone = checkMilestone(i);
        expect(milestone).not.toBeNull();
        expect(milestone!.count).toBe(5);
      }
    });
  });

  describe("REFERRAL_MILESTONES", () => {
    it("is sorted by count ascending", () => {
      for (let i = 1; i < REFERRAL_MILESTONES.length; i++) {
        expect(REFERRAL_MILESTONES[i]!.count).toBeGreaterThan(REFERRAL_MILESTONES[i - 1]!.count);
      }
    });
  });
});
