import { describe, expect, it, vi } from "vitest";
import { DemoDataService } from "../demo/demo-data.service.js";
import { SyncQueueService } from "./sync-queue.service.js";

describe("SyncQueueService", () => {
  const service = new SyncQueueService({ enabled: false } as never);

  it("creates a validated demo run", async () => {
    await expect(service.enqueue("sales-live-sync", "2026-07-21", ["10218"])).resolves.toMatchObject({ type: "sales-live-sync", status: "QUEUED", demo: true });
    await expect(service.enqueue("orders-sync", "2026-07-21", ["10218"])).resolves.toMatchObject({ type: "orders-sync", status: "QUEUED", demo: true });
    await expect(service.enqueue("refunds-sync", "2026-07-21", ["10218"])).resolves.toMatchObject({ type: "refunds-sync", status: "QUEUED", demo: true });
    await expect(service.ping()).resolves.toBe(false);
    await expect(service.status()).resolves.toEqual({ connected: false, demoMode: true, queueLength: 0, active: 0, failed: 0 });
  });

  it("keeps demo enqueue, list, detail source, and queue status in sync", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T15:14:42.000Z"));
    const demo = new DemoDataService();
    const demoService = new SyncQueueService({ enabled: false } as never, demo);
    try {
      const created = await demoService.enqueue("sales-live-sync", "2026-07-23", ["10218"], "operator-1");

      expect(demo.syncRuns()[0]).toMatchObject({
        id: created.id,
        type: "sales-live-sync",
        status: "QUEUED",
        total: 1,
        success: 0,
        payload: { tradeDate: "2026-07-23", shopIds: ["10218"] },
        requestedBy: "operator-1",
      });
      await expect(demoService.status()).resolves.toMatchObject({ connected: true, demoMode: true, queueLength: 1, active: 0 });

      vi.advanceTimersByTime(300);
      expect(demo.syncRuns()[0]).toMatchObject({
        id: created.id,
        status: "RUNNING",
        startedAt: "2026-07-23T15:14:42.300Z",
        items: [expect.objectContaining({ dataType: "sales", fuduoShopId: "10218", status: "RUNNING" })],
      });
      await expect(demoService.status()).resolves.toMatchObject({ queueLength: 0, active: 1 });

      vi.advanceTimersByTime(1_200);
      expect(demo.syncRuns()[0]).toMatchObject({
        id: created.id,
        status: "SUCCEEDED",
        success: 1,
        failed: 0,
        finishedAt: "2026-07-23T15:14:43.500Z",
        durationMs: 1_200,
        items: [expect.objectContaining({ status: "SUCCEEDED", finishedAt: "2026-07-23T15:14:43.500Z" })],
      });
      await expect(demoService.status()).resolves.toMatchObject({ queueLength: 0, active: 0 });

      const retried = await demoService.retry(created.id, ["10218"], "operator-1");
      expect(demo.syncRuns()[0]).toMatchObject({
        id: retried.id,
        status: "QUEUED",
        payload: { sourceRunId: created.id, tradeDate: "2026-07-23", shopIds: ["10218"] },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects unsupported types, malformed dates, and malformed external shop IDs", async () => {
    await expect(service.enqueue("arbitrary-task")).rejects.toThrow("SYNC_TYPE_UNSUPPORTED");
    await expect(service.enqueue("sales-live-sync", "21-07-2026")).rejects.toThrow("SYNC_TRADE_DATE_INVALID");
    await expect(service.enqueue("sales-live-sync", "2026-99-99")).rejects.toThrow("SYNC_TRADE_DATE_INVALID");
    await expect(service.enqueue("sales-live-sync", "2026-07-21", ["not-an-id"])).rejects.toThrow("SYNC_SHOP_IDS_INVALID");
    await expect(service.enqueue("sales-live-sync", "2026-07-21", [])).rejects.toThrow("当前账号没有可同步的店铺");
  });

  it("retries a failed run with its original date and the authorized shop scope", async () => {
    const add = vi.fn(async () => ({ id: "job-1" }));
    const syncRunTransaction = {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "22222222-2222-4222-8222-222222222222",
        createdAt: new Date("2026-07-22T08:00:00.000Z"),
        ...data,
      })),
    };
    const prisma = {
      syncRun: {
        findUnique: vi.fn(async () => ({
          id: "11111111-1111-4111-8111-111111111111",
          type: "sales-live-sync",
          status: "PARTIAL",
          errorCode: "ERP_SHOP_UNAVAILABLE",
          payload: { tradeDate: "2026-07-20", shopIds: ["101", "102"] },
        })),
        update: vi.fn(),
      },
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        syncRun: syncRunTransaction,
        $queryRawUnsafe: vi.fn(async () => [{ pg_advisory_xact_lock: null }]),
      })),
    };
    const retryService = new SyncQueueService({ enabled: true, prisma } as never);
    (retryService as unknown as { queue: { add: typeof add } }).queue = { add };

    await expect(retryService.retry("11111111-1111-4111-8111-111111111111", ["101"], "operator-1")).resolves.toMatchObject({
      id: "22222222-2222-4222-8222-222222222222",
      sourceRunId: "11111111-1111-4111-8111-111111111111",
    });
    expect(syncRunTransaction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ requestedBy: "operator-1" }) });
    expect(add).toHaveBeenCalledWith(
      "sales-live-sync",
      expect.objectContaining({
        syncRunId: "22222222-2222-4222-8222-222222222222",
        sourceRunId: "11111111-1111-4111-8111-111111111111",
        tradeDate: "2026-07-20",
        shopIds: ["101"],
      }),
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it("does not retry active, unauthorized, or context-free historical runs", async () => {
    const findUnique = vi.fn();
    const retryService = new SyncQueueService({ enabled: true, prisma: { syncRun: { findUnique } } } as never);
    findUnique.mockResolvedValueOnce({ id: "run-1", type: "sales-live-sync", status: "RUNNING", payload: {}, errorCode: null });
    await expect(retryService.retry("run-1", ["101"], "operator-1")).rejects.toThrow("任务尚未结束或无需重试");
    findUnique.mockResolvedValueOnce({ id: "run-2", type: "sales-live-sync", status: "FAILED", payload: {}, errorCode: null });
    await expect(retryService.retry("run-2", ["101"], "operator-1")).rejects.toThrow("旧任务缺少业务日期");
    findUnique.mockResolvedValueOnce({ id: "run-3", type: "sales-live-sync", status: "FAILED", payload: { tradeDate: "2026-07-20" }, errorCode: "ERP_REAUTH_REQUIRED" });
    await expect(retryService.retry("run-3", ["101"], "operator-1")).rejects.toThrow("富多授权失效");
  });

  it("deduplicates an equivalent active manual task", async () => {
    const existing = {
      id: "33333333-3333-4333-8333-333333333333",
      status: "QUEUED",
      createdAt: new Date("2026-07-22T08:00:00.000Z"),
    };
    const prisma = {
      shop: { findMany: vi.fn(async () => [{ fuduoShopId: 101n }]) },
      syncRun: {
        update: vi.fn(),
      },
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        syncRun: { findFirst: vi.fn(async () => existing), create: vi.fn() },
        $queryRawUnsafe: vi.fn(async () => [{ pg_advisory_xact_lock: null }]),
      })),
    };
    const dedupeService = new SyncQueueService({ enabled: true, prisma } as never);
    (dedupeService as unknown as { queue: { add: ReturnType<typeof vi.fn> } }).queue = { add: vi.fn(async () => ({ id: "manual-existing" })) };

    await expect(dedupeService.enqueue("sales-live-sync", "2026-07-21", undefined, "operator-1")).resolves.toMatchObject({
      id: existing.id,
      deduplicated: true,
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
  });

  it("keeps a committed run queued when Redis is temporarily unavailable", async () => {
    const run = {
      id: "44444444-4444-4444-8444-444444444444",
      type: "sales-live-sync",
      status: "QUEUED",
      createdAt: new Date("2026-07-23T08:00:00.000Z"),
    };
    const update = vi.fn(async () => run);
    const prisma = {
      syncRun: { update },
      $transaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        syncRun: {
          findFirst: vi.fn(async () => null),
          create: vi.fn(async () => run),
        },
        $queryRawUnsafe: vi.fn(async () => [{ pg_advisory_xact_lock: null }]),
      })),
    };
    const queueService = new SyncQueueService({ enabled: true, prisma } as never);
    (queueService as unknown as { queue: { add: ReturnType<typeof vi.fn> } }).queue = {
      add: vi.fn(async () => { throw new Error("REDIS_DOWN"); }),
    };

    await expect(queueService.enqueue("sales-live-sync", "2026-07-23", ["101"])).rejects.toThrow("REDIS_DOWN");
    expect(update).toHaveBeenCalledWith({
      where: { id: run.id },
      data: expect.objectContaining({ status: "QUEUED", errorCode: "SYNC_QUEUE_UNAVAILABLE", finishedAt: null }),
    });
  });
});
