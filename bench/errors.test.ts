import { describe, it, expect } from "vitest";
import {
  ConfigError,
  AdapterError,
  MemoryError,
  RiskError,
  BlacklistError,
  ScreenerError,
  AuditError,
} from "../engine/errors.js";

describe("errors", () => {
  it("ConfigError constructs with correct _tag", () => {
    const err = new ConfigError({ message: "test config error" });
    expect(err._tag).toBe("ConfigError");
    expect(err.message).toBe("test config error");
  });

  it("AdapterError constructs with correct _tag and optional fields", () => {
    const err = new AdapterError({ message: "test adapter error", poolAddress: "pool123" });
    expect(err._tag).toBe("AdapterError");
    expect(err.message).toBe("test adapter error");
    expect(err.poolAddress).toBe("pool123");
  });

  it("MemoryError constructs with correct _tag", () => {
    const err = new MemoryError({ message: "test memory error" });
    expect(err._tag).toBe("MemoryError");
  });

  it("RiskError constructs with correct _tag and reason", () => {
    const err = new RiskError({ message: "test risk error", reason: "low confidence" });
    expect(err._tag).toBe("RiskError");
    expect(err.reason).toBe("low confidence");
  });

  it("BlacklistError constructs with correct _tag", () => {
    const err = new BlacklistError({ message: "test blacklist error" });
    expect(err._tag).toBe("BlacklistError");
  });

  it("ScreenerError constructs with correct _tag", () => {
    const err = new ScreenerError({ message: "test screener error" });
    expect(err._tag).toBe("ScreenerError");
  });

  it("AuditError constructs with correct _tag", () => {
    const err = new AuditError({ message: "test audit error" });
    expect(err._tag).toBe("AuditError");
  });

  it("all errors are instances of Error", () => {
    expect(new ConfigError({ message: "test" })).toBeInstanceOf(Error);
    expect(new AdapterError({ message: "test" })).toBeInstanceOf(Error);
    expect(new MemoryError({ message: "test" })).toBeInstanceOf(Error);
    expect(new RiskError({ message: "test", reason: "r" })).toBeInstanceOf(Error);
    expect(new BlacklistError({ message: "test" })).toBeInstanceOf(Error);
    expect(new ScreenerError({ message: "test" })).toBeInstanceOf(Error);
    expect(new AuditError({ message: "test" })).toBeInstanceOf(Error);
  });
});
