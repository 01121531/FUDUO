import { describe, expect, it, vi } from "vitest";
import { ensureDefaultReportSchedules, reconcileReportSchedulers } from "./report-scheduler";

describe("report scheduler reconciliation", () => {
  it("creates the default daily and weekly schedules only for an empty database", async () => {
    const createMany = vi.fn(async () => ({ count: 2 }));
    const scheduledReport = { count: vi.fn(async () => 0), createMany };
    await expect(ensureDefaultReportSchedules({ scheduledReport } as never)).resolves.toBe(true);
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.arrayContaining([expect.objectContaining({ type: "DAILY", cron: "0 30 8 * * *" }), expect.objectContaining({ type: "WEEKLY", cron: "0 0 9 * * 1" })]) }));

    scheduledReport.count.mockResolvedValue(1);
    await expect(ensureDefaultReportSchedules({ scheduledReport } as never)).resolves.toBe(false);
    expect(createMany).toHaveBeenCalledTimes(1);
  });

  it("upserts active database schedules and removes stale BullMQ schedulers", async () => {
    const schedules = [
      { id: "daily-1", type: "DAILY", cron: "0 30 8 * * *", timezone: "Asia/Shanghai", active: true, shopIds: ["101"], createdAt: new Date() },
      { id: "disabled-1", type: "WEEKLY", cron: "0 0 9 * * 1", timezone: "Asia/Shanghai", active: false, shopIds: [], createdAt: new Date() },
    ];
    const queue = {
      getJobSchedulers: vi.fn(async () => [{ key: "scheduled-report-disabled-1" }, { key: "sales-live-every-5m" }]),
      removeJobScheduler: vi.fn(async () => true),
      upsertJobScheduler: vi.fn(async () => ({})),
    };
    const result = await reconcileReportSchedulers({ scheduledReport: { findMany: vi.fn(async () => schedules) } } as never, queue as never);

    expect(queue.removeJobScheduler).toHaveBeenCalledWith("scheduled-report-disabled-1");
    expect(queue.removeJobScheduler).not.toHaveBeenCalledWith("sales-live-every-5m");
    expect(queue.upsertJobScheduler).toHaveBeenCalledWith("scheduled-report-daily-1", { pattern: "0 30 8 * * *", tz: "Asia/Shanghai" }, {
      name: "report-generate",
      data: { reportType: "DAILY", scheduledReportId: "daily-1", shopIds: ["101"] },
      opts: { attempts: 3, backoff: { type: "exponential", delay: 2_000 }, removeOnComplete: 200, removeOnFail: 500 },
    });
    expect(result).toEqual({ configured: 1 });
  });
});
