import { describe, expect, it, vi } from "vitest";
import { beginSyncRun } from "./sync-run.js";

describe("synchronization run identity", () => {
  it("creates one run and persists its ID into a scheduled job", async () => {
    const store = syncRunStore();
    const job = { name: "sales-live-sync", data: {}, updateData: vi.fn(async () => undefined) };

    await expect(beginSyncRun(job, store as never)).resolves.toEqual({ id: "run-created" });
    expect(store.create).toHaveBeenCalledOnce();
    expect(job.updateData).toHaveBeenCalledWith({ syncRunId: "run-created" });
  });

  it("reuses the persisted run on a later BullMQ attempt", async () => {
    const store = syncRunStore();
    const job = { name: "sales-live-sync", data: { syncRunId: "run-existing" }, updateData: vi.fn(async () => undefined) };

    await expect(beginSyncRun(job, store as never)).resolves.toEqual({ id: "run-existing" });
    expect(store.create).not.toHaveBeenCalled();
    expect(job.updateData).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith({
      where: { id: "run-existing" },
      data: expect.objectContaining({ status: "RUNNING", finishedAt: null, errorCode: null, errorMessage: null }),
    });
  });

  it("marks a new run failed when its ID cannot be persisted to the job", async () => {
    const store = syncRunStore();
    const job = { name: "orders-sync", data: {}, updateData: vi.fn(async () => { throw new Error("redis unavailable"); }) };

    await expect(beginSyncRun(job, store as never)).rejects.toThrow("redis unavailable");
    expect(store.update).toHaveBeenCalledWith({
      where: { id: "run-created" },
      data: expect.objectContaining({ status: "FAILED", errorCode: "SYNC_JOB_STATE_PERSIST_FAILED" }),
    });
  });
});

function syncRunStore() {
  return {
    create: vi.fn(async () => ({ id: "run-created" })),
    update: vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })),
  };
}
