import { describe, expect, it, vi } from "vitest";
import { collectOrderDaily, collectRefundDaily, shanghaiDayWindow } from "./commerce-daily.js";

describe("commerce daily aggregation", () => {
  it("uses an exact Asia/Shanghai business-day window", () => {
    expect(shanghaiDayWindow("2026-07-21")).toEqual({
      startAt: "2026-07-20T16:00:00.000Z",
      endAt: "2026-07-21T15:59:59.999Z",
    });
    expect(() => shanghaiDayWindow("2026-02-30")).toThrow("SYNC_TRADE_DATE_INVALID");
  });

  it("paginates orders and aggregates monetary values in cents", async () => {
    const listOrders = vi.fn()
      .mockResolvedValueOnce({
        records: [
          { payAmount: 10.1, orderStatus: 1 },
          { payAmount: 20.2, orderStatus: "SHIPPED" },
        ],
        total: 3,
        page: 1,
        size: 2,
      })
      .mockResolvedValueOnce({ records: [{ payAmount: null, orderStatus: "CANCELLED" }], total: 3, page: 2, size: 2 });

    await expect(collectOrderDaily({ listOrders }, 10218, "2026-07-21", { pageSize: 2 })).resolves.toEqual({
      orderCount: 3,
      paidOrderCount: 2,
      paidAmount: 30.3,
    });
    expect(listOrders).toHaveBeenNthCalledWith(1, 10218, "2026-07-20T16:00:00.000Z", "2026-07-21T15:59:59.999Z", 1, 2);
    expect(listOrders).toHaveBeenNthCalledWith(2, 10218, "2026-07-20T16:00:00.000Z", "2026-07-21T15:59:59.999Z", 2, 2);
  });

  it("keeps refund amount unknown when any returned refund lacks an amount", async () => {
    const listAfterSales = vi.fn(async () => ({
      records: [{ refundAmount: 12.34, performanceImpact: null }, { refundAmount: null, performanceImpact: null }],
      total: 2,
      page: 1,
      size: 100,
    }));
    await expect(collectRefundDaily({ listAfterSales }, 10218, "2026-07-21")).resolves.toEqual({
      refundCount: 2,
      refundAmount: null,
    });
  });

  it("rejects inconsistent or unbounded pagination", async () => {
    const wrongPage = vi.fn(async () => ({ records: [{ payAmount: 1, orderStatus: 1 }], page: 2, size: 1 }));
    await expect(collectOrderDaily({ listOrders: wrongPage }, 10218, "2026-07-21", { pageSize: 1 })).rejects.toMatchObject({ code: "ERP_PAGINATION_INVALID" });

    const endless = vi.fn(async (_shopId, _startAt, _endAt, page: number) => ({ records: [{ refundAmount: 1, performanceImpact: null }], page, size: 1 }));
    await expect(collectRefundDaily({ listAfterSales: endless }, 10218, "2026-07-21", { pageSize: 1, maxPages: 2 })).rejects.toMatchObject({ code: "ERP_PAGINATION_LIMIT" });
    expect(endless).toHaveBeenCalledTimes(2);
  });

  it("continues when the server caps page size below the requested size", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({ platformOrderId: `order-${index}`, payAmount: 1, orderStatus: 1 }));
    const listOrders = vi.fn()
      .mockResolvedValueOnce({ records: firstPage, total: 21, page: 1, size: 20 })
      .mockResolvedValueOnce({ records: [{ platformOrderId: "order-20", payAmount: 1, orderStatus: 1 }], total: 21, page: 2, size: 20 });

    await expect(collectOrderDaily({ listOrders }, 10218, "2026-07-21")).resolves.toEqual({
      orderCount: 21,
      paidOrderCount: 21,
      paidAmount: 21,
    });
    expect(listOrders).toHaveBeenCalledTimes(2);
  });

  it("deduplicates stable IDs and rejects records outside the requested context", async () => {
    const duplicateOrders = vi.fn(async () => ({
      records: [
        { platformOrderId: "order-1", businessShopId: 10218, platformOccurredAt: "2026-07-21T01:00:00.000Z", payAmount: 10, orderStatus: 1 },
        { platformOrderId: "order-1", businessShopId: 10218, platformOccurredAt: "2026-07-21T01:00:00.000Z", payAmount: 10, orderStatus: 1 },
      ],
      total: 2,
      page: 1,
      size: 100,
    }));
    await expect(collectOrderDaily({ listOrders: duplicateOrders }, 10218, "2026-07-21")).resolves.toEqual({
      orderCount: 1,
      paidOrderCount: 1,
      paidAmount: 10,
    });

    const wrongShop = vi.fn(async () => ({
      records: [{ platformRefundId: "refund-1", businessShopId: 10232, platformOccurredAt: "2026-07-21T01:00:00.000Z", refundAmount: 10, performanceImpact: null }],
      total: 1,
      page: 1,
      size: 100,
    }));
    await expect(collectRefundDaily({ listAfterSales: wrongShop }, 10218, "2026-07-21")).rejects.toMatchObject({ code: "ERP_RECORD_CONTEXT_MISMATCH" });
  });
});
