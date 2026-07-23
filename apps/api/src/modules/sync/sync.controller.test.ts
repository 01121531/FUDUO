import { describe, expect, it, vi } from "vitest";
import { SyncController } from "./sync.controller.js";

describe("SyncController", () => {
  it("requires sync permission before resolving the requested shop scope", async () => {
    const assertPermission = vi.fn(async () => { throw new Error("FORBIDDEN"); });
    const readableShopIds = vi.fn();
    const enqueue = vi.fn();
    const controller = new SyncController({} as never, { enqueue } as never, { assertPermission, readableShopIds } as never);

    await expect(controller.create({ type: "sales-live-sync", shopIds: ["101"] }, { user: { id: "viewer-1" } })).rejects.toThrow("FORBIDDEN");
    expect(assertPermission).toHaveBeenCalledWith("viewer-1", "sync:run");
    expect(readableShopIds).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("queues only the requested shops after permission and scope checks", async () => {
    const access = {
      assertPermission: vi.fn(async () => ({ userId: "operator-1" })),
      readableShopIds: vi.fn(async () => ["101"]),
    };
    const enqueue = vi.fn(async () => ({ id: "run-1" }));
    const controller = new SyncController({} as never, { enqueue } as never, access as never);

    const response = await controller.create({ type: "sales-live-sync", shopIds: ["101"] }, { user: { id: "operator-1" } });

    expect(enqueue).toHaveBeenCalledWith("sales-live-sync", undefined, ["101"], "operator-1");
    expect(response.data).toEqual({ id: "run-1" });
  });

  it("scopes run details and retries to the operator's readable shops", async () => {
    const run = {
      id: "run-1",
      type: "sales-live-sync",
      status: "PARTIAL",
      total: 2,
      success: 1,
      failed: 1,
      payload: { tradeDate: "2026-07-21", shopIds: ["101"] },
      scopeAllShops: false,
    };
    const data = { syncRun: vi.fn(async () => run) };
    const queue = { retry: vi.fn(async () => ({ id: "run-2" })) };
    const access = {
      assertPermission: vi.fn(async () => ({ userId: "operator-1" })),
      readableShopIds: vi.fn(async () => ["101"]),
    };
    const controller = new SyncController(data as never, queue as never, access as never);

    await expect(controller.detail("run-1", { user: { id: "operator-1" } })).resolves.toMatchObject({
      data: { id: "run-1", payload: { shopIds: ["101"] }, scopeAllShops: false },
    });
    await expect(controller.retry("run-1", { user: { id: "operator-1" } })).resolves.toMatchObject({ data: { id: "run-2" } });
    expect(queue.retry).toHaveBeenCalledWith("run-1", ["101"], "operator-1");
  });

  it("reserves global catalog and credential jobs for administrators", async () => {
    const access = {
      assertPermission: vi.fn(async () => ({ userId: "operator-1", permissions: ["sync:run"] })),
      readableShopIds: vi.fn(async () => ["101"]),
    };
    const enqueue = vi.fn();
    const controller = new SyncController({} as never, { enqueue } as never, access as never);

    await expect(controller.create({ type: "shop-catalog-sync" }, { user: { id: "operator-1" } })).rejects.toThrow("只有管理员");
    await expect(controller.create({ type: "credential-refresh" }, { user: { id: "operator-1" } })).rejects.toThrow("只有管理员");
    expect(enqueue).not.toHaveBeenCalled();
  });
});
