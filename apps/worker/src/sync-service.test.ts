import { describe, expect, it, vi } from "vitest";
import { FuduoApiError } from "@fuduo/fuduo-sdk";
import { SyncService } from "./sync-service.js";

const shopA = { id: "shop-a", fuduoShopId: 10218n, name: "店铺 A" };
const shopB = { id: "shop-b", fuduoShopId: 10232n, name: "店铺 B" };

describe("SyncService commerce persistence", () => {
  it("upserts repeated order synchronization through the same shop/day key", async () => {
    const prisma = prismaMock([shopA]);
    const client = {
      listOrders: vi.fn(async () => ({
        records: [{ payAmount: 10.1, orderStatus: 1 }, { payAmount: 20.2, orderStatus: 2 }],
        total: 2,
        page: 1,
        size: 100,
      })),
    };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never);

    await service.syncOrders("run-1", "2026-07-21");
    await service.syncOrders("run-2", "2026-07-21");

    expect(prisma.orderDaily.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.syncRunItem.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.syncRunItem.update).toHaveBeenCalledTimes(2);
    for (const call of prisma.orderDaily.upsert.mock.calls) {
      expect(call[0]).toMatchObject({
        where: { shopId_tradeDate: { shopId: "shop-a", tradeDate: new Date("2026-07-21T00:00:00.000Z") } },
        create: { orderCount: 2, paidOrderCount: 2, paidAmount: "30.30", source: "FUDUO_OPS_ORDERS" },
        update: { orderCount: 2, paidOrderCount: 2, paidAmount: "30.30", source: "FUDUO_OPS_ORDERS" },
      });
    }
    expect(prisma.syncRunItem.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "SUCCEEDED", errorCode: null }),
    }));
  });

  it("preserves successful refund data and marks a mixed run partial", async () => {
    const prisma = prismaMock([shopA, shopB]);
    const client = {
      listAfterSales: vi.fn(async (shopId: number) => {
        if (shopId === 10232) throw new Error("ERP_SHOP_UNAVAILABLE");
        return { records: [{ refundAmount: 8.88, performanceImpact: -8.88 }], total: 1, page: 1, size: 100 };
      }),
    };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never);

    await expect(service.syncRefunds("run-partial", "2026-07-21")).resolves.toEqual({
      total: 2,
      success: 1,
      failed: 1,
      status: "PARTIAL",
    });
    expect(prisma.refundDaily.upsert).toHaveBeenCalledOnce();
    expect(prisma.syncRunItem.update).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        syncRunId_dataType_tradeDate_fuduoShopId: expect.objectContaining({
          syncRunId: "run-partial",
          dataType: "refunds",
          fuduoShopId: 10232n,
        }),
      },
      data: expect.objectContaining({ status: "FAILED", errorCode: "ERP_SHOP_UNAVAILABLE" }),
    }));
    expect(prisma.syncRun.update).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: "run-partial" },
      data: expect.objectContaining({ status: "PARTIAL", totalItems: 2, successItems: 1, failedItems: 1, errorCode: "ERP_SHOP_UNAVAILABLE" }),
    }));
  });

  it("does not finalize an order run when it participates in a combined reconciliation", async () => {
    const prisma = prismaMock([shopA]);
    const client = {
      listOrders: vi.fn(async () => ({ records: [], total: 0, page: 1, size: 100 })),
    };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never);

    await expect(service.syncOrders("run-combined", "2026-07-21", undefined, false)).resolves.toEqual({
      total: 1,
      success: 1,
      failed: 0,
      status: "SUCCEEDED",
    });
    expect(prisma.syncRun.update).not.toHaveBeenCalled();
  });

  it("holds a type, shop, and business-date lease around order synchronization", async () => {
    const prisma = prismaMock([shopA]);
    const client = { listOrders: vi.fn(async () => ({ records: [], total: 0, page: 1, size: 100 })) };
    const run = vi.fn();
    const lease = { async run<T>(key: string, operation: () => Promise<T>) { run(key, operation); return operation(); } };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never, lease);

    await service.syncOrders("run-lease", "2026-07-21");

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("orders:10218:2026-07-21", expect.any(Function));
    expect(prisma.orderDaily.upsert).toHaveBeenCalledOnce();
  });

  it("stops a batch before external shop requests when ERP authorization is unavailable", async () => {
    const prisma = prismaMock([shopA, shopB]);
    const unavailable = {
      getToken: vi.fn(async () => { throw new Error("ERP_REAUTH_REQUIRED"); }),
      refresh: vi.fn(),
    };
    const client = { listOrders: vi.fn() };
    const service = new SyncService(prisma as never, unavailable as never, () => client as never);

    await expect(service.syncOrders("run-reauth", "2026-07-21")).rejects.toThrow("ERP_REAUTH_REQUIRED");
    expect(unavailable.getToken).toHaveBeenCalledOnce();
    expect(client.listOrders).not.toHaveBeenCalled();
    expect(prisma.orderDaily.upsert).not.toHaveBeenCalled();
  });

  it("propagates a terminal authorization error discovered during a shop request", async () => {
    const prisma = prismaMock([shopA]);
    const unavailable = {
      getToken: vi.fn(async () => "expired-token"),
      refresh: vi.fn(async () => { throw new Error("ERP_REAUTH_REQUIRED"); }),
    };
    const client = { listOrders: vi.fn(async () => { throw new FuduoApiError("BIZ_UNAUTHORIZED", "expired", 401); }) };
    const service = new SyncService(prisma as never, unavailable as never, () => client as never);

    await expect(service.syncOrders("run-refresh-failed", "2026-07-21")).rejects.toThrow("ERP_REAUTH_REQUIRED");
    expect(unavailable.refresh).toHaveBeenCalledOnce();
    expect(prisma.syncRun.update).not.toHaveBeenCalled();
  });

  it("waits for already-started shops before propagating a terminal authorization error", async () => {
    const prisma = prismaMock([shopA, shopB]);
    let releaseShopA!: () => void;
    const shopAResult = new Promise<{ records: never[]; total: number; page: number; size: number }>((resolve) => {
      releaseShopA = () => resolve({ records: [], total: 0, page: 1, size: 100 });
    });
    let signalTerminal!: () => void;
    const terminalStarted = new Promise<void>((resolve) => { signalTerminal = resolve; });
    const unavailable = {
      getToken: vi.fn(async () => "expired-token"),
      refresh: vi.fn(async () => { throw new Error("ERP_REAUTH_REQUIRED"); }),
    };
    const client = {
      listOrders: vi.fn(async (shopId: number) => {
        if (shopId === 10218) return shopAResult;
        signalTerminal();
        throw new FuduoApiError("BIZ_UNAUTHORIZED", "expired", 401);
      }),
    };
    const service = new SyncService(prisma as never, unavailable as never, () => client as never);

    const synchronization = service.syncOrders("run-terminal", "2026-07-21");
    let settled = false;
    void synchronization.finally(() => { settled = true; }).catch(() => undefined);
    await terminalStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseShopA();
    await expect(synchronization).rejects.toThrow("ERP_REAUTH_REQUIRED");
    expect(prisma.orderDaily.upsert).toHaveBeenCalledOnce();
  });

  it("does not mark an empty shop scope as a successful synchronization", async () => {
    const prisma = prismaMock([]);
    const service = new SyncService(prisma as never, credentials() as never, () => ({ listOrders: vi.fn() }) as never);

    await expect(service.syncOrders("run-empty", "2026-07-21", ["999"])).rejects.toThrow("SYNC_NO_ACTIVE_SHOPS");
    expect(prisma.syncRun.update).not.toHaveBeenCalled();
  });

  it("increments the item attempt when the same run retries a shop and date", async () => {
    const prisma = prismaMock([shopA]);
    const client = { listOrders: vi.fn(async () => ({ records: [], total: 0, page: 1, size: 100 })) };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never);

    await service.syncOrders("run-retry", "2026-07-21");
    await service.syncOrders("run-retry", "2026-07-21");

    expect(prisma.syncRunItem.upsert).toHaveBeenCalledTimes(2);
    for (const call of prisma.syncRunItem.upsert.mock.calls) {
      expect(call[0]).toMatchObject({
        update: {
          status: "RUNNING",
          attempt: { increment: 1 },
          errorCode: null,
          errorMessage: null,
          finishedAt: null,
        },
      });
    }
    const starts = prisma.dataSyncState.upsert.mock.calls.map((call) => call[0]);
    expect(starts[0]).toMatchObject({
      where: {
        shopId_dataType_tradeDate: {
          shopId: "shop-a",
          dataType: "orders",
          tradeDate: new Date("2026-07-21T00:00:00.000Z"),
        },
      },
      create: expect.objectContaining({ lastAttemptStatus: "RUNNING", source: "FUDUO_OPS_ORDERS" }),
      update: expect.objectContaining({ lastAttemptStatus: "RUNNING", errorCode: null }),
    });
    expect(starts[0]!.create.currentAttemptKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(starts[1]!.create.currentAttemptKey).not.toBe(starts[0]!.create.currentAttemptKey);
  });

  it("updates the daily record and successful state in one transaction", async () => {
    const prisma = prismaMock([shopA]);
    const client = { listOrders: vi.fn(async () => ({ records: [], total: 0, page: 1, size: 100 })) };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never);

    await service.syncOrders("run-state-success", "2026-07-21");

    const attemptKey = prisma.dataSyncState.upsert.mock.calls[0]![0].create.currentAttemptKey;
    expect(prisma.dataSyncState.updateMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop-a",
        dataType: "orders",
        tradeDate: new Date("2026-07-21T00:00:00.000Z"),
        currentAttemptKey: attemptKey,
      },
      data: expect.objectContaining({
        lastSuccessAt: expect.any(Date),
        lastAttemptStatus: "SUCCEEDED",
        source: "FUDUO_OPS_ORDERS",
        partial: false,
        errorCode: null,
        currentAttemptKey: null,
      }),
    });
    expect(prisma.$transaction.mock.calls.some((call) => {
      const operations = call[0] as unknown[];
      return Array.isArray(operations) && operations.some((operation) => operation === prisma.orderDaily.upsert.mock.results[0]?.value)
        && operations.some((operation) => operation === prisma.dataSyncState.updateMany.mock.results[0]?.value);
    })).toBe(true);
  });

  it("uses the attempt key CAS when recording a failure", async () => {
    const prisma = prismaMock([shopA]);
    const client = { listOrders: vi.fn(async () => { throw new Error("ERP_SHOP_UNAVAILABLE"); }) };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never);

    await service.syncOrders("run-state-failure", "2026-07-21");

    const attemptKey = prisma.dataSyncState.upsert.mock.calls[0]![0].create.currentAttemptKey;
    expect(prisma.dataSyncState.updateMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop-a",
        dataType: "orders",
        tradeDate: new Date("2026-07-21T00:00:00.000Z"),
        currentAttemptKey: attemptKey,
      },
      data: {
        lastAttemptStatus: "FAILED",
        errorCode: "ERP_SHOP_UNAVAILABLE",
        currentAttemptKey: null,
      },
    });
  });

  it("isolates synchronization state by business date", async () => {
    const prisma = prismaMock([shopA]);
    const client = { listOrders: vi.fn(async () => ({ records: [], total: 0, page: 1, size: 100 })) };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never);

    await service.syncOrders("run-day-one", "2026-07-20");
    await service.syncOrders("run-day-two", "2026-07-21");

    expect(prisma.dataSyncState.upsert.mock.calls.map((call) => call[0].where.shopId_dataType_tradeDate.tradeDate)).toEqual([
      new Date("2026-07-20T00:00:00.000Z"),
      new Date("2026-07-21T00:00:00.000Z"),
    ]);
  });

  it("rejects an invalid sales business date before querying shops", async () => {
    const prisma = prismaMock([shopA]);
    const service = new SyncService(prisma as never, credentials() as never);

    await expect(service.syncSales("run-invalid-date", "2026-02-30")).rejects.toThrow("SYNC_TRADE_DATE_INVALID");
    expect(prisma.shop.findMany).not.toHaveBeenCalled();
  });

  it("does not persist a sales response for another shop or business date", async () => {
    const prisma = prismaMock([shopA]);
    const client = { getSalesLive: vi.fn(async () => ({ shopId: 10218, salesStatDate: "2026-07-20", salesAmount: 100 })) };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never);

    await expect(service.syncSales("run-context", "2026-07-21")).resolves.toEqual({
      total: 1,
      success: 0,
      failed: 1,
      status: "FAILED",
    });
    expect(prisma.salesDaily.upsert).not.toHaveBeenCalled();
    expect(prisma.syncRunItem.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", errorCode: "ERP_SALES_CONTEXT_MISMATCH" }),
    }));
  });

  it("does not store yesterday's refund amount as the current sales date refund", async () => {
    const prisma = prismaMock([shopA]);
    const client = { getSalesLive: vi.fn(async () => ({
      shopId: 10218,
      salesStatDate: "2026-07-21",
      salesAmount: 100,
      transactionCount: 5,
      yesterdayRefundAmount: 88.8,
    })) };
    const service = new SyncService(prisma as never, credentials() as never, () => client as never);

    await service.syncSales("run-sales", "2026-07-21");

    expect(prisma.salesDaily.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ refundAmount: null }),
      update: expect.objectContaining({ refundAmount: null }),
    }));
  });

  it("follows the server page size before deactivating missing shops", async () => {
    const prisma = prismaMock([]);
    const listVisibleShops = vi.fn()
      .mockResolvedValueOnce({ records: [externalShop(101), externalShop(102)], total: 3, pages: 2, current: 1, size: 2 })
      .mockResolvedValueOnce({ records: [externalShop(103)], total: 3, pages: 2, current: 2, size: 2 });
    const service = new SyncService(prisma as never, credentials() as never, () => ({ listVisibleShops }) as never);

    await expect(service.syncShops("run-shops")).resolves.toEqual({ total: 3, success: 3, failed: 0 });
    expect(listVisibleShops).toHaveBeenCalledTimes(2);
    expect(prisma.shop.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { fuduoShopId: { notIn: [101n, 102n, 103n] }, status: "ACTIVE" },
    }));
  });

  it("never deactivates shops after an inconsistent catalog page", async () => {
    const prisma = prismaMock([]);
    const listVisibleShops = vi.fn(async () => ({ records: [externalShop(101)], total: 2, pages: 2, current: 2, size: 1 }));
    const service = new SyncService(prisma as never, credentials() as never, () => ({ listVisibleShops }) as never);

    await expect(service.syncShops("run-bad-page")).rejects.toMatchObject({ code: "ERP_PAGINATION_INVALID" });
    expect(prisma.shop.updateMany).not.toHaveBeenCalled();
  });
});

