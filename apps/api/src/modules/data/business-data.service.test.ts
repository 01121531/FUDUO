import { describe, expect, it, vi } from "vitest";
import { BusinessDataService } from "./business-data.service.js";
import { addBusinessDays, resolveDashboardRange, shanghaiBusinessDate } from "./dashboard-period.js";

const decimal = (value: number) => ({ toNumber: () => value });

describe("BusinessDataService dashboard", () => {
  it("aggregates the selected range, compares the adjacent range, and keeps missing shops explicit", async () => {
    const findMany = vi.fn(async () => [
      {
        fuduoShopId: 101n,
        name: "店铺 A",
        lastSyncedAt: new Date("2026-07-21T08:05:00.000Z"),
        salesDaily: [
          row("2026-07-20", 80, 8, "2026-07-20T08:00:00.000Z"),
          row("2026-07-21", 100, 10, "2026-07-21T08:05:00.000Z"),
        ],
        refundDaily: [refundRow("2026-07-20", 4), refundRow("2026-07-21", 7)],
      },
      {
        fuduoShopId: 102n,
        name: "店铺 B",
        lastSyncedAt: new Date("2026-07-20T08:00:00.000Z"),
        salesDaily: [row("2026-07-20", 20, 2, "2026-07-20T08:00:00.000Z")],
        refundDaily: [refundRow("2026-07-20", 2)],
      },
    ]);
    const database = { enabled: true, prisma: { shop: { findMany } } };
    const service = new BusinessDataService(database as never, {} as never);

    const dashboard = await service.dashboard("today", ["101", "102"], resolveDashboardRange("today", new Date("2026-07-21T08:10:00.000Z")));

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: "ACTIVE", fuduoShopId: { in: [101n, 102n] } },
    }));
    expect(dashboard.summary).toMatchObject({ salesAmount: 100, transactionCount: 10, refundAmount: null, refundPartial: true, partial: true, missingShops: ["店铺 B"] });
    expect(dashboard.changes.salesAmount).toBe(0);
    expect(dashboard.changes.refundAmount).toBeNull();
    expect(dashboard.rankings.map((shop) => shop.shopName)).toEqual(["店铺 A", "店铺 B"]);
    expect(dashboard.trend).toEqual([{ date: "07-21", sales: null, previous: 100 }]);
    expect(dashboard.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ title: "店铺 B数据尚未同步" })]));
    expect(dashboard.alerts).toEqual(expect.arrayContaining([expect.objectContaining({ title: "店铺 B退款数据不完整" })]));
  });

  it("marks an empty dashboard as unknown instead of live", async () => {
    const service = new BusinessDataService({ enabled: true, prisma: { shop: { findMany: vi.fn(async () => []) } } } as never, {} as never);
    const dashboard = await service.dashboard("today", [], resolveDashboardRange("today", new Date("2026-07-21T08:10:00.000Z")));

    expect(dashboard.freshness).toBe("UNKNOWN");
    expect(dashboard.rankings).toEqual([]);
  });

  it("returns scoped sales, order, and refund history without exposing database IDs", async () => {
    const findUnique = vi.fn(async () => ({
      salesDaily: [{ ...row("2026-07-21", 100, 10, "2026-07-21T08:05:00.000Z") }],
      orderDaily: [{ tradeDate: new Date("2026-07-21T00:00:00.000Z"), orderCount: 11, paidOrderCount: 10, paidAmount: decimal(100), fetchedAt: new Date("2026-07-21T08:06:00.000Z") }],
      refundDaily: [{ tradeDate: new Date("2026-07-21T00:00:00.000Z"), refundCount: 1, refundAmount: decimal(5), fetchedAt: new Date("2026-07-21T08:07:00.000Z") }],
    }));
    const service = new BusinessDataService({ enabled: true, prisma: { shop: { findUnique } } } as never, {} as never);

    const history = await service.shopHistory("101", 30, ["101"]);

    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { fuduoShopId: 101n } }));
    expect(history).toMatchObject({
      shopId: "101",
      sales: [{ date: "2026-07-21", salesAmount: 100, transactionCount: 10 }],
      orders: [{ date: "2026-07-21", paidOrderCount: 10, paidAmount: 100 }],
      refunds: [{ date: "2026-07-21", refundCount: 1, refundAmount: 5 }],
    });
    await expect(service.shopHistory("202", 30, ["101"])).resolves.toBeNull();
  });

  it("does not label the latest historical row as today's shop data", async () => {
    const yesterday = addBusinessDays(shanghaiBusinessDate(), -1);
    const findUnique = vi.fn(async () => ({
      fuduoShopId: 101n,
      fuduoAccountId: null,
      name: "店铺 A",
      platformCode: "pdd",
      loginStatus: "ACTIVE",
      lastSyncedAt: new Date(`${yesterday}T08:00:00.000Z`),
      salesDaily: [row(yesterday, 100, 10, `${yesterday}T08:00:00.000Z`)],
      refundDaily: [refundRow(yesterday, 5)],
    }));
    const service = new BusinessDataService({ enabled: true, prisma: { shop: { findUnique } } } as never, {} as never);

    await expect(service.shopDetail("101")).resolves.toMatchObject({
      shop: { todaySales: null, todayOrders: null, refundAmount: null },
      sales: null,
    });
  });

  it("returns synchronization completion time separately from start time", async () => {
    const findMany = vi.fn(async () => [{
      id: "run-1",
      type: "sales-live-sync",
      status: "SUCCEEDED",
      totalItems: 2,
      successItems: 2,
      failedItems: 0,
      createdAt: new Date("2026-07-21T08:00:00.000Z"),
      startedAt: new Date("2026-07-21T08:00:01.000Z"),
      finishedAt: new Date("2026-07-21T08:00:04.000Z"),
      errorCode: null,
    }]);
    const service = new BusinessDataService({ enabled: true, prisma: { syncRun: { findMany } } } as never, {} as never);

    await expect(service.syncRuns()).resolves.toEqual([expect.objectContaining({
      id: "run-1",
      startedAt: "2026-07-21T08:00:01.000Z",
      finishedAt: "2026-07-21T08:00:04.000Z",
      durationMs: 3_000,
    })]);
  });

  it("intersects synchronization payloads with the caller's shop scope", async () => {
    const service = new BusinessDataService({ enabled: false } as never, {
      syncRuns: () => [{
        id: "run-1",
        type: "sales-live-sync",
        status: "PARTIAL",
        total: 2,
        success: 1,
        failed: 1,
        payload: { tradeDate: "2026-07-21", shopIds: ["101", "202"] },
      }],
    } as never);

    await expect(service.syncRuns(["101"])).resolves.toEqual([
      expect.objectContaining({ payload: { tradeDate: "2026-07-21", shopIds: ["101"] }, scopeAllShops: false }),
    ]);
    await expect(service.syncRuns(["303"])).resolves.toEqual([]);
  });

  it("returns serialized synchronization items scoped to the caller's shops", async () => {
    const findUnique = vi.fn(async () => ({
      id: "run-1",
      type: "sales-live-sync",
      status: "PARTIAL",
      requestedBy: "web",
      totalItems: 2,
      successItems: 1,
      failedItems: 1,
      errorCode: "ERP_SHOP_UNAVAILABLE",
      errorMessage: "一个或多个店铺同步失败",
      payload: { tradeDate: "2026-07-21", shopIds: ["101", "202"] },
      createdAt: new Date("2026-07-21T08:00:00.000Z"),
      startedAt: new Date("2026-07-21T08:00:01.000Z"),
      finishedAt: new Date("2026-07-21T08:00:04.000Z"),
      items: [
        syncItem("item-101", 101n, "店铺 A", "SUCCEEDED", null),
        syncItem("item-202", 202n, "店铺 B", "FAILED", "ERP_SHOP_UNAVAILABLE"),
      ],
    }));
    const service = new BusinessDataService({ enabled: true, prisma: { syncRun: { findUnique } } } as never, {} as never);

    await expect(service.syncRun("run-1", ["101"])).resolves.toMatchObject({
      total: 1,
      success: 1,
      failed: 0,
      payload: { tradeDate: "2026-07-21", shopIds: ["101"] },
      scopeAllShops: false,
      items: [{ id: "item-101", fuduoShopId: "101", tradeDate: "2026-07-21", status: "SUCCEEDED" }],
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "run-1" },
      include: { items: { orderBy: [{ tradeDate: "desc" }, { dataType: "asc" }, { shopName: "asc" }] } },
    });
  });
});

