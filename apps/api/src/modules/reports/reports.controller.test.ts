import { describe, expect, it, vi } from "vitest";
import { ReportsController, aggregateWechatDeliveryStatus, canReadScopedReport } from "./reports.controller.js";

describe("ReportsController", () => {
  it("only lists snapshots wholly contained in a restricted employee shop scope", async () => {
    const snapshots = [
      report("own", ["101"]),
      report("mixed", ["101", "202"]),
      report("global", []),
    ];
    const database = { enabled: true, prisma: { reportSnapshot: { findMany: vi.fn(async () => snapshots) } } };
    const access = { assertPermission: vi.fn(async () => ({ allShops: false, shopIds: ["101"] })) };
    const controller = new ReportsController(database as never, {} as never, access as never);

    const response = await controller.list({ user: { id: "employee-1" } });

    expect(response.data.map((item) => item.id)).toEqual(["own"]);
    expect(access.assertPermission).toHaveBeenCalledWith("employee-1", "reports:read");
  });

  it("allows administrators to list global and scoped snapshots", async () => {
    const snapshots = [report("global", []), report("scoped", ["101"])];
    const database = { enabled: true, prisma: { reportSnapshot: { findMany: vi.fn(async () => snapshots) } } };
    const access = { assertPermission: vi.fn(async () => ({ allShops: true, shopIds: [] })) };
    const response = await new ReportsController(database as never, {} as never, access as never).list({ user: { id: "admin-1" } });
    expect(response.data.map((item) => item.id)).toEqual(["global", "scoped"]);
  });

  it("does not expose legacy all-shop snapshots to restricted employees", () => {
    expect(canReadScopedReport([], ["101"])).toBe(false);
    expect(canReadScopedReport(["101"], ["101", "102"])).toBe(true);
    expect(canReadScopedReport(["101", "202"], ["101", "102"])).toBe(false);
  });

  it("aggregates real WeChat delivery state without treating Web storage as a push", () => {
    expect(aggregateWechatDeliveryStatus([])).toBe("NOT_SENT");
    expect(aggregateWechatDeliveryStatus([{ channel: "WEB", status: "SUCCEEDED" }])).toBe("NOT_SENT");
    expect(aggregateWechatDeliveryStatus([{ channel: "WECHAT", status: "SUCCEEDED" }])).toBe("SENT");
    expect(aggregateWechatDeliveryStatus([{ channel: "WECHAT", status: "FAILED" }])).toBe("FAILED");
    expect(aggregateWechatDeliveryStatus([{ channel: "WECHAT", status: "FAILED" }, { channel: "WECHAT", status: "QUEUED" }])).toBe("PENDING");
  });

  it("creates and updates schedules in demo mode for UI acceptance", async () => {
    const access = { scope: vi.fn(async () => ({ permissions: ["*"] })) };
    const controller = new ReportsController({ enabled: false } as never, {} as never, access as never);
    const initial = await controller.schedules({ user: { id: "admin-1" } });
    expect(initial.data).toHaveLength(2);

    const created = await controller.createSchedule({ type: "DAILY", cron: "0 15 10 * * *", shopIds: ["101"], channels: ["WEB"] }, { user: { id: "admin-1" } });
    expect(created.data).toMatchObject({ type: "DAILY", cron: "0 15 10 * * *", active: true, shopIds: ["101"] });
    const updated = await controller.updateSchedule(created.data.id, { active: false }, { user: { id: "admin-1" } });
    expect(updated.data.active).toBe(false);
  });

  it("exposes realistic delivery states in demo reports", async () => {
    const access = { assertPermission: vi.fn(async () => ({ allShops: true, shopIds: [] })) };
    const response = await new ReportsController({ enabled: false } as never, {} as never, access as never).list({ user: { id: "admin-1" } });
    expect(response.data.map((report) => report.deliveryStatus)).toEqual(["SENT", "PENDING"]);
  });

  it("adds a manually generated demo report to the list with a new version", async () => {
    const access = { assertPermission: vi.fn(async () => ({ allShops: true, shopIds: [] })) };
    const generated = {
      period: { startDate: "2026-07-21", endDate: "2026-07-21" },
      shops: [{
        shopId: "10218",
        shopName: "云野生活馆",
        salesAmount: 1200,
        transactionCount: 12,
        payBuyerCount: 11,
        refundAmount: 20,
        averageOrderValue: 100,
        freshness: "LIVE",
        dataAsOf: "2026-07-21T08:00:00.000Z",
        missing: false,
      }],
      summary: { salesAmount: 1200, transactionCount: 12, payBuyerCount: 11, refundAmount: 20, averageOrderValue: 100 },
      freshness: "LIVE",
      dataAsOf: "2026-07-21T08:00:00.000Z",
      partial: false,
      missingShops: [],
    };
    const tools = { invoke: vi.fn(async () => generated) };
    const controller = new ReportsController({ enabled: false } as never, tools as never, access as never);

    const created = await controller.generate(
      { type: "DAILY", date: "2026-07-21" },
      { user: { id: "admin-1" } },
    ) as { data: { id: string; type: string; version: number; shopIds: string[] } };
    const listed = await controller.list({ user: { id: "admin-1" } });

    expect(tools.invoke).toHaveBeenCalledWith("generate_daily_report", { date: "2026-07-21" }, { userId: "admin-1" });
    expect(created.data).toMatchObject({ type: "DAILY", version: 2, shopIds: ["10218"] });
    expect(listed.data).toHaveLength(3);
    expect(listed.data[0]).toMatchObject({ id: created.data.id, type: "DAILY", version: 2, deliveryStatus: "NOT_SENT" });
  });

  it("returns a scoped immutable snapshot with its WeChat preview", async () => {
    const snapshot = {
      ...report("550e8400-e29b-41d4-a716-446655440000", ["101"]),
      deliveries: [{ id: "delivery-1", channel: "WECHAT", recipient: "employee@im.wechat", status: "SUCCEEDED", attempts: 1, errorCode: null, lastAttemptAt: new Date("2026-07-21T09:00:00.000Z"), sentAt: new Date("2026-07-21T09:00:01.000Z") }],
      data: {
        period: { startDate: "2026-07-21", endDate: "2026-07-21" },
        shops: [{ shopId: "101", shopName: "测试店铺", salesAmount: 1200, transactionCount: 12, payBuyerCount: 11, refundAmount: 20, averageOrderValue: 100, freshness: "LIVE", dataAsOf: "2026-07-21T08:00:00.000Z", missing: false }],
        summary: { salesAmount: 1200, transactionCount: 12, payBuyerCount: 11, refundAmount: 20, averageOrderValue: 100 },
        freshness: "LIVE",
        dataAsOf: "2026-07-21T08:00:00.000Z",
        partial: false,
        missingShops: [],
      },
    };
    const database = { enabled: true, prisma: { reportSnapshot: { findUnique: vi.fn(async () => snapshot) } } };
    const access = { assertPermission: vi.fn(async () => ({ allShops: false, shopIds: ["101"] })) };
    const response = await new ReportsController(database as never, {} as never, access as never).detail(snapshot.id, { user: { id: "employee-1" } });
    expect(response.data.data.summary.salesAmount).toBe(1200);
    expect(response.data).toMatchObject({ freshness: "LIVE", partial: false, dataAsOf: "2026-07-21T08:00:00.000Z" });
    expect(response.data.previews.wechat).toContain("测试店铺");
    expect(response.data.previews.wechat).toContain("数据状态：实时（完整）");
    expect(response.data.deliveryStatus).toBe("SENT");
    expect(response.data.deliveries[0]).toMatchObject({ recipient: "em***@im.wechat", status: "SUCCEEDED" });
    expect(JSON.stringify(response.data.deliveries)).not.toContain("employee@im.wechat");
  });

  it("hides an out-of-scope snapshot when an employee guesses its id", async () => {
    const snapshot = { ...report("550e8400-e29b-41d4-a716-446655440000", ["202"]), data: {} };
    const database = { enabled: true, prisma: { reportSnapshot: { findUnique: vi.fn(async () => snapshot) } } };
    const access = { assertPermission: vi.fn(async () => ({ allShops: false, shopIds: ["101"] })) };
    await expect(new ReportsController(database as never, {} as never, access as never).detail(snapshot.id, { user: { id: "employee-1" } })).rejects.toMatchObject({ status: 404 });
  });
});

function report(id: string, shopIds: string[]) {
  return {
    id,
    type: "DAILY",
    periodStart: new Date("2026-07-21T00:00:00.000Z"),
    periodEnd: new Date("2026-07-21T00:00:00.000Z"),
    version: 1,
    shopIds,
    dataAsOf: new Date("2026-07-21T08:00:00.000Z"),
    createdAt: new Date("2026-07-21T09:00:00.000Z"),
  };
}