describe("SyncService recent reconciliation", () => {
  it("reconciles sales, orders, and refunds across every requested date and completes once", async () => {
    const prisma = prismaMock([]);
    const service = new SyncService(prisma as never, credentials() as never);
    const sales = vi.spyOn(service, "syncSales").mockResolvedValue({ total: 2, success: 2, failed: 0, status: "SUCCEEDED" });
    const orders = vi.spyOn(service, "syncOrders").mockResolvedValue({ total: 2, success: 2, failed: 0, status: "SUCCEEDED" });
    const refunds = vi.spyOn(service, "syncRefunds").mockResolvedValue({ total: 2, success: 2, failed: 0, status: "SUCCEEDED" });

    await expect(service.reconcileRecent("run-reconcile", ["2026-07-21", "2026-07-20"], ["10218"])).resolves.toEqual({
      total: 12,
      success: 12,
      failed: 0,
      status: "SUCCEEDED",
    });

    expect(sales.mock.calls).toEqual([
      ["run-reconcile", "2026-07-21", ["10218"], false],
      ["run-reconcile", "2026-07-20", ["10218"], false],
    ]);
    expect(orders.mock.calls).toEqual([
      ["run-reconcile", "2026-07-21", ["10218"], false],
      ["run-reconcile", "2026-07-20", ["10218"], false],
    ]);
    expect(refunds.mock.calls).toEqual([
      ["run-reconcile", "2026-07-21", ["10218"], false],
      ["run-reconcile", "2026-07-20", ["10218"], false],
    ]);
    expect(prisma.syncRun.update).toHaveBeenCalledOnce();
    expect(prisma.syncRun.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "run-reconcile" },
      data: expect.objectContaining({ status: "SUCCEEDED", totalItems: 12, successItems: 12, failedItems: 0, errorCode: null }),
    }));
  });

  it("aggregates mixed failures into one partial run", async () => {
    const prisma = prismaMock([]);
    const service = new SyncService(prisma as never, credentials() as never);
    vi.spyOn(service, "syncSales").mockResolvedValue({ total: 2, success: 2, failed: 0, status: "SUCCEEDED" });
    vi.spyOn(service, "syncOrders").mockResolvedValue({ total: 2, success: 1, failed: 1, status: "PARTIAL" });
    vi.spyOn(service, "syncRefunds").mockResolvedValue({ total: 2, success: 0, failed: 2, status: "FAILED" });

    await expect(service.reconcileRecent("run-partial", ["2026-07-21"])).resolves.toEqual({
      total: 6,
      success: 3,
      failed: 3,
      status: "PARTIAL",
    });
    expect(prisma.syncRun.update).toHaveBeenCalledOnce();
    expect(prisma.syncRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PARTIAL", errorCode: "SYNC_RECONCILE_PARTIAL" }),
    }));
  });

  it("marks reconciliation failed when no item succeeds", async () => {
    const prisma = prismaMock([]);
    const service = new SyncService(prisma as never, credentials() as never);
    vi.spyOn(service, "syncSales").mockResolvedValue({ total: 1, success: 0, failed: 1, status: "FAILED" });
    vi.spyOn(service, "syncOrders").mockResolvedValue({ total: 1, success: 0, failed: 1, status: "FAILED" });
    vi.spyOn(service, "syncRefunds").mockResolvedValue({ total: 1, success: 0, failed: 1, status: "FAILED" });

    await expect(service.reconcileRecent("run-failed", ["2026-07-21"])).resolves.toEqual({
      total: 3,
      success: 0,
      failed: 3,
      status: "FAILED",
    });
    expect(prisma.syncRun.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "FAILED", errorCode: "SYNC_RECONCILE_FAILED" }),
    }));
  });
});

