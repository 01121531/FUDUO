import { describe, expect, it, vi } from "vitest";
import { prepareSyncJobData, prepareSyncShopScope, syncRunPayload } from "./sync-job-data.js";

describe("synchronization job data", () => {
  it("freezes the Shanghai business date before a live job starts", async () => {
    const job = { name: "orders-sync" as const, data: {}, updateData: vi.fn(async () => undefined) };
    await expect(prepareSyncJobData(job, new Date("2026-07-21T16:00:00.000Z"))).resolves.toEqual({ tradeDate: "2026-07-22" });
    expect(job.updateData).toHaveBeenCalledWith({ tradeDate: "2026-07-22" });
    expect(job.data).toEqual({ tradeDate: "2026-07-22" });
  });

  it("freezes all seven reconciliation dates and preserves requested shops", async () => {
    const job = { name: "sales-reconcile" as const, data: { shopIds: ["101"] }, updateData: vi.fn(async () => undefined) };
    const data = await prepareSyncJobData(job, new Date("2026-08-01T02:00:00.000Z"));
    expect(data.tradeDates).toEqual(["2026-08-01", "2026-07-31", "2026-07-30", "2026-07-29", "2026-07-28", "2026-07-27", "2026-07-26"]);
    expect(syncRunPayload(data)).toEqual({ tradeDates: data.tradeDates, shopIds: ["101"] });
  });

  it("does not rewrite already fixed job data on retries", async () => {
    const job = { name: "sales-live-sync" as const, data: { tradeDate: "2026-07-20" }, updateData: vi.fn(async () => undefined) };
    await expect(prepareSyncJobData(job, new Date("2026-07-22T00:00:00.000Z"))).resolves.toEqual({ tradeDate: "2026-07-20" });
    expect(job.updateData).not.toHaveBeenCalled();
  });

  it("persists the source run for an operator-triggered retry", () => {
    expect(syncRunPayload({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      tradeDate: "2026-07-21",
      shopIds: ["101"],
    })).toEqual({
      sourceRunId: "11111111-1111-4111-8111-111111111111",
      tradeDate: "2026-07-21",
      shopIds: ["101"],
    });
  });

  it("freezes the active shop scope once before a scheduled job runs", async () => {
    const job = { name: "sales-reconcile" as const, data: { tradeDates: ["2026-07-21"] }, updateData: vi.fn(async () => undefined) };
    const activeShopIds = vi.fn(async () => ["101", "202"]);

    await expect(prepareSyncShopScope(job, activeShopIds)).resolves.toEqual({ tradeDates: ["2026-07-21"], shopIds: ["101", "202"] });
    expect(job.updateData).toHaveBeenCalledWith({ tradeDates: ["2026-07-21"], shopIds: ["101", "202"] });
    await prepareSyncShopScope(job, activeShopIds);
    expect(activeShopIds).toHaveBeenCalledOnce();
  });

  it("rejects a scheduled shop job when no active shops exist", async () => {
    const job = { name: "orders-sync" as const, data: { tradeDate: "2026-07-21" }, updateData: vi.fn(async () => undefined) };
    await expect(prepareSyncShopScope(job, async () => [])).rejects.toThrow("SYNC_NO_ACTIVE_SHOPS");
  });
});
