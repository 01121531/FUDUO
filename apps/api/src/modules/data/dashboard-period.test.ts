import { describe, expect, it } from "vitest";
import { isDashboardPeriod, resolveDashboardRange } from "./dashboard-period.js";

describe("dashboard period", () => {
  const now = new Date("2026-07-21T16:30:00.000Z");

  it("uses the Asia/Shanghai business date", () => {
    expect(resolveDashboardRange("today", now)).toMatchObject({
      start: "2026-07-22",
      end: "2026-07-22",
      previousStart: "2026-07-21",
      previousEnd: "2026-07-21",
    });
  });

  it("builds adjacent equal-length comparison ranges", () => {
    expect(resolveDashboardRange("7d", now)).toMatchObject({
      start: "2026-07-16",
      end: "2026-07-22",
      previousStart: "2026-07-09",
      previousEnd: "2026-07-15",
      dayCount: 7,
    });
    expect(resolveDashboardRange("30d", now)).toMatchObject({
      start: "2026-06-23",
      previousStart: "2026-05-24",
      previousEnd: "2026-06-22",
      dayCount: 30,
    });
  });

  it("accepts only supported URL values", () => {
    expect(isDashboardPeriod("yesterday")).toBe(true);
    expect(isDashboardPeriod("custom")).toBe(true);
    expect(isDashboardPeriod(undefined)).toBe(false);
  });

  it("builds a validated custom range and its adjacent comparison range", () => {
    expect(resolveDashboardRange("custom", now, { start: "2026-07-01", end: "2026-07-21" })).toMatchObject({
      start: "2026-07-01",
      end: "2026-07-21",
      previousStart: "2026-06-10",
      previousEnd: "2026-06-30",
      dayCount: 21,
    });
  });

  it("rejects invalid, reversed, and excessively large custom ranges", () => {
    expect(() => resolveDashboardRange("custom", now, { start: "2026-02-30", end: "2026-03-01" })).toThrow("DASHBOARD_CUSTOM_RANGE_INVALID");
    expect(() => resolveDashboardRange("custom", now, { start: "2026-07-21", end: "2026-07-01" })).toThrow("DASHBOARD_CUSTOM_RANGE_REVERSED");
    expect(() => resolveDashboardRange("custom", now, { start: "2025-01-01", end: "2026-07-21" })).toThrow("DASHBOARD_CUSTOM_RANGE_TOO_LARGE");
    expect(() => resolveDashboardRange("custom", now, { start: "2026-07-01", end: "2026-07-23" })).toThrow("DASHBOARD_CUSTOM_RANGE_FUTURE");
  });
});
