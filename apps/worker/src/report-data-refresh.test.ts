import { describe, expect, it, vi } from "vitest";
import { findMissingReportSales, findReportRefreshPlan, refreshReportDataGroups, reportBusinessPeriod } from "./report-data-refresh.js";

describe("report data refresh", () => {
  it("uses the previous completed Shanghai business period", () => {
    expect(reportBusinessPeriod("DAILY", new Date("2026-07-21T16:00:00.000Z"))).toEqual({
      startDate: "2026-07-21", endDate: "2026-07-21", dates: ["2026-07-21"],
    });
    expect(reportBusinessPeriod("WEEKLY", new Date("2026-07-20T01:00:00.000Z"))).toMatchObject({
      startDate: "2026-07-13", endDate: "2026-07-19",
    });
  });

  it("checks sales, orders and refunds independently for every shop/date", async () => {
    const fresh = new Date("2026-07-22T00:00:00.000Z");
    const source = sourceWith({
      sales: [{ shopId: "internal-1", tradeDate: day("2026-07-21"), fetchedAt: fresh }],
      orders: [{ shopId: "internal-2", tradeDate: day("2026-07-21"), fetchedAt: fresh }],
      refunds: [
        { shopId: "internal-1", tradeDate: day("2026-07-21"), fetchedAt: fresh },
        { shopId: "internal-2", tradeDate: day("2026-07-21"), fetchedAt: fresh },
      ],
    });

    const result = await findReportRefreshPlan(source, "DAILY", undefined, new Date("2026-07-22T01:00:00.000Z"));

    expect(result.groups).toEqual([
      { dataset: "SALES", tradeDate: "2026-07-21", shopIds: ["202"], reason: "MISSING" },
      { dataset: "ORDERS", tradeDate: "2026-07-21", shopIds: ["101"], reason: "MISSING" },
    ]);
    expect(source.refundDaily.findMany).toHaveBeenCalledOnce();
    expect(source.salesDaily.findMany).toHaveBeenCalledOnce();
  });

  it("refreshes old rows even when the period is complete", async () => {
    const old = new Date("2026-07-21T10:00:00.000Z");
    const fresh = new Date("2026-07-22T00:30:00.000Z");
    const complete = [
      { shopId: "internal-1", tradeDate: day("2026-07-21"), fetchedAt: fresh },
      { shopId: "internal-2", tradeDate: day("2026-07-21"), fetchedAt: fresh },
    ];
    const source = sourceWith({
      sales: complete,
      orders: complete,
      refunds: [{ ...complete[0]!, fetchedAt: old }, complete[1]!],
    });

    const result = await findReportRefreshPlan(source, "DAILY", undefined, new Date("2026-07-22T01:00:00.000Z"));

    expect(result.groups).toEqual([
      { dataset: "REFUNDS", tradeDate: "2026-07-21", shopIds: ["101"], reason: "STALE" },
    ]);
  });

  it("treats a partial persisted sync state as stale even when the aggregate row is recent", async () => {
    const fresh = new Date("2026-07-22T00:30:00.000Z");
    const complete = [
      { shopId: "internal-1", tradeDate: day("2026-07-21"), fetchedAt: fresh },
      { shopId: "internal-2", tradeDate: day("2026-07-21"), fetchedAt: fresh },
    ];
    const source = sourceWith({
      sales: complete,
      orders: complete,
      refunds: complete,
      states: [{ shopId: "internal-2", dataType: "ORDERS", tradeDate: day("2026-07-21"), lastSuccessAt: fresh, lastAttemptStatus: "SUCCEEDED", partial: true }],
    });

    const result = await findReportRefreshPlan(source, "DAILY", undefined, new Date("2026-07-22T01:00:00.000Z"));

    expect(result.groups).toContainEqual({ dataset: "ORDERS", tradeDate: "2026-07-21", shopIds: ["202"], reason: "STALE" });
  });

  it("keeps the scheduled period while measuring age at delayed execution time", async () => {
    const fetchedAt = new Date("2026-07-22T00:30:00.000Z");
    const complete = [
      { shopId: "internal-1", tradeDate: day("2026-07-21"), fetchedAt },
      { shopId: "internal-2", tradeDate: day("2026-07-21"), fetchedAt },
    ];
    const source = sourceWith({ sales: complete, orders: complete, refunds: complete });

    const result = await findReportRefreshPlan(
      source,
      "DAILY",
      undefined,
      new Date("2026-07-22T01:00:00.000Z"),
      60 * 60 * 1_000,
      new Date("2026-07-23T10:00:00.000Z"),
    );

    expect(result.period.startDate).toBe("2026-07-21");
    expect(result.groups).toHaveLength(3);
    expect(result.groups.every((group) => group.reason === "STALE")).toBe(true);
  });

  it("retains the sales-only compatibility view", async () => {
    const source = sourceWith({ sales: [{ shopId: "internal-1", tradeDate: day("2026-07-21"), fetchedAt: new Date(0) }] });
    const result = await findMissingReportSales(source, "DAILY", undefined, new Date("2026-07-22T01:00:00.000Z"));
    expect(result.missing).toEqual([{ tradeDate: "2026-07-21", shopIds: ["202"] }]);
  });

  it("limits the completeness check to scheduled shop scope", async () => {
    const source = sourceWith({ shops: [] });
    await findReportRefreshPlan(source, "DAILY", ["101", "202"], new Date("2026-07-22T01:00:00.000Z"));
    expect(source.shop.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { status: "ACTIVE", fuduoShopId: { in: [101n, 202n] } } }));
    expect(source.salesDaily.findMany).not.toHaveBeenCalled();
    expect(source.orderDaily.findMany).not.toHaveBeenCalled();
    expect(source.refundDaily.findMany).not.toHaveBeenCalled();
  });

  it("dispatches every dataset and records a failed group without dropping the report", async () => {
    const sales = vi.fn(async () => ({ total: 1, success: 1, failed: 0 }));
    const orders = vi.fn(async () => { throw new Error("UPSTREAM_TIMEOUT"); });
    const refunds = vi.fn(async () => ({ total: 2, success: 1, failed: 1 }));
    const groups = [
      { dataset: "SALES" as const, tradeDate: "2026-07-21", shopIds: ["101"], reason: "MISSING" as const },
      { dataset: "ORDERS" as const, tradeDate: "2026-07-21", shopIds: ["101"], reason: "STALE" as const },
      { dataset: "REFUNDS" as const, tradeDate: "2026-07-21", shopIds: ["101", "202"], reason: "MISSING" as const },
    ];

    const result = await refreshReportDataGroups(groups, { SALES: sales, ORDERS: orders, REFUNDS: refunds });

    expect(sales).toHaveBeenCalledWith("2026-07-21", ["101"]);
    expect(orders).toHaveBeenCalledWith("2026-07-21", ["101"]);
    expect(refunds).toHaveBeenCalledWith("2026-07-21", ["101", "202"]);
    expect(result).toMatchObject({ total: 4, success: 2, failed: 2 });
    expect(result.failedGroups).toEqual([groups[1], groups[2]]);
  });
});

function sourceWith(options: {
  shops?: Array<{ id: string; fuduoShopId: bigint }>;
  sales?: Array<{ shopId: string; tradeDate: Date; fetchedAt: Date }>;
  orders?: Array<{ shopId: string; tradeDate: Date; fetchedAt: Date }>;
  refunds?: Array<{ shopId: string; tradeDate: Date; fetchedAt: Date }>;
  states?: Array<{ shopId: string; dataType: string; tradeDate: Date; lastSuccessAt: Date | null; lastAttemptStatus: string; partial: boolean }>;
} = {}) {
  return {
    shop: { findMany: vi.fn(async () => options.shops ?? [{ id: "internal-1", fuduoShopId: 101n }, { id: "internal-2", fuduoShopId: 202n }]) },
    salesDaily: { findMany: vi.fn(async () => options.sales ?? []) },
    orderDaily: { findMany: vi.fn(async () => options.orders ?? []) },
    refundDaily: { findMany: vi.fn(async () => options.refunds ?? []) },
    ...(options.states ? { dataSyncState: { findMany: vi.fn(async () => options.states ?? []) } } : {}),
  };
}

function day(value: string) { return new Date(`${value}T00:00:00.000Z`); }
