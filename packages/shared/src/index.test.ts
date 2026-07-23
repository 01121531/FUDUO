import { describe, expect, it } from "vitest";
import { calculateFreshness, formatCurrency } from "./index";

describe("shared business formatting", () => {
  const now = new Date("2026-07-21T08:00:00.000Z");

  it("classifies freshness boundaries", () => {
    expect(calculateFreshness(null, now)).toBe("UNKNOWN");
    expect(calculateFreshness(new Date("2026-07-21T07:55:00.000Z"), now)).toBe("LIVE");
    expect(calculateFreshness(new Date("2026-07-21T07:20:00.000Z"), now)).toBe("RECENT");
    expect(calculateFreshness(new Date("2026-07-21T06:00:00.000Z"), now)).toBe("STALE");
  });

  it("distinguishes missing values from zero", () => {
    expect(formatCurrency(null)).toBe("—");
    expect(formatCurrency(0)).toContain("0.00");
  });
});
