import { describe, it, expect } from "vitest";
import { evaluatePaperValidation } from "../engine/risk-service.js";

describe("evaluatePaperValidation (F6 paper-trading validation)", () => {
  it("approves live ENTER when paper validation period is met", () => {
    // 10 paper days accumulated, min=7 → approve
    const result = evaluatePaperValidation({
      paperTrading: false,
      paperDaysAccumulated: 10,
      minDays: 7,
      enforce: true,
    });
    expect(result.approved).toBe(true);
  });

  it("rejects live ENTER when below min days (enforced)", () => {
    // 3 paper days, min=7, enforce=true → reject
    const result = evaluatePaperValidation({
      paperTrading: false,
      paperDaysAccumulated: 3,
      minDays: 7,
      enforce: true,
    });
    expect(result.approved).toBe(false);
    expect(result.reason.toLowerCase()).toContain("paper");
  });

  it("always approves paper trading (validation only gates live)", () => {
    const result = evaluatePaperValidation({
      paperTrading: true,
      paperDaysAccumulated: 0,
      minDays: 7,
      enforce: true,
    });
    expect(result.approved).toBe(true);
  });

  it("approves live when enforce is off (warn-only mode)", () => {
    const result = evaluatePaperValidation({
      paperTrading: false,
      paperDaysAccumulated: 1,
      minDays: 7,
      enforce: false,
    });
    expect(result.approved).toBe(true);
    expect(result.warning).toBeDefined();
  });

  it("rejects at exact min days - 1 (boundary)", () => {
    const result = evaluatePaperValidation({
      paperTrading: false,
      paperDaysAccumulated: 6,
      minDays: 7,
      enforce: true,
    });
    expect(result.approved).toBe(false);
  });

  it("approves at exact min days", () => {
    const result = evaluatePaperValidation({
      paperTrading: false,
      paperDaysAccumulated: 7,
      minDays: 7,
      enforce: true,
    });
    expect(result.approved).toBe(true);
  });
});
