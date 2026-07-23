import { describe, expect, it } from "vitest";
import { recentBusinessDates, shanghaiBusinessDate } from "./business-dates.js";

describe("Shanghai business dates", () => {
  it("uses the Shanghai calendar date around the UTC day boundary", () => {
    expect(shanghaiBusinessDate(new Date("2026-07-21T15:59:59.000Z"))).toBe("2026-07-21");
    expect(shanghaiBusinessDate(new Date("2026-07-21T16:00:00.000Z"))).toBe("2026-07-22");
  });

  it("returns the requested recent range in descending order across month boundaries", () => {
    expect(recentBusinessDates(4, new Date("2026-08-01T02:00:00.000Z"))).toEqual([
      "2026-08-01",
      "2026-07-31",
      "2026-07-30",
      "2026-07-29",
    ]);
  });

  it("rejects invalid range lengths", () => {
    expect(() => recentBusinessDates(0)).toThrow("BUSINESS_DATE_RANGE_INVALID");
    expect(() => recentBusinessDates(1.5)).toThrow("BUSINESS_DATE_RANGE_INVALID");
  });
});