function credentials() {
  return {
    getToken: vi.fn(async () => "token"),
    refresh: vi.fn(async () => "refreshed-token"),
  };
}

function externalShop(id: number) {
  return { id, accountId: id + 1_000, shopName: `店铺 ${id}`, platformCode: "pdd", loginStatus: "ACTIVE" };
}

function prismaMock(shops: Array<typeof shopA>) {
  const orderDaily = { upsert: vi.fn(async (_args: unknown) => ({ id: "order-daily" })) };
  const refundDaily = { upsert: vi.fn(async (_args: unknown) => ({ id: "refund-daily" })) };
  const salesDaily = { upsert: vi.fn(async (_args: unknown) => ({ id: "sales-daily" })) };
  const salesSnapshot = { create: vi.fn(async (_args: unknown) => ({ id: "sales-snapshot" })) };
  const shop = {
    findMany: vi.fn(async () => shops),
    upsert: vi.fn(async (args: { create: { fuduoShopId: bigint; loginStatus: string | null } }) => ({ id: `shop-${args.create.fuduoShopId}`, platformShopId: null, loginStatus: args.create.loginStatus })),
    update: vi.fn(async (_args: unknown) => ({ id: "shop" })),
    updateMany: vi.fn(async (_args: unknown) => ({ count: 0 })),
  };
  const shopAccount = { upsert: vi.fn(async (_args: unknown) => ({ id: "shop-account" })) };
  const syncRun = { update: vi.fn(async (_args: unknown) => ({ id: "run" })) };
  const syncRunItem = {
    upsert: vi.fn(async (_args: unknown) => ({ id: "sync-run-item" })),
    update: vi.fn(async (_args: unknown) => ({ id: "sync-run-item" })),
  };
  const dataSyncState = {
    upsert: vi.fn(async (args: any) => ({ id: "data-sync-state", ...args })),
    updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  };
  return {
    orderDaily,
    refundDaily,
    salesDaily,
    salesSnapshot,
    shop,
    shopAccount,
    syncRun,
    syncRunItem,
    dataSyncState,
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
  };
}
