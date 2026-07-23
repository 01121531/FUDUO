import { describe, expect, it, vi } from "vitest";
import { ensureCoreSyncSchedulers } from "./sync-scheduler.js";

describe("core synchronization schedulers", () => {
  it("installs every core schedule with bounded exponential retries", async () => {
    const queue = { upsertJobScheduler: vi.fn(async (_id: string, _repeat: unknown, _template: unknown) => ({})) };

    await expect(ensureCoreSyncSchedulers(queue as never)).resolves.toEqual({ configured: 6 });

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(6);
    expect(queue.upsertJobScheduler.mock.calls.map((call) => call[0])).toEqual([
      "shop-catalog-every-10m",
      "credential-refresh-check-every-10m",
      "sales-live-every-5m",
      "orders-every-15m",
      "refunds-every-15m",
      "sales-reconcile-daily",
    ]);
    for (const call of queue.upsertJobScheduler.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({
        opts: {
          attempts: 3,
          backoff: { type: "exponential", delay: 2_000 },
          removeOnComplete: 200,
          removeOnFail: 500,
        },
      }));
    }
    expect(queue.upsertJobScheduler).toHaveBeenLastCalledWith(
      "sales-reconcile-daily",
      { pattern: "0 15 2 * * *", tz: "Asia/Shanghai" },
      expect.objectContaining({ name: "sales-reconcile" }),
    );
  });
});
