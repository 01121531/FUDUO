import { describe, expect, it, vi } from "vitest";
import { DatabaseService } from "../database/database.service.js";
import { DemoDataService } from "../demo/demo-data.service.js";
import { BusinessDataService } from "../data/business-data.service.js";
import { BusinessToolService, canReceiveReport, defaultDailyReportDate, defaultWeeklyReportStart } from "./business-tool.service.js";

function service() {
  const database = new DatabaseService();
  const demo = new DemoDataService();
  return new BusinessToolService(database, new BusinessDataService(database, demo));
}

describe("business tool boundary", () => {
  it("returns deterministic demo sales and freshness metadata", async () => {
    const result = await service().invoke("get_sales_summary", {}) as { summary: { salesAmount: number }; dataAsOf: string };
    expect(result.summary.salesAmount).toBeGreaterThan(0);
    expect(result.dataAsOf).toMatch(/^\d{4}-/);
  });

  it("rejects undeclared parameters so a model cannot pass a URL or headers", async () => {
    await expect(service().invoke("get_sales_summary", { url: "https://example.com", authorization: "Bearer secret" })).rejects.toThrow();
  });

  it("queues reports only for channel users who can read the complete shop scope", () => {
    expect(canReceiveReport({ permissions: ["*"], allShops: true, shopIds: [] }, [])).toBe(true);
    expect(canReceiveReport({ permissions: ["reports:read"], allShops: false, shopIds: ["101", "102"] }, ["101"])).toBe(true);
    expect(canReceiveReport({ permissions: ["reports:read"], allShops: false, shopIds: ["101"] }, ["101", "202"])).toBe(false);
    expect(canReceiveReport({ permissions: ["reports:read"], allShops: false, shopIds: ["101"] }, [])).toBe(false);
    expect(canReceiveReport({ permissions: ["data:read"], allShops: false, shopIds: ["101"] }, ["101"])).toBe(false);
  });

  it("uses the previous completed business period for scheduled reports", () => {
    expect(defaultDailyReportDate(new Date("2026-07-21T16:30:00.000Z"))).toBe("2026-07-21");
    expect(defaultWeeklyReportStart(new Date("2026-07-20T01:00:00.000Z"))).toBe("2026-07-13");
    expect(defaultWeeklyReportStart(new Date("2026-07-26T15:59:59.000Z"))).toBe("2026-07-13");
    expect(defaultWeeklyReportStart(new Date("2026-07-26T16:00:00.000Z"))).toBe("2026-07-20");
  });

  it("applies the caller's shop scope to synchronization status", async () => {
    const syncRuns = vi.fn(async () => []);
    const access = { readableShopIds: vi.fn(async () => ["101"]) };
    const tools = new BusinessToolService(
      { enabled: false } as never,
      { syncRuns } as never,
      access as never,
    );

    await tools.invoke("get_sync_status", {}, { userId: "viewer-1" });

    expect(access.readableShopIds).toHaveBeenCalledWith("viewer-1", []);
    expect(syncRuns).toHaveBeenCalledWith(["101"]);
  });
});
