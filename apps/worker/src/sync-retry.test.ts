import { describe, expect, it, vi } from "vitest";
import { isTerminalSyncError, retryIncompleteSync, SyncRetryRequested } from "./sync-retry.js";

describe("incomplete synchronization retry", () => {
  it("moves a partial run to retry wait while attempts remain", async () => {
    const update = vi.fn(async () => ({}));
    const result = { total: 3, success: 2, failed: 1, status: "PARTIAL" as const };

    await expect(retryIncompleteSync("run-1", result, 0, 3, update)).rejects.toBeInstanceOf(SyncRetryRequested);
    expect(update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        status: "RETRY_WAIT",
        totalItems: 3,
        successItems: 2,
        failedItems: 1,
        errorCode: "SYNC_PARTIAL_RETRY",
        finishedAt: null,
      }),
    });
  });

  it("also retries a fully failed attempt while capacity remains", async () => {
    const update = vi.fn(async () => ({}));
    const result = { total: 2, success: 0, failed: 2, status: "FAILED" as const };
    await expect(retryIncompleteSync("run-2", result, 1, 3, update)).rejects.toMatchObject({ message: "SYNC_RETRY_PENDING" });
    expect(update).toHaveBeenCalledOnce();
  });

  it("returns the final partial result without scheduling another attempt", async () => {
    const update = vi.fn(async () => ({}));
    const result = { total: 3, success: 2, failed: 1, status: "PARTIAL" as const };
    await expect(retryIncompleteSync("run-3", result, 2, 3, update)).resolves.toBe(result);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not retry successful or single-attempt work", async () => {
    const update = vi.fn(async () => ({}));
    const success = { total: 2, success: 2, failed: 0, status: "SUCCEEDED" as const };
    const failed = { total: 2, success: 0, failed: 2, status: "FAILED" as const };
    await expect(retryIncompleteSync("run-4", success, 0, 3, update)).resolves.toBe(success);
    await expect(retryIncompleteSync("run-5", failed, 0, undefined, update)).resolves.toBe(failed);
    expect(update).not.toHaveBeenCalled();
  });

  it("classifies missing or invalid ERP authorization as terminal", () => {
    expect(isTerminalSyncError("ERP_REAUTH_REQUIRED")).toBe(true);
    expect(isTerminalSyncError("ERP_TOKEN_MISSING")).toBe(true);
    expect(isTerminalSyncError("ERP_TIMEOUT")).toBe(false);
  });
});