function syncItem(id: string, fuduoShopId: bigint, shopName: string, status: string, errorCode: string | null) {
  return {
    id,
    dataType: "sales",
    tradeDate: new Date("2026-07-21T00:00:00.000Z"),
    fuduoShopId,
    shopName,
    status,
    attempt: status === "FAILED" ? 2 : 1,
    errorCode,
    errorMessage: errorCode ? "店铺数据同步失败" : null,
    startedAt: new Date("2026-07-21T08:00:01.000Z"),
    finishedAt: new Date("2026-07-21T08:00:03.000Z"),
  };
}

function row(date: string, salesAmount: number, transactionCount: number, fetchedAt: string) {
  return {
    tradeDate: new Date(`${date}T00:00:00.000Z`),
    salesAmount: decimal(salesAmount),
    transactionCount,
    payBuyerCount: transactionCount - 1,
    averageOrderValue: decimal(salesAmount / transactionCount),
    refundAmount: decimal(999),
    fetchedAt: new Date(fetchedAt),
  };
}

function refundRow(date: string, refundAmount: number) {
  return {
    tradeDate: new Date(`${date}T00:00:00.000Z`),
    refundAmount: decimal(refundAmount),
    fetchedAt: new Date(`${date}T08:00:00.000Z`),
  };
}
