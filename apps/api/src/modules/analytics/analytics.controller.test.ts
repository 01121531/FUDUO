import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsController } from "./analytics.controller.js";

describe("AnalyticsController", () => {
  it("passes normalized period and unique shop IDs to the data service", async () => {
    const dashboard = vi.fn(async () => ({ dataAsOf: "2026-07-21T08:00:00.000Z", freshness: "LIVE" }));
    const controller = new AnalyticsController({ dashboard } as never);

    await controller.dashboard("7d", "102,101,102");

    expect(dashboard).toHaveBeenCalledWith("7d", ["102", "101"], expect.objectContaining({ period: "7d", dayCount: 7 }), null);
  });

  it("rejects unsupported periods and malformed shop filters", async () => {
    const controller = new AnalyticsController({ dashboard: vi.fn() } as never);
    await expect(controller.dashboard("quarter", undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.dashboard("today", "102,abc")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("accepts a valid custom range and rejects invalid custom ranges", async () => {
    const dashboard = vi.fn(async () => ({ dataAsOf: "2026-07-21T08:00:00.000Z", freshness: "LIVE" }));
    const controller = new AnalyticsController({ dashboard } as never);

    await controller.dashboard("custom", undefined, "2026-07-01", "2026-07-21");
    expect(dashboard).toHaveBeenCalledWith("custom", [], expect.objectContaining({ start: "2026-07-01", end: "2026-07-21", dayCount: 21 }), null);
    await expect(controller.dashboard("custom", undefined, "2026-07-21", "2026-07-01")).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.dashboard("custom", undefined, undefined, undefined)).rejects.toBeInstanceOf(BadRequestException);
  });
});
